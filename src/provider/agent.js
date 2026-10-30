const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const express = require('express');
const GeminiService = require('./gemini');
const OpenAIService = require('./openai');
const wallet = require('../bsv/wallet');
const pricing = require('../pricing');
const ChannelBook = require('./channelBook');
const WhatsOnChainClient = require('../bsv/explorer');
const { supportsModel, isOpenAIModel } = require('../modelRouting');

class ProviderAgent {
  constructor(options = {}) {
    this.name = options.name || process.env.PROVIDER_NAME || 'Gemini-Pro-Node-Alpha';
    this.bsvAddress = options.bsvAddress || process.env.PROVIDER_BSV_ADDRESS || '';
    this.pricing = pricing.normalizePricing({
      inputPer1k: options.inputPer1k || process.env.PRICE_PER_1K_INPUT_SATS,
      outputPer1k: options.outputPer1k || process.env.PRICE_PER_1K_OUTPUT_SATS,
      minSats: options.minSats || process.env.MIN_PRICE_SATS,
      maxOutputTokens: options.maxOutputTokens || process.env.MAX_OUTPUT_TOKENS_LIMIT
    });
    this.model = options.model || process.env.GEMINI_MODEL || 'gemini-1.5-pro';
    this.geminiApiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? '';
    this.openaiApiKey = options.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.openaiModel = options.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o';
    this.supportedModels = options.supportedModels || [
      'gemini-3.5-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'gemini-1.5-pro',
      'gpt-4o',
      'gpt-4o-mini'
    ];
    this.gatewayUrl = options.gatewayUrl || process.env.GATEWAY_URL || 'http://localhost:3000';
    this.port = parseInt(options.port || process.env.PROVIDER_PORT || '4001', 10);

    this.identityKey = options.identityKey || process.env.PROVIDER_IDENTITY_KEY || null;
    this.bsvAddress = this.bsvAddress.trim();

    // Validate Identity Key: must be a 66-char compressed public key (02/03 + 64 hex chars)
    if (this.identityKey && !/^(02|03)[0-9a-fA-F]{64}$/.test(this.identityKey.trim())) {
      console.error(`[Provider] ERROR: PROVIDER_IDENTITY_KEY is invalid (${this.identityKey.trim().length} chars, expected 66 hex chars starting with 02/03). Ignoring it.`);
      this.identityKey = null;
    }
    // Validate payout value: must be a base58 P2PKH address or a 66-char Identity Key
    if (this.bsvAddress && !/^(02|03)[0-9a-fA-F]{64}$/.test(this.bsvAddress) && !wallet.isValidAddress(this.bsvAddress)) {
      console.error(`[Provider] ERROR: PROVIDER_BSV_ADDRESS "${this.bsvAddress.slice(0, 12)}..." is neither a valid BSV address nor a 66-char Identity Key (${this.bsvAddress.length} chars). Ignoring it.`);
      this.bsvAddress = '';
    }

    // If PROVIDER_BSV_ADDRESS was given as a 66-char BSV Desktop Identity Key (02.../03...), extract both
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(this.bsvAddress)) {
      this.identityKey = this.bsvAddress.trim().toLowerCase();
      try {
        this.bsvAddress = wallet.PublicKey.fromString(this.identityKey).toAddress();
      } catch (_) {}
    } else if (this.identityKey && /^(02|03)[0-9a-fA-F]{64}$/.test(this.identityKey.trim())) {
      this.identityKey = this.identityKey.trim().toLowerCase();
      if (!this.bsvAddress || this.bsvAddress === '1AHWWewBWSpYuhFzscuotwCQvnoZQ5e4xU') {
        try {
          this.bsvAddress = wallet.PublicKey.fromString(this.identityKey).toAddress();
        } catch (_) {}
      }
    }

    // If no address provided, generate a default one for quick demo testing
    if (!this.bsvAddress) {
      console.warn('[Provider] Warning: PROVIDER_BSV_ADDRESS not set. Generating a demo address.');
      const demoWallet = wallet.generateKeypair();
      this.bsvAddress = demoWallet.address;
      this.payoutIsDemo = true;
      console.log(`[Provider] Generated fallback demo address: ${this.bsvAddress}`);
      console.log(`[Provider] (To receive real BSV Desktop satoshis, set PROVIDER_IDENTITY_KEY=<02... or 03...> in .env)`);
    }

    this.gemini = new GeminiService(this.geminiApiKey, this.model);
    this.openai = new OpenAIService(this.openaiApiKey, this.openaiModel);
    this.explorer = new WhatsOnChainClient();
    this.channels = this.createChannelBook(options);
    this.app = express();
    this.app.use(express.json({ limit: '10mb' }));
    this.id = `provider_${Math.random().toString(36).substring(2, 9)}`;
    this.server = null;
    this.heartbeatTimer = null;
  }

  /**
   * TokenChannel payment channels. Disabled if the contract isn't built or the
   * payout address is a throwaway demo address (settled sats would be lost).
   */
  createChannelBook(options) {
    if (this.payoutIsDemo) {
      console.warn('[Provider] Payment channels disabled: payout address is a demo address.');
      return null;
    }
    try {
      // Key, proposals and channels survive restarts, so funded channels can still be opened/settled
      const storePath = options.channelStorePath === undefined
        ? path.join(__dirname, '../../data', `provider-channels-${this.port}.json`)
        : options.channelStorePath;
      return new ChannelBook({
        channelWif: options.channelWif || process.env.PROVIDER_CHANNEL_WIF,
        storePath,
        payoutAddress: this.bsvAddress,
        pricing: this.pricing,
        chunkTokens: parseInt(options.chunkTokens || process.env.CHANNEL_CHUNK_TOKENS || '128', 10),
        verifyFunding: options.verifyFunding || ((params, utxo, lockingScriptHex) => this.verifyChannelFunding(utxo, lockingScriptHex))
      });
    } catch (err) {
      console.warn(`[Provider] Payment channels disabled: ${err.message}`);
      return null;
    }
  }

  async verifyChannelFunding(utxo, lockingScriptHex) {
    const tx = await this.explorer.getTransaction(utxo.txid);
    const out = tx && tx.vout && tx.vout[utxo.vout];
    if (!out || !out.scriptPubKey) return false;
    return out.scriptPubKey.hex === lockingScriptHex && Math.round(out.value * 1e8) === utxo.satoshis;
  }

  selectEngine(requestedModel) {
    const model = (requestedModel || this.model).trim().toLowerCase();
    if (!supportsModel(this, model)) throw new Error(`Unsupported AI model: ${model}`);
    const engine = isOpenAIModel(model) ? this.openai : this.gemini;
    if (engine === this.openai && !engine.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured for ChatGPT.');
    }
    return { model, engine };
  }

  async settleChannel(channelId, opts) {
    const rawTx = this.channels.settle(channelId, opts);
    if (!rawTx) {
      this.channels.markSettled(channelId, null);
      return null;
    }
    const result = await this.explorer.broadcastRawTx(rawTx);
    const txid = typeof result === 'string' ? result : result.txid;
    this.channels.markSettled(channelId, txid);
    console.log(`[Provider] Channel ${channelId} settled on-chain: ${txid}`);
    return txid;
  }

  setupChannelRoutes() {
    const channelRoute = (handler) => async (req, res) => {
      if (!this.channels) {
        return res.status(503).json({ error: 'Payment channels are not enabled on this provider' });
      }
      try {
        res.json({ success: true, ...(await handler(req)) });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    };

    this.app.post('/channel/proposal', channelRoute((req) => this.channels.proposal(req.body)));

    this.app.post('/channel/:id/open', channelRoute((req) => this.channels.open(req.params.id, req.body)));

    this.app.get('/channel/:id', channelRoute((req) => this.channels.summary(this.channels.get(req.params.id))));

    this.app.post('/channel/:id/query', channelRoute(async (req) => {
      const { prompt, maxOutputTokens, model: reqModel } = req.body;
      if (!prompt || typeof prompt !== 'string') throw new Error('Prompt is required');

      const { model, engine } = this.selectEngine(reqModel);

      const { inputTokens } = await engine.countTokens(prompt);
      const cap = pricing.clampMaxOutputTokens(maxOutputTokens, this.pricing);
      const worstCase = pricing.quote({ inputTokens, maxOutputTokens: cap, pricing: this.pricing });
      this.channels.assertCanQuery(req.params.id, worstCase.totalSats);

      const result = await engine.generateAnswer(prompt, { maxOutputTokens: cap, model });
      console.log(`[Provider] Channel ${req.params.id}: generated answer via ${model}, releasing in paid chunks.`);
      return { model: result.model, maxOutputTokens: cap, ...this.channels.addQuery(req.params.id, result) };
    }));

    this.app.post('/channel/:id/chunk', channelRoute((req) => this.channels.payChunk(req.params.id, req.body)));

    this.app.post('/channel/:id/close', channelRoute(async (req) => {
      const txid = await this.settleChannel(req.params.id, { closeSig: req.body.closeSig });
      return { ...this.channels.summary(this.channels.get(req.params.id)), settleTxid: txid };
    }));
  }

  async settleExpiringChannels() {
    if (!this.channels) return;
    for (const channel of this.channels.expiringSoon()) {
      try {
        await this.settleChannel(channel.id);
      } catch (err) {
        console.error(`[Provider] Auto-settle of channel ${channel.id} failed: ${err.message}`);
      }
    }
  }

  async detectBsvDesktopIdentityKey() {
    // Only use explicit PROVIDER_IDENTITY_KEY from .env so we don't accidentally
    // overwrite with the Buyer's own BSV Desktop Identity Key when running on the same laptop.
    return this.identityKey;
  }

  setupRoutes() {
    this.setupChannelRoutes();
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'online',
        id: this.id,
        name: this.name,
        model: this.model,
        supportedModels: this.supportedModels,
        bsvAddress: this.bsvAddress,
        identityKey: this.identityKey,
        payoutIsDemo: !!this.payoutIsDemo,
        pricing: this.pricing
      });
    });

    // Quote route: count input tokens with the model's tokenizer and price the request
    this.app.post('/quote', async (req, res) => {
      const { prompt, maxOutputTokens, model: reqModel } = req.body;
      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Prompt is required' });
      }

      let selected;
      try {
        selected = this.selectEngine(reqModel);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const countProvider = selected.engine;
      const { inputTokens, source } = await countProvider.countTokens(prompt);
      const cap = pricing.clampMaxOutputTokens(maxOutputTokens, this.pricing);
      res.json({
        success: true,
        model: selected.model,
        tokenCountSource: source,
        pricing: this.pricing,
        ...pricing.quote({ inputTokens, maxOutputTokens: cap, pricing: this.pricing })
      });
    });

    // Execute route triggered by Gateway after payment verification
    this.app.post('/execute', async (req, res) => {
      const { invoiceId, prompt, txid, brc29Remittance, maxOutputTokens, model: reqModel } = req.body;

      if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
      }

      let selected;
      try {
        selected = this.selectEngine(reqModel);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const isChatGpt = isOpenAIModel(selected.model);

      console.log(`[Provider] Received paid execution request:`);
      console.log(`  - Invoice ID: ${invoiceId}`);
      console.log(`  - TXID: ${txid}`);
      console.log(`  - AI Engine: ${isChatGpt ? 'OpenAI ChatGPT' : 'Google Gemini'} (${reqModel || this.model})`);
      console.log(`  - Prompt: "${prompt.slice(0, 60)}..."`);
      const outputCap = pricing.clampMaxOutputTokens(maxOutputTokens, this.pricing);
      console.log(`  - Max Output Tokens: ${outputCap}`);

      // If BRC-29 remittance data is included, internalize payment into Provider's BSV Desktop wallet (if running on the recipient machine)
      if (
        brc29Remittance &&
        Array.isArray(brc29Remittance.atomicBeef) &&
        brc29Remittance.derivationPrefix &&
        brc29Remittance.derivationSuffix &&
        brc29Remittance.senderIdentityKey
      ) {
        try {
          const idRes = await fetch('http://127.0.0.1:3321/getPublicKey', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Origin': 'http://localhost:3300'
            },
            body: JSON.stringify({ identityKey: true })
          });
          const idData = await idRes.json().catch(() => ({}));
          const localIdKey = (idData.publicKey || '').toLowerCase();
          const targetRecipientKey = (brc29Remittance.recipientIdentityKey || '').toLowerCase();

          if (!targetRecipientKey || localIdKey === targetRecipientKey) {
            const intRes = await fetch('http://127.0.0.1:3321/internalizeAction', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Origin': 'http://localhost:3300'
              },
              body: JSON.stringify({
                tx: brc29Remittance.atomicBeef,
                outputs: [
                  {
                    outputIndex: brc29Remittance.outputIndex || 0,
                    protocol: 'wallet payment',
                    paymentRemittance: {
                      derivationPrefix: brc29Remittance.derivationPrefix,
                      derivationSuffix: brc29Remittance.derivationSuffix,
                      senderIdentityKey: brc29Remittance.senderIdentityKey
                    }
                  }
                ],
                description: `AI Query Payment (${this.model})`,
                labels: ['brc29', 'ai-swap']
              })
            });
            const intData = await intRes.json().catch(() => ({}));
            if (intRes.ok) {
              console.log(`[Provider] BSV Desktop internalized payment for invoice ${invoiceId}! Status:`, intData);
            } else {
              console.warn(`[Provider] BSV Desktop internalizeAction warning:`, intData);
            }
          } else {
            console.log(`[Provider] Recipient (${targetRecipientKey.slice(0, 14)}...) is on a remote BSV Desktop. Delivered via MessageBox payment_inbox.`);
          }
        } catch (intErr) {
          console.warn(`[Provider] Could not internalize into local BSV Desktop: ${intErr.message}`);
        }
      }

      try {
        const result = await selected.engine.generateAnswer(prompt, { maxOutputTokens: outputCap, model: selected.model });
        const cost = pricing.actualCost({ usage: result.usage, pricing: this.pricing });
        console.log(`[Provider] Successfully generated answer for invoice ${invoiceId} (${cost.inputTokens} in / ${cost.outputTokens} out tokens = ${cost.totalSats} sats)`);
        res.json({
          success: true,
          providerId: this.id,
          providerAddress: this.bsvAddress,
          txid,
          ...result,
          maxOutputTokens: outputCap,
          actualCost: cost
        });
      } catch (err) {
        console.error('[Provider] Execution error:', err.message);
        res.status(500).json({ error: `Inference execution failed: ${err.message}` });
      }
    });
  }

  async registerWithGateway() {
    try {
      await this.detectBsvDesktopIdentityKey();
      const payload = {
        id: this.id,
        name: this.name,
        model: this.model,
        supportedModels: this.supportedModels,
        bsvAddress: this.bsvAddress,
        identityKey: this.identityKey,
        payoutIsDemo: !!this.payoutIsDemo,
        pricing: this.pricing,
        endpoint: `http://localhost:${this.port}/execute`,
        quoteEndpoint: `http://localhost:${this.port}/quote`,
        channelPubKey: this.channels ? this.channels.publicKey : null,
        channelEndpoint: this.channels ? `http://localhost:${this.port}/channel` : null
      };

      const res = await fetch(`${this.gatewayUrl}/api/providers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        console.log(`[Provider] Registered successfully with Gateway at ${this.gatewayUrl}`);
      } else {
        const text = await res.text();
        console.warn(`[Provider] Gateway registration warning: ${text}`);
      }
    } catch (err) {
      console.warn(`[Provider] Could not connect to Gateway at ${this.gatewayUrl} (will retry): ${err.message}`);
    }
  }

  async start() {
    this.setupRoutes();
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, async () => {
        console.log(`\n======================================================`);
        console.log(`  BSV AI Provider Node is RUNNING`);
        console.log(`  - Name: ${this.name}`);
        console.log(`  - Models: ${this.supportedModels.join(', ')}`);
        console.log(`  - Payout BSV Address: ${this.bsvAddress}`);
        console.log(`  - Pricing: ${this.pricing.inputPer1k} sats/1K input, ${this.pricing.outputPer1k} sats/1K output (min ${this.pricing.minSats} sats, max ${this.pricing.maxOutputTokens} output tokens)`);
        console.log(`  - Listening on: http://localhost:${this.port}`);
        console.log(`======================================================\n`);

        await this.registerWithGateway();

        // Heartbeat every 10 seconds
        this.heartbeatTimer = setInterval(() => {
          this.registerWithGateway();
        }, 10000);

        // Settle channels before their refund path opens
        this.settleTimer = setInterval(() => this.settleExpiringChannels(), 60000);
        if (this.settleTimer.unref) this.settleTimer.unref();

        resolve(this);
      });
    });
  }

  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.settleTimer) clearInterval(this.settleTimer);
    if (this.server) this.server.close();
  }
}

// If executed directly
if (require.main === module) {
  const agent = new ProviderAgent();
  agent.start();
}

module.exports = ProviderAgent;
