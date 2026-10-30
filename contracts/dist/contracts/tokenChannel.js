"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenChannel = void 0;
const scrypt_ts_1 = require("scrypt-ts");
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
class TokenChannel extends scrypt_ts_1.SmartContract {
    constructor(providerKey, sessionKey, providerAddr, buyerAddr, expiry, closeFee) {
        super(...arguments);
        this.providerKey = providerKey;
        this.sessionKey = sessionKey;
        this.providerAddr = providerAddr;
        this.buyerAddr = buyerAddr;
        this.expiry = expiry;
        this.closeFee = closeFee;
    }
    settle(providerAmount, sessionSig, providerSig) {
        (0, scrypt_ts_1.assert)(providerAmount > 0n, 'providerAmount must be positive');
        const refund = this.ctx.utxo.value - providerAmount - this.closeFee;
        (0, scrypt_ts_1.assert)(refund >= 0n, 'providerAmount exceeds channel deposit');
        (0, scrypt_ts_1.assert)(this.checkSig(sessionSig, this.sessionKey), 'invalid session signature');
        (0, scrypt_ts_1.assert)(this.checkSig(providerSig, this.providerKey), 'invalid provider signature');
        let outputs = scrypt_ts_1.Utils.buildPublicKeyHashOutput(this.providerAddr, providerAmount);
        if (refund > 0n) {
            outputs += scrypt_ts_1.Utils.buildPublicKeyHashOutput(this.buyerAddr, refund);
        }
        (0, scrypt_ts_1.assert)(this.ctx.hashOutputs == (0, scrypt_ts_1.hash256)(outputs), 'settle outputs mismatch');
    }
    refund() {
        (0, scrypt_ts_1.assert)(this.timeLock(this.expiry), 'channel has not expired yet');
        const outputs = scrypt_ts_1.Utils.buildPublicKeyHashOutput(this.buyerAddr, this.ctx.utxo.value - this.closeFee);
        (0, scrypt_ts_1.assert)(this.ctx.hashOutputs == (0, scrypt_ts_1.hash256)(outputs), 'refund outputs mismatch');
    }
}
exports.TokenChannel = TokenChannel;
__decorate([
    (0, scrypt_ts_1.prop)()
], TokenChannel.prototype, "providerKey", void 0);
__decorate([
    (0, scrypt_ts_1.prop)()
], TokenChannel.prototype, "sessionKey", void 0);
__decorate([
    (0, scrypt_ts_1.prop)()
], TokenChannel.prototype, "providerAddr", void 0);
__decorate([
    (0, scrypt_ts_1.prop)()
], TokenChannel.prototype, "buyerAddr", void 0);
__decorate([
    (0, scrypt_ts_1.prop)()
], TokenChannel.prototype, "expiry", void 0);
__decorate([
    (0, scrypt_ts_1.prop)()
], TokenChannel.prototype, "closeFee", void 0);
__decorate([
    (0, scrypt_ts_1.method)()
], TokenChannel.prototype, "settle", null);
__decorate([
    (0, scrypt_ts_1.method)()
], TokenChannel.prototype, "refund", null);
