/**
 * Gateway-side record of every TokenChannel it brokered, persisted to disk so
 * locked deposits stay visible (and routable to their provider) after restarts.
 *
 * The gateway never holds funds or signatures; this is bookkeeping only. The
 * source of truth for "is the money still locked?" is the chain, checked via
 * the explorer's spent-output lookup.
 */
const fs = require('fs');
const path = require('path');

const ONCHAIN_CACHE_MS = 30 * 1000;
const STALE_PROPOSAL_MS = 60 * 60 * 1000;

class ChannelRegistry {
  constructor(storePath) {
    this.storePath = storePath;
    this.channels = new Map();
    this.onchainCache = new Map();
    if (storePath && fs.existsSync(storePath)) {
      for (const c of JSON.parse(fs.readFileSync(storePath, 'utf8'))) this.channels.set(c.channelId, c);
    }
  }

  persist() {
    if (!this.storePath) return;
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Array.from(this.channels.values()), null, 2));
    fs.renameSync(tmp, this.storePath);
  }

  get(channelId) {
    return this.channels.get(channelId) || null;
  }

  /** Create or merge a channel record. */
  upsert(channelId, fields) {
    const now = Date.now();
    const existing = this.channels.get(channelId) || { channelId, status: 'PROPOSED', paidSats: 0, createdAt: now };
    const updated = { ...existing, ...fields, channelId, updatedAt: now };
    this.channels.set(channelId, updated);
    this.persist();
    return updated;
  }

  /**
   * Where is each funded channel's deposit now? 'locked' (unspent in the
   * contract), 'spent' (settled or refunded) or 'unknown' (explorer error).
   */
  async onchainStatus(channel, explorer) {
    if (!channel.utxo) return { state: 'unfunded' };
    const key = `${channel.utxo.txid}:${channel.utxo.vout}`;
    const cached = this.onchainCache.get(key);
    if (cached && Date.now() - cached.at < ONCHAIN_CACHE_MS) return cached.value;

    let value;
    try {
      const spent = await explorer.getSpentBy(channel.utxo.txid, channel.utxo.vout);
      value = spent ? { state: 'spent', spentBy: spent.txid } : { state: 'locked' };
    } catch (err) {
      value = { state: 'unknown', error: err.message };
    }
    // A spent output never becomes unspent again, so keep that answer
    if (value.state !== 'spent') this.onchainCache.set(key, { at: Date.now(), value });
    else this.onchainCache.set(key, { at: Infinity, value });
    return value;
  }

  /** Funded channels with their on-chain state and lock totals. */
  async summary(explorer) {
    const now = Date.now();
    const rows = [];
    for (const c of this.channels.values()) {
      if (!c.utxo) {
        if (now - c.createdAt > STALE_PROPOSAL_MS) continue; // never funded
      }
      const onchain = await this.onchainStatus(c, explorer);
      const capacity = c.utxo ? c.utxo.satoshis - c.params.closeFee : 0;
      rows.push({
        channelId: c.channelId,
        providerName: c.providerName,
        status: c.status,
        depositSats: c.utxo ? c.utxo.satoshis : 0,
        paidSats: c.paidSats || 0,
        refundableSats: onchain.state === 'locked' ? capacity - (c.paidSats || 0) : 0,
        expiry: c.params.expiry,
        refundOpen: Math.floor(now / 1000) >= c.params.expiry,
        fundingTxid: c.utxo ? c.utxo.txid : null,
        settleTxid: c.settleTxid || null,
        refundTxid: c.refundTxid || null,
        onchain
      });
    }
    rows.sort((a, b) => b.expiry - a.expiry);
    const locked = rows.filter(r => r.onchain.state === 'locked');
    return {
      channels: rows,
      totalLockedSats: locked.reduce((sum, r) => sum + r.depositSats, 0),
      lockedChannels: locked.length
    };
  }
}

module.exports = ChannelRegistry;
