/**
 * BSV AI Swap End-to-End Simulation Script
 * Simulates:
 * 1. Gateway + Provider running
 * 2. Buyer creating an invoice
 * 3. Buyer generating a real BSV keypair & mock on-chain transaction
 * 4. Verification & Gemini Pro execution
 */

const wallet = require('../src/bsv/wallet');
const invoiceManager = require('../src/gateway/invoiceManager');
const providerRegistry = require('../src/gateway/providerRegistry');
const GeminiService = require('../src/provider/gemini');

async function simulate() {
  console.log('--- Simulating BSV AI Swap Full Loop ---');

  // 1. Setup Provider
  const providerWallet = wallet.generateKeypair();
  console.log('Provider BSV Desktop Address:', providerWallet.address);

  const provider = {
    id: 'prov_demo',
    name: 'Gemini Pro Live Node',
    model: 'gemini-1.5-pro',
    bsvAddress: providerWallet.address,
    priceSats: 500,
    endpoint: 'mock'
  };
  providerRegistry.register(provider);

  // 2. Buyer creates invoice
  const prompt = 'What is the utility of BSV microtransactions for AI?';
  const invoice = invoiceManager.createInvoice({ prompt, provider });
  console.log(`Invoice created: ${invoice.id} for ${invoice.amountSats} satoshis`);

  // 3. Buyer pays from BSV Desktop (Simulating TX creation)
  const buyerWallet = wallet.generateKeypair();
  console.log('Buyer BSV Desktop Address:', buyerWallet.address);

  // 4. Verification
  invoiceManager.markPaid(invoice.id, {
    txid: '3f8a42e5b91c8901' + '0'.repeat(48),
    paidSats: 500
  });

  // 5. Provider executes Gemini Pro
  const gemini = new GeminiService(process.env.GEMINI_API_KEY, 'gemini-1.5-pro');
  const result = await gemini.generateAnswer(prompt);
  invoiceManager.markCompleted(invoice.id, result);

  console.log('\n--- AI Response Delivered ---');
  console.log('Model:', result.model);
  console.log('Answer Snippet:\n' + result.answer.slice(0, 200) + '...\n');
  console.log('Invoice Status:', invoiceManager.getInvoice(invoice.id).status);
  console.log('Simulation complete! ✔');
}

simulate().catch(console.error);
