import { PubKey, Addr, Sig, SmartContract } from 'scrypt-ts';
/**
 * One-way payment channel for pay-per-token AI inference.
 *
 * The buyer locks a deposit into this contract once. While tokens stream in,
 * the buyer's browser signs ever-larger settlement transactions with a
 * throwaway session key (off-chain, no wallet prompt). The provider closes
 * the channel by countersigning and broadcasting the latest one.
 *
 * Guarantees enforced on-chain:
 *  - settle: needs both the session key and the provider key, and the only
 *    allowed outputs are `providerAmount` to the provider and the remainder
 *    to the buyer. A leaked session key cannot send funds anywhere else.
 *  - refund: after `expiry` anyone can return the whole deposit (minus the
 *    fixed close fee) to the buyer, so a provider that disappears can't
 *    freeze the funds.
 */
export declare class TokenChannel extends SmartContract {
    readonly providerKey: PubKey;
    readonly sessionKey: PubKey;
    readonly providerAddr: Addr;
    readonly buyerAddr: Addr;
    readonly expiry: bigint;
    readonly closeFee: bigint;
    constructor(providerKey: PubKey, sessionKey: PubKey, providerAddr: Addr, buyerAddr: Addr, expiry: bigint, closeFee: bigint);
    settle(providerAmount: bigint, sessionSig: Sig, providerSig: Sig): void;
    refund(): void;
}
