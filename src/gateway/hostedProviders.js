/**
 * Runtime for providers hosted on the gateway: inference runs here with each
 * provider's own API key, and each provider has its own ChannelBook whose
 * signing key is decrypted from the database.
 *
 * The gateway relays to a hosted provider exactly as it would to a remote node:
 * `handle(id, path, body)` mirrors the node's /channel HTTP routes and returns
 * { status, data }.
 */
const path = require('path');
const ChannelBook = require('../provider/channelBook');
const OpenAIService = require('../provider/openai');
const GeminiService = require('../provider/gemini');
const pricing = require('../pricing');
const { isOpenAIModel } = require('../modelRouting');
const { runChannelQuery, settleChannel } = require('../provider/channelOps');

const MAX_CONCURRENT_QUERIES = 4;
const SETTLE_CHECK_MS = 60 * 1000;

// Upstream failures that mean the provider can't serve anyone until they fix their account
const ACCOUNT_ERRORS = [
  [/401|403|geçersiz|invalid|API key/i, 'API anahtarı reddedildi. Yeni bir anahtar ekleyin.'],
  [/kredisi|quota|insufficient|RESOURCE_EXHAUSTED|billing/i, 'API kotası veya kredisi tükendi.']
];

class HostedProviders {
  /**
   * @param {Object} opts
   * @param {ProviderStore} opts.store
   * @param {ProviderRegistry} opts.registry - hosted providers are listed here next to remote nodes
   * @param {WhatsOnChainClient} opts.explorer
   * @param {string} opts.dataDir - channel state files (no keys) go under dataDir/hosted
   * @param {Function} [opts.onSettled] - (channelId, { settleTxid, settleTx, paidSats }) after a broadcast
   * @param {Function} [opts.recordUsage] - (row) for marketplace stats
   */
  constructor({ store, registry, explorer, dataDir, onSettled = () => {}, recordUsage = () => {}, chunkTokens = 128 }) {
    this.store = store;
    this.registry = registry;
    this.explorer = explorer;
    this.dataDir = dataDir;
    this.onSettled = onSettled;
    this.recordUsage = recordUsage;
    this.chunkTokens = chunkTokens;
    this.runtimes = new Map();
    this.timer = null;
  }

  start() {
    // Load disabled providers too: their open channels must still work and settle
    for (const row of this.store.listAll()) this.reload(row.id);
    this.timer = setInterval(() => this.settleExpiring(), SETTLE_CHECK_MS);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Funding check against the chain; tests replace this. */
  async verifyFunding(utxo, lockingScriptHex) {
    const tx = await this.explorer.getTransaction(utxo.txid);
    const out = tx && tx.vout && tx.vout[utxo.vout];
    if (!out || !out.scriptPubKey) return false;
    return out.scriptPubKey.hex === lockingScriptHex && Math.round(out.value * 1e8) === utxo.satoshis;
  }

  /** (Re)build a provider's runtime after its settings changed. */
  reload(id) {
    const row = this.store.rowById(id);
    const existing = this.runtimes.get(id);
    if (!row) {
      this.runtimes.delete(id);
      this.registry.providers.delete(id);
      return;
    }

    const secrets = this.store.secretsFor(id);
    const providerPricing = pricing.normalizePricing(JSON.parse(row.pricing));
    // Keep the same ChannelBook so open channels and in-flight queries survive a settings change
    const channels = existing ? existing.channels : new ChannelBook({
      channelWif: secrets.channelWif,
      storePath: path.join(this.dataDir, 'hosted', `${id}.json`),
      persistKey: false,
      payoutAddress: row.payout_address,
      pricing: providerPricing,
      chunkTokens: this.chunkTokens,
      verifyFunding: (params, utxo, lockingScriptHex) => this.verifyFunding(utxo, lockingScriptHex)
    });
    channels.pricing = providerPricing;
    channels.payoutAddress = row.payout_address;

    const runtime = {
      id,
      name: row.name,
      models: JSON.parse(row.models),
      keys: secrets.keys,
      pricing: providerPricing,
      channels,
      active: existing ? existing.active : 0
    };
    this.runtimes.set(id, runtime);

    // Disabled providers keep their runtime so open channels can still be used and settled,
    // but they are not offered for new channels
    const available = !!row.enabled && row.status !== 'error';
    this.registry.register({
      id,
      name: row.name,
      model: runtime.models[0],
      supportedModels: runtime.models,
      bsvAddress: row.payout_address,
      identityKey: row.identity_key,
      pricing: providerPricing,
      hosted: true,
      available,
      status: !row.enabled ? 'offline' : row.status,
      endpoint: `hosted:${id}`,
      channelEndpoint: `hosted:${id}`,
      channelPubKey: channels.publicKey
    });
  }

  engineFor(runtime, model) {
    const m = String(model || '').trim();
    if (!runtime.models.includes(m)) throw new Error(`Bu provider ${m || 'bu modeli'} sunmuyor.`);
    const engine = isOpenAIModel(m) ? 'openai' : 'gemini';
    const key = runtime.keys[engine];
    if (!key) throw new Error(`Bu provider'ın ${m} için API anahtarı yok.`);
    if (engine === 'openai') return new OpenAIService(key, m);
    // Exactly the chosen model: never fall back to another Gemini model
    const gemini = new GeminiService(key, m);
    gemini.fallbackModels = [];
    gemini.logPrompts = false;
    return gemini;
  }

  /** Map an upstream failure to a customer-safe message; flag account-level problems. */
  handleUpstreamError(runtime, err) {
    for (const [pattern, reason] of ACCOUNT_ERRORS) {
      if (pattern.test(err.message)) {
        this.store.setStatus(runtime.id, 'error', reason);
        this.reload(runtime.id);
        return new Error('Provider şu an hizmet veremiyor. Başka bir provider seçin.');
      }
    }
    return new Error('Provider cevap üretemedi, tekrar deneyin.');
  }

  async quote(id, { prompt, maxOutputTokens, model }) {
    const runtime = this.runtimes.get(id);
    if (!runtime) return { status: 404, data: { error: 'Provider bulunamadı.' } };
    try {
      const engine = this.engineFor(runtime, model);
      const { inputTokens, source } = await engine.countTokens(prompt);
      const cap = pricing.clampMaxOutputTokens(maxOutputTokens, runtime.pricing);
      return {
        status: 200,
        data: { success: true, model, tokenCountSource: source, pricing: runtime.pricing, ...pricing.quote({ inputTokens, maxOutputTokens: cap, pricing: runtime.pricing }) }
      };
    } catch (err) {
      return { status: 400, data: { error: err.message } };
    }
  }

  async settle(runtime, channelId, closeSig) {
    const settleTxid = await settleChannel({ channels: runtime.channels, explorer: this.explorer, channelId, closeSig });
    const summary = runtime.channels.summary(runtime.channels.get(channelId));
    this.onSettled(channelId, { settleTxid, settleTx: summary.settleTx, paidSats: summary.paidSats, providerId: runtime.id });
    return { ...summary, settleTxid };
  }

  async query(runtime, channelId, body) {
    const engine = this.engineFor(runtime, body.model);
    if (runtime.active >= MAX_CONCURRENT_QUERIES) throw new Error('Provider şu an meşgul, birkaç saniye sonra tekrar deneyin.');
    runtime.active += 1;
    const started = Date.now();
    try {
      const { usage, ...result } = await runChannelQuery({
        channels: runtime.channels, engine, model: body.model, providerPricing: runtime.pricing,
        channelId, prompt: body.prompt, maxOutputTokens: body.maxOutputTokens
      });
      this.recordUsage({ providerId: runtime.id, model: body.model, ok: true, latencyMs: Date.now() - started, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      return result;
    } catch (err) {
      // Channel-side refusals (balance, state) are the customer's to see; upstream errors are not
      if (/balance|Channel|Unknown channel|Prompt/i.test(err.message)) throw err;
      this.recordUsage({ providerId: runtime.id, model: body.model, ok: false, latencyMs: Date.now() - started });
      throw this.handleUpstreamError(runtime, err);
    } finally {
      runtime.active -= 1;
    }
  }

  /**
   * Same contract as a remote node's /channel routes.
   * path: '/proposal' | '/:id' | '/:id/open' | '/:id/query' | '/:id/chunk' | '/:id/close'
   */
  async handle(id, routePath, body) {
    const runtime = this.runtimes.get(id);
    if (!runtime) return { status: 404, data: { error: 'Provider bulunamadı.' } };
    const [, channelId, action] = routePath.split('/');
    try {
      let data;
      if (channelId === 'proposal') {
        const entry = this.registry.providers.get(id);
        if (!entry || !entry.available) throw new Error('Provider şu an yeni kanal kabul etmiyor.');
        data = runtime.channels.proposal(body);
      } else if (!action) {
        data = runtime.channels.summary(runtime.channels.get(channelId));
      } else if (action === 'open') {
        data = await runtime.channels.open(channelId, body);
      } else if (action === 'query') {
        data = await this.query(runtime, channelId, body);
      } else if (action === 'chunk') {
        data = runtime.channels.payChunk(channelId, body);
      } else if (action === 'close') {
        data = await this.settle(runtime, channelId, body.closeSig);
      } else {
        return { status: 404, data: { error: 'Unknown channel action' } };
      }
      return { status: 200, data: { success: true, ...data } };
    } catch (err) {
      return { status: 400, data: { error: err.message } };
    }
  }

  async settleExpiring() {
    for (const runtime of this.runtimes.values()) {
      for (const channel of runtime.channels.expiringSoon()) {
        try {
          await this.settle(runtime, channel.id);
        } catch (err) {
          console.error(`[Hosted] Auto-settle of channel ${channel.id} (${runtime.id}) failed: ${err.message}`);
        }
      }
    }
  }
}

module.exports = HostedProviders;
