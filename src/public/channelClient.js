/**
 * Buyer-side TokenChannel client.
 *
 * Runs in the browser (uses window.bsv from @bsv/sdk's UMD bundle) and in Node
 * (require('@bsv/sdk')) so the exact same signing code is tested against the
 * compiled contract.
 *
 * The buyer computes every sighash itself from the channel parameters. It
 * never signs something the gateway or provider prepared, so a dishonest
 * provider cannot get a signature for more than the buyer agreed to pay.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('@bsv/sdk'));
  } else {
    root.ChannelClient = factory(root.bsv);
  }
})(typeof self !== 'undefined' ? self : this, function (bsv) {
  const SIGHASH_ALL_FORKID = 0x41;
  const SEQUENCE_FINAL = 0xffffffff;
  const MAX_CLOSE_FEE = 50;
  const MAX_TTL_SEC = 3 * 24 * 60 * 60;

  function generateSessionKey() {
    const key = bsv.PrivateKey.fromRandom();
    return { wif: key.toWif(), pubKey: key.toPublicKey().toString() };
  }

  function addressFromPubKey(pubKeyHex, network) {
    return bsv.PublicKey.fromString(pubKeyHex).toAddress(network === 'testnet' ? 'testnet' : 'mainnet');
  }

  /** Outputs of the settlement tx for `providerAmount` (must mirror the contract). */
  function settlementOutputs(channel, providerAmount) {
    const { params, utxo } = channel;
    const refund = utxo.satoshis - providerAmount - params.closeFee;
    if (!Number.isInteger(providerAmount) || providerAmount <= 0) {
      throw new Error('providerAmount must be a positive integer');
    }
    if (refund < 0) throw new Error(`providerAmount ${providerAmount} exceeds channel capacity`);

    const outputs = [{ satoshis: providerAmount, lockingScript: new bsv.P2PKH().lock(params.providerAddress) }];
    if (refund > 0) {
      outputs.push({ satoshis: refund, lockingScript: new bsv.P2PKH().lock(params.buyerAddress) });
    }
    return outputs;
  }

  /** Session signature authorizing the provider to take `providerAmount` from the channel. */
  function signState(channel, providerAmount, sessionWif) {
    const preimage = bsv.TransactionSignature.format({
      sourceTXID: channel.utxo.txid,
      sourceOutputIndex: channel.utxo.vout,
      sourceSatoshis: channel.utxo.satoshis,
      transactionVersion: 1,
      otherInputs: [],
      outputs: settlementOutputs(channel, providerAmount),
      inputIndex: 0,
      subscript: bsv.Script.fromHex(channel.lockingScriptHex),
      inputSequence: SEQUENCE_FINAL,
      lockTime: 0,
      scope: SIGHASH_ALL_FORKID
    });
    const sig = bsv.PrivateKey.fromWif(sessionWif).sign(bsv.Hash.sha256(preimage));
    return bsv.Utils.toHex(new bsv.TransactionSignature(sig.r, sig.s, SIGHASH_ALL_FORKID).toChecksigFormat());
  }

  /**
   * Sanity-check the channel proposal before funding it.
   * The gateway verifies lockingScriptHex == contract(params); here the buyer
   * checks that the params are the ones it asked for.
   */
  function checkProposal(proposal, { sessionPubKey, buyerAddress }) {
    const p = proposal.params || {};
    const now = Math.floor(Date.now() / 1000);
    if (p.sessionPubKey !== sessionPubKey) throw new Error('Proposal has a different session key');
    if (p.buyerAddress !== buyerAddress) throw new Error('Proposal refunds to a different address');
    if (!(p.closeFee >= 1 && p.closeFee <= MAX_CLOSE_FEE)) throw new Error(`Unexpected close fee: ${p.closeFee}`);
    if (!(p.expiry > now && p.expiry <= now + MAX_TTL_SEC)) throw new Error('Unexpected channel expiry');
    if (!/^[0-9a-f]+$/i.test(proposal.lockingScriptHex || '')) throw new Error('Missing contract locking script');
  }

  /** Worst-case price of a query, from the provider's advertised pricing. */
  function maxQuerySats(pricing, inputTokens, maxOutputTokens) {
    const inputSats = Math.ceil((inputTokens * pricing.inputPer1k) / 1000);
    const outputSats = Math.ceil((maxOutputTokens * pricing.outputPer1k) / 1000);
    return Math.max(pricing.minSats, inputSats + outputSats);
  }

  /**
   * Check the provider's terms for the next chunk before signing them.
   * @param {Object} q - { baseSats, capSats, lastStateSats }
   */
  function checkChunkTerms(q, terms) {
    if (!Number.isInteger(terms.stateSats)) throw new Error('Invalid chunk price');
    if (terms.stateSats < q.lastStateSats) throw new Error('Chunk price went down (invalid state)');
    if (terms.stateSats > q.baseSats + q.capSats) {
      throw new Error(`Provider asked ${terms.stateSats - q.baseSats} sats, more than the ${q.capSats} sats query cap`);
    }
  }

  /** Find which output of the funding tx locks the channel contract. */
  function findChannelOutput(fundingBeef, lockingScriptHex) {
    const tx = bsv.Transaction.fromAtomicBEEF(fundingBeef);
    const vout = tx.outputs.findIndex(o => o.lockingScript.toHex() === lockingScriptHex);
    if (vout < 0) throw new Error('Funding transaction has no channel output');
    return { txid: tx.id('hex'), vout, satoshis: tx.outputs[vout].satoshis };
  }

  /**
   * AtomicBEEF of a settlement/refund tx so BSV Desktop can internalize the
   * buyer's refund output (the funding tx's BEEF supplies the ancestry).
   */
  function closingTxBeef(closingTxHex, fundingBeef) {
    const tx = bsv.Transaction.fromHex(closingTxHex);
    tx.inputs[0].sourceTransaction = bsv.Transaction.fromAtomicBEEF(fundingBeef);
    return tx.toAtomicBEEF();
  }

  /** Index of the output paying `buyerAddress` in a closing tx, or -1. */
  function findRefundOutput(closingTxHex, buyerAddress) {
    const expected = new bsv.P2PKH().lock(buyerAddress).toHex();
    return bsv.Transaction.fromHex(closingTxHex).outputs.findIndex(o => o.lockingScript.toHex() === expected);
  }

  return {
    generateSessionKey,
    addressFromPubKey,
    settlementOutputs,
    signState,
    checkProposal,
    maxQuerySats,
    checkChunkTerms,
    findChannelOutput,
    closingTxBeef,
    findRefundOutput
  };
});
