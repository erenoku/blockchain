/**
 * A funding transaction locking `deposit` sats into a channel script, shaped
 * like what BSV Desktop's createAction returns (AtomicBEEF with ancestry).
 * Nothing is broadcast.
 */
const sdk = require('@bsv/sdk');

async function buildFundingBeef(lockingScriptHex, deposit) {
  const buyerKey = sdk.PrivateKey.fromRandom();
  const source = new sdk.Transaction(1, [], [{ satoshis: 100000, lockingScript: new sdk.P2PKH().lock(buyerKey.toAddress()) }], 0);
  source.merklePath = new sdk.MerklePath(900000, [[
    { offset: 0, hash: source.id('hex'), txid: true },
    { offset: 1, duplicate: true }
  ]]);
  const funding = new sdk.Transaction(1, [{
    sourceTransaction: source,
    sourceOutputIndex: 0,
    sequence: 0xffffffff,
    unlockingScriptTemplate: new sdk.P2PKH().unlock(buyerKey)
  }], [
    { satoshis: 50000, lockingScript: new sdk.P2PKH().lock(buyerKey.toAddress()) }, // change first: vout must be detected
    { satoshis: deposit, lockingScript: sdk.Script.fromHex(lockingScriptHex) }
  ], 0);
  await funding.sign();
  return funding.toAtomicBEEF();
}

module.exports = { buildFundingBeef };
