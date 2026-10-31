"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bsv = exports.TokenChannel = exports.estimateCloseFee = exports.verifySpend = exports.buildRefundTx = exports.finalizeSettlement = exports.verifyState = exports.signState = exports.verifyChannelSig = exports.signChannelInput = exports.buildSettlementTx = exports.channelLockingScript = exports.createChannel = void 0;
/**
 * Off-chain helpers for the TokenChannel contract.
 *
 * Everything here works on raw hex (transactions, scripts, signatures), so the
 * Gateway / Provider (which use @bsv/sdk) and BSV Desktop can exchange data
 * with these helpers without sharing a BSV library.
 */
const scrypt_ts_1 = require("scrypt-ts");
Object.defineProperty(exports, "bsv", { enumerable: true, get: function () { return scrypt_ts_1.bsv; } });
const tokenChannel_1 = require("./contracts/tokenChannel");
Object.defineProperty(exports, "TokenChannel", { enumerable: true, get: function () { return tokenChannel_1.TokenChannel; } });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const artifact = require('../artifacts/contracts/tokenChannel.json');
tokenChannel_1.TokenChannel.loadArtifact(artifact);
const SIGHASH_ALL_FORKID = scrypt_ts_1.bsv.crypto.Signature.SIGHASH_ALL | scrypt_ts_1.bsv.crypto.Signature.SIGHASH_FORKID;
const SEQUENCE_FINAL = 0xffffffff;
const SEQUENCE_TIMELOCKED = 0xfffffffe;
function addrHex(address) {
    return (0, scrypt_ts_1.Addr)((0, scrypt_ts_1.toByteString)(scrypt_ts_1.bsv.Address.fromString(address).hashBuffer.toString('hex')));
}
function createChannel(params) {
    return new tokenChannel_1.TokenChannel((0, scrypt_ts_1.PubKey)((0, scrypt_ts_1.toByteString)(params.providerPubKey)), (0, scrypt_ts_1.PubKey)((0, scrypt_ts_1.toByteString)(params.sessionPubKey)), addrHex(params.providerAddress), addrHex(params.buyerAddress), BigInt(params.expiry), BigInt(params.closeFee));
}
exports.createChannel = createChannel;
/** Locking script to fund (e.g. as a BSV Desktop createAction output). */
function channelLockingScript(params) {
    return createChannel(params).lockingScript.toHex();
}
exports.channelLockingScript = channelLockingScript;
function channelInput(tx, utxo, lockingScript, sequence) {
    tx.addInput(new scrypt_ts_1.bsv.Transaction.Input({
        prevTxId: utxo.txid,
        outputIndex: utxo.vout,
        script: new scrypt_ts_1.bsv.Script(''),
        sequenceNumber: sequence,
    }), lockingScript, utxo.satoshis);
}
function p2pkhOutput(address, satoshis) {
    return new scrypt_ts_1.bsv.Transaction.Output({
        script: scrypt_ts_1.bsv.Script.buildPublicKeyHashOut(scrypt_ts_1.bsv.Address.fromString(address)),
        satoshis,
    });
}
/**
 * Unsigned settlement tx paying `providerAmount` to the provider and the rest
 * (minus closeFee) back to the buyer. Both parties sign exactly this tx.
 */
function buildSettlementTx(params, utxo, providerAmount) {
    const refund = utxo.satoshis - providerAmount - params.closeFee;
    if (!Number.isInteger(providerAmount) || providerAmount <= 0) {
        throw new Error('providerAmount must be a positive integer');
    }
    if (refund < 0) {
        throw new Error(`providerAmount ${providerAmount} exceeds channel capacity ${utxo.satoshis - params.closeFee}`);
    }
    const tx = new scrypt_ts_1.bsv.Transaction();
    channelInput(tx, utxo, createChannel(params).lockingScript, SEQUENCE_FINAL);
    tx.addOutput(p2pkhOutput(params.providerAddress, providerAmount));
    if (refund > 0) {
        tx.addOutput(p2pkhOutput(params.buyerAddress, refund));
    }
    return tx;
}
exports.buildSettlementTx = buildSettlementTx;
/** Signature (DER + sighash byte, hex) over the channel input of `tx`. */
function signChannelInput(tx, params, utxo, privateKeyWif) {
    const sig = scrypt_ts_1.bsv.Transaction.Sighash.sign(tx, scrypt_ts_1.bsv.PrivateKey.fromWIF(privateKeyWif), SIGHASH_ALL_FORKID, 0, createChannel(params).lockingScript, new scrypt_ts_1.bsv.crypto.BN(utxo.satoshis));
    return Buffer.concat([sig.toDER(), Buffer.from([SIGHASH_ALL_FORKID])]).toString('hex');
}
exports.signChannelInput = signChannelInput;
/** Check a signature produced by signChannelInput against a public key. */
function verifyChannelSig(tx, params, utxo, sigHex, pubKeyHex) {
    try {
        const sig = scrypt_ts_1.bsv.crypto.Signature.fromTxFormat(Buffer.from(sigHex, 'hex'));
        if (sig.nhashtype !== SIGHASH_ALL_FORKID)
            return false;
        return scrypt_ts_1.bsv.Transaction.Sighash.verify(tx, sig, scrypt_ts_1.bsv.PublicKey.fromString(pubKeyHex), 0, createChannel(params).lockingScript, new scrypt_ts_1.bsv.crypto.BN(utxo.satoshis));
    }
    catch (_) {
        return false;
    }
}
exports.verifyChannelSig = verifyChannelSig;
/**
 * Buyer side: sign a new channel state ("provider may take `providerAmount`").
 * Returns the session signature to send to the provider. Nothing is broadcast.
 */
function signState(params, utxo, providerAmount, sessionWif) {
    const tx = buildSettlementTx(params, utxo, providerAmount);
    return signChannelInput(tx, params, utxo, sessionWif);
}
exports.signState = signState;
/** Provider side: is this a valid buyer signature for `providerAmount`? */
function verifyState(params, utxo, providerAmount, sessionSigHex) {
    let tx;
    try {
        tx = buildSettlementTx(params, utxo, providerAmount);
    }
    catch (_) {
        return false;
    }
    return verifyChannelSig(tx, params, utxo, sessionSigHex, params.sessionPubKey);
}
exports.verifyState = verifyState;
/**
 * Provider side: countersign the latest state and produce a broadcastable
 * settlement transaction (raw hex).
 */
function finalizeSettlement(params, utxo, providerAmount, sessionSigHex, providerWif) {
    const tx = buildSettlementTx(params, utxo, providerAmount);
    const providerSigHex = signChannelInput(tx, params, utxo, providerWif);
    const channel = createChannel(params);
    const unlockingScript = channel.getUnlockingScript((self) => {
        self.to = { tx, inputIndex: 0 };
        self.settle(BigInt(providerAmount), (0, scrypt_ts_1.Sig)((0, scrypt_ts_1.toByteString)(sessionSigHex)), (0, scrypt_ts_1.Sig)((0, scrypt_ts_1.toByteString)(providerSigHex)));
    });
    tx.inputs[0].setScript(unlockingScript);
    return tx.toString();
}
exports.finalizeSettlement = finalizeSettlement;
/**
 * Anyone, after `expiry`: return the full deposit (minus closeFee) to the buyer.
 * Miners only accept it once `expiry` has passed (nLockTime finality rules).
 */
function buildRefundTx(params, utxo) {
    const tx = new scrypt_ts_1.bsv.Transaction();
    channelInput(tx, utxo, createChannel(params).lockingScript, SEQUENCE_TIMELOCKED);
    tx.addOutput(p2pkhOutput(params.buyerAddress, utxo.satoshis - params.closeFee));
    tx.setLockTime(params.expiry);
    const channel = createChannel(params);
    const unlockingScript = channel.getUnlockingScript((self) => {
        self.to = { tx, inputIndex: 0 };
        self.refund();
    });
    tx.inputs[0].setScript(unlockingScript);
    return tx.toString();
}
exports.buildRefundTx = buildRefundTx;
/** Run the channel input's script in the interpreter (for tests / pre-broadcast checks). */
function verifySpend(rawTxHex, params, utxo) {
    const tx = new scrypt_ts_1.bsv.Transaction(rawTxHex);
    tx.inputs[0].output = new scrypt_ts_1.bsv.Transaction.Output({
        script: createChannel(params).lockingScript,
        satoshis: utxo.satoshis,
    });
    const { success, error } = tx.verifyScript(0);
    return { success, error };
}
exports.verifySpend = verifySpend;
/** Fee needed for a closing tx at `satsPerKb`, sized from a real settlement tx. */
function estimateCloseFee(params, satsPerKb = 1) {
    const dummy = new scrypt_ts_1.bsv.PrivateKey();
    const draft = { ...params, closeFee: 0 };
    const utxo = { txid: '00'.repeat(32), vout: 0, satoshis: 1000000 };
    const draftKeys = { ...draft, providerPubKey: dummy.publicKey.toString(), sessionPubKey: dummy.publicKey.toString() };
    const raw = finalizeSettlement(draftKeys, utxo, 1000, signState(draftKeys, utxo, 1000, dummy.toWIF()), dummy.toWIF());
    const sizeBytes = raw.length / 2;
    return Math.max(1, Math.ceil((sizeBytes * satsPerKb) / 1000));
}
exports.estimateCloseFee = estimateCloseFee;
