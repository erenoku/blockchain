// Match the requested model exactly; a different AI provider is never a fallback.
function supportsModel(provider, model) {
  if (typeof model !== 'string' || !model.trim()) return false;
  const models = Array.isArray(provider.supportedModels) ? provider.supportedModels : [provider.model];
  return models.some(candidate => typeof candidate === 'string' && candidate.toLowerCase() === model.trim().toLowerCase());
}

function isOpenAIModel(model) {
  return /^(gpt-|chatgpt-|o\d)/i.test(model);
}

module.exports = { supportsModel, isOpenAIModel };
