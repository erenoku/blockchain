/**
 * Provider page: onboarding form (API keys, models, pricing) and dashboard.
 */
(function () {
  const ENGINES = ['openai', 'gemini'];
  const el = (id) => document.getElementById(id);

  let user = null;
  let provider = null;
  // Models each engine can serve: from a fresh key test, or from the stored key
  const engineModels = { openai: [], gemini: [] };
  const testedKeys = {}; // engine -> key text that passed the test

  function message(text, color = 'var(--text-muted)') {
    el('form-message').innerHTML = `<span style="color:${color}">${text}</span>`;
  }

  function renderModels(selected) {
    const all = [...new Set([...engineModels.openai, ...engineModels.gemini])];
    const box = el('model-checks');
    if (all.length === 0) {
      box.innerHTML = '<span class="hint">Test an API key first.</span>';
      return;
    }
    const checked = new Set(selected || [...box.querySelectorAll('input:checked')].map(i => i.value));
    box.innerHTML = all.map(m => `
      <label class="model-check"><input type="checkbox" value="${m}" ${checked.has(m) ? 'checked' : ''}>${m}</label>
    `).join('');
  }

  function renderKeyStatus() {
    for (const engine of ENGINES) {
      const stored = provider && provider.keys.find(k => k.engine === engine);
      const status = el(`key-status-${engine}`);
      const removeBtn = document.querySelector(`[data-remove="${engine}"]`);
      removeBtn.classList.toggle('hidden', !stored);
      if (testedKeys[engine]) {
        status.innerHTML = `<span style="color:var(--green)">✔ Key valid · ${engineModels[engine].length} models</span>`;
      } else if (stored) {
        status.textContent = `Saved key: ••••${stored.last4} · ${stored.models.length} models. Enter and test a new key to replace it.`;
      } else {
        status.textContent = '';
      }
    }
  }

  function render() {
    const exists = !!provider;
    el('page-title').textContent = exists ? provider.name : 'Become a Provider';
    el('status-card').classList.toggle('hidden', !exists);
    el('earnings-card').classList.toggle('hidden', !exists);
    el('btn-save').innerHTML = `<span>${exists ? 'Save changes' : 'Save and publish'}</span>`;
    if (!exists) return;

    el('page-sub').textContent = 'Update your settings. Your earnings are listed below; use "Claim to wallet" to transfer them into BSV Desktop.';
    const pill = el('status-pill');
    if (!provider.enabled) {
      pill.className = 'status-pill off';
      pill.textContent = 'Offline';
    } else if (provider.status === 'error') {
      pill.className = 'status-pill error';
      pill.textContent = 'Error';
    } else {
      pill.className = 'status-pill ok';
      pill.textContent = 'Live';
    }
    el('status-text').innerHTML =
      (provider.status === 'error' && provider.statusReason ? `<b>${provider.statusReason}</b><br>` : '') +
      `Payout address: <code>${provider.payoutAddress}</code> · ${provider.models.length} models offered`;
    el('btn-toggle').textContent = provider.enabled ? 'Take offline' : 'Go live';
  }

  function payoutMode() {
    return document.querySelector('input[name="payout-mode"]:checked').value;
  }

  function renderPayoutChoice() {
    el('payout-identity-field').classList.toggle('hidden', payoutMode() !== 'identity');
  }

  function fillForm() {
    el('f-name').value = provider.name;
    el('f-payout-identity').value = provider.payoutIdentityKey || user.identityKey;
    el('payout-current').innerHTML = provider.payoutMode === 'identity'
      ? `Payouts go to identity key: <code>${provider.payoutIdentityKey}</code>`
      : 'Payouts go to your signed-in BSV Desktop wallet (via "Claim to wallet").';
    renderPayoutChoice();
    el('f-in').value = provider.pricing.inputPer1k;
    el('f-out').value = provider.pricing.outputPer1k;
    el('f-min').value = provider.pricing.minSats;
    for (const k of provider.keys) engineModels[k.engine] = k.models;
    renderModels(provider.models);
  }

  async function testKey(engine) {
    const apiKey = el(`key-${engine}`).value.trim();
    const status = el(`key-status-${engine}`);
    if (!apiKey) {
      status.textContent = 'Enter an API key first.';
      return;
    }
    status.textContent = 'Testing...';
    try {
      const r = await Session.api('/api/provider/validate-key', { method: 'POST', body: JSON.stringify({ engine, apiKey }) });
      engineModels[engine] = r.models;
      testedKeys[engine] = apiKey;
      renderModels();
      renderKeyStatus();
    } catch (err) {
      delete testedKeys[engine];
      status.innerHTML = `<span style="color:var(--gold)">⚠ ${err.message}</span>`;
    }
  }

  async function removeKey(engine) {
    if (!confirm(`Remove ${engine === 'openai' ? 'OpenAI' : 'Gemini'} key? Models served by this key will be removed from the marketplace.`)) return;
    try {
      provider = (await Session.api(`/api/provider/me/keys/${engine}`, { method: 'DELETE' })).provider;
      engineModels[engine] = [];
      delete testedKeys[engine];
      fillForm();
      render();
      renderKeyStatus();
    } catch (err) {
      message(`⚠ ${err.message}`, 'var(--gold)');
    }
  }

  async function save(e) {
    e.preventDefault();
    const btn = el('btn-save');
    btn.disabled = true;
    try {
      // A typed but untested key would silently not be saved
      for (const engine of ENGINES) {
        const typed = el(`key-${engine}`).value.trim();
        if (typed && testedKeys[engine] !== typed) throw new Error(`Please verify your ${engine === 'openai' ? 'OpenAI' : 'Gemini'} key using "Test" before saving.`);
      }
      const models = [...el('model-checks').querySelectorAll('input:checked')].map(i => i.value);
      const body = {
        name: el('f-name').value.trim(),
        models,
        pricing: { inputPer1k: Number(el('f-in').value), outputPer1k: Number(el('f-out').value), minSats: Number(el('f-min').value) },
        keys: ENGINES.filter(e => testedKeys[e]).map(engine => ({ engine, apiKey: testedKeys[engine] }))
      };
      if (payoutMode() === 'identity') {
        const identityKey = el('f-payout-identity').value.trim().toLowerCase();
        if (!/^(02|03)[0-9a-f]{64}$/.test(identityKey)) {
          throw new Error(`Identity key must be 66 characters and start with 02 or 03 (${identityKey.length} characters entered).`);
        }
        if (!provider || provider.payoutMode !== 'identity' || provider.payoutIdentityKey !== identityKey) body.payout = { identityKey };
      }
      message('Saving...');
      provider = (await Session.api('/api/provider/setup', { method: 'POST', body: JSON.stringify(body) })).provider;
      for (const engine of ENGINES) {
        el(`key-${engine}`).value = '';
        delete testedKeys[engine];
      }
      fillForm();
      render();
      renderKeyStatus();
      if (window.ProviderEarnings) ProviderEarnings.refresh(provider, user);
      message('✔ Saved.', 'var(--green)');
    } catch (err) {
      message(`⚠ ${err.message}`, 'var(--gold)');
    } finally {
      btn.disabled = false;
    }
  }

  async function toggle() {
    try {
      provider = (await Session.api('/api/provider/me/enabled', { method: 'POST', body: JSON.stringify({ enabled: !provider.enabled }) })).provider;
      render();
    } catch (err) {
      message(`⚠ ${err.message}`, 'var(--gold)');
    }
  }

  document.querySelectorAll('[data-test]').forEach(b => b.addEventListener('click', () => testKey(b.dataset.test)));
  document.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => removeKey(b.dataset.remove)));
  el('provider-form').addEventListener('submit', save);
  document.querySelectorAll('input[name="payout-mode"]').forEach(r => r.addEventListener('change', renderPayoutChoice));
  el('btn-toggle').addEventListener('click', toggle);

  const refreshEarningsBtn = el('btn-refresh-earnings');
  if (refreshEarningsBtn) {
    refreshEarningsBtn.addEventListener('click', async () => {
      refreshEarningsBtn.disabled = true;
      refreshEarningsBtn.textContent = '...';
      try {
        if (window.ProviderEarnings && provider && user) {
          await ProviderEarnings.refresh(provider, user);
        }
      } finally {
        refreshEarningsBtn.disabled = false;
        refreshEarningsBtn.textContent = '↻ Refresh';
      }
    });
  }

  (async () => {
    user = await Session.requireLogin();
    el('f-payout-identity').value = user.identityKey;
    provider = (await Session.api('/api/provider/me')).provider;
    if (provider) fillForm();
    render();
    renderKeyStatus();
    if (provider && window.ProviderEarnings) {
      ProviderEarnings.refresh(provider, user);
      setInterval(() => {
        ProviderEarnings.refresh(provider, user).catch(() => {});
      }, 4000);
    }
  })();
})();
