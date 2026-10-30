// Safe JSON fetch wrapper that never throws "JSON.parse: unexpected character"
async function safeFetchJson(url, options = {}) {
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {})
  };
  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`[HTTP ${res.status}] ${text.slice(0, 150) || res.statusText || 'Geçersiz yanıt'}`);
  }
  if (!res.ok) {
    throw new Error(json.message || json.description || json.error || `[HTTP ${res.status}] ${text.slice(0, 100)}`);
  }
  return json;
}

// Fetch and render system status, active providers, and recent swaps
async function refreshState() {
  try {
    const data = await safeFetchJson('/api/status');

    document.getElementById('network-badge').textContent = `BSV ${data.network.toUpperCase()}`;
    document.getElementById('provider-count').textContent = data.activeProviders;
    document.getElementById('total-sats-count').textContent = data.totalSatsSwapped.toLocaleString();

    // Render Recent Swaps
    const swapsContainer = document.getElementById('swaps-history');
    if (data.recentSwaps && data.recentSwaps.length > 0) {
      swapsContainer.innerHTML = data.recentSwaps.map(s => `
        <div class="swap-item">
          <div>
            <a class="swap-tx" href="${data.explorerUrl}/tx/${s.txid}" target="_blank" rel="noopener">
              ${s.txid.slice(0, 8)}...${s.txid.slice(-6)} ↗
            </a>
            <div style="font-size:0.7rem; color:#9ca3af;">${s.model}</div>
          </div>
          <div class="swap-sats">+${s.sats} sats</div>
        </div>
      `).join('');
    } else {
      swapsContainer.innerHTML = '<div class="empty-state">Henüz swap yok. İlk swapı yapın!</div>';
    }
  } catch (err) {
    // Silently ignore polling network errors when servers restart
  }

  // Refresh Providers list
  try {
    const data = await safeFetchJson('/api/providers');

    const provContainer = document.getElementById('providers-list');
    if (data.providers && data.providers.length > 0) {
      provContainer.innerHTML = data.providers.map(p => `
        <div class="provider-card">
          <div class="name-row">
            <span>${p.name}</span>
            <span class="pricing">${p.pricing ? `${p.pricing.inputPer1k}/${p.pricing.outputPer1k} sats per 1K` : '-'}</span>
          </div>
          <div class="addr" title="${p.identityKey || p.bsvAddress}">
            ${p.identityKey ? `ID Key: ${p.identityKey.slice(0, 12)}...${p.identityKey.slice(-8)}` : `Payout: ${p.bsvAddress}`}
          </div>
          <div style="font-size:0.75rem; color:#10b981;">● Online (${(p.supportedModels || [p.model]).join(', ')})</div>
        </div>
      `).join('');

      const best = data.providers[0];
      if (best) {
        if (!lastQuote) updateQuote();

      }
    } else {
      provContainer.innerHTML = '<div class="empty-state">Aktif provider bulunamadı. Provider node çalıştırın!</div>';
    }
  } catch (err) {
    // Silently ignore polling network errors when servers restart
  }
}

// Live token-based price estimate for the current prompt + output cap
let lastQuote = null;
let quoteTimer = null;

function getMaxOutputTokens() {
  const el = document.getElementById('max-output-select');
  return el ? parseInt(el.value, 10) : undefined;
}

function renderQuote(q) {
  document.getElementById('display-fee-sats').textContent = `${q.amountSats} Sats`;
  document.getElementById('display-fee-usd').textContent = `~$${q.estimatedUsd} USD`;
  const source = q.tokenCountSource === 'gemini' ? 'Gemini tokenizer' : 'tahmini';
  document.getElementById('quote-breakdown').textContent =
    `Girdi: ${q.inputTokens} token (${source}) = ${q.inputSats} sats · ` +
    `Çıktı tavanı: ${q.maxOutputTokens} token = ${q.outputSats} sats · ` +
    `Toplam: ${q.amountSats} sats (min ${q.pricing.minSats})`;
}

async function updateQuote() {
  const prompt = document.getElementById('prompt-input').value.trim();
  const breakdown = document.getElementById('quote-breakdown');
  if (!prompt) {
    breakdown.textContent = 'Fiyatı görmek için bir prompt yazın.';
    return;
  }
  try {
    const q = await safeFetchJson('/api/quote', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        model: document.getElementById('model-select').value,
        maxOutputTokens: getMaxOutputTokens()
      })
    });
    lastQuote = q;
    renderQuote(q);
  } catch (err) {
    breakdown.textContent = `Fiyat alınamadı: ${err.message}`;
  }
}

function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(updateQuote, 400);
}

document.getElementById('prompt-input').addEventListener('input', scheduleQuote);
document.getElementById('max-output-select').addEventListener('change', updateQuote);
const modelSelect = document.getElementById('model-select');
modelSelect.addEventListener('change', () => {
  const isGpt = modelSelect.value.toLowerCase().includes('gpt');
  const iconEl = document.getElementById('ai-icon');
  if (iconEl) iconEl.textContent = isGpt ? '🤖' : '✨';
  updateQuote();
});

// Initialize polling
refreshState();
setInterval(refreshState, 5000);
