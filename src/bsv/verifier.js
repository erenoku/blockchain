const { Transaction } = require('@bsv/sdk');
const WhatsOnChainClient = require('./explorer');
const wallet = require('./wallet');
const config = require('../config');

class PaymentVerifier {
  constructor(network = config.BSV_NETWORK) {
    this.explorer = new WhatsOnChainClient(network);
    // Keep track of claimed TXIDs in memory to prevent replay attacks
    this.claimedTxids = new Set();
  }

  /**
   * Verify an on-chain or AtomicBEEF BSV transaction for a specific invoice
   * @param {Object} invoice - { id, providerAddress, amountSats }
   * @param {string} txid - 64-char hex transaction ID from BSV Desktop
   * @param {Array<number>} [atomicBeef] - Optional AtomicBEEF byte array from BSV Desktop createAction
   */
  async verifyPayment(invoice, txid, atomicBeef = null) {
    if (!txid || typeof txid !== 'string' || txid.trim().length !== 64) {
      return { valid: false, reason: 'Invalid TXID format. Must be a 64-character hex string.' };
    }

    const cleanTxid = txid.trim().toLowerCase();

    // Replay attack check
    if (this.claimedTxids.has(cleanTxid)) {
      return { valid: false, reason: 'This transaction has already been used for another query.' };
    }

    console.log(`[Verifier] Verifying TX ${cleanTxid} for invoice ${invoice.id}...`);

    // 1. Fast-path: If BSV Desktop returned AtomicBEEF (bridgeData.tx), verify cryptographically via @bsv/sdk!
    if (Array.isArray(atomicBeef) && atomicBeef.length > 0) {
      try {
        const bsvTx = Transaction.fromAtomicBEEF(atomicBeef);
        const parsedTxid = bsvTx.id('hex').toLowerCase();
        const expectedScriptHex = wallet.p2pkh.lock(invoice.providerAddress).toHex().toLowerCase();

        let paidSats = 0;
        for (const out of bsvTx.outputs) {
          const outScript = out.lockingScript.toHex().toLowerCase();
          if (outScript === expectedScriptHex) {
            paidSats += out.satoshis;
          }
        }

        if (paidSats >= invoice.amountSats) {
          console.log(`[Verifier] AtomicBEEF verified locally! TXID: ${parsedTxid}, Paid: ${paidSats} sats`);
          this.claimedTxids.add(cleanTxid);

          // Also broadcast raw TX hex to WhatsOnChain in background so explorer link works immediately
          this.explorer.broadcastRawTx(bsvTx.toHex()).catch((e) => {
            console.log(`[Verifier] Background WOC broadcast note: ${e.message}`);
          });

          return {
            valid: true,
            txid: cleanTxid,
            paidSats,
            confirmations: 0,
            blocktime: Math.floor(Date.now() / 1000)
          };
        }
      } catch (beefErr) {
        console.warn(`[Verifier] AtomicBEEF parse warning (falling back to WOC): ${beefErr.message}`);
      }
    }

    // 2. Standard path: Query WhatsOnChain with retries (handles 2-5s Arcade broadcast propagation delay)
    let tx = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      tx = await this.explorer.getTransaction(cleanTxid);
      if (tx && tx.vout) break;

      // Also check UTXO list directly (often indexes faster than /tx/hash)
      const utxos = await this.explorer.getUtxos(invoice.providerAddress);
      if (Array.isArray(utxos)) {
        const matchingUtxo = utxos.find(u => u.tx_hash && u.tx_hash.toLowerCase() === cleanTxid && u.value >= invoice.amountSats);
        if (matchingUtxo) {
          console.log(`[Verifier] Verified via UTXO mempool index on attempt ${attempt}!`);
          this.claimedTxids.add(cleanTxid);
          return {
            valid: true,
            txid: cleanTxid,
            paidSats: matchingUtxo.value,
            confirmations: matchingUtxo.height > 0 ? 1 : 0,
            blocktime: Math.floor(Date.now() / 1000)
          };
        }
      }

      if (attempt < 6) {
        console.log(`[Verifier] Waiting for TX ${cleanTxid.slice(0, 10)}... to propagate to mempool (attempt ${attempt}/6)...`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    if (!tx) {
      return {
        valid: false,
        reason: 'Transaction not found in BSV mempool or blockchain yet. Ensure you hit Send in BSV Desktop and wait 2-3 seconds for network broadcast.'
      };
    }

    if (!tx.vout || !Array.isArray(tx.vout)) {
      return { valid: false, reason: 'Malformed transaction structure from indexer.' };
    }

    // Inspect outputs
    let paidSats = 0;
    for (const out of tx.vout) {
      const outSats = Math.round((out.value || 0) * 1e8);
      const addresses = out.scriptPubKey?.addresses || [];
      if (addresses.includes(invoice.providerAddress)) {
        paidSats += outSats;
      }
    }

    if (paidSats < invoice.amountSats) {
      return {
        valid: false,
        reason: `Insufficient payment. Required: ${invoice.amountSats} sats, Found: ${paidSats} sats to address ${invoice.providerAddress}`
      };
    }

    // Payment is valid!
    this.claimedTxids.add(cleanTxid);

    return {
      valid: true,
      txid: cleanTxid,
      paidSats,
      confirmations: tx.confirmations || 0,
      blocktime: tx.blocktime || tx.time || Math.floor(Date.now() / 1000)
    };
  }

  /**
   * Auto-detect incoming transaction to provider address matching invoice amount
   */
  async autoDetectPayment(invoice) {
    console.log(`[Verifier] Auto-detecting payment of ${invoice.amountSats} sats to ${invoice.providerAddress}...`);
    const found = await this.explorer.findIncomingTx(
      invoice.providerAddress,
      invoice.amountSats,
      invoice.createdAt
    );

    if (found && !this.claimedTxids.has(found.txid.toLowerCase())) {
      this.claimedTxids.add(found.txid.toLowerCase());
      return {
        valid: true,
        txid: found.txid,
        paidSats: found.sats,
        confirmations: found.confirmations
      };
    }

    return { valid: false, reason: 'No matching transaction detected yet.' };
  }
}

module.exports = PaymentVerifier;
