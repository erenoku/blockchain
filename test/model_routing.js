const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const OpenAIService = require('../src/provider/openai');
const ProviderAgent = require('../src/provider/agent');
const registry = require('../src/gateway/providerRegistry');
const wallet = require('../src/bsv/wallet');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('model matching never substitutes Gemini or a different GPT model', () => {
  registry.providers.clear();
  registry.register({ id: 'gemini', model: 'gemini-1.5-pro', endpoint: 'http://gemini/execute' });
  assert.equal(registry.getBestProvider('gpt-4o'), null);
  registry.register({ id: 'mini', model: 'gpt-4o-mini', endpoint: 'http://openai/execute' });
  assert.equal(registry.getBestProvider('gpt-4o'), null);
  registry.register({ id: 'both', model: 'gemini-1.5-pro', supportedModels: ['gemini-1.5-pro', 'gpt-4o'], endpoint: 'http://both/execute', channelEndpoint: 'http://both/channel' });
  assert.equal(registry.getBestProvider('gpt-4o').id, 'both');
  assert.equal(registry.getBestProvider('gpt-4o', { requireChannels: true }).id, 'both');
  assert.equal(registry.getBestProvider('gpt-4o-mini', { requireChannels: true }), null);
  registry.providers.clear();
});

test('OpenAI uses its own bearer key, exact model and paid output cap', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return Response.json({ model: 'gpt-4o-mini', choices: [{ message: { content: 'OpenAI answer' } }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });
  });
  const result = await new OpenAIService('test-openai-key').generateAnswer('hello', { model: 'gpt-4o-mini', maxOutputTokens: 32 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-openai-key');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.max_completion_tokens, 32);
  assert.equal(result.answer, 'OpenAI answer');
  assert.equal(result.usage.totalTokenCount, 16);
});

test('quota, authentication, rate limits and missing key never become demo successes', async (t) => {
  let calls = 0;
  let status = 429;
  let error = { code: 'credit_balance_exhausted', type: 'insufficient_quota' };
  t.mock.method(global, 'fetch', async () => {
    calls++;
    return Response.json({ error }, { status });
  });
  const service = new OpenAIService('test-openai-key');
  await assert.rejects(service.generateAnswer('hello'), /kredisi tükenmiş/);
  assert.equal(calls, 1, 'Do not retry another model for an account quota error');
  status = 401;
  error = { code: 'invalid_api_key' };
  await assert.rejects(service.generateAnswer('hello'), /401/);
  status = 429;
  error = { code: 'rate_limit_exceeded' };
  await assert.rejects(service.generateAnswer('hello'), /istek sınırına/);
  status = 404;
  error = { code: 'model_not_found' };
  await assert.rejects(service.generateAnswer('hello'), /modeli kullanılamıyor/);
  await assert.rejects(new OpenAIService('').generateAnswer('hello'), /OPENAI_API_KEY/);
  assert.equal(calls, 4);
});

test('HTTP quote, paid execution and channel query all preserve ChatGPT selection', async (t) => {
  const agent = new ProviderAgent({ bsvAddress: wallet.generateKeypair().address, apiKey: 'test-gemini-key', openaiApiKey: 'test-openai-key', channelStorePath: null });
  const calls = [];
  agent.gemini.countTokens = agent.gemini.generateAnswer = async () => { throw new Error('ChatGPT must never call Gemini'); };
  agent.openai.countTokens = async () => ({ inputTokens: 10, source: 'estimate' });
  agent.openai.generateAnswer = async (prompt, options) => {
    calls.push(options);
    return { success: true, model: options.model, answer: 'OpenAI answer', usage: { promptTokenCount: 10, candidatesTokenCount: 3 } };
  };
  const book = agent.channels;
  agent.channels = { publicKey: book.publicKey, proposal: book.proposal.bind(book), assertCanQuery() {}, addQuery: () => ({ queryId: 'test-query' }) };
  agent.setupRoutes();
  const server = agent.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Exercise the real gateway too, without signing or broadcasting any payment.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-routing-'));
  process.env.DATA_DIR = tempDir;
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const gateway = require('../src/gateway/server').listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => { gateway.closeAllConnections(); gateway.close(); });
  const gatewayBase = `http://127.0.0.1:${gateway.address().port}`;
  registry.register({ id: agent.id, model: agent.model, supportedModels: agent.supportedModels, bsvAddress: agent.bsvAddress, pricing: agent.pricing, endpoint: base + '/execute', quoteEndpoint: base + '/quote', channelEndpoint: base + '/channel', channelPubKey: book.publicKey });
  async function post(route, body) {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  }
  for (const model of ['gpt-4o', 'gpt-4o-mini']) {
    for (const route of ['/api/quote', '/api/invoice']) {
      const res = await fetch(gatewayBase + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'hello', model }) });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).model, model);
    }
    const quote = await post('/quote', { prompt: 'hello', model });
    assert.equal(quote.data.model, model);
    for (const route of ['/execute', '/channel/test/query']) {
      const result = await post(route, { prompt: 'hello', model, maxOutputTokens: 32 });
      assert.equal(result.status, 200);
      assert.equal(result.data.model, model);
      assert.equal(calls.at(-1).model, model);
      assert.equal(calls.at(-1).maxOutputTokens, 32);
    }
  }
  const sessionKey = wallet.generateKeypair().publicKey.toString();
  const prepare = await fetch(gatewayBase + '/api/channel/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionPubKey: sessionKey, buyerAddress: wallet.generateKeypair().address, model: 'gpt-4o-mini' }) });
  assert.equal(prepare.status, 200);
  const proposal = await prepare.json();
  assert.equal(proposal.model, 'gpt-4o-mini');
  // A client omitting the model must retain the model selected at preparation.
  const channelQuery = await fetch(gatewayBase + `/api/channel/${proposal.channelId}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'hello', maxOutputTokens: 32 }) });
  assert.equal(channelQuery.status, 200);
  assert.equal((await channelQuery.json()).model, 'gpt-4o-mini');
  assert.equal((await post('/quote', { prompt: 'hello', model: 'unavailable-model' })).status, 400);
  assert.equal((await post('/quote', { prompt: 'hello', model: 'gpt-3.5-turbo' })).status, 400);
  const retiredInvoice = await fetch(gatewayBase + '/api/invoice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'hello', model: 'gpt-3.5-turbo' }) });
  assert.equal(retiredInvoice.status, 503, 'Do not invoice a retired model');
  agent.openai.apiKey = '';
  assert.equal((await post('/quote', { prompt: 'hello', model: 'gpt-4o' })).status, 400);
  const missingKeyInvoice = await fetch(gatewayBase + '/api/invoice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'hello', model: 'gpt-4o' }) });
  assert.equal(missingKeyInvoice.status, 400, 'Do not create an invoice when OpenAI is unconfigured');
  agent.openai.apiKey = 'test-openai-key';
  agent.openai.generateAnswer = async () => { throw new Error('OpenAI API kredisi tükenmiş'); };
  assert.equal((await post('/execute', { prompt: 'hello', model: 'gpt-4o' })).status, 500);
  assert.equal((await post('/channel/test/query', { prompt: 'hello', model: 'gpt-4o' })).status, 400);
});
