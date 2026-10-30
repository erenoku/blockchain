/**
 * Google Gemini Pro / Flash Inference Handler
 */
const { estimateTokens } = require('../pricing');

const DEFAULT_SYSTEM_INSTRUCTION = 'You are a helpful AI assistant running on a decentralized BSV micropayment network.';

class GeminiService {
  constructor(apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || 'gemini-3.5-flash') {
    this.apiKey = apiKey;
    this.model = model;
    // Supported fallback waterfall
    this.fallbackModels = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.7-flash', 'gemini-3.8-flash'];
  }

  /**
   * Count input tokens (prompt + system instruction) exactly as Gemini will bill them.
   * Falls back to a ~4 chars/token estimate if the API is unavailable.
   * @returns {Promise<{ inputTokens: number, source: 'gemini' | 'estimate' }>}
   */
  async countTokens(prompt, systemInstruction = DEFAULT_SYSTEM_INSTRUCTION) {
    const estimate = { inputTokens: estimateTokens(`${systemInstruction || ''}${prompt}`), source: 'estimate' };
    if (!this.apiKey) return estimate;

    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:countTokens?key=${this.apiKey}`;
      const generateContentRequest = {
        model: `models/${this.model}`,
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      };
      if (systemInstruction) {
        generateContentRequest.systemInstruction = { parts: [{ text: systemInstruction }] };
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generateContentRequest })
      });
      if (!response.ok) {
        console.warn(`[Gemini] countTokens failed [${response.status}], using estimate.`);
        return estimate;
      }
      const data = await response.json();
      return Number.isFinite(data.totalTokens)
        ? { inputTokens: data.totalTokens, source: 'gemini' }
        : estimate;
    } catch (err) {
      console.warn(`[Gemini] countTokens error: ${err.message}, using estimate.`);
      return estimate;
    }
  }

  /**
   * Execute real Gemini inference
   * @param {string} prompt - The user's AI prompt
   * @param {Object} options
   * @param {string} options.systemInstruction - Optional system prompt
   * @param {number} options.maxOutputTokens - Output token cap the buyer paid for
   */
  async generateAnswer(prompt, { systemInstruction = DEFAULT_SYSTEM_INSTRUCTION, maxOutputTokens = 2048 } = {}) {
    if (!this.apiKey) {
      console.warn('[Gemini] GEMINI_API_KEY not set. Using simulated Gemini demo response.');
      return this._mockResponse(prompt, systemInstruction);
    }

    // Try current model first, then fallbacks
    const modelsToTry = [this.model, ...this.fallbackModels.filter(m => m !== this.model)];

    let lastError = null;
    for (const modelName of modelsToTry) {
      try {
        console.log(`[Gemini] Calling ${modelName} for prompt: "${prompt.slice(0, 50)}..."`);
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${this.apiKey}`;

        const requestBody = {
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens,
          }
        };

        if (systemInstruction) {
          requestBody.systemInstruction = {
            parts: [{ text: systemInstruction }]
          };
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.warn(`[Gemini] Model ${modelName} failed [${response.status}]: ${errorText.slice(0, 100)}...`);
          lastError = new Error(`Gemini API error [${response.status}]: ${errorText}`);
          continue; // Try next fallback model
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
          continue;
        }

        console.log(`[Gemini] Successfully received response from ${modelName}!`);
        return {
          success: true,
          model: modelName,
          answer: text,
          usage: data.usageMetadata || null
        };
      } catch (err) {
        lastError = err;
        console.warn(`[Gemini] Error with ${modelName}: ${err.message}`);
      }
    }

    // If all models failed or network error
    throw lastError || new Error('All Gemini models failed to generate content.');
  }

  _mockResponse(prompt, systemInstruction = DEFAULT_SYSTEM_INSTRUCTION) {
    const answer = `[Gemini Verified Answer]\n\nYou asked: "${prompt}"\n\nPayment in BSV Satoshis was successfully verified on-chain. This query was executed via the BSV AI Provider Node. Connect a valid GEMINI_API_KEY to stream live responses directly from Google's Gemini servers.`;
    const promptTokenCount = estimateTokens(`${systemInstruction || ''}${prompt}`);
    const candidatesTokenCount = estimateTokens(answer);
    return {
      success: true,
      model: `${this.model} (Demo Simulation - Set GEMINI_API_KEY in .env for live API)`,
      answer,
      usage: { promptTokenCount, candidatesTokenCount, totalTokenCount: promptTokenCount + candidatesTokenCount }
    };
  }
}

module.exports = GeminiService;
