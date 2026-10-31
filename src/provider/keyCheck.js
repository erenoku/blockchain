/**
 * Validate a provider's API key by listing the chat models it can use.
 * Error messages never contain the key (Gemini sends it in the URL).
 */
const ENGINES = ['openai', 'gemini'];

// OpenAI lists every model family; keep the ones served by /v1/chat/completions
const OPENAI_CHAT = /^(gpt-|chatgpt-|o\d)/;
const OPENAI_NON_CHAT = /(audio|realtime|transcribe|tts|image|embedding|instruct|search|moderation|dall-e|whisper|codex)/;

async function listOpenAIModels(apiKey) {
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000)
    });
  } catch (_) {
    throw new Error('OpenAI\'a ulaşılamadı. Daha sonra tekrar deneyin.');
  }
  if (res.status === 401) throw new Error('OpenAI API anahtarı geçersiz.');
  if (!res.ok) throw new Error(`OpenAI anahtar kontrolü başarısız (${res.status}).`);
  const data = await res.json();
  return (data.data || [])
    .map(m => m.id)
    .filter(id => OPENAI_CHAT.test(id) && !OPENAI_NON_CHAT.test(id))
    .sort();
}

async function listGeminiModels(apiKey) {
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(15000)
    });
  } catch (_) {
    throw new Error('Gemini API\'ye ulaşılamadı. Daha sonra tekrar deneyin.');
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error('Gemini API anahtarı geçersiz.');
  if (!res.ok) throw new Error(`Gemini anahtar kontrolü başarısız (${res.status}).`);
  const data = await res.json();
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name || '').replace(/^models\//, ''))
    .filter(id => id.startsWith('gemini'))
    .sort();
}

/** @returns {Promise<string[]>} model ids the key can serve */
async function listModels(engine, apiKey) {
  if (!ENGINES.includes(engine)) throw new Error(`Bilinmeyen sağlayıcı: ${engine}`);
  if (typeof apiKey !== 'string' || apiKey.trim().length < 10) throw new Error('API anahtarı eksik.');
  const models = engine === 'openai' ? await listOpenAIModels(apiKey.trim()) : await listGeminiModels(apiKey.trim());
  if (models.length === 0) throw new Error('Bu anahtarla kullanılabilir sohbet modeli bulunamadı.');
  return models;
}

module.exports = { listModels, ENGINES };
