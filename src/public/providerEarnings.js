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

  const STATUS = { OPEN: 'open', CLOSED: 'closed', OPEN_FAILED: 'open failed', REFUNDED: 'refunded', PROPOSED: 'prepared' };

  function render() {
    if (!data || !data.totals) return;
    const t = data.totals;
    const totalEarned = (t.totalSats !== undefined) ? t.totalSats : ((t.earnedSats || 0) + (t.openSats || 0));
    el('earnings-total').textContent = `Total ${totalEarned} sats (${t.earnedSats} settled · ${t.openSats} in open channels) · claimed ${t.claimedSats} · unclaimed ${t.unclaimedSats}`;
    const rows = data.channels || [];
    el('earnings-list').innerHTML = rows.length === 0
      ? '<div class="empty-state">No channels yet. Channels will appear here as customers select you.</div>'
      : `<div class="table-wrap"><table class="earnings-table">
          <thead><tr><th>Channel</th><th>Model</th><th>Status</th><th class="num">Earned</th><th></th></tr></thead>
          <tbody>${rows.map(c => {
            let action = '';
            if (c.status === 'CLOSED' && c.settleTxid && c.paidSats > 0) {
              const d = c.payoutDelivery;
              if (c.claimedAt) action = '<span class="status-pill ok">In wallet</span>';
              else if (c.payoutMode === 'identity' && d && d.delivered) action = '<span class="status-pill ok" title="Sent to BSV Desktop incoming payments inbox">Sent to BSV Desktop</span>';
              else if (c.payoutMode === 'identity') {
                action = `<button type="button" class="btn-secondary" data-redeliver="${c.channelId}">${d ? 'Resend' : 'Send'}</button> `;
                if (c.settleTx && c.fundingBeefHex) action += `<button type="button" class="btn-secondary" data-claim="${c.channelId}">Claim to wallet</button>`;
              }
              else if (c.settleTx && c.fundingBeefHex) action = `<button type="button" class="btn-secondary" data-claim="${c.channelId}">Claim to wallet</button>`;
              else action = '<span class="hint" title="Missing transaction data for this channel">Cannot claim automatically</span>';
            } else if (c.status === 'OPEN') {
              action = `<span class="status-pill ok" style="font-size:11px;">Active (${c.paidSats} sats paid)</span>`;
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
    btn.textContent = 'Awaiting BSV Desktop approval...';
    try {
      const outputIndex = ChannelClient.findRefundOutput(c.settleTx, c.payout.address);
      if (outputIndex < 0) throw new Error('Your payout output was not found in the closing transaction.');
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
      btn.textContent = 'Claim to wallet';
      alert(`Could not claim earnings to wallet: ${err.message}`);
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
    btn.textContent = 'Sending...';
    try {
      await Session.api(`/api/provider/earnings/${channelId}/redeliver`, { method: 'POST', body: '{}' });
      await refresh(provider, user);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Resend';
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
