const assert = require('assert');
const wallet = require('../src/bsv/wallet');
const providerRegistry = require('../src/gateway/providerRegistry');
const invoiceManager = require('../src/gateway/invoiceManager');
const GeminiService = require('../src/provider/gemini');
const PaymentVerifier = require('../src/bsv/verifier');
const pricing = require('../src/pricing');
const ChannelBook = require('../src/provider/channelBook');
let channelLib = null;
try {
  channelLib = require('../contracts/dist/channel');
} catch (_) {
  // contracts not built or scrypt-ts not installed
}
const OpenAIService = require('../src/provider/openai');

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
  const testPricing = pricing.normalizePricing({ inputPer1k: 100, outputPer1k: 400, minSats: 50, maxOutputTokens: 4096 });
  providerRegistry.register({
    id: 'test_node_1',
    name: 'Gemini Pro Node 1',
    model: 'gemini-1.5-pro',
    bsvAddress: keypair.address,
    pricing: testPricing,
    endpoint: 'http://localhost:4001/execute'
  });
  providerRegistry.register({
    id: 'test_node_2',
    name: 'Gemini Pro Node 2 (expensive)',
    model: 'gemini-1.5-pro',
    bsvAddress: keypair.address,
    pricing: pricing.normalizePricing({ inputPer1k: 200, outputPer1k: 800 }),
    endpoint: 'http://localhost:4002/execute'
  });

  const providers = providerRegistry.list();
  assert.strictEqual(providers.length, 2, 'Should have 2 registered providers');
  console.log(`  ✔ Registered provider: ${providers[0].name} (${providers[0].model})`);

  const matched = providerRegistry.getBestProvider('gemini-1.5-pro', { prompt: 'What is Bitcoin SV?', maxOutputTokens: 1024 });
  assert(matched, 'Should match provider for gemini-1.5-pro');
  assert.strictEqual(matched.id, 'test_node_1', 'Cheapest provider should win');
  console.log('  ✔ Matched cheapest provider by token price.');

  // Test 3: Token-based Pricing
  console.log('\nTest 3: Token-based Pricing');
  const q = pricing.quote({ inputTokens: 1500, maxOutputTokens: 1024, pricing: testPricing });
  assert.strictEqual(q.inputSats, 150, '1500 input tokens @100/1K = 150 sats');
  assert.strictEqual(q.outputSats, Math.ceil(1024 * 400 / 1000), 'Output cap priced at 400/1K, rounded up');
  assert.strictEqual(q.totalSats, q.inputSats + q.outputSats);
  const tiny = pricing.quote({ inputTokens: 3, maxOutputTokens: 10, pricing: testPricing });
  assert.strictEqual(tiny.totalSats, 50, 'Tiny request should hit the minimum price');
  assert.strictEqual(pricing.quote({ inputTokens: 1, maxOutputTokens: 1, pricing: { inputPer1k: 1, outputPer1k: 1, minSats: 0 } }).totalSats, 2, 'Fractional sats round up');
  assert.strictEqual(pricing.clampMaxOutputTokens(100000, testPricing), 4096, 'Output cap clamped to provider limit');
  assert.strictEqual(pricing.clampMaxOutputTokens(0, testPricing), 1, 'Output cap at least 1');
  assert.strictEqual(pricing.clampMaxOutputTokens('abc', testPricing), 1024, 'Invalid cap falls back to default');
  const actual = pricing.actualCost({ usage: { promptTokenCount: 1500, candidatesTokenCount: 300, thoughtsTokenCount: 200 }, pricing: testPricing });
  assert.strictEqual(actual.outputTokens, 500, 'Thinking tokens count as output');
  assert.strictEqual(actual.totalSats, 150 + 200);
  assert(actual.totalSats <= q.totalSats, 'Actual cost within quoted cap');
  console.log(`  ✔ Quote: ${q.inputSats} + ${q.outputSats} = ${q.totalSats} sats; actual ${actual.totalSats} sats.`);

  // Test 4: Invoice Creation & Invalidation
  console.log('\nTest 4: Invoice Creation & Management');
  const invoice = invoiceManager.createInvoice({
    prompt: 'What is Bitcoin SV?',
    provider: matched,
    quote: { ...q, tokenCountSource: 'estimate' }
  });
  assert(invoice.id.startsWith('inv_'), 'Invoice ID should start with inv_');
  assert.strictEqual(invoice.amountSats, q.totalSats, 'Amount should equal quoted sats');
  assert.strictEqual(invoice.maxOutputTokens, 1024);
  assert.strictEqual(invoice.inputTokens, 1500);
  assert.strictEqual(invoice.status, 'PENDING_PAYMENT');
  console.log(`  ✔ Created invoice ${invoice.id} for ${invoice.amountSats} satoshis (${invoice.inputTokens} in + ${invoice.maxOutputTokens} out cap).`);

  // Test 5: Replay Attack Protection in Verifier
  console.log('\nTest 5: Payment Verifier Replay Prevention');
  const verifier = new PaymentVerifier('mainnet');
  verifier.claimedTxids.add('a'.repeat(64));
  const replayResult = await verifier.verifyPayment(invoice, 'a'.repeat(64));
  assert.strictEqual(replayResult.valid, false, 'Should reject already claimed TXID');
  console.log('  ✔ Replay attack successfully blocked.');

  // Test 6: Gemini Pro Service
  console.log('\nTest 6: Gemini Pro Service Call');
  const gemini = new GeminiService(process.env.TEST_LIVE_GEMINI ? process.env.GEMINI_API_KEY : null, 'gemini-1.5-pro');
  const counted = await gemini.countTokens('Hello Gemini!');
  assert(counted.inputTokens > 0, 'Token count must be positive');
  console.log(`  ✔ Counted ${counted.inputTokens} input tokens (${counted.source}).`);
  const answerResult = await gemini.generateAnswer('Hello Gemini!', { maxOutputTokens: 256 });
  assert(answerResult.answer, 'Answer must not be empty');
  assert(answerResult.usage && answerResult.usage.promptTokenCount > 0, 'Usage metadata must include prompt tokens');
  console.log(`  ✔ Gemini Model: ${answerResult.model}`);
  console.log(`  ✔ Response snippet: "${answerResult.answer.slice(0, 80).replace(/\n/g, ' ')}..."`);

  // Test 7: OpenAI ChatGPT Service
  console.log('\nTest 7: OpenAI ChatGPT Service Call');
  const openai = new OpenAIService(process.env.TEST_LIVE_OPENAI ? process.env.OPENAI_API_KEY : null, 'gpt-4o');
  const oaiCounted = await openai.countTokens('Hello ChatGPT!');
  assert(oaiCounted.inputTokens > 0, 'Token count must be positive');
  console.log(`  ✔ Counted ${oaiCounted.inputTokens} input tokens (${oaiCounted.source}).`);
  if (process.env.TEST_LIVE_OPENAI) {
    const oaiAnswer = await openai.generateAnswer('Hello ChatGPT!', { maxOutputTokens: 256 });
    assert(oaiAnswer.answer, 'Answer must not be empty');
    assert(oaiAnswer.usage && oaiAnswer.usage.promptTokenCount > 0);
  } else {
    await assert.rejects(openai.generateAnswer('Hello ChatGPT!'), /OPENAI_API_KEY/);
    console.log('  ✔ Missing OpenAI key is reported instead of a simulated answer.');
  }

  // Test 8: TokenChannel pay-per-chunk flow
  if (channelLib) {
    console.log('\nTest 8: TokenChannel Smart Contract Payment Channel');
    const providerPayout = wallet.generateKeypair();
    const buyerRefund = wallet.generateKeypair();
    const sessionKey = wallet.generateKeypair();
    const channelPricing = pricing.normalizePricing({ inputPer1k: 100, outputPer1k: 400, minSats: 10 });
    const book = new ChannelBook({
      channelWif: wallet.generateKeypair().wif,
      payoutAddress: providerPayout.address,
      pricing: channelPricing,
      chunkTokens: 100,
      verifyFunding: async (params, utxo, lockingScriptHex) => lockingScriptHex === channelLib.channelLockingScript(params)
    });

    const { channelId, params: chParams } = book.proposal({
      sessionPubKey: sessionKey.publicKey.toString(),
      buyerAddress: buyerRefund.address
    });
    const fundingUtxo = { txid: 'cd'.repeat(32), vout: 0, satoshis: 5000 };
    const opened = await book.open(channelId, fundingUtxo);
    assert.strictEqual(opened.status, 'OPEN');
    assert.strictEqual(opened.capacity, 5000 - chParams.closeFee);
    console.log(`  ✔ Channel ${channelId} opened: ${opened.capacity} sats capacity, close fee ${chParams.closeFee} sats.`);

    const signFor = (terms) => channelLib.signState(chParams, fundingUtxo, terms.stateSats, sessionKey.wif);
    const answerText = 'word '.repeat(240).trim();
    const usage = { promptTokenCount: 30, candidatesTokenCount: 300, thoughtsTokenCount: 10 };
    const q1 = book.addQuery(channelId, { answer: answerText, usage });
    assert.strictEqual(q1.totalChunks, 3, '300 tokens / 100 per chunk = 3 chunks');

    // Buyer pays and receives every chunk of query 1
    let terms = q1.next;
    let received = '';
    let prevState = 0;
    while (terms) {
      // Never decreases; early chunks can be covered by the per-query minimum price
      assert(terms.stateSats >= prevState && terms.stateSats > 0, 'State amount must never decrease');
      prevState = terms.stateSats;
      const r = book.payChunk(channelId, { queryId: terms.queryId, index: terms.index, sessionSig: signFor(terms) });
      received += r.text;
      terms = r.next;
    }
    assert.strictEqual(received, answerText, 'Reassembled chunks must equal the answer');
    const q1Cost = pricing.actualCost({ usage, pricing: channelPricing }).totalSats;
    assert.strictEqual(book.get(channelId).paidSats, q1Cost, 'Paying every chunk equals the exact token cost');
    console.log(`  ✔ Query 1: ${q1.totalChunks} chunks paid, total ${q1Cost} sats = exact token cost.`);

    // Signature for the wrong amount / replayed signature must be rejected
    const q2 = book.addQuery(channelId, { answer: answerText, usage });
    assert.throws(() => book.payChunk(channelId, { queryId: q2.queryId, index: 0, sessionSig: signFor({ stateSats: q2.next.stateSats - 1 }) }), /Invalid session signature/);
    assert.throws(() => book.payChunk(channelId, { queryId: q2.queryId, index: 1, sessionSig: signFor(q2.next) }), /Expected payment for chunk 0/);

    // Query 2: buyer stops after the first chunk
    book.payChunk(channelId, { queryId: q2.queryId, index: 0, sessionSig: signFor(q2.next) });
    const paidAfterStop = book.get(channelId).paidSats;
    assert(paidAfterStop < q1Cost * 2, 'Stopping early pays less than the full answer');
    console.log(`  ✔ Query 2 stopped after 1 chunk; channel total ${paidAfterStop} sats.`);

    assert.throws(() => book.assertCanQuery(channelId, 999999), /balance too low/);

    // Provider settles: tx must pass the contract script and split funds correctly
    const settleTx = book.settle(channelId);
    assert.deepStrictEqual(channelLib.verifySpend(settleTx, chParams, fundingUtxo), { success: true, error: '' });
    const { bsv } = channelLib;
    const decoded = new bsv.Transaction(settleTx);
    assert.strictEqual(decoded.outputs[0].satoshis, paidAfterStop);
    assert.strictEqual(decoded.outputs[0].script.toAddress().toString(), providerPayout.address);
    assert.strictEqual(decoded.outputs[1].satoshis, 5000 - paidAfterStop - chParams.closeFee);
    assert.strictEqual(decoded.outputs[1].script.toAddress().toString(), buyerRefund.address);
    console.log(`  ✔ Settlement tx valid: ${paidAfterStop} sats to provider, ${decoded.outputs[1].satoshis} sats back to buyer.`);
  } else {
    console.log('\nTest 8: TokenChannel Smart Contract Payment Channel (Skipped: contracts dependencies not compiled)');
  }

  console.log('\n==================================================');
  console.log('   All Core Tests Passed Successfully! ✔');
  console.log('==================================================\n');
}

runTests().catch(err => {
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
