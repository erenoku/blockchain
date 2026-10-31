/**
 * Pay a provider's identity key (02.../03...) the way BSV Desktop expects:
 * a BRC-29 output derived from the gateway's identity key and the provider's
 * identity key, announced with a PeerPay token in the provider's MessageBox
 * `payment_inbox`. BSV Desktop picks it up from there.
 *
 * MessageBoxClient comes from the browser bundle: the npm package needs a
 * newer @bsv/sdk than the one this project uses.
 */
const crypto = require('crypto');
const { MessageBoxClient } = require('../public/messagebox-bundle');

const BRC29_PROTOCOL = [2, '3241645161d8'];
const MESSAGEBOX_HOSTS = [
  'https://messagebox.bsvblockchain.tech',
  'https://message-box-us-1.bsvb.tech',
  'https://messagebox.babbage.systems'
];

/** A fresh BRC-29 payout key for `recipientIdentityKey`, as a PeerPay sender derives it. */
async function derivePayout(senderWallet, recipientIdentityKey) {
  const derivationPrefix = crypto.randomBytes(12).toString('base64');
  const derivationSuffix = crypto.randomBytes(12).toString('base64');
  const { publicKey } = await senderWallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: recipientIdentityKey
  });
  return { publicKey, derivationPrefix, derivationSuffix };
}

/**
 * Send the PeerPay token. Tries the recipient's advertised MessageBox host first
 * (where their BSV Desktop listens), then the other known hosts.
 * @returns {{ delivered, host, messageId, errors }}
 */
async function deliverPayment({ senderWallet, recipientIdentityKey, derivationPrefix, derivationSuffix, atomicBeef, amount, outputIndex }) {
  const result = { delivered: false, host: null, messageId: null, errors: [] };
  const token = {
    customInstructions: { derivationPrefix, derivationSuffix },
    transaction: atomicBeef,
    amount,
    outputIndex
  };
  const message = { recipient: recipientIdentityKey, messageBox: 'payment_inbox', body: JSON.stringify(token) };

  const attempts = [{ label: 'advertised', host: undefined }, ...MESSAGEBOX_HOSTS.slice(1).map(h => ({ label: h, host: h }))];
  for (const attempt of attempts) {
    try {
      const client = new MessageBoxClient({ host: MESSAGEBOX_HOSTS[0], walletClient: senderWallet, enableLogging: false });
      const host = attempt.host || await client.resolveHostForRecipient(recipientIdentityKey).catch(() => MESSAGEBOX_HOSTS[0]);
      const sent = await client.sendMessage(message, host);
      Object.assign(result, { delivered: true, host, messageId: (sent && sent.messageId) || null });
      return result;
    } catch (err) {
      result.errors.push(`${attempt.label}: ${err.message}`);
    }
  }
  return result;
}

module.exports = { derivePayout, deliverPayment, BRC29_PROTOCOL };
