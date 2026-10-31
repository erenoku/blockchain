/**
 * Multi-user network end-to-end test, in-process:
 *   providers sign in and onboard with API keys -> marketplace -> a customer
 *   picks a provider + model -> channel open, paid chunks, close -> provider
 *   claims earnings; plus access control, key failure and hardening checks.
 *
 * Real gateway code; only OpenAI/Gemini and the chain are simulated.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'network-e2e-'));
process.env.DATA_DIR = DATA_DIR;
process.env.GEMINI_API_KEY = '';

const assert = require('assert');
const { once } = require('events');
const sdk = require('@bsv/sdk');
const ChannelClient = require('../src/public/channelClient');
const channelLib = require('../contracts/dist/channel');
const { login } = require('./helpers/login');
const { buildFundingBeef } = require('./helpers/funding');

// ---- Simulated upstream AI APIs ----
const KEYS = { p1: 'sk-p1-openai-key-0001', p1New: 'sk-p1-openai-key-0002', p2: 'AIza-p2-gemini-key-0001' };
const revokedKeys = new Set();
const upstreamCalls = [];
const ANSWER = 'BSV payment channels let a buyer lock funds once and pay per chunk. '.repeat(20).trim();
const realFetch = global.fetch;
const wocBroadcasts = [];
global.fetch = async (url, options = {}) => {
  const u = String(url);
  // Miner ARC endpoint: rejects low fees like the real one (error 465)
  if (u.startsWith('https://arc.gorillapool.io/')) {
    return Response.json({ status: 465, title: 'Fee too low', extraInfo: 'arc error 465: transaction fee is too low\nminimum expected fee: 274, actual fee: 3' }, { status: 465 });
  }
  if (u.includes('whatsonchain.com') && u.endsWith('/tx/raw')) {
    wocBroadcasts.push(u);
    return Response.json('should-not-be-used');
  }
  if (u.startsWith('https://api.openai.com/')) {
    const key = (options.headers?.Authorization || '').replace('Bearer ', '');
    upstreamCalls.push({ engine: 'openai', url: u, key, body: options.body ? JSON.parse(options.body) : null });
    if (![KEYS.p1, KEYS.p1New].includes(key) || revokedKeys.has(key)) return Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 });
    if (u.endsWith('/v1/models')) return Response.json({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }, { id: 'text-embedding-3-small' }] });
    const body = JSON.parse(options.body);
    return Response.json({ model: body.model, choices: [{ message: { content: ANSWER } }], usage: { prompt_tokens: 30, completion_tokens: 300, total_tokens: 330 } });
  }
  if (u.startsWith('https://generativelanguage.googleapis.com/')) {
    const key = new URL(u).searchParams.get('key');
    upstreamCalls.push({ engine: 'gemini', url: u.replace(/key=[^&]+/, 'key=…'), key });
    if (key !== KEYS.p2) return Response.json({ error: {} }, { status: 400 });
    if (u.includes('/models?')) return Response.json({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] });
    if (u.includes(':countTokens')) return Response.json({ totalTokens: 25 });
    return Response.json({ candidates: [{ content: { parts: [{ text: ANSWER }] } }], usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 300 } });
  }
  return realFetch(url, options);
};

const app = require('../src/gateway/server');
const broadcasts = [];

async function main() {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  // Chain: funding checked against the contract script, broadcasts captured
  app.locals.hosted.verifyFunding = async (utxo, lockingScriptHex) => !!lockingScriptHex && utxo.satoshis === 6000;
  app.locals.explorer.broadcastRawTx = async (raw) => { broadcasts.push(raw); return sdk.Transaction.fromHex(raw).id('hex'); };
  app.locals.explorer.getSpentBy = async () => null;

  const call = async (who, method, route, body) => {
    const res = await realFetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: who.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers };
  };
  const ok = async (...args) => {
    const r = await call(...args);
    assert.strictEqual(r.status, 200, `${args[1]} ${args[2]} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };

  // MessageBox payment notices (provider earnings), captured instead of sent
  const deliveries = [];
  let deliveryWorks = true;
  app.locals.payouts.deliver = async (args) => {
    deliveries.push(args);
    return deliveryWorks ? { delivered: true, host: 'https://messagebox.test', messageId: `m${deliveries.length}`, errors: [] } : { delivered: false, host: null, messageId: null, errors: ['offline'] };
  };

  try {
    // ---- Providers onboard: earnings go to their identity key (02/03) ----
    async function onboard(role, setup) {
      const who = await login(base, undefined, role);
      // A wallet-derived payout key (no 02/03 identity) is not accepted any more
      const prefix = 'cGF5b3V0LXByZWZpeA==';
      const suffix = 'cGF5b3V0LXN1ZmZpeA==';
      const { publicKey } = await who.wallet.getPublicKey({ protocolID: [2, '3241645161d8'], keyID: `${prefix} ${suffix}`, counterparty: who.identityKey });
      assert.strictEqual((await call(who, 'POST', '/api/provider/setup', { ...setup, payout: { publicKey, prefix, suffix } })).status, 400);
      const res = await ok(who, 'POST', '/api/provider/setup', { ...setup, payout: { identityKey: who.identityKey } });
      assert.strictEqual(res.provider.payoutMode, 'identity');
      return { ...who, provider: res.provider };
    }

    const v = await call((await login(base, undefined, 'provider')), 'POST', '/api/provider/validate-key', { engine: 'openai', apiKey: KEYS.p1 });
    assert.deepStrictEqual(v.data.models, ['gpt-4o', 'gpt-4o-mini'], 'Only chat models are listed');

    const p1 = await onboard('provider', { name: 'P1 OpenAI', models: ['gpt-4o-mini'], pricing: { inputPer1k: 100, outputPer1k: 400, minSats: 10 }, keys: [{ engine: 'openai', apiKey: KEYS.p1 }] });
    const p2 = await onboard('provider', { name: 'P2 Gemini', models: ['gemini-2.5-flash'], pricing: { inputPer1k: 200, outputPer1k: 900, minSats: 10 }, keys: [{ engine: 'gemini', apiKey: KEYS.p2 }] });
    assert.strictEqual(p1.provider.keys[0].last4, '0001');
    console.log('  ✔ Two providers onboarded (OpenAI and Gemini keys validated server-side).');

    // ---- Marketplace ----
    const customer = await login(base, undefined, 'customer');
    const market = await ok(customer, 'GET', '/api/market');
    const names = market.providers.map(p => p.name);
    assert.deepStrictEqual(names.slice(0, 2), ['P1 OpenAI', 'P2 Gemini'], 'Cheaper output price first');
    assert(market.providers.every(p => p.available));
    const geminiOnly = await ok(customer, 'GET', '/api/market?model=gemini-2.5-flash');
    assert.deepStrictEqual(geminiOnly.providers.map(p => p.name), ['P2 Gemini']);
    assert.strictEqual((await call(customer, 'POST', '/api/quote', { prompt: 'hi', model: 'gemini-2.5-flash', providerId: p1.provider.id })).status, 400, 'P1 does not offer Gemini');
    const quote = await ok(customer, 'POST', '/api/quote', { prompt: 'Explain payment channels', model: 'gpt-4o-mini', providerId: p1.provider.id, maxOutputTokens: 1024 });
    assert.strictEqual(quote.providerName, 'P1 OpenAI');
    console.log(`  ✔ Marketplace lists ${market.providers.length} providers, filters by model; quote from the chosen provider: ${quote.amountSats} sats.`);

    // ---- Customer opens a channel with the chosen provider ----
    async function openChannel(providerId, model) {
      const session = ChannelClient.generateSessionKey();
      const buyerAddress = sdk.PrivateKey.fromRandom().toAddress();
      const proposal = await ok(customer, 'POST', '/api/channel/prepare', { sessionPubKey: session.pubKey, buyerAddress, model, providerId });
      ChannelClient.checkProposal(proposal, { sessionPubKey: session.pubKey, buyerAddress });
      assert.strictEqual(proposal.lockingScriptHex, channelLib.channelLockingScript(proposal.params));
      assert.strictEqual(proposal.providerId, providerId);
      const fundingBeef = await buildFundingBeef(proposal.lockingScriptHex, 6000);
      const utxo = ChannelClient.findChannelOutput(fundingBeef, proposal.lockingScriptHex);
      await ok(customer, 'POST', `/api/channel/${proposal.channelId}/open`, { ...utxo, fundingBeefHex: sdk.Utils.toHex(fundingBeef) });
      return { proposal, session, buyerAddress, utxo, fundingBeef, channel: { params: proposal.params, utxo, lockingScriptHex: proposal.lockingScriptHex } };
    }
    const ch = await openChannel(p1.provider.id, 'gpt-4o-mini');
    assert.strictEqual(ch.proposal.params.providerAddress, p1.provider.payoutAddress, 'Earnings go to the provider\'s BRC-29 payout address');
    console.log(`  ✔ Channel ${ch.proposal.channelId} opened with P1 (hosted on the gateway).`);

    // Someone else can't drive this customer's channel
    const stranger = await login(base, undefined, 'customer');
    assert.strictEqual((await call(stranger, 'POST', `/api/channel/${ch.proposal.channelId}/query`, { prompt: 'x', model: 'gpt-4o-mini' })).status, 403);
    assert.strictEqual((await call(null, 'POST', `/api/channel/${ch.proposal.channelId}/close`, {})).status, 403);
    console.log('  ✔ Other users (and anonymous requests) are refused on this channel.');

    // ---- Ask, pay every chunk ----
    const callsBefore = upstreamCalls.length;
    const q = await ok(customer, 'POST', `/api/channel/${ch.proposal.channelId}/query`, { prompt: 'Explain payment channels', model: 'gpt-4o-mini', maxOutputTokens: 1024 });
    const chat = upstreamCalls.slice(callsBefore).find(c => c.url.endsWith('/chat/completions'));
    assert.strictEqual(chat.key, KEYS.p1, 'Ran with P1\'s own API key');
    assert.strictEqual(chat.body.model, 'gpt-4o-mini');
    const cap = ChannelClient.maxQuerySats(ch.proposal.pricing, q.inputTokens, q.maxOutputTokens);
    assert(q.totalQuerySats <= cap);
    const state = { baseSats: 0, capSats: cap, lastStateSats: 0 };
    let terms = q.next;
    let text = '';
    while (terms) {
      ChannelClient.checkChunkTerms(state, terms);
      const r = await ok(customer, 'POST', `/api/channel/${ch.proposal.channelId}/chunk`, {
        queryId: terms.queryId, index: terms.index, sessionSig: ChannelClient.signState(ch.channel, terms.stateSats, ch.session.wif)
      });
      text += r.text;
      state.lastStateSats = terms.stateSats;
      terms = r.next;
    }
    assert.strictEqual(text, ANSWER);
    console.log(`  ✔ Answer received in ${q.totalChunks} paid chunks, ${state.lastStateSats} sats.`);

    // ---- Close, then provider claims earnings ----
    const closed = await ok(customer, 'POST', `/api/channel/${ch.proposal.channelId}/close`, {});
    assert.deepStrictEqual(channelLib.verifySpend(closed.settleTx, ch.proposal.params, ch.utxo), { success: true, error: '' });
    const settle = sdk.Transaction.fromHex(closed.settleTx);
    assert.strictEqual(settle.outputs[0].satoshis, state.lastStateSats);
    const settleBytes = closed.settleTx.length / 2;
    assert(ch.proposal.params.closeFee >= Math.ceil(settleBytes * 100 / 1000), `Close fee ${ch.proposal.params.closeFee} sats meets the 100 sats/kB miner policy for ${settleBytes} bytes`);
    assert.strictEqual(settle.outputs[0].lockingScript.toHex(), new sdk.P2PKH().lock(p1.provider.payoutAddress).toHex());

    const earnings = await ok(p1, 'GET', '/api/provider/earnings');
    const row = earnings.channels.find(c => c.channelId === ch.proposal.channelId);
    assert.strictEqual(row.status, 'CLOSED');
    assert.strictEqual(earnings.totals.unclaimedSats, state.lastStateSats);
    // What the provider page hands to BSV Desktop's internalizeAction
    const beef = ChannelClient.closingTxBeef(row.settleTx, sdk.Utils.toArray(row.fundingBeefHex, 'hex'));
    assert.strictEqual(sdk.Transaction.fromAtomicBEEF(beef).id('hex'), closed.settleTxid);
    assert.strictEqual(row.claimable, true);
    assert.strictEqual(row.payoutMode, 'identity');
    assert.strictEqual(ChannelClient.findRefundOutput(row.settleTx, row.payout.address), 0);
    // Announced to P1's identity right after settlement
    await new Promise(r => setTimeout(r, 50));
    const p1Notice = deliveries.find(d => sdk.Transaction.fromAtomicBEEF(d.atomicBeef).id('hex') === closed.settleTxid);
    assert(p1Notice, 'Payment notice sent for P1\'s channel');
    assert.strictEqual(p1Notice.recipientIdentityKey, p1.identityKey);
    assert.strictEqual(p1Notice.amount, state.lastStateSats);
    assert.strictEqual((await ok(p1, 'GET', '/api/provider/earnings')).channels.find(c => c.channelId === ch.proposal.channelId).payoutDelivery.delivered, true);
    assert.strictEqual((await call(p2, 'POST', `/api/provider/earnings/${ch.proposal.channelId}/claimed`, {})).status, 404, 'P2 cannot claim P1\'s channel');
    await ok(p1, 'POST', `/api/provider/earnings/${ch.proposal.channelId}/claimed`, {});
    const after = await ok(p1, 'GET', '/api/provider/earnings');
    assert.strictEqual(after.totals.claimedSats, state.lastStateSats);
    const customerView = await ok(customer, 'GET', '/api/channels');
    assert(customerView.channels.some(c => c.channelId === ch.proposal.channelId));
    assert(!(await ok(stranger, 'GET', '/api/channels')).channels.length, 'Users only see their own channels');
    console.log(`  ✔ Settled on-chain format, P1 earned ${state.lastStateSats} sats and marked them claimed; earnings data builds a valid AtomicBEEF.`);

    const stats = (await ok(customer, 'GET', '/api/market')).providers.find(p => p.id === p1.provider.id).stats;
    assert.strictEqual(stats.queries24h, 1);
    assert.strictEqual(stats.successRate, 1);

    // ---- Paying another identity key (02/03), with a failed first delivery ----
    deliveryWorks = false;
    const deliveriesBefore = deliveries.length;
    const p2Setup = (payout) => call(p2, 'POST', '/api/provider/setup', { name: 'P2 Gemini', models: ['gemini-2.5-flash'], pricing: { inputPer1k: 200, outputPer1k: 900, minSats: 10 }, payout });
    assert.strictEqual((await p2Setup({ identityKey: p2.identityKey.slice(0, 65) })).status, 400, '65-character identity key is refused');
    assert.strictEqual((await p2Setup({ address: sdk.PrivateKey.fromRandom().toAddress() })).status, 400, 'Plain 1... addresses are not accepted');
    const switched = await p2Setup({ identityKey: p2.identityKey.toUpperCase().replace(/^0/, '0') });
    assert.strictEqual(switched.status, 200, JSON.stringify(switched.data));
    assert.strictEqual(switched.data.provider.payoutMode, 'identity');
    assert.strictEqual(switched.data.provider.payoutIdentityKey, p2.identityKey);

    const ch3 = await openChannel(p2.provider.id, 'gemini-2.5-flash');
    const q3 = await ok(customer, 'POST', `/api/channel/${ch3.proposal.channelId}/query`, { prompt: 'hi', model: 'gemini-2.5-flash', maxOutputTokens: 512 });
    await ok(customer, 'POST', `/api/channel/${ch3.proposal.channelId}/chunk`, { queryId: q3.next.queryId, index: 0, sessionSig: ChannelClient.signState(ch3.channel, q3.next.stateSats, ch3.session.wif) });
    const closed3 = await ok(customer, 'POST', `/api/channel/${ch3.proposal.channelId}/close`, {});
    await new Promise(r => setTimeout(r, 50)); // delivery runs right after settlement

    assert.strictEqual(deliveries.length, deliveriesBefore + 1, 'Settlement triggers one MessageBox payment notice');
    const sent = deliveries[deliveries.length - 1];
    assert.strictEqual(sent.recipientIdentityKey, p2.identityKey);
    assert.strictEqual(sent.outputIndex, 0);
    assert.strictEqual(sent.amount, q3.next.stateSats);
    assert.strictEqual(sdk.Transaction.fromAtomicBEEF(sent.atomicBeef).id('hex'), closed3.settleTxid, 'Token carries the settlement as AtomicBEEF');
    // The provider's own wallet (BSV Desktop) derives the key that was paid, from the sender = gateway
    const senderKey = (await sent.senderWallet.getPublicKey({ identityKey: true })).publicKey;
    const { publicKey: walletKey } = await p2.wallet.getPublicKey({ protocolID: [2, '3241645161d8'], keyID: `${sent.derivationPrefix} ${sent.derivationSuffix}`, counterparty: senderKey, forSelf: true });
    assert.strictEqual(sdk.Transaction.fromHex(closed3.settleTx).outputs[0].lockingScript.toHex(), new sdk.P2PKH().lock(sdk.PublicKey.fromString(walletKey).toAddress()).toHex(),
      'The recipient wallet recognises the payout output as its own');

    let row3 = (await ok(p2, 'GET', '/api/provider/earnings')).channels.find(c => c.channelId === ch3.proposal.channelId);
    assert.strictEqual(row3.payoutMode, 'identity');
    assert.strictEqual(row3.payoutDelivery.delivered, false);
    assert.strictEqual(row3.payout.senderIdentityKey, senderKey, '"Cüzdana al" fallback uses the gateway as sender');
    assert.strictEqual((await call(p1, 'POST', `/api/provider/earnings/${ch3.proposal.channelId}/redeliver`, {})).status, 404, 'Only the owner can re-send');
    deliveryWorks = true;
    await ok(p2, 'POST', `/api/provider/earnings/${ch3.proposal.channelId}/redeliver`, {});
    row3 = (await ok(p2, 'GET', '/api/provider/earnings')).channels.find(c => c.channelId === ch3.proposal.channelId);
    assert.strictEqual(row3.payoutDelivery.delivered, true);
    deliveryWorks = true;
    console.log('  ✔ Identity-key payout: settlement announced in the provider\'s MessageBox, wallet-derivable key, re-send works; plain addresses refused.');

    // ---- Provider's key is revoked upstream ----
    revokedKeys.add(KEYS.p1);
    const ch2 = await openChannel(p1.provider.id, 'gpt-4o-mini');
    const failed = await call(customer, 'POST', `/api/channel/${ch2.proposal.channelId}/query`, { prompt: 'hello', model: 'gpt-4o-mini' });
    assert.strictEqual(failed.status, 400);
    assert(!/sk-|401|invalid_api_key/.test(failed.data.error), `No upstream details leak: ${failed.data.error}`);
    const p1View = (await ok(customer, 'GET', '/api/market')).providers.find(p => p.id === p1.provider.id);
    assert.strictEqual(p1View.available, false);
    assert.strictEqual(p1View.status, 'error');
    assert.strictEqual((await call(customer, 'POST', '/api/channel/prepare', { sessionPubKey: ch2.session.pubKey, buyerAddress: ch2.buyerAddress, model: 'gpt-4o-mini', providerId: p1.provider.id })).status, 404);
    // The open channel can still be closed (nothing was paid, so the customer signs 1 sat)
    const closeSig = ChannelClient.signState(ch2.channel, 1, ch2.session.wif);
    assert.strictEqual((await ok(customer, 'POST', `/api/channel/${ch2.proposal.channelId}/close`, { closeSig })).paidSats, 1);
    // A new key brings the provider back
    const fixed = await ok(p1, 'POST', '/api/provider/setup', { name: 'P1 OpenAI', models: ['gpt-4o-mini'], pricing: { inputPer1k: 100, outputPer1k: 400, minSats: 10 }, keys: [{ engine: 'openai', apiKey: KEYS.p1New }] });
    assert.strictEqual(fixed.provider.status, 'ok');
    assert.strictEqual((await ok(customer, 'GET', '/api/market')).providers.find(p => p.id === p1.provider.id).available, true);
    console.log('  ✔ Revoked key: provider marked out of service, hidden from new channels, no upstream details shown; new key restores it.');

    // ---- Going offline ----
    await ok(p2, 'POST', '/api/provider/me/enabled', { enabled: false });
    assert.strictEqual((await ok(customer, 'GET', '/api/market')).providers.find(p => p.id === p2.provider.id).available, false);
    await ok(p2, 'POST', '/api/provider/me/enabled', { enabled: true });

    // ---- Hardening ----
    const page = await realFetch(base + '/');
    assert(page.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.strictEqual(page.headers.get('x-frame-options'), 'DENY');
    const formPost = await realFetch(base + '/api/me/role', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: customer.cookie }, body: 'role=provider' });
    assert.strictEqual(formPost.status, 415, 'Cross-site form posts are refused');
    const dbFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('app.db')).map(f => fs.readFileSync(path.join(DATA_DIR, f)).toString('latin1')).join('');
    const hostedFiles = fs.readdirSync(path.join(DATA_DIR, 'hosted')).map(f => fs.readFileSync(path.join(DATA_DIR, 'hosted', f), 'utf8')).join('');
    for (const k of Object.values(KEYS)) assert(!dbFiles.includes(k) && !hostedFiles.includes(k), 'API keys are never stored in plaintext');
    assert(!hostedFiles.includes('channelWif"'), 'Hosted channel keys are not written to state files');
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      limited = (await realFetch(base + '/api/auth/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 429;
    }
    assert(limited, 'Sign-in attempts are rate limited');
    console.log('  ✔ Security headers, JSON-only API, encrypted keys at rest and rate limiting verified.');

    // A miner's fee rejection surfaces as an error; no silent fallback to WhatsOnChain
    const WhatsOnChainClient = require('../src/bsv/explorer');
    await assert.rejects(new WhatsOnChainClient('mainnet').broadcastRawTx('00'), /fee is too low/);
    assert.strictEqual(wocBroadcasts.length, 0, 'Not re-sent to WhatsOnChain after a miner rejection');
    console.log(`  ✔ Close fee ${ch.proposal.params.closeFee} sats covers miner policy; ARC fee rejections are reported, not swallowed.`);

    assert(broadcasts.length >= 2);
    console.log('\nNetwork end-to-end test passed ✔');
  } finally {
    app.locals.hosted.stop();
    server.closeAllConnections();
    server.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('\n❌ Network e2e failure:', err);
  process.exit(1);
});
