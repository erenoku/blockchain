/**
 * TokenChannel end-to-end test over HTTP:
 *   real Gateway (child process) + real ProviderAgent (in-process)
 *   + the browser's channelClient.js for every buyer-side signature.
 *
 * Only the wallet and the chain are simulated: the funding tx is built locally
 * with @bsv/sdk instead of BSV Desktop, and the provider's explorer is stubbed
 * so nothing is broadcast to the real network.
 */
// Use the offline Gemini demo response (dotenv never overrides an existing variable)
process.env.GEMINI_API_KEY = '';
process.env.PROVIDER_IDENTITY_KEY = '';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sdk = require('@bsv/sdk');
const ChannelClient = require('../src/public/channelClient');
const ProviderAgent = require('../src/provider/agent');
const channelLib = require('../contracts/dist/channel');
const wallet = require('../src/bsv/wallet');
const { login } = require('./helpers/login');
const { buildFundingBeef } = require('./helpers/funding');

const GATEWAY_PORT = 3398;
const PROVIDER_PORT = 4098;
const GATEWAY = `http://localhost:${GATEWAY_PORT}`;

// Session cookie of the signed-in customer (set once the gateway is up)
let cookie = '';

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body || {}) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function waitFor(fn, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  // The provider is paid to this identity key (02/03), never to a plain address
  const providerIdentity = sdk.PrivateKey.fromRandom();
  const providerIdentityKey = providerIdentity.toPublicKey().toString();
  const deliveries = [];
  const broadcasts = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-e2e-'));
  const providerStore = path.join(tmpDir, 'provider.json');
  let funded = true;

  const gateway = spawn(process.execPath, [path.join(__dirname, '../src/gateway/server.js')], {
    env: { ...process.env, PORT: String(GATEWAY_PORT), GEMINI_API_KEY: '', DATA_DIR: path.join(tmpDir, 'gateway-data') },
    stdio: 'ignore'
  });

  // Provider with simulated chain access; state persisted to providerStore
  function makeProvider() {
    const agent = new ProviderAgent({
      identityKey: providerIdentityKey,
      model: 'gemini-1.5-pro',
      supportedModels: ['gemini-1.5-pro'],
      deliverPayment: async (notice) => { deliveries.push(notice); return { delivered: true, host: 'https://messagebox.test', messageId: 'm1', errors: [] }; },
      port: PROVIDER_PORT,
      gatewayUrl: GATEWAY,
      apiKey: '',
      inputPer1k: 100,
      outputPer1k: 400,
      minSats: 10,
      chunkTokens: 25,
      channelStorePath: providerStore
    });
    agent.channels.verifyFunding = async (params, utxo, lockingScriptHex) =>
      funded && lockingScriptHex === channelLib.channelLockingScript(params) && utxo.satoshis === 6000;
    agent.explorer.broadcastRawTx = async (rawTx) => {
      broadcasts.push(rawTx);
      return sdk.Transaction.fromHex(rawTx).id('hex');
    };
    return agent;
  }
  let provider = makeProvider();

  try {
    await waitFor(async () => (await fetch(`${GATEWAY}/api/status`)).ok, 'gateway');
    ({ cookie } = await login(GATEWAY, undefined, 'customer'));
    await provider.start();
    await waitFor(async () => {
      const { providers } = await (await fetch(`${GATEWAY}/api/providers`)).json();
      return providers.some(p => p.supportsChannels);
    }, 'provider registration');
    console.log('  ✔ Gateway and channel-enabled provider are up.');

    // 1. Buyer prepares a channel (browser code path)
    const session = ChannelClient.generateSessionKey();
    const buyerAddress = wallet.generateKeypair().address;
    const proposal = await post(`${GATEWAY}/api/channel/prepare`, { sessionPubKey: session.pubKey, buyerAddress });
    ChannelClient.checkProposal(proposal, { sessionPubKey: session.pubKey, buyerAddress });
    assert.throws(() => ChannelClient.checkProposal(proposal, { sessionPubKey: session.pubKey, buyerAddress: wallet.generateKeypair().address }), /different address/);
    assert.strictEqual(proposal.payout.identityKey, providerIdentityKey, 'Proposal pays the provider identity');
    assert.notStrictEqual(proposal.params.providerAddress, providerIdentity.toAddress(), 'Never the identity key\'s plain address');
    console.log(`  ✔ Proposal ${proposal.channelId} checked (close fee ${proposal.params.closeFee} sats).`);

    // 2. Fund it; the provider restarts before the buyer reports the funding
    const fundingBeef = await buildFundingBeef(proposal.lockingScriptHex, 6000);
    const utxo = ChannelClient.findChannelOutput(fundingBeef, proposal.lockingScriptHex);
    assert.strictEqual(utxo.vout, 1, 'Channel output detected behind the change output');

    const keyBefore = provider.channels.publicKey;
    provider.stop();
    await new Promise(r => provider.server.on('close', r));
    provider = makeProvider();
    assert.strictEqual(provider.channels.publicKey, keyBefore, 'Channel key survives a restart');
    await provider.start();
    await waitFor(async () => {
      const { providers } = await (await fetch(`${GATEWAY}/api/providers`)).json();
      return providers.filter(p => p.supportsChannels).length >= 1 && providers.some(p => p.id === provider.id);
    }, 'restarted provider registration');

    await post(`${GATEWAY}/api/channel/${proposal.channelId}/open`, { ...utxo, fundingBeefHex: sdk.Utils.toHex(fundingBeef) });
    console.log('  ✔ Provider restarted between funding and opening; channel still opened.');
    const channel = { params: proposal.params, utxo, lockingScriptHex: proposal.lockingScriptHex };
    console.log('  ✔ Channel funded and opened.');

    // 3. Ask, paying chunk by chunk with browser signatures; stop after 2 chunks
    const prompt = 'Explain BSV payment channels in detail. '.repeat(3);
    const q = await post(`${GATEWAY}/api/channel/${proposal.channelId}/query`, { prompt, maxOutputTokens: 512 });
    const capSats = ChannelClient.maxQuerySats(proposal.pricing, q.inputTokens, q.maxOutputTokens);
    assert(q.totalQuerySats <= capSats, 'Query priced within cap');
    assert(q.totalChunks >= 3, `Demo answer should span several chunks (got ${q.totalChunks})`);

    const state = { baseSats: 0, capSats, lastStateSats: 0 };
    let terms = q.next;
    let text = '';
    for (let i = 0; i < 2; i++) {
      ChannelClient.checkChunkTerms(state, terms);
      const sessionSig = ChannelClient.signState(channel, terms.stateSats, session.wif);
      const chunk = await post(`${GATEWAY}/api/channel/${proposal.channelId}/chunk`, { queryId: terms.queryId, index: terms.index, sessionSig });
      assert.strictEqual(chunk.paidSats, terms.stateSats);
      text += chunk.text;
      state.lastStateSats = terms.stateSats;
      terms = chunk.next;
    }
    assert(text.length > 0 && terms, 'Received 2 chunks, more were available');
    console.log(`  ✔ Paid 2/${q.totalChunks} chunks (${state.lastStateSats} sats of ${q.totalQuerySats}), then stopped.`);

    // A tampered price must be refused by the buyer before signing
    assert.throws(() => ChannelClient.checkChunkTerms(state, { ...terms, stateSats: capSats + 1 }), /query cap/);

    // 4. Close: provider settles, buyer's refund output is internalizable
    const closed = await post(`${GATEWAY}/api/channel/${proposal.channelId}/close`, {});
    assert.strictEqual(broadcasts.length, 1, 'Settlement broadcast once');
    assert.deepStrictEqual(channelLib.verifySpend(closed.settleTx, proposal.params, utxo), { success: true, error: '' });
    const refundIndex = ChannelClient.findRefundOutput(closed.settleTx, buyerAddress);
    const settleTx = sdk.Transaction.fromHex(closed.settleTx);
    assert.strictEqual(settleTx.outputs[0].satoshis, state.lastStateSats);
    assert.strictEqual(settleTx.outputs[refundIndex].satoshis, 6000 - state.lastStateSats - proposal.params.closeFee);
    const beef = ChannelClient.closingTxBeef(closed.settleTx, fundingBeef);
    const parsed = sdk.Transaction.fromAtomicBEEF(beef);
    assert.strictEqual(parsed.id('hex'), closed.settleTxid);
    assert.strictEqual(parsed.inputs[0].sourceTransaction.id('hex'), utxo.txid);
    console.log(`  ✔ Settled: ${state.lastStateSats} sats to provider, ${settleTx.outputs[refundIndex].satoshis} sats refund (AtomicBEEF ready for BSV Desktop).`);

    // The provider's identity is told about its earnings in its MessageBox payment_inbox
    assert.strictEqual(deliveries.length, 1, 'One payment notice after settlement');
    const notice = deliveries[0];
    assert.strictEqual(notice.recipientIdentityKey, providerIdentityKey);
    assert.strictEqual(notice.amount, state.lastStateSats);
    assert.strictEqual(notice.outputIndex, 0);
    assert.strictEqual(sdk.Transaction.fromAtomicBEEF(notice.atomicBeef).id('hex'), closed.settleTxid);
    // The identity's own wallet recognises the paid output (derived from the node's key as sender)
    const { publicKey: walletKey } = await new sdk.ProtoWallet(providerIdentity).getPublicKey({
      protocolID: [2, '3241645161d8'], keyID: `${notice.derivationPrefix} ${notice.derivationSuffix}`,
      counterparty: proposal.payout.senderIdentityKey, forSelf: true
    });
    assert.strictEqual(settleTx.outputs[0].lockingScript.toHex(), new sdk.P2PKH().lock(sdk.PublicKey.fromString(walletKey).toAddress()).toHex());
    assert.strictEqual(closed.payoutDelivery.delivered, true);
    console.log('  ✔ Earnings paid to the provider\'s identity key and announced via MessageBox (no plain address).');

    // 5. An unused channel closes immediately with a 1-sat state
    const session2 = ChannelClient.generateSessionKey();
    const p2 = await post(`${GATEWAY}/api/channel/prepare`, { sessionPubKey: session2.pubKey, buyerAddress });
    const beef2 = await buildFundingBeef(p2.lockingScriptHex, 6000);
    const utxo2 = ChannelClient.findChannelOutput(beef2, p2.lockingScriptHex);
    await post(`${GATEWAY}/api/channel/${p2.channelId}/open`, { ...utxo2, fundingBeefHex: sdk.Utils.toHex(beef2) });
    const closeSig = ChannelClient.signState({ params: p2.params, utxo: utxo2, lockingScriptHex: p2.lockingScriptHex }, 1, session2.wif);
    const closed2 = await post(`${GATEWAY}/api/channel/${p2.channelId}/close`, { closeSig });
    assert(channelLib.verifySpend(closed2.settleTx, p2.params, utxo2).success);
    assert.strictEqual(sdk.Transaction.fromHex(closed2.settleTx).outputs[0].satoshis, 1);
    console.log('  ✔ Unused channel closed right away for 1 sat.');

    // 6. Refund endpoint refuses before expiry; a funding mismatch is refused on open
    await assert.rejects(post(`${GATEWAY}/api/channel/refund`, { params: p2.params, utxo: utxo2 }), /not expired/);
    funded = false;
    const p3 = await post(`${GATEWAY}/api/channel/prepare`, { sessionPubKey: session2.pubKey, buyerAddress });
    await assert.rejects(post(`${GATEWAY}/api/channel/${p3.channelId}/open`, { txid: 'ef'.repeat(32), vout: 0, satoshis: 6000 }), /does not match/);
    console.log('  ✔ Early refund and unfunded channels are refused.');

    // 7. Gateway lists brokered channels for the locked-funds view
    const listed = await (await fetch(`${GATEWAY}/api/channels`, { headers: { Cookie: cookie } })).json();
    const byId = Object.fromEntries(listed.channels.map(c => [c.channelId, c]));
    assert.strictEqual(byId[proposal.channelId].status, 'CLOSED');
    assert.strictEqual(byId[proposal.channelId].settleTxid, closed.settleTxid);
    assert.strictEqual(byId[p3.channelId].status, 'OPEN_FAILED');
    assert.strictEqual(byId[p3.channelId].depositSats, 6000);

    // A channel funded before the gateway kept records can be reported by the browser
    const legacy = { channelId: 'ch_00112233aabbccdd', params: p2.params, utxo: { txid: '12'.repeat(32), vout: 0, satoshis: 777 }, providerName: 'old', status: 'FUNDED' };
    await post(`${GATEWAY}/api/channels/track`, legacy);
    const listed2 = await (await fetch(`${GATEWAY}/api/channels`, { headers: { Cookie: cookie } })).json();
    assert(listed2.channels.some(c => c.channelId === legacy.channelId && c.status === 'OPEN_FAILED'));
    console.log(`  ✔ /api/channels lists ${listed2.channels.length} channels (on-chain lookups: ${[...new Set(listed2.channels.map(c => c.onchain.state))].join(', ')}).`);

    console.log('\nTokenChannel end-to-end test passed ✔');
  } finally {
    provider.stop();
    gateway.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch(err => {
  console.error('\n❌ Channel e2e failure:', err);
  process.exit(1);
});
