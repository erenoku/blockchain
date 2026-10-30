/**
 * Off-chain helpers for the TokenChannel contract.
 *
 * Everything here works on raw hex (transactions, scripts, signatures), so the
 * Gateway / Provider (which use @bsv/sdk) and BSV Desktop can exchange data
 * with these helpers without sharing a BSV library.
 */
import { bsv, PubKey, Addr, Sig, toByteString } from 'scrypt-ts'
import { TokenChannel } from './contracts/tokenChannel'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const artifact = require('../artifacts/contracts/tokenChannel.json')

TokenChannel.loadArtifact(artifact)

const SIGHASH_ALL_FORKID = bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID
const SEQUENCE_FINAL = 0xffffffff
const SEQUENCE_TIMELOCKED = 0xfffffffe

export interface ChannelParams {
    providerPubKey: string   // 33-byte compressed hex
    sessionPubKey: string    // 33-byte compressed hex (buyer's throwaway key)
    providerAddress: string  // base58 P2PKH payout address
    buyerAddress: string     // base58 P2PKH refund address
    expiry: number           // nLockTime: UNIX timestamp (>= 500000000) or block height
    closeFee: number         // satoshis reserved for the closing tx fee
}

export interface ChannelUtxo {
    txid: string
    vout: number
    satoshis: number
}

function addrHex(address: string): Addr {
    return Addr(toByteString(bsv.Address.fromString(address).hashBuffer.toString('hex')))
}

export function createChannel(params: ChannelParams): TokenChannel {
    return new TokenChannel(
        PubKey(toByteString(params.providerPubKey)),
        PubKey(toByteString(params.sessionPubKey)),
        addrHex(params.providerAddress),
        addrHex(params.buyerAddress),
        BigInt(params.expiry),
        BigInt(params.closeFee)
    )
}

/** Locking script to fund (e.g. as a BSV Desktop createAction output). */
export function channelLockingScript(params: ChannelParams): string {
    return createChannel(params).lockingScript.toHex()
}

function channelInput(tx: bsv.Transaction, utxo: ChannelUtxo, lockingScript: bsv.Script, sequence: number) {
    tx.addInput(
        new bsv.Transaction.Input({
            prevTxId: utxo.txid,
            outputIndex: utxo.vout,
            script: new bsv.Script(''),
            sequenceNumber: sequence,
        }),
        lockingScript,
        utxo.satoshis
    )
}

function p2pkhOutput(address: string, satoshis: number) {
    return new bsv.Transaction.Output({
        script: bsv.Script.buildPublicKeyHashOut(bsv.Address.fromString(address)),
        satoshis,
    })
}

/**
 * Unsigned settlement tx paying `providerAmount` to the provider and the rest
 * (minus closeFee) back to the buyer. Both parties sign exactly this tx.
 */
export function buildSettlementTx(params: ChannelParams, utxo: ChannelUtxo, providerAmount: number): bsv.Transaction {
    const refund = utxo.satoshis - providerAmount - params.closeFee
    if (!Number.isInteger(providerAmount) || providerAmount <= 0) {
        throw new Error('providerAmount must be a positive integer')
    }
    if (refund < 0) {
        throw new Error(`providerAmount ${providerAmount} exceeds channel capacity ${utxo.satoshis - params.closeFee}`)
    }

    const tx = new bsv.Transaction()
    channelInput(tx, utxo, createChannel(params).lockingScript, SEQUENCE_FINAL)
    tx.addOutput(p2pkhOutput(params.providerAddress, providerAmount))
    if (refund > 0) {
        tx.addOutput(p2pkhOutput(params.buyerAddress, refund))
    }
    return tx
}

/** Signature (DER + sighash byte, hex) over the channel input of `tx`. */
export function signChannelInput(tx: bsv.Transaction, params: ChannelParams, utxo: ChannelUtxo, privateKeyWif: string): string {
    const sig = bsv.Transaction.Sighash.sign(
        tx,
        bsv.PrivateKey.fromWIF(privateKeyWif),
        SIGHASH_ALL_FORKID,
        0,
        createChannel(params).lockingScript,
        new bsv.crypto.BN(utxo.satoshis)
    )
    return Buffer.concat([sig.toDER(), Buffer.from([SIGHASH_ALL_FORKID])]).toString('hex')
}

/** Check a signature produced by signChannelInput against a public key. */
export function verifyChannelSig(tx: bsv.Transaction, params: ChannelParams, utxo: ChannelUtxo, sigHex: string, pubKeyHex: string): boolean {
    try {
        const sig = bsv.crypto.Signature.fromTxFormat(Buffer.from(sigHex, 'hex'))
        if (sig.nhashtype !== SIGHASH_ALL_FORKID) return false
        return bsv.Transaction.Sighash.verify(
            tx,
            sig as any,
            bsv.PublicKey.fromString(pubKeyHex),
            0,
            createChannel(params).lockingScript,
            new bsv.crypto.BN(utxo.satoshis)
        )
    } catch (_) {
        return false
    }
}

/**
 * Buyer side: sign a new channel state ("provider may take `providerAmount`").
 * Returns the session signature to send to the provider. Nothing is broadcast.
 */
export function signState(params: ChannelParams, utxo: ChannelUtxo, providerAmount: number, sessionWif: string): string {
    const tx = buildSettlementTx(params, utxo, providerAmount)
    return signChannelInput(tx, params, utxo, sessionWif)
}

/** Provider side: is this a valid buyer signature for `providerAmount`? */
export function verifyState(params: ChannelParams, utxo: ChannelUtxo, providerAmount: number, sessionSigHex: string): boolean {
    let tx: bsv.Transaction
    try {
        tx = buildSettlementTx(params, utxo, providerAmount)
    } catch (_) {
        return false
    }
    return verifyChannelSig(tx, params, utxo, sessionSigHex, params.sessionPubKey)
}

/**
 * Provider side: countersign the latest state and produce a broadcastable
 * settlement transaction (raw hex).
 */
export function finalizeSettlement(
    params: ChannelParams,
    utxo: ChannelUtxo,
    providerAmount: number,
    sessionSigHex: string,
    providerWif: string
): string {
    const tx = buildSettlementTx(params, utxo, providerAmount)
    const providerSigHex = signChannelInput(tx, params, utxo, providerWif)
    const channel = createChannel(params)
    const unlockingScript = channel.getUnlockingScript((self) => {
        self.to = { tx, inputIndex: 0 }
        self.settle(BigInt(providerAmount), Sig(toByteString(sessionSigHex)), Sig(toByteString(providerSigHex)))
    })
    tx.inputs[0].setScript(unlockingScript)
    return tx.toString()
}

/**
 * Anyone, after `expiry`: return the full deposit (minus closeFee) to the buyer.
 * Miners only accept it once `expiry` has passed (nLockTime finality rules).
 */
export function buildRefundTx(params: ChannelParams, utxo: ChannelUtxo): string {
    const tx = new bsv.Transaction()
    channelInput(tx, utxo, createChannel(params).lockingScript, SEQUENCE_TIMELOCKED)
    tx.addOutput(p2pkhOutput(params.buyerAddress, utxo.satoshis - params.closeFee))
    tx.setLockTime(params.expiry)

    const channel = createChannel(params)
    const unlockingScript = channel.getUnlockingScript((self) => {
        self.to = { tx, inputIndex: 0 }
        self.refund()
    })
    tx.inputs[0].setScript(unlockingScript)
    return tx.toString()
}

/** Run the channel input's script in the interpreter (for tests / pre-broadcast checks). */
export function verifySpend(rawTxHex: string, params: ChannelParams, utxo: ChannelUtxo): { success: boolean; error: string } {
    const tx = new bsv.Transaction(rawTxHex)
    tx.inputs[0].output = new bsv.Transaction.Output({
        script: createChannel(params).lockingScript,
        satoshis: utxo.satoshis,
    })
    const { success, error } = tx.verifyScript(0)
    return { success, error }
}

/** Fee needed for a closing tx at `satsPerKb`, sized from a real settlement tx. */
export function estimateCloseFee(params: Omit<ChannelParams, 'closeFee'>, satsPerKb = 1): number {
    const dummy = new bsv.PrivateKey()
    const draft: ChannelParams = { ...params, closeFee: 0 }
    const utxo: ChannelUtxo = { txid: '00'.repeat(32), vout: 0, satoshis: 1_000_000 }
    const draftKeys = { ...draft, providerPubKey: dummy.publicKey.toString(), sessionPubKey: dummy.publicKey.toString() }
    const raw = finalizeSettlement(draftKeys, utxo, 1000, signState(draftKeys, utxo, 1000, dummy.toWIF()), dummy.toWIF())
    const sizeBytes = raw.length / 2
    return Math.max(1, Math.ceil((sizeBytes * satsPerKb) / 1000))
}

export { TokenChannel, bsv }
