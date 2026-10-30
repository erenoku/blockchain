const test = require('node:test')
const assert = require('node:assert')
const { bsv, Sig, SigHashPreimage, toByteString } = require('scrypt-ts')
const ch = require('../dist/channel')

const provider = new bsv.PrivateKey()
const session = new bsv.PrivateKey()
const buyer = new bsv.PrivateKey()
const attacker = new bsv.PrivateKey()

const expiry = 1_800_000_000 // UNIX timestamp
const base = {
    providerPubKey: provider.publicKey.toString(),
    sessionPubKey: session.publicKey.toString(),
    providerAddress: provider.toAddress().toString(),
    buyerAddress: buyer.toAddress().toString(),
    expiry,
}
const closeFee = ch.estimateCloseFee(base, 1)
const params = { ...base, closeFee }
const utxo = { txid: 'ab'.repeat(32), vout: 0, satoshis: 10_000 }

const SIGHASH_ALL_FORKID = 0x41

// Build the unlocking script straight from the compiled script ABI, skipping
// sCrypt's off-chain JS pre-check, so the on-chain script itself is what rejects.
function rawUnlock(tx, method, args) {
    const channel = ch.createChannel(params)
    const preimage = SigHashPreimage(toByteString(tx.getPreimage(0, SIGHASH_ALL_FORKID)))
    const call = channel.delegateInstance[method](...args, preimage)
    tx.inputs[0].setScript(call.unlockingScript)
    return ch.verifySpend(tx.toString(), params, utxo)
}

function forceSettle(tx, providerAmount, sessionSigHex, providerSigHex) {
    return rawUnlock(tx, 'settle', [BigInt(providerAmount), Sig(toByteString(sessionSigHex)), Sig(toByteString(providerSigHex))])
}

function forceRefund(tx) {
    return rawUnlock(tx, 'refund', [])
}

test('close fee is a few sats at 1 sat/kB', () => {
    assert(closeFee >= 1 && closeFee <= 10, `closeFee=${closeFee}`)
})

test('settle: latest state pays provider and refunds buyer', () => {
    const sig = ch.signState(params, utxo, 1234, session.toWIF())
    const raw = ch.finalizeSettlement(params, utxo, 1234, sig, provider.toWIF())
    assert.deepStrictEqual(ch.verifySpend(raw, params, utxo), { success: true, error: '' })

    const tx = new bsv.Transaction(raw)
    assert.strictEqual(tx.outputs.length, 2)
    assert.strictEqual(tx.outputs[0].satoshis, 1234)
    assert.strictEqual(tx.outputs[0].script.toAddress().toString(), params.providerAddress)
    assert.strictEqual(tx.outputs[1].satoshis, 10_000 - 1234 - closeFee)
    assert.strictEqual(tx.outputs[1].script.toAddress().toString(), params.buyerAddress)
})

test('settle: full deposit to provider has a single output', () => {
    const amount = utxo.satoshis - closeFee
    const sig = ch.signState(params, utxo, amount, session.toWIF())
    const raw = ch.finalizeSettlement(params, utxo, amount, sig, provider.toWIF())
    assert(ch.verifySpend(raw, params, utxo).success)
    assert.strictEqual(new bsv.Transaction(raw).outputs.length, 1)
})

test('verifyState: accepts only the exact signed amount and session key', () => {
    const sig = ch.signState(params, utxo, 500, session.toWIF())
    assert.strictEqual(ch.verifyState(params, utxo, 500, sig), true)
    assert.strictEqual(ch.verifyState(params, utxo, 900, sig), false, 'sig for 500 must not authorize 900')
    const wrongKeySig = ch.signState(params, utxo, 500, attacker.toWIF())
    assert.strictEqual(ch.verifyState(params, utxo, 500, wrongKeySig), false)
    assert.strictEqual(ch.verifyState(params, utxo, 999_999, sig), false, 'over capacity')
})

test('attack: provider reuses a 500-sat signature to claim 900 sats', () => {
    const sig500 = ch.signState(params, utxo, 500, session.toWIF())
    const tx = ch.buildSettlementTx(params, utxo, 900)
    const providerSig = ch.signChannelInput(tx, params, utxo, provider.toWIF())
    assert.strictEqual(forceSettle(tx, 900, sig500, providerSig).success, false)
})

test('attack: leaked session key + provider key cannot pay a third address', () => {
    const tx = new bsv.Transaction()
    tx.addInput(
        new bsv.Transaction.Input({ prevTxId: utxo.txid, outputIndex: 0, script: new bsv.Script(''), sequenceNumber: 0xffffffff }),
        ch.createChannel(params).lockingScript,
        utxo.satoshis
    )
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.buildPublicKeyHashOut(attacker.toAddress()), satoshis: 1000 }))
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.buildPublicKeyHashOut(buyer.toAddress()), satoshis: 10_000 - 1000 - closeFee }))
    const s = ch.signChannelInput(tx, params, utxo, session.toWIF())
    const p = ch.signChannelInput(tx, params, utxo, provider.toWIF())
    assert.strictEqual(forceSettle(tx, 1000, s, p).success, false)
})

test('attack: settle without provider signature fails', () => {
    const tx = ch.buildSettlementTx(params, utxo, 700)
    const s = ch.signChannelInput(tx, params, utxo, session.toWIF())
    const fake = ch.signChannelInput(tx, params, utxo, attacker.toWIF())
    assert.strictEqual(forceSettle(tx, 700, s, fake).success, false)
})

test('raw unlock path accepts a valid settlement (sanity check for the attack tests)', () => {
    const tx = ch.buildSettlementTx(params, utxo, 800)
    const s = ch.signChannelInput(tx, params, utxo, session.toWIF())
    const p = ch.signChannelInput(tx, params, utxo, provider.toWIF())
    assert.strictEqual(forceSettle(tx, 800, s, p).success, true)
})

test('attack: claiming more than the deposit fails on-chain', () => {
    const tx = ch.buildSettlementTx(params, utxo, 1000)
    tx.outputs[0].satoshis = utxo.satoshis
    tx.removeOutput(1)
    const s = ch.signChannelInput(tx, params, utxo, session.toWIF())
    const p = ch.signChannelInput(tx, params, utxo, provider.toWIF())
    assert.strictEqual(forceSettle(tx, utxo.satoshis, s, p).success, false)
})

test('buildSettlementTx rejects amounts beyond the deposit', () => {
    assert.throws(() => ch.buildSettlementTx(params, utxo, utxo.satoshis))
    assert.throws(() => ch.buildSettlementTx(params, utxo, 0))
})

test('refund: after expiry the whole deposit returns to the buyer', () => {
    const raw = ch.buildRefundTx(params, utxo)
    assert.deepStrictEqual(ch.verifySpend(raw, params, utxo), { success: true, error: '' })
    const tx = new bsv.Transaction(raw)
    assert.strictEqual(tx.nLockTime, expiry)
    assert.strictEqual(tx.outputs.length, 1)
    assert.strictEqual(tx.outputs[0].satoshis, utxo.satoshis - closeFee)
    assert.strictEqual(tx.outputs[0].script.toAddress().toString(), params.buyerAddress)
})

function refundDraft({ lockTime, sequence, to = buyer, satoshis = utxo.satoshis - closeFee }) {
    const tx = new bsv.Transaction()
    tx.addInput(
        new bsv.Transaction.Input({ prevTxId: utxo.txid, outputIndex: 0, script: new bsv.Script(''), sequenceNumber: sequence }),
        ch.createChannel(params).lockingScript,
        utxo.satoshis
    )
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.buildPublicKeyHashOut(to.toAddress()), satoshis }))
    tx.setLockTime(lockTime)
    return tx
}

test('raw unlock path accepts a valid refund (sanity check)', () => {
    assert.strictEqual(forceRefund(refundDraft({ lockTime: expiry, sequence: 0xfffffffe })).success, true)
})

test('attack: refund before expiry fails', () => {
    assert.strictEqual(forceRefund(refundDraft({ lockTime: expiry - 1, sequence: 0xfffffffe })).success, false)
})

test('attack: refund with final sequence (nLockTime ignored) fails', () => {
    assert.strictEqual(forceRefund(refundDraft({ lockTime: expiry, sequence: 0xffffffff })).success, false)
})

test('attack: refund to another address fails', () => {
    assert.strictEqual(forceRefund(refundDraft({ lockTime: expiry, sequence: 0xfffffffe, to: attacker })).success, false)
})
