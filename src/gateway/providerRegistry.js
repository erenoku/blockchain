const pricing = require('../pricing');
const { supportsModel } = require('../modelRouting');

class ProviderRegistry {
  constructor() {
    this.providers = new Map();
    // Periodically remove stale providers (no heartbeat for 30s)
    const timer = setInterval(() => this.cleanup(), 15000);
    if (timer.unref) timer.unref();
  }

  register(provider) {
    const existing = this.providers.get(provider.id);
    const updated = {
      ...existing,
      ...provider,
      lastSeen: Date.now()
    };
    this.providers.set(provider.id, updated);
    return updated;
  }

  cleanup() {
    const now = Date.now();
    for (const [id, provider] of this.providers.entries()) {
      // Hosted providers run inside the gateway and send no heartbeat
      if (provider.hosted) continue;
      if (now - provider.lastSeen > 30000) {
        console.log(`[Registry] Provider ${provider.name} (${id}) timed out. Removing.`);
        this.providers.delete(id);
      }
    }
  }

  list() {
    return Array.from(this.providers.values()).map(p => ({
      id: p.id,
      name: p.name,
      model: p.model,
      supportedModels: p.supportedModels || [p.model],
      bsvAddress: p.bsvAddress,
      identityKey: p.identityKey || null,
      pricing: p.pricing,
      supportsChannels: !!p.channelEndpoint,
      hosted: !!p.hosted,
      available: p.available !== false,
      status: p.status || 'online',
      lastSeen: p.lastSeen
    }));
  }

  /**
   * Pick the cheapest matching provider for this request. Ranking uses a local
   * token estimate; the chosen provider then returns an exact quote.
   */
  getBestProvider(model = 'gemini-1.5-pro', { prompt = '', maxOutputTokens, requireChannels = false, excludeHosted = false } = {}) {
    const active = Array.from(this.providers.values()).filter(p => {
      if (!p.endpoint) return false;
      if (p.available === false) return false;
      // Hosted providers only take channel payments, not the legacy invoice /execute flow
      if (excludeHosted && p.hosted) return false;
      if (requireChannels && !p.channelEndpoint) return false;
      return supportsModel(p, model);
    });

    if (active.length === 0) {
      return null;
    }

    const inputTokens = pricing.estimateTokens(prompt);
    const estimatedSats = (p) => pricing.quote({
      inputTokens,
      maxOutputTokens: pricing.clampMaxOutputTokens(maxOutputTokens, p.pricing),
      pricing: p.pricing
    }).totalSats;

    // Sort by estimated request cost ascending
    active.sort((a, b) => estimatedSats(a) - estimatedSats(b));
    return active[0];
  }
}

module.exports = new ProviderRegistry();
