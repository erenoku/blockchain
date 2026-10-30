const { PrivateKey, PublicKey, P2PKH, Transaction } = require('@bsv/sdk');

class WalletService {
  constructor() {
    this.p2pkh = new P2PKH();
  }

  /**
   * Generate a fresh new BSV keypair
   */
  generateKeypair() {
    const priv = PrivateKey.fromRandom();
    const pub = priv.toPublicKey();
    return {
      wif: priv.toWif(),
      address: pub.toAddress(),
      publicKey: pub.toString()
    };
  }

  /**
   * Derive address and public key from WIF
   */
  fromWif(wif) {
    try {
      const priv = PrivateKey.fromWif(wif.trim());
      const pub = priv.toPublicKey();
      return {
        privateKey: priv,
        wif: priv.toWif(),
        address: pub.toAddress(),
        publicKey: pub.toString()
      };
    } catch (err) {
      throw new Error(`Invalid WIF private key: ${err.message}`);
    }
  }

  /**
   * Validate if a string looks like a standard BSV P2PKH address
   */
  isValidAddress(address) {
    if (!address || typeof address !== 'string') return false;
    // Standard BSV base58check P2PKH: mainnet starts with '1', testnet with 'm' or 'n'
    return /^[1mn][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address.trim());
  }

  /**
   * Build & sign a BSV transaction paying `recipientAddress` with `amountSats`
   * @param {string} wif - Buyer's private key
   * @param {Array<{txid: string, vout: number, satoshis: number, rawTxHex: string}>} utxos
   * @param {string} recipientAddress - Provider payout address
   * @param {number} amountSats - Amount to pay provider
   * @param {string} opReturnText - Optional audit string for OP_RETURN
   * @param {number} feeSats - Mining fee (default 50 sats)
   */
  async buildAndSignPaymentTx({
    wif,
    utxos,
    recipientAddress,
    amountSats,
    opReturnText = null,
    feeSats = 50
  }) {
    if (!utxos || utxos.length === 0) {
      throw new Error('No UTXOs available to fund transaction');
    }

    const wallet = this.fromWif(wif);
    const buyerAddress = wallet.address;

    // Calculate total available sats
    const totalInputSats = utxos.reduce((sum, u) => sum + (u.satoshis || u.value), 0);
    const requiredSats = amountSats + feeSats;

    if (totalInputSats < requiredSats) {
      throw new Error(
        `Insufficient funds. Required: ${requiredSats} sats, Available: ${totalInputSats} sats`
      );
    }

    const changeSats = totalInputSats - amountSats - feeSats;

    // Create Transaction
    const tx = new Transaction(1);

    // Add inputs
    for (const u of utxos) {
      let parentTx;
      if (u.rawTxHex) {
        parentTx = Transaction.fromHex(u.rawTxHex);
      } else {
        // Fallback reconstructed parent TX
        parentTx = new Transaction(1);
        parentTx.addOutput({
          satoshis: u.satoshis || u.value,
          lockingScript: this.p2pkh.lock(buyerAddress)
        });
      }

      tx.addInput({
        sourceTransaction: parentTx,
        sourceOutputIndex: u.vout !== undefined ? u.vout : u.tx_pos,
        unlockingScriptTemplate: this.p2pkh.unlock(wallet.privateKey, 'all', false)
      });
    }

    // Output 0: Provider Payment
    tx.addOutput({
      satoshis: amountSats,
      lockingScript: this.p2pkh.lock(recipientAddress)
    });

    // Output 1: Optional OP_RETURN audit record
    if (opReturnText) {
      // OP_FALSE OP_RETURN <data>
      const dataBytes = Array.from(Buffer.from(opReturnText, 'utf8'));
      const scriptHex = '006a' + (dataBytes.length < 76
        ? dataBytes.length.toString(16).padStart(2, '0')
        : '4c' + dataBytes.length.toString(16).padStart(2, '0')) +
        Buffer.from(dataBytes).toString('hex');

      tx.addOutput({
        satoshis: 0,
        lockingScript: {
          toHex: () => scriptHex
        }
      });
    }

    // Output 2: Change back to Buyer (if above dust threshold ~135 sats)
    if (changeSats >= 135) {
      tx.addOutput({
        satoshis: changeSats,
        lockingScript: this.p2pkh.lock(buyerAddress)
      });
    }

    // Sign the transaction
    await tx.sign();

    return {
      txid: tx.id('hex'),
      rawTxHex: tx.toHex(),
      amountSats,
      changeSats,
      recipientAddress,
      buyerAddress
    };
  }
}

module.exports = new WalletService();
