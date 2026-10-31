/**
 * Provider onboarding API (signed-in users only):
 *   POST   /api/provider/validate-key   test a key, list its models (nothing stored)
 *   GET    /api/provider/me             current settings (keys shown as last 4 only)
 *   POST   /api/provider/setup          create/update; keys are re-validated server-side
 *   POST   /api/provider/me/enabled     go online/offline
 *   DELETE /api/provider/me/keys/:engine
 */
const express = require('express');
const { PublicKey } = require('@bsv/sdk');
const { derivePayout } = require('./peerPay');
const { listModels, ENGINES } = require('../provider/keyCheck');
const config = require('../config');

const MAX_PRICE_PER_1K = 1000000;

const IDENTITY_KEY_RE = /^(02|03)[0-9a-f]{64}$/;

/**
 * @param {Object} opts.gateway - the gateway identity ({ wallet, publicKey }); it is the BRC-29
 *   sender for identity-key payouts
 */
function createProviderAccounts({ store, requireAuth, network, gateway, onChange = () => {} }) {
  const toAddress = (publicKey) => PublicKey.fromString(publicKey).toAddress(network === 'testnet' ? 'testnet' : 'mainnet');

  const router = express.Router();
  router.use('/provider', requireAuth);

  const asyncRoute = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  };

  router.post('/provider/validate-key', asyncRoute(async (req, res) => {
    const { engine, apiKey } = req.body || {};
    res.json({ success: true, engine, models: await listModels(engine, apiKey) });
  }));

  router.get('/provider/me', (req, res) => {
    res.json({ provider: store.view(store.rowByIdentity(req.user.identityKey)) });
  });

  router.post('/provider/setup', asyncRoute(async (req, res) => {
    const { name, models, pricing: rawPricing, keys = [], payout } = req.body || {};
    const existing = store.rowByIdentity(req.user.identityKey);

    const cleanName = String(name || '').trim();
    if (cleanName.length < 2 || cleanName.length > 60) throw new Error('Görünen ad 2-60 karakter olmalı.');

    // Re-validate every submitted key; the browser's own check is not trusted
    const validatedKeys = [];
    for (const k of Array.isArray(keys) ? keys : []) {
      if (!k || !k.apiKey) continue;
      if (!ENGINES.includes(k.engine)) throw new Error(`Bilinmeyen sağlayıcı: ${k.engine}`);
      validatedKeys.push({ engine: k.engine, apiKey: String(k.apiKey).trim(), models: await listModels(k.engine, k.apiKey) });
    }

    // Offered models must be servable by a stored or newly validated key
    const servable = new Set([
      ...validatedKeys.flatMap(k => k.models),
      ...(existing ? store.keysFor(existing.id).filter(k => !validatedKeys.some(v => v.engine === k.engine)).flatMap(k => k.models) : [])
    ]);
    if (servable.size === 0) throw new Error('En az bir geçerli API anahtarı gerekli.');
    const offered = [...new Set((Array.isArray(models) ? models : []).map(String))];
    if (offered.length === 0) throw new Error('En az bir model seçin.');
    const unservable = offered.filter(m => !servable.has(m));
    if (unservable.length) throw new Error(`Bu modeller anahtarlarınızla sunulamıyor: ${unservable.join(', ')}`);

    const p = rawPricing || {};
    for (const field of ['inputPer1k', 'outputPer1k', 'minSats']) {
      const v = Number(p[field]);
      if (!Number.isInteger(v) || v < 0 || v > MAX_PRICE_PER_1K) throw new Error(`Geçersiz fiyat: ${field}`);
    }
    const maxOutputTokens = Math.min(parseInt(p.maxOutputTokens, 10) || config.MAX_OUTPUT_TOKENS_LIMIT, config.MAX_OUTPUT_TOKENS_LIMIT);

    // Payout goes to a BRC-29 key, so BSV Desktop can take it in:
    //  - identityKey: derived from the gateway's key + that identity (02/03); the gateway announces
    //    each payment in the identity's MessageBox payment_inbox
    //  - publicKey: derived by the signed-in BSV Desktop itself; claimed with "Cüzdana al"
    let cleanPayout = null;
    if (payout && payout.identityKey !== undefined) {
      const identityKey = String(payout.identityKey).trim().toLowerCase();
      if (!IDENTITY_KEY_RE.test(identityKey)) throw new Error(`Kimlik anahtarı 66 karakter olmalı ve 02 veya 03 ile başlamalı (${identityKey.length} karakter girildi).`);
      try { PublicKey.fromString(identityKey); } catch (_) { throw new Error('Kimlik anahtarı geçerli bir açık anahtar değil.'); }
      const d = await derivePayout(gateway.wallet, identityKey);
      cleanPayout = { address: toAddress(d.publicKey), prefix: d.derivationPrefix, suffix: d.derivationSuffix, identityKey };
    } else if (payout && payout.publicKey) {
      if (typeof payout.prefix !== 'string' || typeof payout.suffix !== 'string') throw new Error('Ödeme anahtarı bilgisi eksik.');
      cleanPayout = { address: toAddress(payout.publicKey), prefix: payout.prefix, suffix: payout.suffix };
    } else if (payout) {
      throw new Error('Ödeme için 02/03 ile başlayan kimlik anahtarı gerekli.');
    }
    if (!existing && !cleanPayout) throw new Error('Ödeme anahtarı gerekli.');

    const row = store.save(req.user.identityKey, {
      name: cleanName,
      models: offered,
      pricing: { inputPer1k: Number(p.inputPer1k), outputPer1k: Number(p.outputPer1k), minSats: Number(p.minSats), maxOutputTokens },
      keys: validatedKeys,
      payout: cleanPayout
    });
    req.app.locals.db.prepare('UPDATE users SET is_provider = 1 WHERE identity_key = ?').run(req.user.identityKey);
    onChange(row.id);
    res.json({ success: true, provider: store.view(row) });
  }));

  router.post('/provider/me/enabled', asyncRoute(async (req, res) => {
    const row = store.rowByIdentity(req.user.identityKey);
    if (!row) throw new Error('Önce provider kaydını tamamlayın.');
    store.setEnabled(row.id, !!(req.body && req.body.enabled));
    onChange(row.id);
    res.json({ success: true, provider: store.view(store.rowById(row.id)) });
  }));

  router.delete('/provider/me/keys/:engine', asyncRoute(async (req, res) => {
    const row = store.rowByIdentity(req.user.identityKey);
    if (!row) throw new Error('Provider kaydı yok.');
    store.deleteKey(row.id, req.params.engine);
    onChange(row.id);
    res.json({ success: true, provider: store.view(store.rowById(row.id)) });
  }));

  return router;
}

module.exports = { createProviderAccounts };
