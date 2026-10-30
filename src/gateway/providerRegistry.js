const pricing = require('../pricing');

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
      bsvAddress: p.bsvAddress,
      identityKey: p.identityKey || null,
      pricing: p.pricing,
      supportsChannels: !!p.channelEndpoint,
      status: 'online',
      lastSeen: p.lastSeen
    }));
  }

  /**
   * Pick the cheapest matching provider for this request. Ranking uses a local
   * token estimate; the chosen provider then returns an exact quote.
   */
  getBestProvider(model = 'gemini-1.5-pro', { prompt = '', maxOutputTokens } = {}) {
    const active = Array.from(this.providers.values()).filter(p => {
      if (!p.endpoint) return false;
      if (model && p.model && !p.model.toLowerCase().includes(model.toLowerCase()) && !model.toLowerCase().includes(p.model.toLowerCase())) {
        return false;
      }
      return true;
    });

    if (active.length === 0) {
      // Fallback to any online provider
      const allActive = Array.from(this.providers.values());
      return allActive[0] || null;
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
