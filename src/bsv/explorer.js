const config = require('../config');

class WhatsOnChainClient {
  constructor(network = config.BSV_NETWORK) {
    this.network = network;
    this.baseUrl = config.WOC_API_BASE(network);
  }

  /**
   * Fetch raw or JSON transaction by hash (TXID)
   */
  async getTransaction(txid) {
    try {
      const res = await fetch(`${this.baseUrl}/tx/hash/${txid}`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'BSV-AI-Swap/1.0'
        }
      });
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`WhatsOnChain error [${res.status}]: ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      console.error(`[WOC] Error fetching tx ${txid}:`, err.message);
      return null;
    }
  }

  /**
   * Fetch confirmed and unconfirmed UTXOs for an address
   */
  async getUtxos(address) {
    try {
      const res = await fetch(`${this.baseUrl}/address/${address}/unspent`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'BSV-AI-Swap/1.0'
        }
      });
      if (!res.ok) throw new Error(`WhatsOnChain error [${res.status}]: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      console.error(`[WOC] Error fetching UTXOs for ${address}:`, err.message);
      return [];
    }
  }

  /**
   * Fetch transaction history for an address (includes mempool & confirmed)
   */
  async getAddressHistory(address) {
    try {
      const res = await fetch(`${this.baseUrl}/address/${address}/history`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'BSV-AI-Swap/1.0'
        }
      });
      if (!res.ok) throw new Error(`WhatsOnChain error [${res.status}]: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      console.error(`[WOC] Error fetching history for ${address}:`, err.message);
      return [];
    }
  }

  /**
   * Broadcast a raw signed transaction (hex) to the BSV network
   */
  async broadcastRawTx(rawTxHex) {
    try {
      const res = await fetch(`${this.baseUrl}/tx/raw`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'BSV-AI-Swap/1.0'
        },
        body: JSON.stringify({ txhex: rawTxHex })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
      }
      return data; // returns txid
    } catch (err) {
      console.error(`[WOC] Error broadcasting tx:`, err.message);
      throw err;
    }
  }

  /**
   * Check if an address has received a transaction of at least minSats (checks mempool UTXOs first)
   */
  async findIncomingTx(address, minSats, sinceTimestamp = 0) {
    // 1. Check unspent UTXOs (instant mempool detection!)
    const utxos = await this.getUtxos(address);
    if (utxos && Array.isArray(utxos)) {
      for (const u of utxos) {
        if (u.value >= minSats && u.tx_hash) {
          console.log(`[WOC] Found incoming UTXO in mempool/block for ${address}: ${u.tx_hash} (${u.value} sats)`);
          return {
            txid: u.tx_hash,
            sats: u.value,
            confirmations: u.height > 0 ? 1 : 0
          };
        }
      }
    }

    // 2. Fallback: check transaction history
    const history = await this.getAddressHistory(address);
    if (!history || !Array.isArray(history)) return null;

    for (const item of history.slice(0, 10)) {
      const tx = await this.getTransaction(item.tx_hash);
      if (!tx || !tx.vout) continue;

      for (const out of tx.vout) {
        const outSats = Math.round(out.value * 1e8);
        const scriptAddresses = out.scriptPubKey?.addresses || [];
        if (scriptAddresses.includes(address) && outSats >= minSats) {
          return {
            txid: tx.txid,
            sats: outSats,
            confirmations: tx.confirmations || 0,
            raw: tx
          };
        }
      }
    }
    return null;
  }
}

module.exports = WhatsOnChainClient;
