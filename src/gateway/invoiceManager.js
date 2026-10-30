const crypto = require('crypto');
const config = require('../config');

class InvoiceManager {
  constructor() {
    this.invoices = new Map();
    // Swap history for analytics / ticker on frontend
    this.swapHistory = [];
  }

  /**
   * @param {Object} quote - output of pricing.quote() plus tokenCountSource
   */
  createInvoice({ prompt, provider, quote }) {
    const id = `inv_${crypto.randomBytes(8).toString('hex')}`;
    const amountSats = quote.totalSats;

    // Estimate USD value (rough estimate: 1 BSV ~ $50 -> 1 sat ~ $0.0000005)
    const estimatedUsd = ((amountSats * 50) / 1e8).toFixed(4);

    const invoice = {
      id,
      prompt,
      promptHash: crypto.createHash('sha256').update(prompt).digest('hex'),
      model: provider.model,
      providerId: provider.id,
      providerName: provider.name,
      providerAddress: provider.bsvAddress,
      providerIdentityKey: provider.identityKey || null,
      derivationPrefix: crypto.randomBytes(12).toString('base64'),
      derivationSuffix: crypto.randomBytes(12).toString('base64'),
      senderIdentityKey: null,
      amountSats,
      estimatedUsd,
      pricing: provider.pricing,
      inputTokens: quote.inputTokens,
      maxOutputTokens: quote.maxOutputTokens,
      inputSats: quote.inputSats,
      outputSats: quote.outputSats,
      tokenCountSource: quote.tokenCountSource || 'estimate',
      usage: null,
      actualCost: null,
      status: 'PENDING_PAYMENT', // PENDING_PAYMENT -> PAID -> COMPLETED -> EXPIRED
      createdAt: Date.now(),
      expiresAt: Date.now() + config.INVOICE_TTL_MS,
      txid: null,
      answer: null
    };

    this.invoices.set(id, invoice);
    return invoice;
  }

  getInvoice(id) {
    const inv = this.invoices.get(id);
    if (!inv) return null;
    if (inv.status === 'PENDING_PAYMENT' && Date.now() > inv.expiresAt) {
      inv.status = 'EXPIRED';
    }
    return inv;
  }

  markPaid(id, txData) {
    const inv = this.invoices.get(id);
    if (!inv) throw new Error('Invoice not found');
    inv.status = 'PAID';
    inv.txid = txData.txid;
    inv.paidSats = txData.paidSats;
    inv.paidAt = Date.now();
    return inv;
  }

  markCompleted(id, result) {
    const inv = this.invoices.get(id);
    if (!inv) throw new Error('Invoice not found');
    inv.status = 'COMPLETED';
    inv.answer = result.answer;
    inv.usage = result.usage || null;
    inv.actualCost = result.actualCost || null;
    inv.completedAt = Date.now();

    // Record into public swap history
    this.swapHistory.unshift({
      id: inv.id,
      model: inv.model,
      sats: inv.amountSats,
      inputTokens: inv.actualCost ? inv.actualCost.inputTokens : inv.inputTokens,
      outputTokens: inv.actualCost ? inv.actualCost.outputTokens : null,
      txid: inv.txid,
      providerAddress: inv.providerAddress,
      timestamp: inv.completedAt
    });

    if (this.swapHistory.length > 50) {
      this.swapHistory.pop();
    }

    return inv;
  }

  getHistory() {
    return this.swapHistory;
  }
}

module.exports = new InvoiceManager();
