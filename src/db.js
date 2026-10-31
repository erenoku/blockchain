/**
 * SQLite database for the multi-user network (Node's built-in node:sqlite).
 * Schema changes are applied in order and tracked with PRAGMA user_version.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  // 1: accounts, sessions, providers, channels
  `
  CREATE TABLE users (
    identity_key TEXT PRIMARY KEY,
    is_customer INTEGER NOT NULL DEFAULT 0,
    is_provider INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    identity_key TEXT NOT NULL REFERENCES users(identity_key),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_identity ON sessions(identity_key);

  CREATE TABLE auth_challenges (
    nonce TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    identity_key TEXT NOT NULL UNIQUE REFERENCES users(identity_key),
    name TEXT NOT NULL,
    models TEXT NOT NULL,              -- JSON array of model ids offered
    pricing TEXT NOT NULL,             -- JSON { inputPer1k, outputPer1k, minSats, maxOutputTokens }
    channel_wif_enc TEXT NOT NULL,     -- encrypted key that countersigns channel settlements
    payout_address TEXT NOT NULL,      -- BRC-29 address of the provider's own wallet
    payout_prefix TEXT NOT NULL,
    payout_suffix TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'error' (e.g. key revoked, quota exhausted)
    status_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE provider_keys (
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    engine TEXT NOT NULL,              -- 'openai' | 'gemini'
    api_key_enc TEXT NOT NULL,
    last4 TEXT NOT NULL,
    models TEXT NOT NULL,              -- JSON array of models this key can serve
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider_id, engine)
  );

  CREATE TABLE channels (
    channel_id TEXT PRIMARY KEY,
    customer_key TEXT,
    provider_id TEXT,
    data TEXT NOT NULL,                -- JSON channel record
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX channels_customer ON channels(customer_key);
  CREATE INDEX channels_provider ON channels(provider_id);
  `,
  // 2: per-query usage, for marketplace stats
  `
  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    ok INTEGER NOT NULL,
    latency_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX usage_provider_time ON usage(provider_id, created_at);
  `,
  // 3: gateway settings (its own identity key) and identity-key payouts delivered via MessageBox
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  ALTER TABLE providers ADD COLUMN payout_identity_key TEXT;
  `
];

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

module.exports = { openDb };
