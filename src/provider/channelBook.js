/**
 * Provider-side bookkeeping for TokenChannel payment channels.
 *
 * Flow per channel:
 *   proposal()  -> gateway gets the provider's half of the contract params
 *   open()      -> buyer funded the contract; provider checks the funding output
 *   addQuery()  -> provider generated an answer; it is split into priced chunks
 *   payChunk()  -> buyer sends a session signature for the next chunk's
 *                  cumulative price; provider verifies it and releases the text
 *   settle()    -> provider countersigns the latest state into a broadcastable tx
 *
 * Chunks are paid ahead: the buyer always knows the exact price of the next
 * chunk before signing, and can stop at any point.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pricing = require('../pricing');
const config = require('../config');
const sdk = require('@bsv/sdk');

const BRC29_PROTOCOL = [2, '3241645161d8'];
const IDENTITY_KEY_RE = /^(02|03)[0-9a-f]{64}$/;

let channelLib = null;
function lib() {
  if (!channelLib) {
    try {
      channelLib = require('../../contracts/dist/channel');
    } catch (err) {
      throw new Error(`TokenChannel contract is not built (${err.message}). Run "npm run build:contracts".`);
    }
  }
  return channelLib;
}

const DEFAULT_TTL_SEC = 24 * 60 * 60;
const MIN_TTL_SEC = 10 * 60;

class ChannelBook {
  /**
   * @param {Object} opts
   * @param {string} [opts.channelWif] - provider key that countersigns settlements
   *   (if omitted, the key saved in `storePath` is used, or a new one is created and saved)
   * @param {string} [opts.payoutIdentityKey] - identity key (02/03) that earnings are paid to:
   *   each channel pays a fresh BRC-29 key derived from it, with this book's key as the sender,
   *   so the identity's BSV Desktop can take it in (see payoutNotice). Takes precedence over payoutAddress.
   * @param {string} [opts.storePath] - JSON file that keeps the key, proposals and channels
   *   across restarts. Without it a restart strands funded channels until their refund.
   * @param {string} opts.payoutAddress - where settled sats go
   * @param {Object} opts.pricing - normalized token pricing
   * @param {number} [opts.chunkTokens] - output tokens released per paid chunk
   * @param {Function} [opts.verifyFunding] - async (params, utxo, lockingScriptHex) => boolean
   */
  constructor({ channelWif, storePath, persistKey = true, payoutAddress, payoutIdentityKey, pricing: providerPricing, chunkTokens = 128, verifyFunding }) {
    const { bsv } = lib();
    this.storePath = storePath || null;
    // Hosted providers keep their key encrypted in the database, not in this file
    this.persistKey = persistKey;
    const stored = this.readStore();

    this.privateKey = bsv.PrivateKey.fromWIF(channelWif || stored.channelWif || new bsv.PrivateKey().toWIF());
    this.publicKey = this.privateKey.publicKey.toString();
    this.payoutAddress = payoutAddress;
    this.payoutIdentityKey = payoutIdentityKey ? String(payoutIdentityKey).toLowerCase() : null;
    if (this.payoutIdentityKey && !IDENTITY_KEY_RE.test(this.payoutIdentityKey)) throw new Error('payoutIdentityKey must be a 02/03 identity key');
    // BRC-29 sender for identity payouts: the same key that countersigns settlements
    this.senderKey = sdk.PrivateKey.fromWif(this.privateKey.toWIF());
    this.senderIdentityKey = this.senderKey.toPublicKey().toString();
    this.senderWallet = new sdk.ProtoWallet(this.senderKey);
    this.pricing = providerPricing;
    this.chunkTokens = Math.max(1, chunkTokens);
    this.verifyFunding = verifyFunding || (async () => true);
    this.proposals = new Map(stored.proposals || []);
    this.channels = new Map((stored.channels || []).map(([id, c]) => [id, { ...c, activeQuery: null }]));
    this.persist();
  }

  readStore() {
    if (!this.storePath || !fs.existsSync(this.storePath)) return {};
    return JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
  }

  /** Save key + channel states. Answer chunks (activeQuery) are not kept. */
  persist() {
    if (!this.storePath) return;
    const channels = Array.from(this.channels.entries()).map(([id, c]) => [id, { ...c, activeQuery: null }]);
    const data = JSON.stringify({
      channelWif: this.persistKey ? this.privateKey.toWIF() : undefined,
      proposals: Array.from(this.proposals.entries()),
      channels
    }, null, 2);
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, this.storePath);
  }

  /** Provider's half of the contract parameters for a new channel. */
  proposal({ sessionPubKey, buyerAddress, ttlSec = DEFAULT_TTL_SEC }) {
    if (!/^(02|03)[0-9a-fA-F]{64}$/.test(sessionPubKey || '')) {
      throw new Error('sessionPubKey must be a 33-byte compressed public key (hex)');
    }
    const ttl = Math.max(MIN_TTL_SEC, parseInt(ttlSec, 10) || DEFAULT_TTL_SEC);
    const payout = this.payoutIdentityKey ? this.derivePayout() : null;
    const base = {
      providerPubKey: this.publicKey,
      sessionPubKey: sessionPubKey.toLowerCase(),
      providerAddress: payout ? payout.address : this.payoutAddress,
      buyerAddress,
      expiry: Math.floor(Date.now() / 1000) + ttl
    };
    // The close fee is fixed in the contract for the channel's lifetime, so it must meet miner policy
    const params = { ...base, closeFee: lib().estimateCloseFee(base, config.CHANNEL_FEE_SATS_PER_KB) };
    const channelId = `ch_${crypto.randomBytes(8).toString('hex')}`;
    const lockingScriptHex = lib().channelLockingScript(params);
    const payoutInfo = payout ? { identityKey: payout.identityKey, derivationPrefix: payout.derivationPrefix, derivationSuffix: payout.derivationSuffix, senderIdentityKey: this.senderIdentityKey } : null;
    this.proposals.set(channelId, { params, lockingScriptHex, payout: payoutInfo });
    this.persist();
    return { channelId, params, lockingScriptHex, payout: payoutInfo };
  }

  /** A fresh BRC-29 key for the payout identity, derived exactly as a PeerPay sender would. */
  derivePayout() {
    const derivationPrefix = crypto.randomBytes(12).toString('base64');
    const derivationSuffix = crypto.randomBytes(12).toString('base64');
    const publicKey = new sdk.KeyDeriver(this.senderKey)
      .derivePublicKey(BRC29_PROTOCOL, `${derivationPrefix} ${derivationSuffix}`, this.payoutIdentityKey, false);
    const network = config.BSV_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
    return { identityKey: this.payoutIdentityKey, derivationPrefix, derivationSuffix, address: publicKey.toAddress(network) };
  }

  /** Buyer reports the funding outpoint; provider checks it and opens the channel. */
  async open(channelId, { txid, vout = 0, satoshis, fundingBeefHex }) {
    const proposal = this.proposals.get(channelId);
    if (!proposal) throw new Error('Unknown channel proposal');
    if (!/^[0-9a-fA-F]{64}$/.test(txid || '')) throw new Error('Invalid funding txid');

    const utxo = { txid: txid.toLowerCase(), vout: parseInt(vout, 10), satoshis: parseInt(satoshis, 10) };
    const capacity = utxo.satoshis - proposal.params.closeFee;
    if (!(capacity >= this.pricing.minSats)) {
      throw new Error(`Deposit too small: need at least ${this.pricing.minSats + proposal.params.closeFee} sats`);
    }
    const funded = await this.verifyFunding(proposal.params, utxo, proposal.lockingScriptHex);
    if (!funded) throw new Error('Funding output not found or does not match the channel contract');

    this.proposals.delete(channelId);
    const channel = {
      id: channelId,
      params: proposal.params,
      utxo,
      capacity,
      paidSats: 0,
      latestSig: null,
      status: 'OPEN',
      activeQuery: null,
      settleTxid: null,
      payout: proposal.payout || null,
      payoutDelivery: null,
      // Needed to hand the settlement to the payout identity's wallet as AtomicBEEF
      fundingBeefHex: typeof fundingBeefHex === 'string' && /^[0-9a-f]+$/i.test(fundingBeefHex) ? fundingBeefHex : null
    };
    this.channels.set(channelId, channel);
    this.persist();
    return this.summary(channel);
  }

  get(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error('Unknown channel');
    return channel;
  }

  summary(channel) {
    return {
      channelId: channel.id,
      status: channel.status,
      capacity: channel.capacity,
      paidSats: channel.paidSats,
      remainingSats: channel.capacity - channel.paidSats,
      expiry: channel.params.expiry,
      settleTxid: channel.settleTxid,
      settleTx: channel.settleTx || null,
      payout: channel.payout || null,
      payoutDelivery: channel.payoutDelivery || null
    };
  }

  /**
   * What the payout identity's wallet needs to take in this channel's earnings:
   * the settlement as AtomicBEEF plus the BRC-29 derivation. Null if nothing to deliver.
   */
  payoutNotice(channelId) {
    const channel = this.get(channelId);
    if (!channel.payout || !channel.settleTx) return null;
    if (!channel.fundingBeefHex) throw new Error('Funding transaction data missing; cannot build the payment for the wallet');
    const settle = sdk.Transaction.fromHex(channel.settleTx);
    settle.inputs[0].sourceTransaction = sdk.Transaction.fromAtomicBEEF(sdk.Utils.toArray(channel.fundingBeefHex, 'hex'));
    const outputIndex = 0; // the contract always pays the provider first
    return {
      senderWallet: this.senderWallet,
      recipientIdentityKey: channel.payout.identityKey,
      derivationPrefix: channel.payout.derivationPrefix,
      derivationSuffix: channel.payout.derivationSuffix,
      atomicBeef: settle.toAtomicBEEF(),
      amount: settle.outputs[outputIndex].satoshis,
      outputIndex
    };
  }

  markPayoutDelivery(channelId, result) {
    const channel = this.get(channelId);
    const attempts = ((channel.payoutDelivery && channel.payoutDelivery.attempts) || 0) + 1;
    channel.payoutDelivery = { ...result, attempts, at: Date.now() };
    this.persist();
  }

  /** Settled channels whose payment notice still has to reach the payout identity. */
  undeliveredPayouts(maxAttempts = 30) {
    return Array.from(this.channels.values()).filter(c =>
      c.payout && c.settleTx && !(c.payoutDelivery && c.payoutDelivery.delivered) &&
      ((c.payoutDelivery && c.payoutDelivery.attempts) || 0) < maxAttempts);
  }

  /** Can this channel afford a query with this quote? (worst case: full output cap) */
  assertCanQuery(channelId, quotedSats) {
    const channel = this.get(channelId);
    if (channel.status !== 'OPEN') throw new Error(`Channel is ${channel.status}`);
    if (channel.params.expiry * 1000 <= Date.now()) throw new Error('Channel expired');
    const remaining = channel.capacity - channel.paidSats;
    if (quotedSats > remaining) {
      throw new Error(`Channel balance too low: query may cost up to ${quotedSats} sats, ${remaining} sats left`);
    }
    return channel;
  }

  /**
   * Register a generated answer and split it into priced chunks.
   * Starting a new query abandons any unfinished one (nothing is owed for unpaid chunks).
   */
  addQuery(channelId, { answer, usage }) {
    const channel = this.get(channelId);
    const inputTokens = (usage && usage.promptTokenCount) || 0;
    const answerTokens = (usage && usage.candidatesTokenCount) || pricing.estimateTokens(answer);
    const thoughtTokens = (usage && usage.thoughtsTokenCount) || 0;

    const texts = splitText(answer, Math.max(1, Math.ceil(answerTokens / this.chunkTokens)));
    const perChunk = distribute(answerTokens, texts.length);
    perChunk[0] += thoughtTokens; // thinking happens before the first visible token

    const base = channel.paidSats;
    const inputSats = Math.ceil((inputTokens * this.pricing.inputPer1k) / 1000);
    let outputSoFar = 0;
    const chunks = texts.map((text, index) => {
      outputSoFar += perChunk[index];
      const querySats = Math.max(
        this.pricing.minSats,
        inputSats + Math.ceil((outputSoFar * this.pricing.outputPer1k) / 1000)
      );
      return { index, text, tokens: perChunk[index], stateSats: base + querySats };
    });

    const queryId = `q_${crypto.randomBytes(6).toString('hex')}`;
    channel.activeQuery = { id: queryId, inputTokens, chunks, nextIndex: 0 };
    return {
      queryId,
      inputTokens,
      outputTokens: answerTokens + thoughtTokens,
      totalChunks: chunks.length,
      totalQuerySats: chunks[chunks.length - 1].stateSats - base,
      next: this.nextChunkTerms(channel)
    };
  }

  /** What the buyer must sign to receive the next chunk. */
  nextChunkTerms(channel) {
    const q = channel.activeQuery;
    if (!q || q.nextIndex >= q.chunks.length) return null;
    const c = q.chunks[q.nextIndex];
    return { queryId: q.id, index: c.index, tokens: c.tokens, stateSats: c.stateSats };
  }

  /** Verify the buyer's signature for the next chunk and release its text. */
  payChunk(channelId, { queryId, index, sessionSig }) {
    const channel = this.get(channelId);
    if (channel.status !== 'OPEN') throw new Error(`Channel is ${channel.status}`);
    const q = channel.activeQuery;
    if (!q || q.id !== queryId) throw new Error('Unknown or abandoned query');
    if (index !== q.nextIndex) throw new Error(`Expected payment for chunk ${q.nextIndex}`);

    const chunk = q.chunks[index];
    if (chunk.stateSats > channel.capacity) throw new Error('Chunk exceeds channel capacity');
    if (!lib().verifyState(channel.params, channel.utxo, chunk.stateSats, sessionSig)) {
      throw new Error(`Invalid session signature for ${chunk.stateSats} sats`);
    }

    channel.paidSats = chunk.stateSats;
    channel.latestSig = sessionSig;
    q.nextIndex += 1;
    this.persist();
    return {
      index,
      text: chunk.text,
      paidSats: channel.paidSats,
      done: q.nextIndex >= q.chunks.length,
      next: this.nextChunkTerms(channel)
    };
  }

  /**
   * Countersign the latest state. Returns raw tx hex, or null if nothing was paid.
   * An unused channel can still close right away if the buyer signs a 1-sat
   * state (`closeSig`); otherwise its deposit waits for the refund path.
   */
  settle(channelId, { closeSig } = {}) {
    const channel = this.get(channelId);
    if (channel.status !== 'OPEN') throw new Error(`Channel is ${channel.status}`);
    if (!channel.latestSig && closeSig && lib().verifyState(channel.params, channel.utxo, 1, closeSig)) {
      channel.paidSats = 1;
      channel.latestSig = closeSig;
    }
    if (!channel.latestSig) return null;
    const rawTx = lib().finalizeSettlement(
      channel.params,
      channel.utxo,
      channel.paidSats,
      channel.latestSig,
      this.privateKey.toWIF()
    );
    channel.status = 'SETTLING';
    channel.settleTx = rawTx;
    this.persist();
    return rawTx;
  }

  markSettled(channelId, txid) {
    const channel = this.get(channelId);
    channel.status = 'CLOSED';
    channel.settleTxid = txid;
    channel.activeQuery = null;
    this.persist();
  }

  /** Channels that must be settled before the buyer's refund path opens. */
  expiringSoon(marginSec = 15 * 60) {
    const cutoff = Math.floor(Date.now() / 1000) + marginSec;
    return Array.from(this.channels.values()).filter(c => c.status === 'OPEN' && c.params.expiry <= cutoff);
  }
}

/** Split text into `count` pieces of similar length, preferring whitespace boundaries. */
function splitText(text, count) {
  const pieces = [];
  let rest = String(text || '');
  for (let left = count; left > 1 && rest.length > 0; left--) {
    let cut = Math.ceil(rest.length / left);
    const space = rest.lastIndexOf(' ', cut);
    if (space > cut * 0.5) cut = space + 1;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

/** Split `total` into `parts` integers that differ by at most 1. */
function distribute(total, parts) {
  const base = Math.floor(total / parts);
  return Array.from({ length: parts }, (_, i) => base + (i < total % parts ? 1 : 0));
}

module.exports = ChannelBook;
