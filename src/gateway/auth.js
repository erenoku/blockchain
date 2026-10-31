/**
 * Sign-in with BSV Desktop.
 *
 * 1. POST /api/auth/challenge  -> a single-use nonce
 * 2. The browser asks BSV Desktop to sign the challenge message with
 *    createSignature({ protocolID: LOGIN_PROTOCOL, keyID: nonce, counterparty: 'anyone' })
 * 3. POST /api/auth/verify     -> signature checked against the identity key;
 *    an HttpOnly session cookie is set. Only the token's hash is stored.
 *
 * No passwords: the account *is* the wallet's identity key.
 */
const crypto = require('crypto');
const express = require('express');
const { ProtoWallet } = require('@bsv/sdk');

const LOGIN_PROTOCOL = [2, 'bsv ai swap login'];
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'sid';
const IDENTITY_KEY_RE = /^(02|03)[0-9a-f]{64}$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function challengeMessage(nonce) {
  return `Sign in to BSV AI Swap\nnonce: ${nonce}`;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth({ db, secureCookies = false }) {
  const verifier = new ProtoWallet('anyone');
  const router = express.Router();

  function sessionCookie(token, maxAgeMs) {
    return [
      `${COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
      secureCookies ? 'Secure' : null
    ].filter(Boolean).join('; ');
  }

  function userFromRequest(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const row = db.prepare(`
      SELECT u.identity_key, u.is_customer, u.is_provider
      FROM sessions s JOIN users u ON u.identity_key = s.identity_key
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(sha256(token), Date.now());
    if (!row) return null;
    return { identityKey: row.identity_key, isCustomer: !!row.is_customer, isProvider: !!row.is_provider };
  }

  /** Attach req.user when signed in (never rejects). */
  function optionalAuth(req, res, next) {
    req.user = userFromRequest(req);
    next();
  }

  /** Reject with 401 unless signed in. */
  function requireAuth(req, res, next) {
    req.user = userFromRequest(req);
    if (!req.user) return res.status(401).json({ error: 'Giriş yapmanız gerekiyor.' });
    next();
  }

  router.post('/auth/challenge', (req, res) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO auth_challenges (nonce, expires_at) VALUES (?, ?)').run(nonce, Date.now() + CHALLENGE_TTL_MS);
    res.json({ nonce, message: challengeMessage(nonce), protocolID: LOGIN_PROTOCOL, keyID: nonce });
  });

  router.post('/auth/verify', async (req, res) => {
    const { identityKey, nonce, signature } = req.body || {};
    const key = String(identityKey || '').toLowerCase();
    if (!IDENTITY_KEY_RE.test(key) || typeof nonce !== 'string' || !Array.isArray(signature)) {
      return res.status(400).json({ error: 'identityKey, nonce and signature are required' });
    }
    // Single use: consume the challenge whether or not the signature checks out
    const consumed = db.prepare('DELETE FROM auth_challenges WHERE nonce = ? AND expires_at > ?').run(nonce, Date.now());
    if (consumed.changes !== 1) return res.status(400).json({ error: 'Giriş isteğinin süresi doldu, tekrar deneyin.' });

    let valid = false;
    try {
      ({ valid } = await verifier.verifySignature({
        data: Array.from(Buffer.from(challengeMessage(nonce), 'utf8')),
        signature,
        protocolID: LOGIN_PROTOCOL,
        keyID: nonce,
        counterparty: key
      }));
    } catch (_) {
      valid = false;
    }
    if (!valid) return res.status(401).json({ error: 'İmza doğrulanamadı.' });

    const now = Date.now();
    db.prepare(`
      INSERT INTO users (identity_key, created_at, last_login_at) VALUES (?, ?, ?)
      ON CONFLICT(identity_key) DO UPDATE SET last_login_at = excluded.last_login_at
    `).run(key, now, now);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);

    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, identity_key, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), key, now, now + SESSION_TTL_MS);
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_TTL_MS));
    const user = db.prepare('SELECT is_customer, is_provider FROM users WHERE identity_key = ?').get(key);
    res.json({ success: true, identityKey: key, isCustomer: !!user.is_customer, isProvider: !!user.is_provider });
  });

  router.post('/auth/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    res.json({ success: true });
  });

  router.get('/me', requireAuth, (req, res) => {
    const provider = db.prepare('SELECT id, name, enabled, status FROM providers WHERE identity_key = ?').get(req.user.identityKey);
    res.json({ ...req.user, provider: provider ? { id: provider.id, name: provider.name, enabled: !!provider.enabled, status: provider.status } : null });
  });

  // Choose a role after signing in; a user may be both
  router.post('/me/role', requireAuth, (req, res) => {
    const { role } = req.body || {};
    if (role !== 'customer' && role !== 'provider') return res.status(400).json({ error: "role must be 'customer' or 'provider'" });
    db.prepare(`UPDATE users SET ${role === 'customer' ? 'is_customer' : 'is_provider'} = 1 WHERE identity_key = ?`).run(req.user.identityKey);
    res.json({ success: true, role });
  });

  return { router, requireAuth, optionalAuth, LOGIN_PROTOCOL, challengeMessage };
}

module.exports = { createAuth, LOGIN_PROTOCOL, challengeMessage };
