/**
 * Gateway-side record of every TokenChannel it brokered, stored in SQLite so
 * locked deposits stay visible (and routable to their provider) after restarts.
 *
 * The gateway never holds funds or signatures; this is bookkeeping only. The
 * source of truth for "is the money still locked?" is the chain, checked via
 * the explorer's spent-output lookup.
 */
const fs = require('fs');

const ONCHAIN_CACHE_MS = 30 * 1000;
const STALE_PROPOSAL_MS = 60 * 60 * 1000;

class ChannelRegistry {
  /**
   * @param {DatabaseSync} db
   * @param {string} [legacyJsonPath] - pre-database JSON store, imported once if present
   */
  constructor(db, legacyJsonPath) {
    this.db = db;
    this.onchainCache = new Map();
    if (legacyJsonPath) this.importLegacy(legacyJsonPath);
  }

  importLegacy(jsonPath) {
    if (!fs.existsSync(jsonPath)) return;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO channels (channel_id, customer_key, provider_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const c of JSON.parse(fs.readFileSync(jsonPath, 'utf8'))) {
      insert.run(c.channelId, c.customerKey || null, c.providerId || null, JSON.stringify(c), c.createdAt || Date.now(), c.updatedAt || Date.now());
    }
    fs.renameSync(jsonPath, `${jsonPath}.imported`);
    console.log(`[Channels] Imported legacy channel records from ${jsonPath}`);
  }

  get(channelId) {
    const row = this.db.prepare('SELECT data FROM channels WHERE channel_id = ?').get(channelId);
    return row ? JSON.parse(row.data) : null;
  }

  /** Create or merge a channel record. */
  upsert(channelId, fields) {
    const now = Date.now();
    const existing = this.get(channelId) || { channelId, status: 'PROPOSED', paidSats: 0, createdAt: now };
    const updated = { ...existing, ...fields, channelId, updatedAt: now };
    this.db.prepare(`
      INSERT INTO channels (channel_id, customer_key, provider_id, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        customer_key = excluded.customer_key, provider_id = excluded.provider_id,
        data = excluded.data, updated_at = excluded.updated_at
    `).run(channelId, updated.customerKey || null, updated.providerId || null, JSON.stringify(updated), updated.createdAt, now);
    return updated;
  }

  list({ customerKey, providerId } = {}) {
    let rows;
    if (customerKey && providerId) {
      rows = this.db.prepare('SELECT data FROM channels WHERE customer_key = ? OR provider_id = ?').all(customerKey, providerId);
    } else if (customerKey) {
      rows = this.db.prepare('SELECT data FROM channels WHERE customer_key = ?').all(customerKey);
    } else if (providerId) {
      rows = this.db.prepare('SELECT data FROM channels WHERE provider_id = ?').all(providerId);
    } else {
      rows = this.db.prepare('SELECT data FROM channels').all();
    }
    return rows.map(r => JSON.parse(r.data));
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
    this.onchainCache.set(key, { at: value.state === 'spent' ? Infinity : Date.now(), value });
    return value;
  }

  /** Funded channels (optionally only one customer's/provider's) with on-chain state and totals. */
  async summary(explorer, filter = {}) {
    const now = Date.now();
    const rows = [];
    for (const c of this.list(filter)) {
      if (!c.utxo && now - c.createdAt > STALE_PROPOSAL_MS) continue; // never funded
      const onchain = await this.onchainStatus(c, explorer);
      const capacity = c.utxo ? c.utxo.satoshis - c.params.closeFee : 0;
      rows.push({
        channelId: c.channelId,
        providerName: c.providerName,
        providerId: c.providerId || null,
        model: c.model || null,
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
