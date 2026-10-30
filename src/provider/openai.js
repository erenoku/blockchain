/** OpenAI inference. Never substitute another model or a simulated answer. */
const { estimateTokens } = require('../pricing');
const { isOpenAIModel } = require('../modelRouting');
const DEFAULT_SYSTEM_INSTRUCTION = 'You are a helpful AI assistant running on a decentralized BSV micropayment network.';

class OpenAIService {
  constructor(apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL || 'gpt-4o') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async countTokens(prompt, systemInstruction = DEFAULT_SYSTEM_INSTRUCTION) {
    return { inputTokens: estimateTokens(`${systemInstruction || ''}${prompt}`), source: 'estimate' };
  }

  async generateAnswer(prompt, options = {}) {
    if (typeof options === 'string') options = { model: options };
    const { model = this.model, systemInstruction = DEFAULT_SYSTEM_INSTRUCTION, maxOutputTokens = 2048 } = options;
    if (!isOpenAIModel(model)) throw new Error(`Unsupported OpenAI model: ${model}`);
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not configured for ChatGPT.');
    const messages = [];
    if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
    messages.push({ role: 'user', content: prompt });
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model, messages, max_completion_tokens: maxOutputTokens }),
      signal: AbortSignal.timeout(60000)
    });
    const data = await response.json();
    if (!response.ok) {
      const code = data.error?.code;
      if (code === 'insufficient_quota' || code === 'credit_balance_exhausted' || data.error?.type === 'insufficient_quota') {
        throw new Error('OpenAI API kredisi tükenmiş. OpenAI API hesabına kredi ekleyin (429 / insufficient_quota).');
      }
      if (response.status === 401) throw new Error('OpenAI API anahtarı geçersiz (401). OPENAI_API_KEY ayarını kontrol edin.');
      if (response.status === 429) throw new Error('OpenAI istek sınırına ulaşıldı (429). Lütfen daha sonra tekrar deneyin.');
      if (response.status === 404 || code === 'model_not_found') {
        throw new Error('Seçilen OpenAI modeli kullanılamıyor veya hesabınızın bu modele erişimi yok (404). Model seçimini kontrol edin.');
      }
      // Do not expose raw upstream errors, which may contain credentials.
      throw new Error(`OpenAI API request failed (${response.status}).`);
    }
    const answer = data.choices?.[0]?.message?.content;
    if (!answer) throw new Error('OpenAI returned an empty answer.');
    const promptTokens = data.usage?.prompt_tokens ?? estimateTokens(`${systemInstruction}${prompt}`);
    const completionTokens = data.usage?.completion_tokens ?? estimateTokens(answer);
    return {
      success: true,
      model: data.model || model,
      answer,
      usage: {
        ...data.usage,
        promptTokenCount: promptTokens,
        candidatesTokenCount: completionTokens,
        thoughtsTokenCount: 0,
        totalTokenCount: data.usage?.total_tokens ?? (promptTokens + completionTokens)
      }
    };
  }
}
module.exports = OpenAIService;
