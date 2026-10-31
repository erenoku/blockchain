/**
 * Locked-funds page: every TokenChannel this gateway brokered, with how much
 * is still locked in the contract on-chain (from GET /api/channels).
 */
(function () {
  const REFRESH_MS = 15000;
  const el = (id) => document.getElementById(id);
  let filter = 'locked';
  let lastData = null;

  const STATUS_TEXT = {
    PROPOSED: 'hazırlandı',
    OPEN: 'açık',
    OPEN_FAILED: 'açılamadı',
    CLOSED: 'kapandı',
    REFUNDED: 'iade edildi'
  };
  const ONCHAIN = {
    locked: ['locked', 'Kilitli'],
    spent: ['spent', 'Serbest'],
    unknown: ['unknown', 'Bilinmiyor'],
    unfunded: ['unknown', 'Yatırılmadı']
  };

  const fmt = (n) => Number(n || 0).toLocaleString('tr-TR');

  function remaining(expiry) {
    const s = expiry - Math.floor(Date.now() / 1000);
    if (s <= 0) return '<span style="color:var(--green)">açık</span>';
    const h = Math.floor(s / 3600);
    const m = Math.ceil((s % 3600) / 60);
    return h > 0 ? `${h} sa ${m} dk` : `${m} dk`;
  }

  function txLink(base, txid, label) {
    return txid ? `<a href="${base}/tx/${txid}" target="_blank" rel="noopener" title="${txid}">${label} ${txid.slice(0, 8)}… ↗</a>` : '';
  }

  function render() {
    const data = lastData;
    if (!data) return;
    const base = data.network === 'testnet' ? 'https://testnet.whatsonchain.com' : 'https://whatsonchain.com';
    const rows = data.channels;
    const stillLocked = rows.filter(c => c.onchain.state === 'locked' || c.onchain.state === 'unknown');
    const refundOpen = stillLocked.filter(c => c.refundOpen);
    const paid = rows.filter(c => c.onchain.state === 'spent').reduce((sum, c) => sum + (c.paidSats || 0), 0);

    el('network-badge').textContent = `BSV ${data.network.toUpperCase()}`;
    el('t-locked').textContent = `${fmt(data.totalLockedSats)} sats`;
    el('t-locked-sub').textContent = `${data.lockedChannels} kanal`;
    el('t-refund').textContent = `${fmt(refundOpen.reduce((s, c) => s + c.depositSats, 0))} sats`;
    el('t-refund-sub').textContent = `${refundOpen.length} kanal şu an iade edilebilir`;
    el('t-paid').textContent = `${fmt(paid)} sats`;
    el('t-total').textContent = rows.length;
    el('t-total-sub').textContent = `${rows.length - stillLocked.length} kapandı/iade edildi`;

    const shown = filter === 'locked' ? stillLocked : rows;
    el('rows').innerHTML = shown.length === 0
      ? `<tr><td colspan="8" class="muted">${filter === 'locked' ? 'Kontratta kilitli para yok.' : 'Henüz kanal yok.'}</td></tr>`
      : shown.map(c => {
        const [cls, label] = ONCHAIN[c.onchain.state] || ONCHAIN.unknown;
        const isLocked = c.onchain.state === 'locked' || c.onchain.state === 'unknown';
        return `<tr>
          <td><span class="badge ${cls}">${label}</span></td>
          <td><span title="${c.channelId}">${c.channelId.slice(0, 11)}…</span><br><span class="muted">${STATUS_TEXT[c.status] || c.status}</span></td>
          <td>${c.providerName || '-'}</td>
          <td class="num">${fmt(c.depositSats)}</td>
          <td class="num">${fmt(c.paidSats)}</td>
          <td class="num">${isLocked ? fmt(c.refundableSats || c.depositSats - (c.paidSats || 0)) : '<span class="muted">–</span>'}</td>
          <td>${isLocked ? `${new Date(c.expiry * 1000).toLocaleString('tr-TR')}<br><span class="muted">${remaining(c.expiry)}</span>` : '<span class="muted">–</span>'}</td>
          <td>${[
            txLink(base, c.fundingTxid, 'kilit'),
            txLink(base, c.settleTxid, 'kapanış'),
            txLink(base, c.refundTxid, 'iade'),
            c.onchain.state === 'spent' && !c.settleTxid && !c.refundTxid ? txLink(base, c.onchain.spentBy, 'harcayan') : ''
          ].filter(Boolean).join('<br>')}</td>
        </tr>`;
      }).join('');
  }

  async function refresh() {
    try {
      const res = await fetch('/api/channels', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      lastData = await res.json();
      el('updated').textContent = `Son güncelleme: ${new Date().toLocaleTimeString('tr-TR')} · her 15 sn yenilenir`;
      render();
    } catch (err) {
      el('updated').textContent = `Gateway'e ulaşılamadı (${err.message}), tekrar denenecek...`;
    }
  }

  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === btn));
      render();
    });
  });

  Session.requireLogin().then(() => {
    refresh();
    setInterval(refresh, REFRESH_MS);
  });
})();
