/**
 * Encryption for secrets stored in the database (provider API keys, channel keys).
 *
 * AES-256-GCM with a 32-byte master key from MASTER_KEY (hex or base64). In
 * development, if MASTER_KEY is unset, a key is generated once and kept in
 * data/master.key. In production set MASTER_KEY (ideally from a secrets
 * manager) and never store it next to the database backup.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = 'v1';

function parseKey(value) {
  const raw = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (raw.length !== 32) throw new Error('MASTER_KEY must be 32 bytes (64 hex chars or base64)');
  return raw;
}

function loadMasterKey({ envValue = process.env.MASTER_KEY, devKeyPath } = {}) {
  if (envValue) return parseKey(envValue.trim());
  if (!devKeyPath) throw new Error('MASTER_KEY is not set');
  if (!fs.existsSync(devKeyPath)) {
    fs.mkdirSync(path.dirname(devKeyPath), { recursive: true });
    fs.writeFileSync(devKeyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    console.warn(`[Secrets] MASTER_KEY not set; generated a development key at ${devKeyPath}. Set MASTER_KEY in production.`);
  }
  return parseKey(fs.readFileSync(devKeyPath, 'utf8').trim());
}

class SecretBox {
  constructor(masterKey) {
    this.key = masterKey;
  }

  encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
  }

  decrypt(sealed) {
    const [version, iv, tag, ct] = String(sealed).split(':');
    if (version !== VERSION) throw new Error('Unknown secret format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  }
}

module.exports = { SecretBox, loadMasterKey };
