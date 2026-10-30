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

  const updated = providerRegistry.register({
    id,
    name: name || 'Anonymous Node',
    model: model || 'gemini-1.5-pro',
    bsvAddress,
    identityKey: identityKey || null,
    priceSats: parseInt(priceSats || config.DEFAULT_PRICE_SATS, 10),
    endpoint
  });

  res.json({ success: true, provider: updated });
});

// API: Create Invoice for AI Query
app.post('/api/invoice', (req, res) => {
  const { prompt, model } = req.body;
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

  const bsvAmount = (invoice.amountSats / 1e8).toFixed(8);
  const bip21Uri = `bitcoin:${invoice.providerAddress}?amount=${bsvAmount}&message=AI_Swap_${invoice.id}`;
  const lockingScriptHex = wallet.p2pkh.lock(invoice.providerAddress).toHex();

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
  const { invoiceId, txid, atomicBeef, senderIdentityKey, autoDetect } = req.body;

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
          outputIndex: 0
        }
      : null;

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
      explorerUrl
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
