const assert = require('assert');
const wallet = require('../src/bsv/wallet');
const providerRegistry = require('../src/gateway/providerRegistry');
const invoiceManager = require('../src/gateway/invoiceManager');
const GeminiService = require('../src/provider/gemini');
const PaymentVerifier = require('../src/bsv/verifier');

async function runTests() {
  console.log('==================================================');
  console.log('   Running BSV AI Pool Test Suite');
  console.log('==================================================\n');

  // Test 1: Key & Address Generation
  console.log('Test 1: Wallet Key Generation & Address Validation');
  const keypair = wallet.generateKeypair();
  assert(keypair.wif, 'WIF should be generated');
  assert(keypair.address, 'Address should be generated');
  assert(wallet.isValidAddress(keypair.address), `Generated address ${keypair.address} should be valid`);
  console.log(`  ✔ Generated Address: ${keypair.address}`);

  const restored = wallet.fromWif(keypair.wif);
  assert.strictEqual(restored.address, keypair.address, 'Restored address must match generated address');
  console.log('  ✔ WIF import and address derivation verified.');

  // Test 2: Provider Registry & Matching
  console.log('\nTest 2: Provider Node Registration & Matching');
  providerRegistry.register({
    id: 'test_node_1',
    name: 'Gemini Pro Node 1',
    model: 'gemini-1.5-pro',
    bsvAddress: keypair.address,
    priceSats: 500,
    endpoint: 'http://localhost:4001/execute'
  });

  const providers = providerRegistry.list();
  assert.strictEqual(providers.length, 1, 'Should have 1 registered provider');
  console.log(`  ✔ Registered provider: ${providers[0].name} (${providers[0].model})`);

  const matched = providerRegistry.getBestProvider('gemini-1.5-pro');
  assert(matched, 'Should match provider for gemini-1.5-pro');
  assert.strictEqual(matched.id, 'test_node_1');
  console.log('  ✔ Matched best provider successfully.');

  // Test 3: Invoice Creation & Invalidation
  console.log('\nTest 3: Invoice Creation & Management');
  const invoice = invoiceManager.createInvoice({
    prompt: 'What is Bitcoin SV?',
    provider: matched
  });
  assert(invoice.id.startsWith('inv_'), 'Invoice ID should start with inv_');
  assert.strictEqual(invoice.amountSats, 500, 'Amount should be 500 sats');
  assert.strictEqual(invoice.status, 'PENDING_PAYMENT');
  console.log(`  ✔ Created invoice ${invoice.id} for ${invoice.amountSats} satoshis.`);

  // Test 4: Replay Attack Protection in Verifier
  console.log('\nTest 4: Payment Verifier Replay Prevention');
  const verifier = new PaymentVerifier('mainnet');
  verifier.claimedTxids.add('a'.repeat(64));
  const replayResult = await verifier.verifyPayment(invoice, 'a'.repeat(64));
  assert.strictEqual(replayResult.valid, false, 'Should reject already claimed TXID');
  console.log('  ✔ Replay attack successfully blocked.');

  // Test 5: Gemini Pro Service
  console.log('\nTest 5: Gemini Pro Service Call');
  const gemini = new GeminiService(process.env.TEST_LIVE_GEMINI ? process.env.GEMINI_API_KEY : null, 'gemini-1.5-pro');
  const answerResult = await gemini.generateAnswer('Hello Gemini!');
  assert(answerResult.answer, 'Answer must not be empty');
  console.log(`  ✔ Gemini Model: ${answerResult.model}`);
  console.log(`  ✔ Response snippet: "${answerResult.answer.slice(0, 80).replace(/\n/g, ' ')}..."`);

  console.log('\n==================================================');
  console.log('   All 5 Core Tests Passed Successfully! ✔');
  console.log('==================================================\n');
}

runTests().catch(err => {
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
