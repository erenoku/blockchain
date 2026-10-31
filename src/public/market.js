/**
 * Marketplace: list providers, filter by model, pick provider + model.
 * The choice is kept in localStorage ('bsv_selected_provider') for the ask page.
 */
(function () {
  const SELECTION_KEY = 'bsv_selected_provider';
  const el = (id) => document.getElementById(id);
  let providers = [];

  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function selection() {
    try { return JSON.parse(localStorage.getItem(SELECTION_KEY)) || null; } catch (_) { return null; }
  }

  function statusPill(p) {
    if (p.available) return '<span class="status-pill ok">Çevrimiçi</span>';
    if (p.status === 'error') return '<span class="status-pill error">Hizmet dışı</span>';
    return '<span class="status-pill off">Çevrimdışı</span>';
  }

  function statsLine(p) {
    if (!p.stats) return p.hosted ? 'Henüz soru yanıtlamadı' : 'Kendi sunucusunda çalışan node';
    const parts = [`24 saatte ${p.stats.queries24h} soru`];
    if (p.stats.successRate !== null) parts.push(`%${Math.round(p.stats.successRate * 100)} başarı`);
    if (p.stats.avgLatencyMs) parts.push(`ort. ${(p.stats.avgLatencyMs / 1000).toFixed(1)} sn`);
    return parts.join(' · ');
  }

  function render() {
    const model = el('filter-model').value;
    const sort = el('sort-by').value;
    const current = selection();
    let list = providers.filter(p => !model || p.models.includes(model));
    list = list.slice().sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      if (sort === 'input') return a.pricing.inputPer1k - b.pricing.inputPer1k;
      if (sort === 'speed') return (a.stats?.avgLatencyMs ?? Infinity) - (b.stats?.avgLatencyMs ?? Infinity);
      return a.pricing.outputPer1k - b.pricing.outputPer1k;
    });

    el('provider-grid').innerHTML = list.length === 0
      ? `<div class="empty-state">${model ? 'Bu modeli sunan provider yok.' : 'Henüz provider yok.'}</div>`
      : list.map(p => `
        <article class="card provider-offer${current && current.providerId === p.id ? ' selected' : ''}">
          <div class="offer-head">
            <h3>${esc(p.name)}</h3>
            ${statusPill(p)}
          </div>
          <div class="offer-prices">
            <div><span class="hint">Girdi</span><b>${p.pricing.inputPer1k}</b></div>
            <div><span class="hint">Çıktı</span><b>${p.pricing.outputPer1k}</b></div>
            <div><span class="hint">En az</span><b>${p.pricing.minSats}</b></div>
          </div>
          <div class="hint">${statsLine(p)}</div>
          <div class="offer-models">
            ${p.models.filter(m => !model || m === model).map(m => `
              <button type="button" class="model-check offer-model${current && current.providerId === p.id && current.model === m ? ' active' : ''}"
                data-provider="${esc(p.id)}" data-model="${esc(m)}" ${p.available ? '' : 'disabled'}>${esc(m)}</button>
            `).join('')}
          </div>
        </article>`).join('');
  }

  function choose(providerId, model) {
    const p = providers.find(x => x.id === providerId);
    if (!p || !p.available) return;
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ providerId, providerName: p.name, model, models: p.models, pricing: p.pricing }));
    location.href = '/';
  }

  async function load() {
    const data = await Session.api('/api/market');
    providers = data.providers;
    const models = [...new Set(providers.flatMap(p => p.models))].sort();
    const filter = el('filter-model');
    const keep = filter.value;
    filter.innerHTML = '<option value="">Tüm modeller</option>' + models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    filter.value = models.includes(keep) ? keep : '';
    el('market-updated').textContent = `${providers.filter(p => p.available).length} provider çevrimiçi`;
    render();
  }

  el('filter-model').addEventListener('change', render);
  el('sort-by').addEventListener('change', render);
  el('provider-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-model]');
    if (btn) choose(btn.dataset.provider, btn.dataset.model);
  });

  (async () => {
    await Session.requireLogin();
    await load();
    setInterval(() => load().catch(() => {}), 15000);
  })();
})();
