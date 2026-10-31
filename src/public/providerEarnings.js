/**
 * Provider earnings: settled channels and "Cüzdana al", which internalizes the
 * provider's settlement output into BSV Desktop (BRC-29 wallet payment).
 * Depends on window.bsv, ChannelClient and Session.
 */
(function () {
  const el = (id) => document.getElementById(id);
  let data = null;
  let provider = null;
  let user = null;

  const STATUS = { OPEN: 'açık', CLOSED: 'kapandı', OPEN_FAILED: 'açılamadı', REFUNDED: 'iade edildi', PROPOSED: 'hazırlandı' };

  function render() {
    const t = data.totals;
    el('earnings-total').textContent = `Toplam ${t.earnedSats} sats · cüzdanda ${t.claimedSats} · bekleyen ${t.unclaimedSats} · açık kanallarda ${t.openSats}`;
    const rows = data.channels;
    el('earnings-list').innerHTML = rows.length === 0
      ? '<div class="empty-state">Henüz kanal yok. Customer\'lar sizi seçtikçe burada görünecek.</div>'
      : `<div class="table-wrap"><table class="earnings-table">
          <thead><tr><th>Kanal</th><th>Model</th><th>Durum</th><th class="num">Kazanç</th><th></th></tr></thead>
          <tbody>${rows.map(c => {
            let action = '';
            if (c.status === 'CLOSED' && c.settleTxid && c.paidSats > 0) {
              const d = c.payoutDelivery;
              if (c.claimedAt) action = '<span class="status-pill ok">Cüzdanda</span>';
              else if (c.payoutMode === 'identity' && d && d.delivered) action = '<span class="status-pill ok" title="BSV Desktop gelen ödemeler kutusuna gönderildi">BSV Desktop\'a gönderildi</span>';
              else if (c.payoutMode === 'identity') {
                action = `<button type="button" class="btn-secondary" data-redeliver="${c.channelId}">${d ? 'Tekrar gönder' : 'Gönder'}</button> `;
                if (c.settleTx && c.fundingBeefHex) action += `<button type="button" class="btn-secondary" data-claim="${c.channelId}">Cüzdana al</button>`;
              }
              else if (c.settleTx && c.fundingBeefHex) action = `<button type="button" class="btn-secondary" data-claim="${c.channelId}">Cüzdana al</button>`;
              else action = '<span class="hint" title="Bu kanal için gerekli işlem verisi yok">Otomatik alınamaz</span>';
            }
            return `<tr>
              <td title="${c.channelId}">${c.channelId.slice(0, 11)}…</td>
              <td>${c.model || '-'}</td>
              <td>${STATUS[c.status] || c.status}</td>
              <td class="num">${c.paidSats}</td>
              <td>${action}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>`;
  }

  async function claim(channelId) {
    const c = data.channels.find(x => x.channelId === channelId);
    const btn = document.querySelector(`[data-claim="${channelId}"]`);
    btn.disabled = true;
    btn.textContent = 'BSV Desktop onayı bekleniyor...';
    try {
      const outputIndex = ChannelClient.findRefundOutput(c.settleTx, c.payout.address);
      if (outputIndex < 0) throw new Error('Kapanış işleminde ödeme çıktınız bulunamadı.');
      await Session.wallet('internalizeAction', {
        tx: ChannelClient.closingTxBeef(c.settleTx, bsv.Utils.toArray(c.fundingBeefHex, 'hex')),
        outputs: [{
          outputIndex,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: c.payout.prefix,
            derivationSuffix: c.payout.suffix,
            senderIdentityKey: c.payout.senderIdentityKey
          }
        }],
        description: 'AI provider earnings',
        labels: ['ai-provider-earnings']
      });
      await Session.api(`/api/provider/earnings/${channelId}/claimed`, { method: 'POST', body: '{}' });
      await refresh(provider, user);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Cüzdana al';
      alert(`Kazanç cüzdana alınamadı: ${err.message}`);
    }
  }

  async function refresh(p, u) {
    provider = p;
    user = u;
    data = await Session.api('/api/provider/earnings');
    render();
  }

  async function redeliver(channelId) {
    const btn = document.querySelector(`[data-redeliver="${channelId}"]`);
    btn.disabled = true;
    btn.textContent = 'Gönderiliyor...';
    try {
      await Session.api(`/api/provider/earnings/${channelId}/redeliver`, { method: 'POST', body: '{}' });
      await refresh(provider, user);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Tekrar gönder';
      alert(err.message);
    }
  }

  el('earnings-list').addEventListener('click', (e) => {
    const claimBtn = e.target.closest('[data-claim]');
    if (claimBtn) claim(claimBtn.dataset.claim);
    const redeliverBtn = e.target.closest('[data-redeliver]');
    if (redeliverBtn) redeliver(redeliverBtn.dataset.redeliver);
  });

  window.ProviderEarnings = { refresh };
})();
