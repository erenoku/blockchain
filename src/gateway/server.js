require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const express = require('express');
const cors = require('cors');

const config = require('../config');
const providerRegistry = require('./providerRegistry');
const invoiceManager = require('./invoiceManager');
const ChannelRegistry = require('./channelRegistry');
const { createAuth } = require('./auth');
const ProviderStore = require('./providerStore');
const HostedProviders = require('./hostedProviders');
const { supportsModel } = require('../modelRouting');
const { securityHeaders, requireJsonBody, rateLimit } = require('./security');
const { loadGatewayIdentity } = require('./gatewayIdentity');
const peerPay = require('./peerPay');
const { createProviderAccounts } = require('./providerAccounts');
const { openDb } = require('../db');
const { SecretBox, loadMasterKey } = require('../secrets');
const PaymentVerifier = require('../bsv/verifier');
const WhatsOnChainClient = require('../bsv/explorer');
const wallet = require('../bsv/wallet');
const pricing = require('../pricing');
const { MessageBoxClient } = require('../public/messagebox-bundle');

function createNodeBridgeWalletClient() {
  return new Proxy({}, {
    get(_, method) {
      if (method === 'then' || typeof method === 'symbol') return undefined;
      return async (args = {}) => {
        const res = await fetch(`http://127.0.0.1:3321/${String(method)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Origin': 'http://localhost:3300'
          },
          body: JSON.stringify(args)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.message || data.description || `Wallet ${String(method)} failed (${res.status})`);
        }
        return data;
      };
    }
  });
}

const IDENTITY_KEY_RE = /^(02|03)[0-9a-fA-F]{64}$/;
const MESSAGEBOX_HOSTS = [
  'https://messagebox.bsvblockchain.tech',
  'https://message-box-us-1.bsvb.tech',
  'https://messagebox.babbage.systems'
];

/**
 * Deliver a BRC-29 PeerPay payment token into the recipient's MessageBox `payment_inbox`.
 * 1) First send WITHOUT a host override, so the client resolves the recipient's advertised
 *    MessageBox host via the overlay (that is where their BSV Desktop actually listens);
 *    if they have no advertisement it uses the primary host.
 * 2) If that fails, fall back through the other known hosts.
 * Returns { delivered, host, messageId, errors }.
 */
async function deliverPeerPayFromNode({ recipientIdentityKey, derivationPrefix, derivationSuffix, atomicBeef, amountSats }) {
  const result = { delivered: false, host: null, messageId: null, errors: [] };
  if (!recipientIdentityKey || !IDENTITY_KEY_RE.test(recipientIdentityKey)) {
    result.errors.push('invalid recipient identity key');
    return result;
  }
  const paymentToken = {
    customInstructions: { derivationPrefix, derivationSuffix },
    transaction: atomicBeef,
    amount: amountSats,
    outputIndex: 0
  };
  const walletClient = createNodeBridgeWalletClient();
  const message = {
    recipient: recipientIdentityKey.toLowerCase(),
    messageBox: 'payment_inbox',
    body: JSON.stringify(paymentToken)
  };

  const attempts = [{ label: 'advertised', override: undefined }, ...MESSAGEBOX_HOSTS.slice(1).map(h => ({ label: h, override: h }))];
  for (const attempt of attempts) {
    try {
      const mbClient = new MessageBoxClient({
        host: MESSAGEBOX_HOSTS[0],
        walletClient,
        originator: 'localhost:3300',
        enableLogging: false
      });
      const usedHost = attempt.override || await mbClient.resolveHostForRecipient(message.recipient).catch(() => MESSAGEBOX_HOSTS[0]);
      const sent = await mbClient.sendMessage(message, usedHost);
      result.delivered = true;
      result.host = usedHost;
      result.messageId = sent?.messageId || null;
      console.log(`[Gateway PeerPay] ✔ Delivered payment token to ${recipientIdentityKey.slice(0, 14)}... on ${usedHost} (messageId: ${result.messageId})`);
      return result;
    } catch (err) {
      console.warn(`[Gateway PeerPay] ${attempt.label} delivery failed:`, err.message);
      result.errors.push(`${attempt.label}: ${err.message}`);
    }
  }
  return result;
}

// Accounts, providers and channel records live in SQLite under DATA_DIR
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const dbPath = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

// In demo mode (default unless PERSIST_DB=true), reset databases, sessions and channels on every server restart
if (process.env.PERSIST_DB !== 'true') {
  try {
    if (dbPath && dbPath !== ':memory:') {
      for (const suffix of ['', '-wal', '-shm']) {
        const p = dbPath + suffix;
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch (_) {}
        }
      }
    }
    const cleanDir = (dir) => {
      if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir)) {
          if (file.endsWith('.json')) {
            try { fs.unlinkSync(path.join(dir, file)); } catch (_) {}
          }
        }
      }
    };
    cleanDir(path.join(DATA_DIR, 'hosted'));
    cleanDir(path.join(DATA_DIR, 'accounts'));

    if (fs.existsSync(DATA_DIR)) {
      for (const file of fs.readdirSync(DATA_DIR)) {
        if (file.startsWith('provider-channels-') || file.startsWith('gateway-channels')) {
          try { fs.unlinkSync(path.join(DATA_DIR, file)); } catch (_) {}
        }
      }
    }
    console.log('[Gateway Demo Mode] Cleaned database, sessions, and channel state for fresh start.');
  } catch (err) {
    console.warn('[Gateway Demo Mode] Warning while resetting state:', err.message);
  }
}

const db = openDb(dbPath);

// Ensure all tables are completely empty on start if files were held open
if (process.env.PERSIST_DB !== 'true') {
  try {
    db.exec('PRAGMA foreign_keys = OFF;');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of tables) {
      db.exec(`DELETE FROM "${name}";`);
    }
    db.exec('PRAGMA foreign_keys = ON;');
  } catch (_) {}
}

const secrets = new SecretBox(loadMasterKey({ devKeyPath: path.join(DATA_DIR, 'master.key') }));
const auth = createAuth({ db, secureCookies: config.COOKIE_SECURE });
// BRC-29 sender for payouts to providers' identity keys
const gatewayIdentity = loadGatewayIdentity(db, secrets);

const app = express();
if (config.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders);
// Same-origin by default; provider nodes call the API server-to-server, which CORS doesn't affect
if (config.CORS_ORIGINS.length) app.use(cors({ origin: config.CORS_ORIGINS, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use('/api', requireJsonBody);

const userOrIp = (req) => (req.user && req.user.identityKey) || req.ip;
app.use('/api/auth', rateLimit({ windowMs: 60 * 1000, max: 30 }));
app.use(['/api/provider/validate-key', '/api/provider/setup'], auth.optionalAuth, rateLimit({ windowMs: 60 * 1000, max: 20, key: userOrIp }));
app.use('/api/quote', rateLimit({ windowMs: 60 * 1000, max: 120 }));
app.use('/api/channel/:id/query', auth.optionalAuth, rateLimit({ windowMs: 60 * 1000, max: 30, key: userOrIp }));
app.use('/api', auth.router);
app.locals.db = db;

const providerStore = new ProviderStore(db, secrets);
let hosted = null; // HostedProviders runtime, created below
app.locals.payouts = { deliver: peerPay.deliverPayment }; // tests replace this
app.use('/api', createProviderAccounts({
  store: providerStore,
  requireAuth: auth.requireAuth,
  network: config.BSV_NETWORK,
  gateway: gatewayIdentity,
  onChange: (providerId) => hosted && hosted.reload(providerId)
}));
app.use(express.static(path.join(__dirname, '../public')));
// @bsv/sdk browser bundle, used by channelClient.js to sign channel states
app.get('/vendor/bsv-sdk.js', (req, res) => {
  // The package "exports" map hides dist/umd, so require.resolve can't reach it
  res.sendFile(path.join(__dirname, '../../node_modules/@bsv/sdk/dist/umd/bundle.js'));
});
// Markdown rendering for AI answers: parser + HTML sanitizer, served locally rather than from a CDN
app.get('/vendor/marked.js', (req, res) => {
  res.sendFile(path.join(__dirname, '../../node_modules/marked/lib/marked.umd.js'));
});
app.get('/vendor/purify.js', (req, res) => {
  res.sendFile(path.join(__dirname, '../../node_modules/dompurify/dist/purify.min.js'));
});
// LaTeX math in AI answers (KaTeX script, stylesheet and its fonts)
app.use('/vendor/katex', express.static(path.join(__dirname, '../../node_modules/katex/dist')));

const verifier = new PaymentVerifier(config.BSV_NETWORK);
const explorer = new WhatsOnChainClient(config.BSV_NETWORK);

/**
 * Ask the provider for an exact token-based quote (it owns the model's tokenizer).
 * Falls back to a local estimate if the provider has no /quote route or doesn't answer.
 */
async function getProviderQuote(provider, prompt, maxOutputTokens, model = null) {
  const cap = pricing.clampMaxOutputTokens(maxOutputTokens, provider.pricing);
  if (provider.hosted) {
    const { status, data } = await hosted.quote(provider.id, { prompt, maxOutputTokens: cap, model: model || provider.model });
    if (status !== 200) return { error: data.error, status };
    return {
      ...pricing.quote({ inputTokens: data.inputTokens, maxOutputTokens: cap, pricing: provider.pricing }),
      tokenCountSource: data.tokenCountSource || 'provider'
    };
  }
  if (provider.quoteEndpoint) {
    try {
      const qRes = await fetch(provider.quoteEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, maxOutputTokens: cap, model }),
        signal: AbortSignal.timeout(8000)
      });
      if (qRes.ok) {
        const q = await qRes.json();
        // Re-price on the gateway with the registered pricing so a provider can't inflate the invoice
        return {
          ...pricing.quote({ inputTokens: q.inputTokens, maxOutputTokens: cap, pricing: provider.pricing }),
          tokenCountSource: q.tokenCountSource || 'provider'
        };
      }
      if (qRes.status === 400 || qRes.status === 503) {
        const data = await qRes.json();
        return { error: data.error || 'Selected AI model is unavailable.', status: qRes.status };
      }
      console.warn(`[Gateway] Provider ${provider.name} quote failed (${qRes.status}), using local estimate.`);
    } catch (err) {
      console.warn(`[Gateway] Provider ${provider.name} quote error: ${err.message}, using local estimate.`);
    }
  }
  return {
    ...pricing.quote({ inputTokens: pricing.estimateTokens(prompt), maxOutputTokens: cap, pricing: provider.pricing }),
    tokenCountSource: 'estimate'
  };
}

/** A provider the customer picked by id, if it can serve this model right now. */
function chosenProvider(providerId, model, { requireChannels = false } = {}) {
  const provider = providerRegistry.providers.get(providerId);
  if (!provider || provider.available === false) return { status: 404, error: 'Seçilen provider şu an çevrimdışı.' };
  if (model && !supportsModel(provider, model)) return { status: 400, error: `Seçilen provider ${model} modelini sunmuyor.` };
  if (requireChannels && !provider.channelEndpoint) return { status: 400, error: 'Seçilen provider ödeme kanalı desteklemiyor.' };
  return { provider };
}

/**
 * Pick the best provider for a prompt (or the one the customer chose) and quote it.
 * Returns { provider, quote } or { error, status }.
 */
async function quoteRequest({ prompt, model, maxOutputTokens, providerId, excludeHosted = false }) {
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { status: 400, error: 'Prompt is required' };
  }
  const cleanPrompt = prompt.trim();
  let provider;
  if (providerId) {
    const chosen = chosenProvider(providerId, model);
    if (chosen.error) return chosen;
    provider = chosen.provider;
  } else {
    provider = providerRegistry.getBestProvider(model || 'gemini-1.5-pro', { prompt: cleanPrompt, maxOutputTokens, excludeHosted });
  }
  if (!provider) {
    return {
      status: 503,
      error: 'No active AI providers available in the pool right now. Start a provider node or try again shortly.'
    };
  }
  const quote = await getProviderQuote(provider, cleanPrompt, maxOutputTokens, model);
  if (quote.error) return quote;
  return { provider, prompt: cleanPrompt, quote };
}

function quoteResponseFields(quote, providerPricing) {
  return {
    inputTokens: quote.inputTokens,
    maxOutputTokens: quote.maxOutputTokens,
    inputSats: quote.inputSats,
    outputSats: quote.outputSats,
    tokenCountSource: quote.tokenCountSource,
    pricing: providerPricing
  };
}

// API: Bring BSV-Desktop app to foreground on macOS
app.post('/api/focus-wallet', (req, res) => {
  // Only meaningful when the browser runs on the gateway's own machine
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.json({ success: false });
  exec('osascript -e \'tell application "BSV-Desktop" to activate\'', (err) => {
    res.json({ success: !err });
  });
});

// API: System Status & Stats
app.get('/api/status', (req, res) => {
  const providers = providerRegistry.list();
  const history = invoiceManager.getHistory();
  const totalSatsSwapped = history.reduce((sum, h) => sum + h.sats, 0);

  res.json({
    status: 'online',
    network: config.BSV_NETWORK,
    activeProviders: providers.length,
    totalSatsSwapped,
    totalQueriesExecuted: history.length,
    recentSwaps: history.slice(0, 10),
    explorerUrl: config.BSV_NETWORK === 'testnet' ? 'https://testnet.whatsonchain.com' : 'https://whatsonchain.com'
  });
});

// API: Marketplace — every provider with models, prices and (for hosted ones) 24h stats
app.get('/api/market', (req, res) => {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const stats = new Map(db.prepare(`
    SELECT provider_id, COUNT(*) AS queries, SUM(ok) AS ok, AVG(CASE WHEN ok = 1 THEN latency_ms END) AS avg_latency
    FROM usage WHERE created_at > ? GROUP BY provider_id
  `).all(since).map(r => [r.provider_id, r]));
  const model = typeof req.query.model === 'string' ? req.query.model.trim().toLowerCase() : '';

  const providers = providerRegistry.list()
    .filter(p => p.supportsChannels)
    .filter(p => !model || p.supportedModels.some(m => m.toLowerCase() === model))
    .map(p => {
      const s = stats.get(p.id);
      return {
        id: p.id,
        name: p.name,
        hosted: p.hosted,
        available: p.available,
        status: p.status,
        models: p.supportedModels,
        pricing: p.pricing,
        stats: s ? { queries24h: s.queries, successRate: s.queries ? s.ok / s.queries : null, avgLatencyMs: s.avg_latency ? Math.round(s.avg_latency) : null } : null
      };
    })
    .sort((a, b) => (b.available - a.available) || (a.pricing.outputPer1k - b.pricing.outputPer1k));
  res.json({ network: config.BSV_NETWORK, providers });
});

// API: List Providers
app.get('/api/providers', (req, res) => {
  res.json({
    providers: providerRegistry.list()
  });
});

// API: Register Provider Node
app.post('/api/providers/register', (req, res) => {
  const { id, name, model, identityKey, endpoint, quoteEndpoint, channelPubKey, channelEndpoint } = req.body;
  if (!id || !endpoint) {
    return res.status(400).json({ error: 'Missing required provider fields (id, endpoint)' });
  }
  // Providers are only ever paid to an identity key (02/03), never to a plain address
  const cleanIdentityKey = typeof identityKey === 'string' ? identityKey.trim().toLowerCase() : '';
  if (!IDENTITY_KEY_RE.test(cleanIdentityKey)) {
    return res.status(400).json({ error: `Provider identityKey must be a 66-char key starting with 02/03 (got ${cleanIdentityKey.length} chars)` });
  }

  const updated = providerRegistry.register({
    id,
    name: name || 'Anonymous Node',
    model: model || 'gemini-1.5-pro',
    supportedModels: req.body.supportedModels || [model || 'gemini-1.5-pro'],
    bsvAddress: null,
    identityKey: cleanIdentityKey,
    pricing: pricing.normalizePricing(req.body.pricing),
    endpoint,
    quoteEndpoint: quoteEndpoint || null,
    channelPubKey: channelPubKey || null,
    channelEndpoint: channelEndpoint || null
  });

  res.json({ success: true, provider: updated });
});

// API: Price a prompt without creating an invoice (live estimate in the UI)
app.post('/api/quote', async (req, res) => {
  const { prompt, model, maxOutputTokens, providerId } = req.body;
  const result = await quoteRequest({ prompt, model, maxOutputTokens, providerId });
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  const { provider, quote } = result;
  res.json({
    success: true,
    providerName: provider.name,
    model: model || provider.model,
    amountSats: quote.totalSats,
    estimatedUsd: ((quote.totalSats * 50) / 1e8).toFixed(4),
    ...quoteResponseFields(quote, provider.pricing)
  });
});

// API: Create Invoice for AI Query
app.post('/api/invoice', async (req, res) => {
  const { model, recipientIdentityKey, maxOutputTokens } = req.body;
  const result = await quoteRequest({ prompt: req.body.prompt, model, maxOutputTokens, excludeHosted: true });
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  const { provider, prompt, quote } = result;

  const invoice = invoiceManager.createInvoice({ prompt, provider, quote, requestedModel: model });

  // Payments go only to an identity key (02/03): the buyer's wallet derives the BRC-29 address
  // (/api/derive-locking-script) and the recipient is notified via MessageBox. No plain addresses.
  const recipient = String(recipientIdentityKey || provider.identityKey || '').trim().toLowerCase();
  if (!IDENTITY_KEY_RE.test(recipient)) {
    return res.status(400).json({ error: 'Alıcının 02/03 ile başlayan 66 karakterlik kimlik anahtarı gerekli; düz adreslere ödeme yapılmaz.' });
  }
  invoice.providerIdentityKey = recipient;
  invoice.providerAddress = null; // set once the buyer's wallet derives the BRC-29 key
  const bip21Uri = null;
  const lockingScriptHex = null;

  res.json({
    success: true,
    invoiceId: invoice.id,
    model: invoice.model,
    providerName: invoice.providerName,
    providerAddress: invoice.providerAddress,
    providerIdentityKey: invoice.providerIdentityKey,
    derivationPrefix: invoice.derivationPrefix,
    derivationSuffix: invoice.derivationSuffix,
    amountSats: invoice.amountSats,
    estimatedUsd: invoice.estimatedUsd,
    ...quoteResponseFields(quote, provider.pricing),
    bip21Uri,
    lockingScriptHex,
    expiresAt: invoice.expiresAt,
    network: config.BSV_NETWORK,
    explorerAddressUrl: null
  });
});

// API: Convert BRC-29 Derived Public Key into P2PKH Locking Script & Bind to Invoice
app.post('/api/derive-locking-script', (req, res) => {
  const { invoiceId, publicKey, senderIdentityKey } = req.body;
  if (!publicKey) {
    return res.status(400).json({ error: 'publicKey is required' });
  }

  try {
    const pub = wallet.PublicKey.fromString(publicKey);
    const derivedAddress = pub.toAddress();
    const lockingScriptHex = wallet.p2pkh.lock(derivedAddress).toHex();

    if (invoiceId) {
      const inv = invoiceManager.getInvoice(invoiceId);
      if (inv) {
        inv.providerAddress = derivedAddress;
        if (senderIdentityKey) inv.senderIdentityKey = senderIdentityKey;
      }
    }

    console.log(`[Gateway] BRC-29 derived P2PKH address: ${derivedAddress} (invoice: ${invoiceId || 'n/a'})`);

    res.json({
      success: true,
      address: derivedAddress,
      lockingScriptHex
    });
  } catch (err) {
    res.status(400).json({ error: `Invalid public key: ${err.message}` });
  }
});

// API: Get Invoice Status
app.get('/api/invoice/:id', (req, res) => {
  const invoice = invoiceManager.getInvoice(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  res.json(invoice);
});

// API: Verify Payment & Dispatch Inference
app.post('/api/verify', async (req, res) => {
  const { invoiceId, txid, atomicBeef, senderIdentityKey, autoDetect, peerPayDelivery: clientPeerPayDelivery } = req.body;

  const invoice = invoiceManager.getInvoice(invoiceId);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  if (invoice.status === 'COMPLETED') {
    return res.json({
      success: true,
      status: 'COMPLETED',
      txid: invoice.txid,
      answer: invoice.answer,
      alreadyCompleted: true
    });
  }

  let verificationResult;
  if (autoDetect) {
    verificationResult = await verifier.autoDetectPayment(invoice);
  } else {
    if (!txid) {
      return res.status(400).json({ error: 'Transaction ID (txid) is required unless autoDetect is true.' });
    }
    verificationResult = await verifier.verifyPayment(invoice, txid, atomicBeef);
  }

  if (!verificationResult.valid) {
    return res.status(400).json({
      success: false,
      error: verificationResult.reason
    });
  }

  // Payment verified! Update invoice status
  invoiceManager.markPaid(invoice.id, verificationResult);

  // Find provider to execute
  const provider = providerRegistry.providers.get(invoice.providerId) || providerRegistry.getBestProvider(invoice.model);
  if (!provider || !provider.endpoint) {
    return res.status(500).json({ error: 'Matched provider is no longer online.' });
  }

  console.log(`[Gateway] Dispatching invoice ${invoice.id} to provider ${provider.name} at ${provider.endpoint}...`);

  try {
    const brc29Remittance = (Array.isArray(atomicBeef) && invoice.derivationPrefix && (senderIdentityKey || invoice.senderIdentityKey))
      ? {
          atomicBeef,
          derivationPrefix: invoice.derivationPrefix,
          derivationSuffix: invoice.derivationSuffix,
          senderIdentityKey: senderIdentityKey || invoice.senderIdentityKey,
          recipientIdentityKey: invoice.providerIdentityKey || null,
          outputIndex: 0
        }
      : null;

    // Make sure the payment token reaches the recipient's BSV Desktop payment_inbox.
    // If the browser already delivered it, don't send a duplicate; otherwise deliver from Node.
    let peerPayDelivery = (clientPeerPayDelivery && clientPeerPayDelivery.delivered)
      ? { ...clientPeerPayDelivery, via: 'browser' }
      : null;
    if (!peerPayDelivery && brc29Remittance && invoice.providerIdentityKey) {
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ delivered: false, errors: ['timeout (25s)'] }), 25000));
      peerPayDelivery = await Promise.race([
        deliverPeerPayFromNode({
          recipientIdentityKey: invoice.providerIdentityKey,
          derivationPrefix: invoice.derivationPrefix,
          derivationSuffix: invoice.derivationSuffix,
          atomicBeef,
          amountSats: invoice.amountSats
        }).catch((e) => ({ delivered: false, errors: [e.message] })),
        timeout
      ]);
      peerPayDelivery.via = 'gateway';
    }
    if (peerPayDelivery) {
      invoice.peerPayDelivery = peerPayDelivery;
      console.log(`[Gateway PeerPay] Invoice ${invoice.id} delivery status:`, JSON.stringify(peerPayDelivery));
    }

    const execRes = await fetch(provider.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoiceId: invoice.id,
        prompt: invoice.prompt,
        txid: verificationResult.txid,
        maxOutputTokens: invoice.maxOutputTokens,
        brc29Remittance,
        model: invoice.model
      })
    });

    if (!execRes.ok) {
      const errText = await execRes.text();
      throw new Error(`Provider execution failed: ${errText}`);
    }

    const execData = await execRes.json();
    if (!execRes.ok || execData.success === false || execData.error) {
      throw new Error(execData.error || 'Provider execution failed.');
    }
    invoiceManager.markCompleted(invoice.id, execData);

    const explorerUrl = `${config.BSV_NETWORK === 'testnet' ? 'https://testnet.whatsonchain.com' : 'https://whatsonchain.com'}/tx/${verificationResult.txid}`;

    res.json({
      success: true,
      status: 'COMPLETED',
      invoiceId: invoice.id,
      txid: verificationResult.txid,
      paidSats: verificationResult.paidSats,
      quotedSats: invoice.amountSats,
      maxOutputTokens: invoice.maxOutputTokens,
      usage: invoice.usage,
      actualCost: invoice.actualCost,
      model: execData.model,
      answer: execData.answer,
      explorerUrl,
      recipientIdentityKey: invoice.providerIdentityKey || null,
      peerPayDelivery: peerPayDelivery || null
    });
  } catch (err) {
    console.error(`[Gateway] Error dispatching to provider:`, err.message);
    res.status(500).json({ error: `Provider error: ${err.message}` });
  }
});

// API: One-Click Instant Pay & Execute (Supports Burner Wallet / Direct WIF)
app.post('/api/execute-autopay', async (req, res) => {
  // Paid the provider's plain address; payments only go to identity keys now
  return res.status(410).json({ error: 'Bu ödeme yöntemi kapatıldı: ödemeler yalnızca 02/03 kimlik anahtarlarına yapılır.' });
  // eslint-disable-next-line no-unreachable
  const { prompt, model, buyerWif, maxOutputTokens } = req.body;

  if (!prompt || !buyerWif) {
    return res.status(400).json({ error: 'Prompt and buyerWif are required.' });
  }

  let buyerWallet;
  try {
    buyerWallet = wallet.fromWif(buyerWif);
  } catch (err) {
    return res.status(400).json({ error: `Invalid WIF: ${err.message}` });
  }

  const quoted = await quoteRequest({ prompt, model, maxOutputTokens, excludeHosted: true });
  if (quoted.error) {
    return res.status(quoted.status).json({ error: quoted.error });
  }
  const { provider, quote } = quoted;

  const invoice = invoiceManager.createInvoice({ prompt: quoted.prompt, provider, quote, requestedModel: model });

  try {
    // 1. Fetch UTXOs for buyer
    console.log(`[AutoPay] Fetching UTXOs for buyer address ${buyerWallet.address}...`);
    const utxos = await explorer.getUtxos(buyerWallet.address);
    if (!utxos || utxos.length === 0) {
      return res.status(400).json({
        error: `Buyer address ${buyerWallet.address} has 0 UTXOs. Please fund it with Satoshis from your BSV Desktop wallet.`
      });
    }

    // 2. Fetch raw parent TXs for UTXOs
    for (const u of utxos) {
      const parent = await explorer.getTransaction(u.tx_hash);
      if (parent && parent.hex) {
        u.rawTxHex = parent.hex;
      }
    }

    // 3. Build & sign transaction
    console.log(`[AutoPay] Building & signing BSV transaction...`);
    const signed = await wallet.buildAndSignPaymentTx({
      wif: buyerWif,
      utxos,
      recipientAddress: provider.bsvAddress,
      amountSats: invoice.amountSats,
      opReturnText: `BSV_AI_SWAP:${invoice.promptHash.slice(0, 16)}`
    });

    // 4. Broadcast to BSV network
    console.log(`[AutoPay] Broadcasting transaction to BSV network...`);
    const broadcastResult = await explorer.broadcastRawTx(signed.rawTxHex);
    const txid = typeof broadcastResult === 'string' ? broadcastResult : broadcastResult.txid || signed.txid;
    console.log(`[AutoPay] Transaction broadcast successful! TXID: ${txid}`);

    // 5. Mark invoice paid
    invoiceManager.markPaid(invoice.id, {
      txid,
      paidSats: invoice.amountSats
    });

    // 6. Trigger provider inference
    const execRes = await fetch(provider.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoiceId: invoice.id,
        prompt: invoice.prompt,
        txid,
        maxOutputTokens: invoice.maxOutputTokens,
        model: invoice.model
      })
    });

    const execData = await execRes.json();
    if (!execRes.ok || execData.success === false || execData.error) {
      throw new Error(execData.error || 'Provider execution failed.');
    }
    invoiceManager.markCompleted(invoice.id, execData);

    const explorerUrl = `${config.BSV_NETWORK === 'testnet' ? 'https://testnet.whatsonchain.com' : 'https://whatsonchain.com'}/tx/${txid}`;

    res.json({
      success: true,
      invoiceId: invoice.id,
      txid,
      paidSats: invoice.amountSats,
      quotedSats: invoice.amountSats,
      maxOutputTokens: invoice.maxOutputTokens,
      usage: invoice.usage,
      actualCost: invoice.actualCost,
      model: execData.model,
      answer: execData.answer,
      explorerUrl
    });
  } catch (err) {
    console.error('[AutoPay] Error:', err.message);
    res.status(500).json({ error: `AutoPay failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// TokenChannel payment channels: the gateway matches buyer and provider, then
// relays messages. Signatures and channel state live with the provider.
// ---------------------------------------------------------------------------
// Persisted so locked deposits stay visible and routable after a gateway restart
const channelRegistry = new ChannelRegistry(
  db,
  process.env.CHANNEL_REGISTRY_PATH || path.join(DATA_DIR, 'gateway-channels.json')
);

hosted = new HostedProviders({
  store: providerStore,
  registry: providerRegistry,
  explorer,
  dataDir: DATA_DIR,
  onSettled: (channelId, s) => {
    const record = channelRegistry.upsert(channelId, {
      status: 'CLOSED',
      paidSats: s.paidSats,
      settleTxid: s.settleTxid,
      settleTx: s.settleTx || null,
      ...(s.providerId ? { providerId: s.providerId } : {})
    });
    if (record && record.payoutIdentityKey && s.settleTx) deliverPayout(channelId).catch(() => {});
  },
  recordUsage: (u) => db.prepare(
    'INSERT INTO usage (provider_id, model, ok, latency_ms, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(u.providerId, u.model, u.ok ? 1 : 0, u.latencyMs || null, u.inputTokens || null, u.outputTokens || null, Date.now())
}).start();
app.locals.hosted = hosted;
app.locals.explorer = explorer;

/**
 * Tell the provider's BSV Desktop about its earnings from a settled channel: a PeerPay
 * token in the MessageBox payment_inbox of the identity key the provider chose.
 */
async function deliverPayout(channelId) {
  const record = channelRegistry.get(channelId);
  if (!record || !record.payoutIdentityKey || !record.settleTx) throw new Error('Bu kanal için gönderilecek ödeme yok.');
  if (!record.fundingBeefHex) {
    channelRegistry.upsert(channelId, { payoutDelivery: { delivered: false, at: Date.now(), errors: ['funding transaction data missing'] } });
    throw new Error('Kanalın funding işlem verisi yok.');
  }
  const { Transaction, Utils } = require('@bsv/sdk');
  const settle = Transaction.fromHex(record.settleTx);
  settle.inputs[0].sourceTransaction = Transaction.fromAtomicBEEF(Utils.toArray(record.fundingBeefHex, 'hex'));
  const outputIndex = 0; // the contract always pays the provider first
  const result = await app.locals.payouts.deliver({
    senderWallet: gatewayIdentity.wallet,
    recipientIdentityKey: record.payoutIdentityKey,
    derivationPrefix: record.payoutPrefix,
    derivationSuffix: record.payoutSuffix,
    atomicBeef: settle.toAtomicBEEF(),
    amount: settle.outputs[outputIndex].satoshis,
    outputIndex
  });
  channelRegistry.upsert(channelId, { payoutDelivery: { ...result, at: Date.now() } });
  if (!result.delivered) console.warn(`[Payout] MessageBox delivery for ${channelId} failed: ${result.errors.join(' | ')}`);
  return result;
}

let channelLib = null;
function contractLib() {
  if (!channelLib) channelLib = require('../../contracts/dist/channel');
  return channelLib;
}

async function relayToProvider(provider, path, body) {
  if (provider.hosted) return hosted.handle(provider.id, path, body);
  const pRes = await fetch(`${provider.channelEndpoint}${path}`, body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await pRes.json().catch(() => ({ error: `Provider returned ${pRes.status}` }));
  return { status: pRes.status, data };
}

// Providers get a new id on every start, but their channel key is persisted, so match on that
function channelProvider(channelId) {
  const record = channelRegistry.get(channelId);
  if (!record) return null;
  return Array.from(providerRegistry.providers.values())
    .find(p => p.channelEndpoint && p.channelPubKey === record.params.providerPubKey) || null;
}

// Record what each relayed channel action did, for the locked-funds view
function recordChannelAction(channelId, action, body, status, data) {
  const ok = status === 200;
  if (action === 'open') {
    channelRegistry.upsert(channelId, {
      utxo: { txid: String(body.txid).toLowerCase(), vout: parseInt(body.vout, 10), satoshis: parseInt(body.satoshis, 10) },
      status: ok ? 'OPEN' : 'OPEN_FAILED',
      ...(typeof body.fundingBeefHex === 'string' && /^[0-9a-f]+$/i.test(body.fundingBeefHex) ? { fundingBeefHex: body.fundingBeefHex } : {})
    });
  } else if (action === 'chunk' && ok) {
    channelRegistry.upsert(channelId, { paidSats: data.paidSats });
  } else if (action === 'close' && ok) {
    channelRegistry.upsert(channelId, {
      status: 'CLOSED', paidSats: data.paidSats, settleTxid: data.settleTxid || null, settleTx: data.settleTx || null,
      ...(data.payoutDelivery ? { payoutDelivery: data.payoutDelivery } : {})
    });
  }
}

// API: Prepare a channel (returns the contract locking script for the buyer to fund)
app.post('/api/channel/prepare', auth.optionalAuth, async (req, res) => {
  const { sessionPubKey, buyerAddress, model, ttlSec, providerId } = req.body;
  if (!buyerAddress || !wallet.isValidAddress(buyerAddress)) {
    return res.status(400).json({ error: 'A valid buyerAddress (refund address) is required' });
  }
  let provider;
  if (providerId) {
    const chosen = chosenProvider(providerId, model, { requireChannels: true });
    if (chosen.error) return res.status(chosen.status).json({ error: chosen.error });
    provider = chosen.provider;
  } else {
    provider = providerRegistry.getBestProvider(model || 'gemini-1.5-pro', { requireChannels: true });
  }
  if (!provider) {
    return res.status(503).json({ error: 'No provider with payment channel support for the selected model is online.' });
  }

  try {
    const { status, data } = await relayToProvider(provider, '/proposal', { sessionPubKey, buyerAddress, ttlSec });
    if (status !== 200) return res.status(status).json(data);

    // Don't let the buyer fund a script that isn't our audited contract with these params
    if (data.lockingScriptHex !== contractLib().channelLockingScript(data.params)) {
      return res.status(502).json({ error: 'Provider returned a locking script that does not match the TokenChannel contract' });
    }
    if (data.params.providerPubKey !== provider.channelPubKey) {
      return res.status(502).json({ error: 'Provider returned a channel key that differs from its registration' });
    }
    // Earnings must go to the provider's identity key: hosted ones to the gateway-derived payout,
    // self-hosted nodes to a BRC-29 key of the identity they registered with
    const paysIdentity = provider.hosted
      ? data.params.providerAddress === provider.bsvAddress
      : !!(data.payout && data.payout.identityKey === provider.identityKey && provider.identityKey);
    if (!paysIdentity) {
      return res.status(502).json({ error: 'Provider would not pay its registered 02/03 identity key; channel refused.' });
    }
    // Remember how this channel's earnings are claimed, even if the provider later changes payout
    const hostedRow = provider.hosted ? providerStore.rowById(provider.id) : null;
    channelRegistry.upsert(data.channelId, {
      providerName: provider.name,
      providerId: provider.id,
      customerKey: req.user ? req.user.identityKey : null,
      model: model || provider.model,
      params: data.params,
      payoutPrefix: hostedRow ? hostedRow.payout_prefix : null,
      payoutSuffix: hostedRow ? hostedRow.payout_suffix : null,
      payoutIdentityKey: hostedRow ? hostedRow.payout_identity_key || null : (data.payout ? data.payout.identityKey : null),
      selfHostedPayout: !provider.hosted
    });
    res.json({ ...data, providerId: provider.id, providerName: provider.name, model: model || provider.model, pricing: provider.pricing, network: config.BSV_NETWORK });
  } catch (err) {
    res.status(502).json({ error: `Provider unreachable: ${err.message}` });
  }
});

// API: Relay channel actions to the provider that owns the channel
for (const action of ['open', 'query', 'chunk', 'close']) {
  app.post(`/api/channel/:id/${action}`, auth.optionalAuth, async (req, res) => {
    // A channel opened by a signed-in customer can only be used by that customer
    const record = channelRegistry.get(req.params.id);
    if (record && record.customerKey && (!req.user || req.user.identityKey !== record.customerKey)) {
      return res.status(403).json({ error: 'Bu kanal başka bir kullanıcıya ait.' });
    }
    const provider = channelProvider(req.params.id);
    if (!provider) {
      if (action === 'open' && channelRegistry.get(req.params.id)) {
        recordChannelAction(req.params.id, action, req.body, 503, {});
      }
      return res.status(404).json({ error: 'Unknown channel or provider offline' });
    }
    try {
      let body = req.body;
      if (action === 'query') body = { ...req.body, model: req.body.model || record?.model || provider.model };
      if (action === 'open') {
        body = { txid: req.body.txid, vout: req.body.vout, satoshis: req.body.satoshis };
        // Self-hosted nodes build the payment for their identity's wallet from the funding BEEF
        if (!provider.hosted) body.fundingBeefHex = req.body.fundingBeefHex;
      }
      const { status, data } = await relayToProvider(provider, `/${req.params.id}/${action}`, body);
      recordChannelAction(req.params.id, action, req.body, status, data);
      res.status(status).json(data);
    } catch (err) {
      res.status(502).json({ error: `Provider unreachable: ${err.message}` });
    }
  });
}

// API: Build & broadcast the refund of an expired channel. Anyone may do this:
// the contract only lets the deposit go back to the buyer's refund address.
app.post('/api/channel/refund', async (req, res) => {
  const { params, utxo } = req.body;
  if (!params || !utxo) return res.status(400).json({ error: 'params and utxo are required' });
  if (Math.floor(Date.now() / 1000) < params.expiry) {
    return res.status(400).json({ error: `Channel has not expired yet (refund opens at ${new Date(params.expiry * 1000).toISOString()})` });
  }
  try {
    const refundTx = contractLib().buildRefundTx(params, utxo);
    const result = await explorer.broadcastRawTx(refundTx);
    const refundTxid = typeof result === 'string' ? result : result.txid;
    if (req.body.channelId && channelRegistry.get(req.body.channelId)) {
      channelRegistry.upsert(req.body.channelId, { status: 'REFUNDED', refundTxid });
    }
    res.json({ success: true, refundTxid, refundTx });
  } catch (err) {
    // Miners judge nLockTime against chain time, which can trail the wall clock for a while
    const hint = /final/i.test(err.message) ? ' Zincir saati henüz iade zamanına ulaşmadı; birkaç dakika sonra tekrar deneyin.' : '';
    res.status(400).json({ error: `Refund failed: ${err.message}.${hint}` });
  }
});

// API: A hosted provider's earnings. Settled channels can be claimed into BSV Desktop:
// the browser builds the settlement's AtomicBEEF from the stored funding BEEF.
app.get('/api/provider/earnings', auth.requireAuth, (req, res) => {
  const row = providerStore.rowByIdentity(req.user.identityKey);
  if (!row) return res.status(404).json({ error: 'Provider kaydı yok.' });

  // Sync any channels currently held in the hosted runtime's ChannelBook into the registry
  if (hosted && hosted.runtimes) {
    const runtime = hosted.runtimes.get(row.id);
    if (runtime && runtime.channels && runtime.channels.channels) {
      for (const [chId, ch] of runtime.channels.channels.entries()) {
        const existing = channelRegistry.get(chId);
        if (!existing || existing.paidSats !== ch.paidSats || existing.status !== ch.status) {
          channelRegistry.upsert(chId, {
            providerId: row.id,
            providerName: row.name,
            model: ch.model || (runtime.models ? runtime.models[0] : null),
            status: ch.status,
            paidSats: ch.paidSats || 0,
            params: ch.params,
            utxo: ch.utxo,
            settleTxid: ch.settleTxid || null,
            settleTx: ch.settleTx || null,
            fundingBeefHex: ch.fundingBeefHex || null,
            payoutPrefix: row.payout_prefix,
            payoutSuffix: row.payout_suffix,
            payoutIdentityKey: row.payout_identity_key
          });
        }
      }
    }
  }

  const channels = channelRegistry.list({ providerId: row.id, identityKey: req.user.identityKey, payoutAddress: row.payout_address })
    .filter(c => c.utxo || c.paidSats > 0 || c.status === 'OPEN' || c.status === 'CLOSED')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(c => ({
      channelId: c.channelId,
      model: c.model || null,
      status: c.status,
      paidSats: c.paidSats || 0,
      settleTxid: c.settleTxid || null,
      settleTx: c.settleTx || null,
      fundingBeefHex: c.fundingBeefHex || null,
      claimedAt: c.claimedAt || null,
      // Paid to a BRC-29 key: identity mode is announced via MessageBox (and can also be claimed
      // here); wallet mode is claimed here. Each channel keeps the derivation it was opened with.
      claimable: !!(c.payoutPrefix || row.payout_prefix),
      payoutMode: (c.payoutIdentityKey || row.payout_identity_key) ? 'identity' : 'wallet',
      payoutDelivery: c.payoutDelivery || null,
      payout: {
        address: c.params?.providerAddress || row.payout_address,
        prefix: c.payoutPrefix || row.payout_prefix || '',
        suffix: c.payoutSuffix || row.payout_suffix || '',
        identityKey: c.payoutIdentityKey || row.payout_identity_key || null,
        senderIdentityKey: (c.payoutIdentityKey || row.payout_identity_key) ? gatewayIdentity.publicKey : req.user.identityKey
      },
      updatedAt: c.updatedAt
    }));

  const settled = channels.filter(c => c.status === 'CLOSED' && c.settleTxid);
  const openChannels = channels.filter(c => c.status === 'OPEN');
  const earnedSats = settled.reduce((s, c) => s + (c.paidSats || 0), 0);
  const openSats = openChannels.reduce((s, c) => s + (c.paidSats || 0), 0);
  const totalSats = earnedSats + openSats;

  res.json({
    payout: { address: row.payout_address, prefix: row.payout_prefix, suffix: row.payout_suffix, mode: row.payout_prefix ? 'wallet' : 'address' },
    channels,
    totals: {
      totalSats,
      earnedSats,
      claimedSats: settled.filter(c => c.claimedAt).reduce((s, c) => s + (c.paidSats || 0), 0),
      unclaimedSats: settled.filter(c => !c.claimedAt).reduce((s, c) => s + (c.paidSats || 0), 0),
      openSats
    }
  });
});

// Re-send the MessageBox payment notice for an identity-key payout
app.post('/api/provider/earnings/:channelId/redeliver', auth.requireAuth, async (req, res) => {
  const row = providerStore.rowByIdentity(req.user.identityKey);
  const record = channelRegistry.get(req.params.channelId);
  if (!row || !record || record.providerId !== row.id) return res.status(404).json({ error: 'Kanal bulunamadı.' });
  try {
    const result = await deliverPayout(req.params.channelId);
    if (!result.delivered) return res.status(502).json({ error: `Ödeme mesajı gönderilemedi: ${result.errors.join(' | ')}` });
    res.json({ success: true, delivery: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/provider/earnings/:channelId/claimed', auth.requireAuth, (req, res) => {
  const row = providerStore.rowByIdentity(req.user.identityKey);
  const record = channelRegistry.get(req.params.channelId);
  if (!row || !record || record.providerId !== row.id) return res.status(404).json({ error: 'Kanal bulunamadı.' });
  if (!record.settleTxid) return res.status(400).json({ error: 'Kanal henüz kapanmadı.' });
  channelRegistry.upsert(req.params.channelId, { claimedAt: Date.now() });
  res.json({ success: true });
});

// API: The signed-in user's channels (as customer, and as provider if they host one),
// with how much is still locked on-chain
app.get('/api/channels', auth.requireAuth, async (req, res) => {
  const ownProvider = providerStore.rowByIdentity(req.user.identityKey);
  const filter = { customerKey: req.user.identityKey, providerId: ownProvider ? ownProvider.id : undefined };
  res.json({ network: config.BSV_NETWORK, ...(await channelRegistry.summary(explorer, filter)) });
});

// API: Let a browser report a channel it funded (e.g. from before the gateway kept records)
app.post('/api/channels/track', auth.requireAuth, (req, res) => {
  const { channelId, params, utxo, providerName, status } = req.body;
  if (!/^ch_[0-9a-f]{16}$/.test(channelId || '') || !params || !utxo || !/^[0-9a-f]{64}$/i.test(utxo.txid || '')) {
    return res.status(400).json({ error: 'channelId, params and utxo are required' });
  }
  const existing = channelRegistry.get(channelId);
  if (existing) {
    // Records from before sign-in existed have no owner; the browser that funded it claims it
    if (!existing.customerKey) channelRegistry.upsert(channelId, { customerKey: req.user.identityKey });
    return res.json({ success: true, known: true });
  }
  channelRegistry.upsert(channelId, {
    providerName: providerName || 'unknown',
    customerKey: req.user.identityKey,
    params,
    utxo: { txid: utxo.txid.toLowerCase(), vout: parseInt(utxo.vout, 10), satoshis: parseInt(utxo.satoshis, 10) },
    status: status === 'OPEN' ? 'OPEN' : 'OPEN_FAILED'
  });
  res.json({ success: true, known: false });
});

app.get('/api/channel/:id', async (req, res) => {
  const provider = channelProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: 'Unknown channel or provider offline' });
  try {
    const { status, data } = await relayToProvider(provider, `/${req.params.id}`);
    res.status(status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Provider unreachable: ${err.message}` });
  }
});

// Start Gateway
const PORT = config.PORT;
if (require.main === module) app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  BSV AI Gateway is RUNNING`);
  console.log(`  - Network: BSV ${config.BSV_NETWORK.toUpperCase()}`);
  console.log(`  - Dashboard: http://localhost:${PORT}`);
  console.log(`  - Explorer: ${config.BSV_NETWORK === 'testnet' ? 'https://testnet.whatsonchain.com' : 'https://whatsonchain.com'}`);
  console.log(`======================================================\n`);
});

module.exports = app;
