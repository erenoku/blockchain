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
    if (seconds <= 0) return 'açık';
    const h = Math.floor(seconds / 3600);
    const m = Math.ceil((seconds % 3600) / 60);
    return h > 0 ? `${h} sa ${m} dk kaldı` : `${m} dk kaldı`;
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
    OPEN_FAILED: 'açılamadı',
    CLOSE_FAILED: 'kapatılamadı',
    AWAITING_REFUND: 'iade bekliyor'
  };

  function renderParked() {
    const list = el('channel-locked-list');
    if (parked.length === 0) {
      list.innerHTML = '';
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const total = parked.reduce((sum, c) => sum + c.utxo.satoshis, 0);
    list.innerHTML = `<div style="font-weight:600; color:#fcd34d; margin-bottom:6px;">🔐 Kontratta kilitli: ${total} sats (${parked.length} kanal)</div>` +
      parked.map((c, i) => {
        const open = isExpired(c);
        return `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 0; border-top:1px solid rgba(255,255,255,0.08);">
          <div style="font-size:0.78rem; color:#d1d5db;">
            <b>${c.utxo.satoshis} sats</b> · ${c.providerName} · ${PARKED_LABELS[c.status] || c.status}<br>
            <span style="color:#9ca3af;">İade: ${new Date(c.params.expiry * 1000).toLocaleString()} (${formatRemaining(c.params.expiry - now)}) ·
            <a href="${explorerTx(c, c.utxo.txid)}" target="_blank" rel="noopener">kontrat TX ↗</a></span>
          </div>
          <div style="display:flex; gap:6px;">
            ${c.status === 'OPEN_FAILED' && !channel ? `<button type="button" class="btn-copy" data-parked-retry="${i}" style="padding:6px 10px; border-radius:6px; cursor:pointer;">Tekrar Aç</button>` : ''}
            <button type="button" class="btn-copy" data-parked-refund="${i}" ${open ? '' : 'disabled'} style="padding:6px 10px; border-radius:6px; cursor:${open ? 'pointer' : 'not-allowed'}; opacity:${open ? 1 : 0.5};">İade Al</button>
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
        `Kanal <code>${channel.channelId}</code> · ${channel.providerName}<br>` +
        `Harcanan: <b>${channel.paidSats}</b> / ${capacity()} sats · Kalan: <b>${capacity() - channel.paidSats}</b> sats · Son geçerlilik: ${expires}`;
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
    if (!(deposit >= 100)) throw new Error('Depozito en az 100 sats olmalı.');

    message('BSV Desktop kimliği alınıyor...');
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

    message('Provider ile kanal sözleşmesi hazırlanıyor...');
    const proposal = await post('/api/channel/prepare', {
      sessionPubKey: session.pubKey,
      buyerAddress,
      model: el('model-select').value
    });
    ChannelClient.checkProposal(proposal, { sessionPubKey: session.pubKey, buyerAddress });

    message(`BSV Desktop'ta ${deposit} sats kilitleme işlemini onaylayın...`);
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
    if (!Array.isArray(funding.tx)) throw new Error('BSV Desktop işlemi (AtomicBEEF) döndürmedi.');
    const utxo = ChannelClient.findChannelOutput(funding.tx, proposal.lockingScriptHex);

    // Save before asking the provider, so the deposit is recoverable even if opening fails
    channel = {
      status: 'FUNDED',
      channelId: proposal.channelId,
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

    message(`Kilitleme işlemi yayınlandı (${utxo.txid.slice(0, 10)}…). Provider onayı bekleniyor...`);
    try {
      await requestOpen(channel);
    } catch (err) {
      parkChannel('OPEN_FAILED');
      throw new Error(`Provider kanalı açamadı: ${err.message}. Para kontratta güvende (kilitli listede). "Tekrar Aç" deneyebilir, süre dolunca iade alabilir ya da yeni kanal açabilirsiniz.`);
    }
    channel.status = 'OPEN';
    saveChannel();
    trackOnGateway(channel);
    message('✔ Kanal açık. Artık her cevap parçası için otomatik imza atılacak.', '#10b981');
  }

  async function requestOpen(c) {
    let lastErr;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        return await post(`/api/channel/${c.channelId}/open`, c.utxo);
      } catch (err) {
        lastErr = err;
        if (!/not found|does not match/i.test(err.message)) break;
        await new Promise(r => setTimeout(r, 2000)); // wait for the funding tx to reach the explorer
      }
    }
    throw lastErr;
  }

  async function retryParked(index) {
    if (channel) throw new Error('Önce açık kanalı kapatın.');
    const c = parked[index];
    message('Provider\'dan kanalı tekrar açması isteniyor...');
    await requestOpen(c);
    parked.splice(index, 1);
    channel = { ...c, status: 'OPEN' };
    saveChannel();
    message('✔ Kanal açıldı.', '#10b981');
  }

  async function askWithChannel() {
    const prompt = el('prompt-input').value.trim();
    if (!prompt) throw new Error('Lütfen bir soru yazın.');

    const resultCard = el('result-card');
    const answerEl = el('ai-answer-content');
    resultCard.classList.remove('hidden');
    answerEl.textContent = '';
    el('token-usage-summary').textContent = '';
    const link = el('tx-explorer-link');
    link.href = `${channel.network === 'testnet' ? 'https://testnet.whatsonchain.com' : 'https://whatsonchain.com'}/tx/${channel.utxo.txid}`;
    link.textContent = `Kanal kontratı: ${channel.utxo.txid.slice(0, 10)}... (WhatsOnChain ↗)`;

    message('Provider cevabı hazırlıyor...');
    const q = await post(`/api/channel/${channel.channelId}/query`, {
      prompt,
      maxOutputTokens: getMaxOutputTokens()
    });

    // Never trust the provider's numbers blindly: cap the query at the advertised price
    const promptEstimate = Math.ceil(prompt.length / 4);
    if (q.inputTokens > promptEstimate * 2 + 100) {
      throw new Error(`Provider girdi token sayısını şüpheli bildirdi (${q.inputTokens}). Ödeme yapılmadı.`);
    }
    const capSats = ChannelClient.maxQuerySats(channel.pricing, q.inputTokens, q.maxOutputTokens);
    const allowedSats = ChannelClient.allowedQuerySats(capSats);
    if (q.totalQuerySats > allowedSats) {
      throw new Error(`Provider ${q.totalQuerySats} sats istedi; fiyat tavanı ${capSats} sats, %${ChannelClient.OVER_CAP_TOLERANCE_PCT} toleransla en fazla ${allowedSats} sats. Ödeme yapılmadı.`);
    }
    const overCapSats = Math.max(0, q.totalQuerySats - capSats);
    const state = { baseSats: channel.paidSats, capSats, lastStateSats: channel.paidSats };

    let terms = q.next;
    let chunks = 0;
    while (terms) {
      if (stopRequested) {
        message(`⏹ Durduruldu. Sadece alınan ${chunks}/${q.totalChunks} parça ödendi.`, '#f59e0b');
        break;
      }
      ChannelClient.checkChunkTerms(state, terms);
      message(`Parça ${terms.index + 1}/${q.totalChunks} için ${terms.stateSats - state.lastStateSats} sats imzalanıyor...`);
      const sessionSig = ChannelClient.signState(channel, terms.stateSats, channel.sessionWif);
      const chunk = await post(`/api/channel/${channel.channelId}/chunk`, {
        queryId: terms.queryId,
        index: terms.index,
        sessionSig
      });
      if (chunk.paidSats !== terms.stateSats) throw new Error('Provider farklı bir tutar kaydetti, durduruldu.');

      answerEl.textContent += chunk.text;
      state.lastStateSats = terms.stateSats;
      channel.paidSats = terms.stateSats;
      saveChannel();
      chunks += 1;
      render();
      terms = chunk.next;
    }

    const querySats = state.lastStateSats - state.baseSats;
    el('token-usage-summary').textContent =
      `Bu soru: ${querySats} sats (${chunks}/${q.totalChunks} parça, ${q.inputTokens} girdi token) · ` +
      `Fiyat tavanı ${capSats} sats idi${overCapSats > 0 ? ` (provider tavanı ${overCapSats} sats aştı, %${ChannelClient.OVER_CAP_TOLERANCE_PCT} tolerans içinde olduğu için ödendi)` : ''} · ` +
      `Kanalda kalan: ${capacity() - channel.paidSats} sats`;
    if (!stopRequested) message('✔ Cevap tamamlandı.', '#10b981');
    if (typeof refreshState === 'function') refreshState();
  }

  async function closeChannel() {
    // An unused channel closes with a 1-sat state instead of waiting for expiry
    const closeSig = channel.paidSats === 0
      ? ChannelClient.signState(channel, 1, channel.sessionWif)
      : undefined;

    message('Provider kanalı kapatıyor ve zincire yazıyor...');
    let closed;
    try {
      closed = await post(`/api/channel/${channel.channelId}/close`, { closeSig });
    } catch (err) {
      const expiry = new Date(channel.params.expiry * 1000).toLocaleString();
      parkChannel('CLOSE_FAILED');
      throw new Error(`Provider kanalı kapatamadı (${err.message}). Para kilitli listede; ${expiry} sonrası "İade Al" ile geri alabilirsiniz. Yeni kanal açabilirsiniz.`);
    }

    if (!closed.settleTx) {
      const expiry = new Date(channel.params.expiry * 1000).toLocaleString();
      parkChannel('AWAITING_REFUND');
      throw new Error(`Provider kapanış işlemi üretmedi. Para kilitli listede; ${expiry} sonrası "İade Al" ile geri alabilirsiniz.`);
    }

    let refunded = null;
    {
      try {
        refunded = await internalizeRefund(channel, closed.settleTx);
      } catch (err) {
        message(`Kanal kapandı (${closed.settleTxid}), ancak iade cüzdana otomatik alınamadı: ${err.message}`, '#f59e0b');
        channel = null;
        saveChannel();
        return;
      }
    }
    message(`✔ Kanal kapandı. Provider'a ${closed.paidSats} sats ödendi${refunded ? `, ${refunded} sats cüzdanınıza geri döndü` : ''}. TX: ${closed.settleTxid}`, '#10b981');
    channel = null;
    saveChannel();
  }

  async function refundParked(index) {
    const c = parked[index];
    if (!isExpired(c)) {
      throw new Error(`İade ${new Date(c.params.expiry * 1000).toLocaleString()} tarihinden sonra alınabilir (${formatRemaining(c.params.expiry - Math.floor(Date.now() / 1000))}).`);
    }
    message('İade işlemi hazırlanıyor...');
    const r = await post('/api/channel/refund', { channelId: c.channelId, params: c.params, utxo: c.utxo });
    parked.splice(index, 1);
    saveChannel();
    let refunded;
    try {
      refunded = await internalizeRefund(c, r.refundTx);
    } catch (err) {
      message(`İade zincire yazıldı (${r.refundTxid}), ancak cüzdana otomatik alınamadı: ${err.message}`, '#f59e0b');
      return;
    }
    message(`✔ ${refunded} sats cüzdanınıza geri döndü. TX: ${r.refundTxid}`, '#10b981');
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
        ? '<div class="empty-state">Kontratta kilitli para yok.</div>'
        : locked.map(c => `
          <div class="swap-item">
            <div>
              <div style="font-size:0.8rem;">${c.depositSats} sats · ${c.providerName}</div>
              <div style="font-size:0.7rem; color:#9ca3af;">${c.status} · iade ${formatRemaining(c.expiry - now)}${c.onchain.state === 'unknown' ? ' · zincir durumu bilinmiyor' : ''}</div>
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
