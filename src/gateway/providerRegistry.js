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
      priceSats: p.priceSats,
      status: 'online',
      lastSeen: p.lastSeen
    }));
  }

  getBestProvider(model = 'gemini-1.5-pro') {
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

    // Sort by price ascending
    active.sort((a, b) => a.priceSats - b.priceSats);
    return active[0];
  }
}

module.exports = new ProviderRegistry();
