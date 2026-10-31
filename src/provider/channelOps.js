/**
 * Channel operations shared by self-hosted provider nodes (agent.js) and
 * providers hosted on the gateway (hostedProviders.js).
 */
const pricing = require('../pricing');

/**
 * Generate an answer for a paid channel query and split it into priced chunks.
 * Refuses up front if the channel can't cover the worst case (full output cap).
 */
async function runChannelQuery({ channels, engine, model, providerPricing, channelId, prompt, maxOutputTokens }) {
  if (!prompt || typeof prompt !== 'string') throw new Error('Prompt is required');
  const { inputTokens } = await engine.countTokens(prompt);
  const cap = pricing.clampMaxOutputTokens(maxOutputTokens, providerPricing);
  const worstCase = pricing.quote({ inputTokens, maxOutputTokens: cap, pricing: providerPricing });
  channels.assertCanQuery(channelId, worstCase.totalSats);

  const result = await engine.generateAnswer(prompt, { maxOutputTokens: cap, model });
  return {
    model: result.model,
    maxOutputTokens: cap,
    usage: result.usage || null,
    ...channels.addQuery(channelId, result)
  };
}

/** Countersign the latest state and broadcast it. Returns the txid, or null if nothing was paid. */
async function settleChannel({ channels, explorer, channelId, closeSig }) {
  const rawTx = channels.settle(channelId, { closeSig });
  if (!rawTx) {
    channels.markSettled(channelId, null);
    return null;
  }
  const result = await explorer.broadcastRawTx(rawTx);
  const txid = typeof result === 'string' ? result : result.txid;
  channels.markSettled(channelId, txid);
  return txid;
}

module.exports = { runChannelQuery, settleChannel };
