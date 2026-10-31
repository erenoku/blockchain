/**
 * TokenChannel UI: open a smart contract channel with one BSV Desktop approval,
 * then pay for each answer chunk with an automatic session-key signature.
 * Depends on window.bsv (@bsv/sdk), ChannelClient and safeFetchJson (app.js).
 */
(function () {
  const STORAGE_KEY = 'bsv_token_channel';
  // Funded channels that can't be used any more (open/close failed): their
  // deposit waits in the contract for the refund path. They don't block new channels.
  const PARKED_KEY = 'bsv_token_channels_parked';
  const WALLET_URL = 'http://localhost:3321';
  const BRC29_PROTOCOL = [2, '3241645161d8'];

  const el = (id) => document.getElementById(id);
  let channel = loadChannel();
  let parked = loadParked();
  let busy = false;
  let stopRequested = false;

  function loadChannel() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null;
    } catch (_) {
      return null;
    }
  }

  function loadParked() {
    try {
      return JSON.parse(localStorage.getItem(PARKED_KEY)) || [];
    } catch (_) {
      return [];
    }
  }

  // The session key and funding BEEF are kept so the deposit can still be
  // recovered after a page reload. The session key can only pay this provider.
  function saveChannel() {
    try {
      if (channel) localStorage.setItem(STORAGE_KEY, JSON.stringify(channel));
      else localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(PARKED_KEY, JSON.stringify(parked));
    } catch (_) {}
  }

  /** Move the active channel to the locked-funds list so a new one can be opened. */
  function parkChannel(status) {
    channel.status = status;
    parked.push(channel);
    trackOnGateway(channel);
    channel = null;
    saveChannel();
  }

  // Make sure the gateway's locked-funds view knows about channels funded in this browser
  function trackOnGateway(c) {
    post('/api/channels/track', {
      channelId: c.channelId,
      params: c.params,
      utxo: c.utxo,
      providerName: c.providerName,
      status: c.status
    }).catch(() => {});
  }

  function formatRemaining(seconds) {
    if (seconds <= 0) return 'available now';
    const h = Math.floor(seconds / 3600);
    const m = Math.ceil((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
  }

  function explorerTx(c, txid) {
    return `${c.network === 'testnet' ? 'https://testnet.whatsonchain.com' : 'https://whatsonchain.com'}/tx/${txid}`;
  }

  function wallet(method, args) {
    return safeFetchJson(`${WALLET_URL}/${method}`, { method: 'POST', body: JSON.stringify(args) });
  }

  function post(url, body) {
    return safeFetchJson(url, { method: 'POST', body: JSON.stringify(body || {}) });
  }

  function randomBase64(bytes) {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return btoa(String.fromCharCode(...buf));
  }

  function message(text, color = '#9ca3af') {
    el('channel-message').innerHTML = `<span style="color:${color};">${text}</span>`;
  }

  function capacity() {
    return channel.utxo.satoshis - channel.params.closeFee;
  }

  function isExpired(c) {
    return Math.floor(Date.now() / 1000) >= c.params.expiry;
  }

  const PARKED_LABELS = {
    OPEN_FAILED: 'open failed',
    CLOSE_FAILED: 'close failed',
    AWAITING_REFUND: 'awaiting refund'
  };

  function renderParked() {
    const list = el('channel-locked-list');
    if (parked.length === 0) {
      list.innerHTML = '';
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const total = parked.reduce((sum, c) => sum + c.utxo.satoshis, 0);
    list.innerHTML = `<div style="font-weight:600; color:#fcd34d; margin-bottom:6px;">🔐 Locked in contract: ${total} sats (${parked.length} channels)</div>` +
      parked.map((c, i) => {
        const open = isExpired(c);
        return `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 0; border-top:1px solid rgba(255,255,255,0.08);">
          <div style="font-size:0.78rem; color:#d1d5db;">
            <b>${c.utxo.satoshis} sats</b> · ${c.providerName} · ${PARKED_LABELS[c.status] || c.status}<br>
            <span style="color:#9ca3af;">Refund: ${new Date(c.params.expiry * 1000).toLocaleString()} (${formatRemaining(c.params.expiry - now)}) ·
            <a href="${explorerTx(c, c.utxo.txid)}" target="_blank" rel="noopener">contract TX ↗</a></span>
          </div>
          <div style="display:flex; gap:6px;">
            ${c.status === 'OPEN_FAILED' && !channel ? `<button type="button" class="btn-copy" data-parked-retry="${i}" style="padding:6px 10px; border-radius:6px; cursor:pointer;">Retry Open</button>` : ''}
            <button type="button" class="btn-copy" data-parked-refund="${i}" ${open ? '' : 'disabled'} style="padding:6px 10px; border-radius:6px; cursor:${open ? 'pointer' : 'not-allowed'}; opacity:${open ? 1 : 0.5};">Claim Refund</button>
          </div>
        </div>`;
      }).join('');
  }

  function render() {
    const open = channel && channel.status === 'OPEN';
    el('channel-open-view').classList.toggle('hidden', !open);
    el('channel-closed-view').classList.toggle('hidden', open);
    el('btn-channel-open').disabled = busy;
    renderParked();
    el('btn-channel-stop').classList.toggle('hidden', !busy);
    el('btn-channel-ask').disabled = busy;
    el('btn-channel-close').disabled = busy;

    if (open) {
      const expires = new Date(channel.params.expiry * 1000).toLocaleString();
      el('channel-status').innerHTML =
        `Channel <code>${channel.channelId}</code> · ${channel.providerName}<br>` +
        `Spent: <b>${channel.paidSats}</b> / ${capacity()} sats · Remaining: <b>${capacity() - channel.paidSats}</b> sats · Expires: ${expires}<br>` +
        `<span style="color:#9ca3af;">A miner fee of ${channel.params.closeFee} sats is deducted when the channel closes.</span>`;
    }
  }

  async function withBusy(fn) {
    if (busy) return;
    busy = true;
    render();
    try {
      await fn();
    } catch (err) {
      message(`⚠ ${err.message}`, '#f59e0b');
    } finally {
      busy = false;
      stopRequested = false;
      render();
    }
  }

  // Receive a closing tx's buyer output (refund) into BSV Desktop via BRC-29
  async function internalizeRefund(c, closingTxHex) {
    const outputIndex = ChannelClient.findRefundOutput(closingTxHex, c.params.buyerAddress);
    if (outputIndex < 0) return null;
    const fundingBeef = bsv.Utils.toArray(c.fundingBeefHex, 'hex');
    await wallet('internalizeAction', {
      tx: ChannelClient.closingTxBeef(closingTxHex, fundingBeef),
      outputs: [{
        outputIndex,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: c.derivationPrefix,
          derivationSuffix: c.derivationSuffix,
          senderIdentityKey: c.identityKey
        }
      }],
      description: 'AI token channel refund',
      labels: ['ai-token-channel']
    });
    return bsv.Transaction.fromHex(closingTxHex).outputs[outputIndex].satoshis;
  }

  async function openChannel() {
    const deposit = parseInt(el('channel-deposit').value, 10);
    if (!(deposit >= 100)) throw new Error('Deposit must be at least 100 sats.');
    const selected = getSelectedProvider();
    if (!selected) throw new Error('Select a provider and model from the marketplace first.');

    message('Reading BSV Desktop identity...');
    const identityKey = (await wallet('getPublicKey', { identityKey: true })).publicKey;
    const derivationPrefix = randomBase64(12);
    const derivationSuffix = randomBase64(12);
    // Refunds go to a BRC-29 key of the buyer's own wallet, so BSV Desktop can take them back in
    const refundKey = (await wallet('getPublicKey', {
      protocolID: BRC29_PROTOCOL,
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: identityKey
    })).publicKey;
    const { network } = await safeFetchJson('/api/status');
    const buyerAddress = ChannelClient.addressFromPubKey(refundKey, network);
    const session = ChannelClient.generateSessionKey();

    message('Preparing channel contract with provider...');
    const proposal = await post('/api/channel/prepare', {
      sessionPubKey: session.pubKey,
      buyerAddress,
      model: el('model-select').value,
      providerId: selected.providerId
    });
    ChannelClient.checkProposal(proposal, { sessionPubKey: session.pubKey, buyerAddress });
    // Check before locking anything: a deposit below the miner fee could never be closed or refunded
    const minDeposit = proposal.params.closeFee + proposal.pricing.minSats;
    if (deposit < minDeposit) {
      throw new Error(`Deposit must be at least ${minDeposit} sats (${proposal.params.closeFee} sats channel close fee + ${proposal.pricing.minSats} sats minimum query fee).`);
    }

    message(`Approve locking ${deposit} sats in BSV Desktop...`);
    const focusTimer = setTimeout(() => fetch('/api/focus-wallet', { method: 'POST' }).catch(() => {}), 400);
    let funding;
    try {
      funding = await wallet('createAction', {
        description: `AI token channel deposit (${proposal.providerName})`,
        labels: ['ai-token-channel'],
        outputs: [{
          satoshis: deposit,
          lockingScript: proposal.lockingScriptHex,
          outputDescription: 'TokenChannel smart contract deposit'
        }],
        options: { randomizeOutputs: false }
      });
    } finally {
      clearTimeout(focusTimer);
    }
    if (!Array.isArray(funding.tx)) throw new Error('BSV Desktop did not return an AtomicBEEF transaction.');
    const utxo = ChannelClient.findChannelOutput(funding.tx, proposal.lockingScriptHex);

    // Save before asking the provider, so the deposit is recoverable even if opening fails
    channel = {
      status: 'FUNDED',
      channelId: proposal.channelId,
      providerId: proposal.providerId,
      providerName: proposal.providerName,
      network,
      params: proposal.params,
      pricing: proposal.pricing,
      lockingScriptHex: proposal.lockingScriptHex,
      utxo,
      sessionWif: session.wif,
      identityKey,
      derivationPrefix,
      derivationSuffix,
      fundingBeefHex: bsv.Utils.toHex(funding.tx),
      paidSats: 0
    };
    saveChannel();

    message(`Funding transaction broadcast (${utxo.txid.slice(0, 10)}…). Waiting for provider confirmation...`);
    try {
      await requestOpen(channel);
    } catch (err) {
      parkChannel('OPEN_FAILED');
      throw new Error(`Provider could not open channel: ${err.message}. Your funds are safe in the contract (listed under locked funds). You can click "Retry Open", claim a refund after expiry, or open a new channel.`);
    }
    channel.status = 'OPEN';
    saveChannel();
    trackOnGateway(channel);
    message('✔ Channel open. Each response chunk will now be signed automatically.', '#10b981');
  }

  async function requestOpen(c) {
    let lastErr;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        // The funding BEEF lets the provider later claim its earnings into BSV Desktop
        return await post(`/api/channel/${c.channelId}/open`, { ...c.utxo, fundingBeefHex: c.fundingBeefHex });
      } catch (err) {
        lastErr = err;
        if (!/not found|does not match/i.test(err.message)) break;
        await new Promise(r => setTimeout(r, 2000)); // wait for the funding tx to reach the explorer
      }
    }
    throw lastErr;
  }

  async function retryParked(index) {
    if (channel) throw new Error('Close your active channel first.');
    const c = parked[index];
    message('Requesting provider to reopen the channel...');
    await requestOpen(c);
    parked.splice(index, 1);
    channel = { ...c, status: 'OPEN' };
    saveChannel();
    message('✔ Channel opened.', '#10b981');
  }

  async function askWithChannel() {
    const prompt = el('prompt-input').value.trim();
    if (!prompt) throw new Error('Please enter a prompt.');
    const selected = getSelectedProvider();
    if (selected && channel.providerId && selected.providerId !== channel.providerId) {
      throw new Error(`Your open channel belongs to provider ${channel.providerName}. Close this channel first to query ${selected.providerName}.`);
    }

    const resultCard = el('result-card');
    const answerEl = el('ai-answer-content');
    resultCard.classList.remove('hidden');
    answerEl.textContent = '';
    let answerMarkdown = '';
    el('token-usage-summary').textContent = '';
    const link = el('tx-explorer-link');
    link.href = `${channel.network === 'testnet' ? 'https://testnet.whatsonchain.com' : 'https://whatsonchain.com'}/tx/${channel.utxo.txid}`;
    link.textContent = `Channel contract: ${channel.utxo.txid.slice(0, 10)}... (WhatsOnChain ↗)`;

    message('Provider is preparing the response...');
    const q = await post(`/api/channel/${channel.channelId}/query`, {
      prompt,
      model: el('model-select').value,
      maxOutputTokens: getMaxOutputTokens()
    });
    el('result-model-label').textContent = `AI Response (${q.model})`;
    el('result-icon').textContent = /^(gpt-|chatgpt-|o\d)/i.test(q.model) ? '🤖' : '✨';

    // Never trust the provider's numbers blindly: cap the query at the advertised price
    const promptEstimate = Math.ceil(prompt.length / 4);
    if (q.inputTokens > promptEstimate * 2 + 100) {
      throw new Error(`Provider reported a suspicious input token count (${q.inputTokens}). No payment was made.`);
    }
    const capSats = ChannelClient.maxQuerySats(channel.pricing, q.inputTokens, q.maxOutputTokens);
    if (q.totalQuerySats > capSats) {
      throw new Error(`Provider requested ${q.totalQuerySats} sats, exceeding the price cap of ${capSats} sats. No payment was made.`);
    }
    const state = { baseSats: channel.paidSats, capSats, lastStateSats: channel.paidSats };

    let terms = q.next;
    let chunks = 0;
    while (terms) {
      if (stopRequested) {
        message(`⏹ Stopped. Paid only for ${chunks}/${q.totalChunks} received chunks.`, '#f59e0b');
        break;
      }
      ChannelClient.checkChunkTerms(state, terms);
      message(`Signing ${terms.stateSats - state.lastStateSats} sats for chunk ${terms.index + 1}/${q.totalChunks}...`);
      const sessionSig = ChannelClient.signState(channel, terms.stateSats, channel.sessionWif);
      const chunk = await post(`/api/channel/${channel.channelId}/chunk`, {
        queryId: terms.queryId,
        index: terms.index,
        sessionSig
      });
      if (chunk.paidSats !== terms.stateSats) throw new Error('Provider recorded a mismatched amount; stopped.');

      // Re-render the whole answer so markdown split across chunks still formats correctly
      answerMarkdown += chunk.text;
      renderMarkdown(answerEl, answerMarkdown);
      state.lastStateSats = terms.stateSats;
      channel.paidSats = terms.stateSats;
      saveChannel();
      chunks += 1;
      render();
      terms = chunk.next;
    }

    const querySats = state.lastStateSats - state.baseSats;
    el('token-usage-summary').textContent =
      `This query: ${querySats} sats (${chunks}/${q.totalChunks} chunks, ${q.inputTokens} input tokens) · ` +
      `Price cap was ${capSats} sats · Remaining in channel: ${capacity() - channel.paidSats} sats`;
    if (!stopRequested) message('✔ Response complete.', '#10b981');
    if (typeof refreshState === 'function') refreshState();
  }

  async function closeChannel() {
    // An unused channel closes with a 1-sat state instead of waiting for expiry
    const closeSig = channel.paidSats === 0
      ? ChannelClient.signState(channel, 1, channel.sessionWif)
      : undefined;

    message('Provider is settling the channel on-chain...');
    let closed;
    try {
      closed = await post(`/api/channel/${channel.channelId}/close`, { closeSig });
    } catch (err) {
      const expiry = new Date(channel.params.expiry * 1000).toLocaleString();
      parkChannel('CLOSE_FAILED');
      throw new Error(`Provider could not close the channel (${err.message}). Funds are in the locked list; you can claim a refund after ${expiry} or open a new channel.`);
    }

    if (!closed.settleTx) {
      const expiry = new Date(channel.params.expiry * 1000).toLocaleString();
      parkChannel('AWAITING_REFUND');
      throw new Error(`Provider did not produce a settlement transaction. Funds are in the locked list; you can claim a refund after ${expiry}.`);
    }

    let refunded = null;
    {
      try {
        refunded = await internalizeRefund(channel, closed.settleTx);
      } catch (err) {
        message(`Channel closed (${closed.settleTxid}), but the refund could not be automatically internalized into your wallet: ${err.message}`, '#f59e0b');
        channel = null;
        saveChannel();
        return;
      }
    }
    message(`✔ Channel closed. Paid ${closed.paidSats} sats to provider${refunded ? `, returned ${refunded} sats to your wallet` : ''}. TX: ${closed.settleTxid}`, '#10b981');
    channel = null;
    saveChannel();
  }

  async function refundParked(index) {
    const c = parked[index];
    if (!isExpired(c)) {
      throw new Error(`Refund will be available after ${new Date(c.params.expiry * 1000).toLocaleString()} (${formatRemaining(c.params.expiry - Math.floor(Date.now() / 1000))}).`);
    }
    message('Preparing refund transaction...');
    const r = await post('/api/channel/refund', { channelId: c.channelId, params: c.params, utxo: c.utxo });
    parked.splice(index, 1);
    saveChannel();
    let refunded;
    try {
      refunded = await internalizeRefund(c, r.refundTx);
    } catch (err) {
      message(`Refund broadcast on-chain (${r.refundTxid}), but could not be automatically internalized into your wallet: ${err.message}`, '#f59e0b');
      return;
    }
    message(`✔ ${refunded} sats returned to your wallet. TX: ${r.refundTxid}`, '#10b981');
  }

  // Locked-funds overview from the gateway (sidebar)
  async function refreshGatewayLocked() {
    const box = el('gateway-locked-funds');
    if (!box) return;
    try {
      const data = await safeFetchJson('/api/channels');
      // 'unknown' = explorer couldn't answer; show it rather than hide money that may be locked
      const locked = data.channels.filter(c => c.onchain.state === 'locked' || c.onchain.state === 'unknown');
      el('gateway-locked-total').textContent = `${data.totalLockedSats} sats`;
      el('nav-locked-sats').textContent = `${data.totalLockedSats} sats`;
      const now = Math.floor(Date.now() / 1000);
      box.innerHTML = locked.length === 0
        ? '<div class="empty-state">No funds currently locked in contracts.</div>'
        : locked.map(c => `
          <div class="swap-item">
            <div>
              <div style="font-size:0.8rem;">${c.depositSats} sats · ${c.providerName}</div>
              <div style="font-size:0.7rem; color:#9ca3af;">${c.status} · refund ${formatRemaining(c.expiry - now)}${c.onchain.state === 'unknown' ? ' · chain status unknown' : ''}</div>
            </div>
            <a class="swap-tx" href="${data.network === 'testnet' ? 'https://testnet.whatsonchain.com' : 'https://whatsonchain.com'}/tx/${c.fundingTxid}" target="_blank" rel="noopener">${c.fundingTxid.slice(0, 8)}… ↗</a>
          </div>`).join('');
    } catch (_) {
      // Ignore polling errors while servers restart
    }
  }

  el('btn-channel-open').addEventListener('click', () => withBusy(openChannel));
  el('btn-channel-ask').addEventListener('click', () => withBusy(askWithChannel));
  el('btn-channel-close').addEventListener('click', () => withBusy(closeChannel));
  el('channel-locked-list').addEventListener('click', (e) => {
    const refund = e.target.closest('[data-parked-refund]');
    const retry = e.target.closest('[data-parked-retry]');
    if (refund) withBusy(() => refundParked(parseInt(refund.dataset.parkedRefund, 10)));
    if (retry) withBusy(() => retryParked(parseInt(retry.dataset.parkedRetry, 10)));
  });
  el('btn-channel-stop').addEventListener('click', () => {
    stopRequested = true;
  });

  // Older versions kept a failed channel as the active one, which blocked opening new channels
  if (channel && channel.status !== 'OPEN') {
    parkChannel(channel.status === 'FUNDED' ? 'OPEN_FAILED' : channel.status);
  }
  [channel, ...parked].filter(Boolean).forEach(trackOnGateway);
  render();
  refreshGatewayLocked();
  setInterval(() => {
    if (!busy) renderParked(); // keep the countdowns fresh
    refreshGatewayLocked();
  }, 30000);
})();
