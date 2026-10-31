/**
 * Off-chain helpers for the TokenChannel contract.
 *
 * Everything here works on raw hex (transactions, scripts, signatures), so the
 * Gateway / Provider (which use @bsv/sdk) and BSV Desktop can exchange data
 * with these helpers without sharing a BSV library.
 */
import { bsv } from 'scrypt-ts';
import { TokenChannel } from './contracts/tokenChannel';
export interface ChannelParams {
    providerPubKey: string;
    sessionPubKey: string;
    providerAddress: string;
    buyerAddress: string;
    expiry: number;
    closeFee: number;
}
export interface ChannelUtxo {
    txid: string;
    vout: number;
    satoshis: number;
}
export declare function createChannel(params: ChannelParams): TokenChannel;
/** Locking script to fund (e.g. as a BSV Desktop createAction output). */
export declare function channelLockingScript(params: ChannelParams): string;
/**
 * Unsigned settlement tx paying `providerAmount` to the provider and the rest
 * (minus closeFee) back to the buyer. Both parties sign exactly this tx.
 */
export declare function buildSettlementTx(params: ChannelParams, utxo: ChannelUtxo, providerAmount: number): bsv.Transaction;
/** Signature (DER + sighash byte, hex) over the channel input of `tx`. */
export declare function signChannelInput(tx: bsv.Transaction, params: ChannelParams, utxo: ChannelUtxo, privateKeyWif: string): string;
/** Check a signature produced by signChannelInput against a public key. */
export declare function verifyChannelSig(tx: bsv.Transaction, params: ChannelParams, utxo: ChannelUtxo, sigHex: string, pubKeyHex: string): boolean;
/**
 * Buyer side: sign a new channel state ("provider may take `providerAmount`").
 * Returns the session signature to send to the provider. Nothing is broadcast.
 */
export declare function signState(params: ChannelParams, utxo: ChannelUtxo, providerAmount: number, sessionWif: string): string;
/** Provider side: is this a valid buyer signature for `providerAmount`? */
export declare function verifyState(params: ChannelParams, utxo: ChannelUtxo, providerAmount: number, sessionSigHex: string): boolean;
/**
 * Provider side: countersign the latest state and produce a broadcastable
 * settlement transaction (raw hex).
 */
export declare function finalizeSettlement(params: ChannelParams, utxo: ChannelUtxo, providerAmount: number, sessionSigHex: string, providerWif: string): string;
/**
 * Anyone, after `expiry`: return the full deposit (minus closeFee) to the buyer.
 * Miners only accept it once `expiry` has passed (nLockTime finality rules).
 */
export declare function buildRefundTx(params: ChannelParams, utxo: ChannelUtxo): string;
/** Run the channel input's script in the interpreter (for tests / pre-broadcast checks). */
export declare function verifySpend(rawTxHex: string, params: ChannelParams, utxo: ChannelUtxo): {
    success: boolean;
    error: string;
};
/** Fee needed for a closing tx at `satsPerKb`, sized from a real settlement tx. */
export declare function estimateCloseFee(params: Omit<ChannelParams, 'closeFee'>, satsPerKb?: number): number;
export { TokenChannel, bsv };
