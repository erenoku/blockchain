require('dotenv').config();

module.exports = {
  // Network: 'mainnet' or 'testnet'
  BSV_NETWORK: process.env.BSV_NETWORK || 'mainnet',

  // Gateway port
  PORT: parseInt(process.env.PORT || '3300', 10),

  // Platform fee in satoshis (optional, 0 or small cut)
  PLATFORM_FEE_SATS: parseInt(process.env.PLATFORM_FEE_SATS || '0', 10),
  PLATFORM_FEE_ADDRESS: process.env.PLATFORM_FEE_ADDRESS || '',

  // Default provider price in satoshis if not specified
  DEFAULT_PRICE_SATS: parseInt(process.env.DEFAULT_PRICE_SATS || '500', 10),

  // WhatsOnChain API endpoints ('main' or 'test')
  WOC_API_BASE: (network) => `https://api.whatsonchain.com/v1/bsv/${network === 'testnet' ? 'test' : 'main'}`,

  // Invoice expiry in milliseconds (10 minutes)
  INVOICE_TTL_MS: 10 * 60 * 1000,
};
