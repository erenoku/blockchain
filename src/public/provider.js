/**
 * Provider page: onboarding form (API keys, models, pricing) and dashboard.
 */
(function () {
  const BRC29_PROTOCOL = [2, '3241645161d8'];
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

  function randomBase64(bytes) {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return btoa(String.fromCharCode(...buf));
  }

  function renderModels(selected) {
    const all = [...new Set([...engineModels.openai, ...engineModels.gemini])];
    const box = el('model-checks');
    if (all.length === 0) {
      box.innerHTML = '<span class="hint">Önce bir API anahtarını test edin.</span>';
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
        status.innerHTML = `<span style="color:var(--green)">✔ Anahtar geçerli · ${engineModels[engine].length} model</span>`;
      } else if (stored) {
        status.textContent = `Kayıtlı anahtar: ••••${stored.last4} · ${stored.models.length} model. Değiştirmek için yenisini yazıp test edin.`;
      } else {
        status.textContent = '';
      }
    }
  }

  function render() {
    const exists = !!provider;
    el('page-title').textContent = exists ? provider.name : 'Provider ol';
    el('status-card').classList.toggle('hidden', !exists);
    el('earnings-card').classList.toggle('hidden', !exists);
    el('btn-save').innerHTML = `<span>${exists ? 'Değişiklikleri kaydet' : 'Kaydet ve yayına al'}</span>`;
    if (!exists) return;

    el('page-sub').textContent = 'Ayarlarınızı güncelleyin. Kazançlarınız aşağıda; "Cüzdana al" ile BSV Desktop\'a aktarabilirsiniz.';
    const pill = el('status-pill');
    if (!provider.enabled) {
      pill.className = 'status-pill off';
      pill.textContent = 'Yayında değil';
    } else if (provider.status === 'error') {
      pill.className = 'status-pill error';
      pill.textContent = 'Hata';
    } else {
      pill.className = 'status-pill ok';
      pill.textContent = 'Yayında';
    }
    el('status-text').innerHTML =
      (provider.status === 'error' && provider.statusReason ? `<b>${provider.statusReason}</b><br>` : '') +
      `Ödeme adresi: <code>${provider.payoutAddress}</code> · ${provider.models.length} model sunuluyor`;
    el('btn-toggle').textContent = provider.enabled ? 'Yayından kaldır' : 'Yayına al';
  }

  function payoutMode() {
    return document.querySelector('input[name="payout-mode"]:checked').value;
  }

  function renderPayoutChoice() {
    el('payout-identity-field').classList.toggle('hidden', payoutMode() !== 'identity');
  }

  function fillForm() {
    el('f-name').value = provider.name;
    document.querySelector(`input[name="payout-mode"][value="${provider.payoutMode}"]`).checked = true;
    el('f-payout-identity').value = provider.payoutIdentityKey || user.identityKey;
    el('payout-current').innerHTML = provider.payoutMode === 'identity'
      ? `Ödemeler şu kimlik anahtarına gidiyor: <code>${provider.payoutIdentityKey}</code>`
      : 'Ödemeler giriş yaptığınız BSV Desktop cüzdanına gidiyor ("Cüzdana al" ile).';
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
      status.textContent = 'Önce anahtarı yazın.';
      return;
    }
    status.textContent = 'Test ediliyor...';
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
    if (!confirm(`${engine === 'openai' ? 'OpenAI' : 'Gemini'} anahtarı silinsin mi? Bu anahtarla sunulan modeller pazaryerinden kalkar.`)) return;
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

  /** BRC-29 key of the provider's own wallet; earnings sent there can be claimed into BSV Desktop. */
  async function derivePayout() {
    const prefix = randomBase64(12);
    const suffix = randomBase64(12);
    const { publicKey } = await Session.wallet('getPublicKey', {
      protocolID: BRC29_PROTOCOL,
      keyID: `${prefix} ${suffix}`,
      counterparty: user.identityKey
    });
    return { publicKey, prefix, suffix };
  }

  async function save(e) {
    e.preventDefault();
    const btn = el('btn-save');
    btn.disabled = true;
    try {
      // A typed but untested key would silently not be saved
      for (const engine of ENGINES) {
        const typed = el(`key-${engine}`).value.trim();
        if (typed && testedKeys[engine] !== typed) throw new Error(`${engine === 'openai' ? 'OpenAI' : 'Gemini'} anahtarını kaydetmeden önce "Test et" ile doğrulayın.`);
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
          throw new Error(`Kimlik anahtarı 66 karakter olmalı ve 02 veya 03 ile başlamalı (${identityKey.length} karakter girildi).`);
        }
        if (!provider || provider.payoutMode !== 'identity' || provider.payoutIdentityKey !== identityKey) body.payout = { identityKey };
      } else if (!provider || provider.payoutMode !== 'wallet') {
        // A fresh BSV Desktop key only when first choosing the wallet option
        message('BSV Desktop\'tan ödeme anahtarı alınıyor...');
        body.payout = await derivePayout();
      }
      message('Kaydediliyor...');
      provider = (await Session.api('/api/provider/setup', { method: 'POST', body: JSON.stringify(body) })).provider;
      for (const engine of ENGINES) {
        el(`key-${engine}`).value = '';
        delete testedKeys[engine];
      }
      fillForm();
      render();
      renderKeyStatus();
      if (window.ProviderEarnings) ProviderEarnings.refresh(provider, user);
      message('✔ Kaydedildi.', 'var(--green)');
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

  (async () => {
    user = await Session.requireLogin();
    el('f-payout-identity').value = user.identityKey;
    provider = (await Session.api('/api/provider/me')).provider;
    if (provider) fillForm();
    render();
    renderKeyStatus();
    if (provider && window.ProviderEarnings) ProviderEarnings.refresh(provider, user);
  })();
})();
