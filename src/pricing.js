/**
 * Token-based pricing helpers shared by the Gateway and Provider nodes.
 *
 * Prices are expressed in satoshis per 1,000 tokens. A quote charges the exact
 * input token count plus the full output-token cap (maxOutputTokens), because
 * payment happens before inference and the real output length is unknown.
 */
const config = require('./config');

function toPositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Fill in missing / invalid pricing fields with gateway defaults.
 * @param {Object} raw - { inputPer1k, outputPer1k, minSats, maxOutputTokens }
 */
function normalizePricing(raw = {}) {
  return {
    inputPer1k: toPositiveInt(raw.inputPer1k, config.PRICE_PER_1K_INPUT_SATS),
    outputPer1k: toPositiveInt(raw.outputPer1k, config.PRICE_PER_1K_OUTPUT_SATS),
    minSats: toPositiveInt(raw.minSats, config.MIN_PRICE_SATS),
    maxOutputTokens: Math.max(1, toPositiveInt(raw.maxOutputTokens, config.MAX_OUTPUT_TOKENS_LIMIT))
  };
}

/**
 * Clamp the buyer's requested output cap to [1, provider limit].
 */
function clampMaxOutputTokens(requested, pricing) {
  const limit = pricing.maxOutputTokens;
  const n = toPositiveInt(requested, Math.min(config.DEFAULT_MAX_OUTPUT_TOKENS, limit));
  return Math.min(Math.max(1, n), limit);
}

/**
 * Rough token estimate (~4 chars per token) used when the model's token
 * counter is unavailable (no API key, network error) and for provider ranking.
 */
function estimateTokens(text = '') {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function tokensToSats(tokens, per1k) {
  return Math.ceil((tokens * per1k) / 1000);
}

/**
 * Price a request before payment.
 * @returns {{ inputTokens, maxOutputTokens, inputSats, outputSats, totalSats }}
 */
function quote({ inputTokens, maxOutputTokens, pricing }) {
  const p = normalizePricing(pricing);
  const inputSats = tokensToSats(inputTokens, p.inputPer1k);
  const outputSats = tokensToSats(maxOutputTokens, p.outputPer1k);
  return {
    inputTokens,
    maxOutputTokens,
    inputSats,
    outputSats,
    totalSats: Math.max(p.minSats, inputSats + outputSats)
  };
}

/**
 * Price a completed request from the model's usage metadata.
 * Thinking tokens count as output since they consume the maxOutputTokens budget.
 */
function actualCost({ usage, pricing }) {
  const p = normalizePricing(pricing);
  const inputTokens = (usage && usage.promptTokenCount) || 0;
  const outputTokens = ((usage && usage.candidatesTokenCount) || 0) + ((usage && usage.thoughtsTokenCount) || 0);
  const totalSats = Math.max(
    p.minSats,
    tokensToSats(inputTokens, p.inputPer1k) + tokensToSats(outputTokens, p.outputPer1k)
  );
  return { inputTokens, outputTokens, totalSats };
}

module.exports = {
  normalizePricing,
  clampMaxOutputTokens,
  estimateTokens,
  quote,
  actualCost
};
