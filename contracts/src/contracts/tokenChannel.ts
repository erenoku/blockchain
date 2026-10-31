import {
    assert,
    ByteString,
    hash256,
    method,
    prop,
    PubKey,
    Addr,
    Sig,
    SmartContract,
    Utils,
} from 'scrypt-ts'

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
export class TokenChannel extends SmartContract {
    @prop()
    readonly providerKey: PubKey

    @prop()
    readonly sessionKey: PubKey

    @prop()
    readonly providerAddr: Addr

    @prop()
    readonly buyerAddr: Addr

    // nLockTime after which `refund` becomes spendable (UNIX timestamp or block height)
    @prop()
    readonly expiry: bigint

    // Miner fee reserved for the closing transaction, in satoshis
    @prop()
    readonly closeFee: bigint

    constructor(
        providerKey: PubKey,
        sessionKey: PubKey,
        providerAddr: Addr,
        buyerAddr: Addr,
        expiry: bigint,
        closeFee: bigint
    ) {
        super(...arguments)
        this.providerKey = providerKey
        this.sessionKey = sessionKey
        this.providerAddr = providerAddr
        this.buyerAddr = buyerAddr
        this.expiry = expiry
        this.closeFee = closeFee
    }

    @method()
    public settle(providerAmount: bigint, sessionSig: Sig, providerSig: Sig) {
        assert(providerAmount > 0n, 'providerAmount must be positive')
        const refund: bigint = this.ctx.utxo.value - providerAmount - this.closeFee
        assert(refund >= 0n, 'providerAmount exceeds channel deposit')

        assert(this.checkSig(sessionSig, this.sessionKey), 'invalid session signature')
        assert(this.checkSig(providerSig, this.providerKey), 'invalid provider signature')

        let outputs: ByteString = Utils.buildPublicKeyHashOutput(this.providerAddr, providerAmount)
        if (refund > 0n) {
            outputs += Utils.buildPublicKeyHashOutput(this.buyerAddr, refund)
        }
        assert(this.ctx.hashOutputs == hash256(outputs), 'settle outputs mismatch')
    }

    @method()
    public refund() {
        assert(this.timeLock(this.expiry), 'channel has not expired yet')
        const outputs: ByteString = Utils.buildPublicKeyHashOutput(
            this.buyerAddr,
            this.ctx.utxo.value - this.closeFee
        )
        assert(this.ctx.hashOutputs == hash256(outputs), 'refund outputs mismatch')
    }
}
