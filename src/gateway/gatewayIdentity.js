/**
 * The gateway's own identity key. It is the "sender" of BRC-29 payouts to
 * providers' identity keys: payout addresses are derived from it, and the
 * PeerPay message that tells a provider's BSV Desktop about a payment is
 * signed with it. Stored encrypted in the settings table.
 */
const { PrivateKey, ProtoWallet } = require('@bsv/sdk');

const SETTING = 'gateway_identity_wif';

function loadGatewayIdentity(db, secrets) {
  let row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING);
  if (!row) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(SETTING, secrets.encrypt(PrivateKey.fromRandom().toWif()));
    row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING);
  }
  const privateKey = PrivateKey.fromWif(secrets.decrypt(row.value));
  return {
    privateKey,
    publicKey: privateKey.toPublicKey().toString(),
    wallet: new ProtoWallet(privateKey)
  };
}

module.exports = { loadGatewayIdentity };
