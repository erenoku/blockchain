/**
 * Hosted providers: accounts that run inference on the gateway with their own
 * API keys. Keys and the channel signing key are stored encrypted; only
 * `secretsFor` (used by the hosted runtime) ever decrypts them.
 */
const crypto = require('crypto');
const { PrivateKey } = require('@bsv/sdk');
const pricing = require('../pricing');

const json = (s, fallback) => {
  try { return JSON.parse(s); } catch (_) { return fallback; }
};

class ProviderStore {
  constructor(db, secrets) {
    this.db = db;
    this.secrets = secrets;
  }

  rowById(id) {
    return this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) || null;
  }

  rowByIdentity(identityKey) {
    return this.db.prepare('SELECT * FROM providers WHERE identity_key = ?').get(identityKey) || null;
  }

  keysFor(id) {
    return this.db.prepare('SELECT engine, last4, models, updated_at FROM provider_keys WHERE provider_id = ?').all(id)
      .map(k => ({ engine: k.engine, last4: k.last4, models: json(k.models, []), updatedAt: k.updated_at }));
  }

  /** Safe to send to the browser: no keys, only their last 4 characters. */
  view(row) {
    if (!row) return null;
    return {
      id: row.id,
      identityKey: row.identity_key,
      name: row.name,
      models: json(row.models, []),
      pricing: json(row.pricing, {}),
      payoutAddress: row.payout_address,
      // 'identity': paid to an identity key (02/03) and delivered to its BSV Desktop via MessageBox;
      // 'wallet': BRC-29 key of the signed-in BSV Desktop, claimed with "Cüzdana al"
      payoutMode: row.payout_identity_key ? 'identity' : 'wallet',
      payoutIdentityKey: row.payout_identity_key || null,
      enabled: !!row.enabled,
      status: row.status,
      statusReason: row.status_reason,
      keys: this.keysFor(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listAll() {
    return this.db.prepare('SELECT * FROM providers').all();
  }

  /**
   * Create or update the provider owned by `identityKey`.
   * @param {Object} input
   * @param {Array<{engine, apiKey, models}>} input.keys - new/replaced keys (already validated)
   * @param {{publicKey?, address, prefix, suffix}} [input.payout] - required on create
   */
  save(identityKey, { name, models, pricing: rawPricing, keys = [], payout }) {
    const now = Date.now();
    const existing = this.rowByIdentity(identityKey);
    const id = existing ? existing.id : `prv_${crypto.randomBytes(8).toString('hex')}`;
    const normalized = pricing.normalizePricing(rawPricing || {});

    this.db.exec('BEGIN');
    try {
      if (existing) {
        this.db.prepare('UPDATE providers SET name = ?, models = ?, pricing = ?, updated_at = ? WHERE id = ?')
          .run(name, JSON.stringify(models), JSON.stringify(normalized), now, id);
        if (payout) {
          this.db.prepare('UPDATE providers SET payout_address = ?, payout_prefix = ?, payout_suffix = ?, payout_identity_key = ? WHERE id = ?')
            .run(payout.address, payout.prefix, payout.suffix, payout.identityKey || null, id);
        }
      } else {
        if (!payout) throw new Error('Ödeme adresi gerekli.');
        this.db.prepare(`
          INSERT INTO providers (id, identity_key, name, models, pricing, channel_wif_enc, payout_address, payout_prefix, payout_suffix, payout_identity_key, enabled, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ok', ?, ?)
        `).run(id, identityKey, name, JSON.stringify(models), JSON.stringify(normalized),
          this.secrets.encrypt(PrivateKey.fromRandom().toWif()), payout.address, payout.prefix, payout.suffix, payout.identityKey || null, now, now);
      }
      for (const k of keys) {
        this.db.prepare(`
          INSERT INTO provider_keys (provider_id, engine, api_key_enc, last4, models, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider_id, engine) DO UPDATE SET api_key_enc = excluded.api_key_enc, last4 = excluded.last4,
            models = excluded.models, updated_at = excluded.updated_at
        `).run(id, k.engine, this.secrets.encrypt(k.apiKey), k.apiKey.slice(-4), JSON.stringify(k.models), now);
      }
      // New keys clear an earlier key error
      if (keys.length > 0) this.db.prepare("UPDATE providers SET status = 'ok', status_reason = NULL WHERE id = ?").run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.rowById(id);
  }

  setEnabled(id, enabled) {
    this.db.prepare('UPDATE providers SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, Date.now(), id);
  }

  setStatus(id, status, reason = null) {
    this.db.prepare('UPDATE providers SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').run(status, reason, Date.now(), id);
  }

  deleteKey(id, engine) {
    this.db.prepare('DELETE FROM provider_keys WHERE provider_id = ? AND engine = ?').run(id, engine);
    // Models only that key could serve are no longer offered
    const servable = new Set(this.keysFor(id).flatMap(k => k.models));
    const row = this.rowById(id);
    const models = json(row.models, []).filter(m => servable.has(m));
    this.db.prepare('UPDATE providers SET models = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(models), Date.now(), id);
  }

  /** Decrypted secrets for the hosted runtime only. */
  secretsFor(id) {
    const row = this.rowById(id);
    if (!row) return null;
    const keys = {};
    for (const k of this.db.prepare('SELECT engine, api_key_enc FROM provider_keys WHERE provider_id = ?').all(id)) {
      keys[k.engine] = this.secrets.decrypt(k.api_key_enc);
    }
    return { channelWif: this.secrets.decrypt(row.channel_wif_enc), keys };
  }
}

module.exports = ProviderStore;
