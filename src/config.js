require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

module.exports = {
  // Network: 'mainnet' or 'testnet'
  BSV_NETWORK: process.env.BSV_NETWORK || 'mainnet',

  // Gateway port
  PORT: parseInt(process.env.PORT || '3300', 10),

  // Platform fee in satoshis (optional, 0 or small cut)
  PLATFORM_FEE_SATS: parseInt(process.env.PLATFORM_FEE_SATS || '0', 10),
  PLATFORM_FEE_ADDRESS: process.env.PLATFORM_FEE_ADDRESS || '',

  // Default token pricing (satoshis per 1K tokens) if a provider doesn't specify its own
  PRICE_PER_1K_INPUT_SATS: parseInt(process.env.PRICE_PER_1K_INPUT_SATS || '100', 10),
  PRICE_PER_1K_OUTPUT_SATS: parseInt(process.env.PRICE_PER_1K_OUTPUT_SATS || '400', 10),

  // Floor price per query in satoshis
  MIN_PRICE_SATS: parseInt(process.env.MIN_PRICE_SATS || '50', 10),

  // Output token cap the buyer pays for up-front (default, and hard upper limit)
  DEFAULT_MAX_OUTPUT_TOKENS: parseInt(process.env.DEFAULT_MAX_OUTPUT_TOKENS || '1024', 10),
  MAX_OUTPUT_TOKENS_LIMIT: parseInt(process.env.MAX_OUTPUT_TOKENS_LIMIT || '8192', 10),

  // WhatsOnChain API endpoints ('main' or 'test')
  WOC_API_BASE: (network) => `https://api.whatsonchain.com/v1/bsv/${network === 'testnet' ? 'test' : 'main'}`,

  // Mark session cookies Secure (set to true when served over HTTPS)
  COOKIE_SECURE: process.env.COOKIE_SECURE === 'true',

  // Behind a TLS-terminating reverse proxy: trust X-Forwarded-* for client IPs
  TRUST_PROXY: process.env.TRUST_PROXY === 'true',

  // Other origins allowed to call the API with cookies (comma-separated). Empty = same origin only.
  CORS_ORIGINS: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),

  // Fee rate for channel settlement/refund transactions. Miners (TAAL, GorillaPool ARC) currently
  // require 100 sats/kB; the close fee is fixed in the contract when the channel opens, so keep a margin.
  CHANNEL_FEE_SATS_PER_KB: parseInt(process.env.CHANNEL_FEE_SATS_PER_KB || '120', 10),

  // ARC endpoint used to broadcast settlements, so a miner's fee/policy rejection is reported
  // (WhatsOnChain's node accepts transactions miners will never mine). Empty disables ARC.
  ARC_URL: process.env.ARC_URL !== undefined ? process.env.ARC_URL : ((process.env.BSV_NETWORK || 'mainnet') === 'testnet' ? '' : 'https://arc.gorillapool.io'),

  // Invoice expiry in milliseconds (10 minutes)
  INVOICE_TTL_MS: 10 * 60 * 1000,
};
