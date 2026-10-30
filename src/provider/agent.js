require('dotenv').config();
const express = require('express');
const GeminiService = require('./gemini');
const wallet = require('../bsv/wallet');

class ProviderAgent {
  constructor(options = {}) {
    this.name = options.name || process.env.PROVIDER_NAME || 'Gemini-Pro-Node-Alpha';
    this.bsvAddress = options.bsvAddress || process.env.PROVIDER_BSV_ADDRESS || '';
    this.priceSats = parseInt(options.priceSats || process.env.PRICE_SATS || '500', 10);
    this.model = options.model || process.env.GEMINI_MODEL || 'gemini-1.5-pro';
    this.geminiApiKey = options.apiKey || process.env.GEMINI_API_KEY || '';
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
    this.app = express();
    this.app.use(express.json({ limit: '10mb' }));
    this.id = `provider_${Math.random().toString(36).substring(2, 9)}`;
    this.server = null;
    this.heartbeatTimer = null;
  }

  async detectBsvDesktopIdentityKey() {
    // Only use explicit PROVIDER_IDENTITY_KEY from .env so we don't accidentally
    // overwrite with the Buyer's own BSV Desktop Identity Key when running on the same laptop.
    return this.identityKey;
  }

  setupRoutes() {
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'online',
        id: this.id,
        name: this.name,
        model: this.model,
        bsvAddress: this.bsvAddress,
        identityKey: this.identityKey,
        payoutIsDemo: !!this.payoutIsDemo,
        priceSats: this.priceSats
      });
    });

    // Execute route triggered by Gateway after payment verification
    this.app.post('/execute', async (req, res) => {
      const { invoiceId, prompt, txid, brc29Remittance } = req.body;

      if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
      }

      console.log(`[Provider] Received paid execution request:`);
      console.log(`  - Invoice ID: ${invoiceId}`);
      console.log(`  - TXID: ${txid}`);
      console.log(`  - Prompt: "${prompt.slice(0, 60)}..."`);

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
              console.log(`[Provider] BSV Desktop internalized +${this.priceSats} sats! Status:`, intData);
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
        const result = await this.gemini.generateAnswer(prompt);
        console.log(`[Provider] Successfully generated Gemini answer for invoice ${invoiceId}`);
        res.json({
          success: true,
          providerId: this.id,
          providerAddress: this.bsvAddress,
          txid,
          ...result
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
        bsvAddress: this.bsvAddress,
        identityKey: this.identityKey,
        payoutIsDemo: !!this.payoutIsDemo,
        priceSats: this.priceSats,
        endpoint: `http://localhost:${this.port}/execute`
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
        console.log(`  - Model: Google Gemini Pro (${this.model})`);
        console.log(`  - Payout BSV Address: ${this.bsvAddress}`);
        console.log(`  - Query Fee: ${this.priceSats} Satoshis`);
        console.log(`  - Listening on: http://localhost:${this.port}`);
        console.log(`======================================================\n`);

        await this.registerWithGateway();

        // Heartbeat every 10 seconds
        this.heartbeatTimer = setInterval(() => {
          this.registerWithGateway();
        }, 10000);

        resolve(this);
      });
    });
  }

  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.server) this.server.close();
  }
}

// If executed directly
if (require.main === module) {
  const agent = new ProviderAgent();
  agent.start();
}

module.exports = ProviderAgent;
