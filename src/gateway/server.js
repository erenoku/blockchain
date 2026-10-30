require('dotenv').config();
const path = require('path');
const { exec } = require('child_process');
const express = require('express');
const cors = require('cors');

const config = require('../config');
const providerRegistry = require('./providerRegistry');
const invoiceManager = require('./invoiceManager');
const ChannelRegistry = require('./channelRegistry');
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

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));
// @bsv/sdk browser bundle, used by channelClient.js to sign channel states
app.get('/vendor/bsv-sdk.js', (req, res) => {
  // The package "exports" map hides dist/umd, so require.resolve can't reach it
  res.sendFile(path.join(__dirname, '../../node_modules/@bsv/sdk/dist/umd/bundle.js'));
});

const verifier = new PaymentVerifier(config.BSV_NETWORK);
const explorer = new WhatsOnChainClient(config.BSV_NETWORK);

/**
 * Ask the provider for an exact token-based quote (it owns the model's tokenizer).
 * Falls back to a local estimate if the provider has no /quote route or doesn't answer.
 */
async function getProviderQuote(provider, prompt, maxOutputTokens, model = null) {
  const cap = pricing.clampMaxOutputTokens(maxOutputTokens, provider.pricing);
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

/**
 * Pick the best provider for a prompt and quote it.
 * Returns { provider, quote } or { error, status }.
 */
async function quoteRequest({ prompt, model, maxOutputTokens }) {
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { status: 400, error: 'Prompt is required' };
  }
  const cleanPrompt = prompt.trim();
  const provider = providerRegistry.getBestProvider(model || 'gemini-1.5-pro', { prompt: cleanPrompt, maxOutputTokens });
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

// API: List Providers
app.get('/api/providers', (req, res) => {
  res.json({
    providers: providerRegistry.list()
  });
});

// API: Register Provider Node
app.post('/api/providers/register', (req, res) => {
  const { id, name, model, bsvAddress, identityKey, endpoint, quoteEndpoint, channelPubKey, channelEndpoint } = req.body;
  if (!id || !bsvAddress || !endpoint) {
    return res.status(400).json({ error: 'Missing required provider fields (id, bsvAddress, endpoint)' });
  }
  if (!wallet.isValidAddress(bsvAddress)) {
    return res.status(400).json({ error: `Invalid provider bsvAddress "${String(bsvAddress).slice(0, 14)}..." (must be a base58 BSV address)` });
  }
  const cleanIdentityKey = (typeof identityKey === 'string' && IDENTITY_KEY_RE.test(identityKey.trim()))
    ? identityKey.trim().toLowerCase()
    : null;
  if (identityKey && !cleanIdentityKey) {
    console.warn(`[Gateway] Provider ${id} sent invalid identityKey (${String(identityKey).length} chars). Ignoring it.`);
  }

  const updated = providerRegistry.register({
    id,
    name: name || 'Anonymous Node',
    model: model || 'gemini-1.5-pro',
    supportedModels: req.body.supportedModels || [model || 'gemini-1.5-pro'],
    bsvAddress,
    identityKey: cleanIdentityKey,
    payoutIsDemo: !!req.body.payoutIsDemo,
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
  const { prompt, model, maxOutputTokens } = req.body;
  const result = await quoteRequest({ prompt, model, maxOutputTokens });
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
  const result = await quoteRequest({ prompt: req.body.prompt, model, maxOutputTokens });
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  const { provider, prompt, quote } = result;

  const invoice = invoiceManager.createInvoice({ prompt, provider, quote, requestedModel: model });

  if (recipientIdentityKey && typeof recipientIdentityKey === 'string' && recipientIdentityKey.trim()) {
    const cleaned = recipientIdentityKey.trim();
    if (IDENTITY_KEY_RE.test(cleaned)) {
      invoice.providerIdentityKey = cleaned.toLowerCase();
      try {
        invoice.providerAddress = wallet.PublicKey.fromString(invoice.providerIdentityKey).toAddress();
      } catch (_) {}
    } else if (wallet.isValidAddress(cleaned)) {
      invoice.providerAddress = cleaned;
      invoice.providerIdentityKey = null;
    } else {
      return res.status(400).json({
        error: `Alıcı Identity Key geçersiz: ${cleaned.length} karakter girildi, 66 karakter olmalı (02/03 ile başlayan hex). Karşı bilgisayardaki BSV Desktop'tan Identity Key'i tekrar kopyalayın.`
      });
    }
  }

  if (!wallet.isValidAddress(invoice.providerAddress)) {
    return res.status(500).json({
      error: `Provider payout address is invalid ("${String(invoice.providerAddress).slice(0, 14)}..."). Check PROVIDER_BSV_ADDRESS / PROVIDER_IDENTITY_KEY in .env.`
    });
  }
  if (provider.payoutIsDemo && !invoice.providerIdentityKey && invoice.providerAddress === provider.bsvAddress) {
    return res.status(400).json({
      error: 'Alıcı cüzdan ayarlı değil (provider geçici demo adresi kullanıyor, bu adrese giden satoshiler kaybolur). Lütfen "Alıcı BSV Desktop Identity Key" alanına karşı bilgisayarın 66 karakterlik Identity Key\'ini girin.'
    });
  }

  const bsvAmount = (invoice.amountSats / 1e8).toFixed(8);
  const bip21Uri = `bitcoin:${invoice.providerAddress}?amount=${bsvAmount}&message=AI_Swap_${invoice.id}`;
  let lockingScriptHex;
  try {
    lockingScriptHex = wallet.p2pkh.lock(invoice.providerAddress).toHex();
  } catch (err) {
    return res.status(500).json({ error: `Could not build locking script: ${err.message}` });
  }

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
    explorerAddressUrl: `${config.BSV_NETWORK === 'testnet' ? 'https://testnet.whatsonchain.com' : 'https://whatsonchain.com'}/address/${invoice.providerAddress}`
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

  const quoted = await quoteRequest({ prompt, model, maxOutputTokens });
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
  process.env.CHANNEL_REGISTRY_PATH || path.join(__dirname, '../../data/gateway-channels.json')
);

let channelLib = null;
function contractLib() {
  if (!channelLib) channelLib = require('../../contracts/dist/channel');
  return channelLib;
}

async function relayToProvider(provider, path, body) {
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
      status: ok ? 'OPEN' : 'OPEN_FAILED'
    });
  } else if (action === 'chunk' && ok) {
    channelRegistry.upsert(channelId, { paidSats: data.paidSats });
  } else if (action === 'close' && ok) {
    channelRegistry.upsert(channelId, { status: 'CLOSED', paidSats: data.paidSats, settleTxid: data.settleTxid || null });
  }
}

// API: Prepare a channel (returns the contract locking script for the buyer to fund)
app.post('/api/channel/prepare', async (req, res) => {
  const { sessionPubKey, buyerAddress, model, ttlSec } = req.body;
  if (!buyerAddress || !wallet.isValidAddress(buyerAddress)) {
    return res.status(400).json({ error: 'A valid buyerAddress (refund address) is required' });
  }
  const provider = providerRegistry.getBestProvider(model || 'gemini-1.5-pro', { requireChannels: true });
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
    if (data.params.providerAddress !== provider.bsvAddress || data.params.providerPubKey !== provider.channelPubKey) {
      return res.status(502).json({ error: 'Provider returned channel keys/addresses that differ from its registration' });
    }
    channelRegistry.upsert(data.channelId, { providerName: provider.name, model: model || provider.model, params: data.params });
    res.json({ ...data, providerName: provider.name, model: model || provider.model, pricing: provider.pricing, network: config.BSV_NETWORK });
  } catch (err) {
    res.status(502).json({ error: `Provider unreachable: ${err.message}` });
  }
});

// API: Relay channel actions to the provider that owns the channel
for (const action of ['open', 'query', 'chunk', 'close']) {
  app.post(`/api/channel/:id/${action}`, async (req, res) => {
    const provider = channelProvider(req.params.id);
    if (!provider) {
      if (action === 'open' && channelRegistry.get(req.params.id)) {
        recordChannelAction(req.params.id, action, req.body, 503, {});
      }
      return res.status(404).json({ error: 'Unknown channel or provider offline' });
    }
    try {
      const body = action === 'query'
        ? { ...req.body, model: req.body.model || channelRegistry.get(req.params.id)?.model || provider.model }
        : req.body;
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

// API: Every channel this gateway brokered, with how much is still locked on-chain
app.get('/api/channels', async (req, res) => {
  res.json({ network: config.BSV_NETWORK, ...(await channelRegistry.summary(explorer)) });
});

// API: Let a browser report a channel it funded (e.g. from before the gateway kept records)
app.post('/api/channels/track', (req, res) => {
  const { channelId, params, utxo, providerName, status } = req.body;
  if (!/^ch_[0-9a-f]{16}$/.test(channelId || '') || !params || !utxo || !/^[0-9a-f]{64}$/i.test(utxo.txid || '')) {
    return res.status(400).json({ error: 'channelId, params and utxo are required' });
  }
  if (channelRegistry.get(channelId)) return res.json({ success: true, known: true });
  channelRegistry.upsert(channelId, {
    providerName: providerName || 'unknown',
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
