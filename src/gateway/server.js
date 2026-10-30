require('dotenv').config();
const path = require('path');
const { exec } = require('child_process');
const express = require('express');
const cors = require('cors');

const config = require('../config');
const providerRegistry = require('./providerRegistry');
const invoiceManager = require('./invoiceManager');
const PaymentVerifier = require('../bsv/verifier');
const WhatsOnChainClient = require('../bsv/explorer');
const wallet = require('../bsv/wallet');
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

const verifier = new PaymentVerifier(config.BSV_NETWORK);
const explorer = new WhatsOnChainClient(config.BSV_NETWORK);

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
  const { id, name, model, bsvAddress, identityKey, priceSats, endpoint } = req.body;
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
    bsvAddress,
    identityKey: cleanIdentityKey,
    payoutIsDemo: !!req.body.payoutIsDemo,
    priceSats: parseInt(priceSats || config.DEFAULT_PRICE_SATS, 10),
    endpoint
  });

  res.json({ success: true, provider: updated });
});

// API: Create Invoice for AI Query
app.post('/api/invoice', (req, res) => {
  const { prompt, model, recipientIdentityKey } = req.body;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  const targetModel = model || 'gemini-1.5-pro';
  const provider = providerRegistry.getBestProvider(targetModel);

  if (!provider) {
    return res.status(503).json({
      error: 'No active AI providers available in the pool right now. Start a provider node or try again shortly.'
    });
  }

  const invoice = invoiceManager.createInvoice({
    prompt: prompt.trim(),
    provider
  });

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
        brc29Remittance
      })
    });

    if (!execRes.ok) {
      const errText = await execRes.text();
      throw new Error(`Provider execution failed: ${errText}`);
    }

    const execData = await execRes.json();
    invoiceManager.markCompleted(invoice.id, execData);

    const explorerUrl = `${config.BSV_NETWORK === 'testnet' ? 'https://testnet.whatsonchain.com' : 'https://whatsonchain.com'}/tx/${verificationResult.txid}`;

    res.json({
      success: true,
      status: 'COMPLETED',
      invoiceId: invoice.id,
      txid: verificationResult.txid,
      paidSats: verificationResult.paidSats,
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
  const { prompt, model, buyerWif } = req.body;

  if (!prompt || !buyerWif) {
    return res.status(400).json({ error: 'Prompt and buyerWif are required.' });
  }

  let buyerWallet;
  try {
    buyerWallet = wallet.fromWif(buyerWif);
  } catch (err) {
    return res.status(400).json({ error: `Invalid WIF: ${err.message}` });
  }

  const targetModel = model || 'gemini-1.5-pro';
  const provider = providerRegistry.getBestProvider(targetModel);
  if (!provider) {
    return res.status(503).json({ error: 'No active AI providers online.' });
  }

  const invoice = invoiceManager.createInvoice({
    prompt: prompt.trim(),
    provider
  });

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
        txid
      })
    });

    const execData = await execRes.json();
    invoiceManager.markCompleted(invoice.id, execData);

    const explorerUrl = `${config.BSV_NETWORK === 'testnet' ? 'https://testnet.whatsonchain.com' : 'https://whatsonchain.com'}/tx/${txid}`;

    res.json({
      success: true,
      invoiceId: invoice.id,
      txid,
      paidSats: invoice.amountSats,
      model: execData.model,
      answer: execData.answer,
      explorerUrl
    });
  } catch (err) {
    console.error('[AutoPay] Error:', err.message);
    res.status(500).json({ error: `AutoPay failed: ${err.message}` });
  }
});

// Start Gateway
const PORT = config.PORT;
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  BSV AI Gateway is RUNNING`);
  console.log(`  - Network: BSV ${config.BSV_NETWORK.toUpperCase()}`);
  console.log(`  - Dashboard: http://localhost:${PORT}`);
  console.log(`  - Explorer: ${config.BSV_NETWORK === 'testnet' ? 'https://testnet.whatsonchain.com' : 'https://whatsonchain.com'}`);
  console.log(`======================================================\n`);
});

module.exports = app;
