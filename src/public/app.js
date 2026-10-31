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
    throw new Error(`[HTTP ${res.status}] ${text.slice(0, 150) || res.statusText || 'Invalid response'}`);
  }
  if (!res.ok) {
    throw new Error(json.message || json.description || json.error || `[HTTP ${res.status}] ${text.slice(0, 100)}`);
  }
  return json;
}

// Curated list of well-known industry AI models
const KNOWN_MODELS = [
  {
    group: 'Google Gemini',
    models: [
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }
    ]
  },
  {
    group: 'OpenAI (ChatGPT & Reasoning)',
    models: [
      { id: 'gpt-4o', name: 'ChatGPT GPT-4o' },
      { id: 'gpt-4o-mini', name: 'ChatGPT GPT-4o Mini' },
      { id: 'o1', name: 'OpenAI o1' },
      { id: 'o3-mini', name: 'OpenAI o3-mini' }
    ]
  },
  {
    group: 'Anthropic Claude',
    models: [
      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku' }
    ]
  },
  {
    group: 'DeepSeek & Open Weights',
    models: [
      { id: 'deepseek-r1', name: 'DeepSeek R1' },
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B' }
    ]
  }
];

function getModelFamily(modelId) {
  const m = String(modelId || '').trim().toLowerCase();
  if (/^gemini/i.test(m) || /goog/i.test(m)) {
    return 'Google Gemini';
  }
  if (/^(gpt|chatgpt|o\d|text-|davinci)/i.test(m) || /openai/i.test(m)) {
    return 'OpenAI (ChatGPT & Reasoning)';
  }
  if (/^claude/i.test(m) || /anthropic/i.test(m)) {
    return 'Anthropic Claude';
  }
  if (/^(deepseek|llama|mistral|qwen|grok|yi|phi)/i.test(m)) {
    return 'DeepSeek & Open Weights';
  }
  return 'Other Network Models';
}

function formatModelDisplayName(modelId) {
  const raw = String(modelId || '').trim();
  for (const g of KNOWN_MODELS) {
    const found = g.models.find(m => m.id.toLowerCase() === raw.toLowerCase());
    if (found) return found.name;
  }
  if (/^gemini/i.test(raw)) {
    return raw
      .replace(/^gemini[-_]?/i, 'Gemini ')
      .replace(/[-_]/g, ' ')
      .replace(/\bflash\b/i, 'Flash')
      .replace(/\bpro\b/i, 'Pro')
      .replace(/\bultra\b/i, 'Ultra')
      .replace(/\b([a-z])/g, c => c.toUpperCase())
      .trim();
  }
  if (/^(gpt|chatgpt)/i.test(raw)) {
    return 'ChatGPT ' + raw
      .replace(/^(gpt|chatgpt)[-_]?/i, 'GPT-')
      .replace(/[-_]mini\b/i, ' Mini')
      .replace(/[-_]turbo\b/i, ' Turbo')
      .replace(/[-_]preview\b/i, ' Preview')
      .replace(/[-_]/g, ' ')
      .trim();
  }
  if (/^claude/i.test(raw)) {
    return raw
      .replace(/^claude[-_]?/i, 'Claude ')
      .replace(/[-_]/g, ' ')
      .replace(/\bsonnet\b/i, 'Sonnet')
      .replace(/\bhaiku\b/i, 'Haiku')
      .replace(/\bopus\b/i, 'Opus')
      .replace(/\b([a-z])/g, c => c.toUpperCase())
      .trim();
  }
  if (/^deepseek/i.test(raw)) {
    return raw.replace(/^deepseek[-_]?/i, 'DeepSeek ').replace(/[-_]/g, ' ').toUpperCase();
  }
  return raw.replace(/[-_]/g, ' ').replace(/\b([a-z])/g, c => c.toUpperCase());
}

const SELECTION_KEY = 'bsv_selected_provider';
let cachedProviders = [];
let lastQuote = null;
let quoteTimer = null;

function getSelectedProvider() {
  try {
    return JSON.parse(localStorage.getItem(SELECTION_KEY)) || null;
  } catch (_) {
    return null;
  }
}

function providerSupportsModel(p, modelId) {
  if (!p || !modelId) return false;
  const models = Array.isArray(p.supportedModels) ? p.supportedModels : (p.models || [p.model]);
  const target = String(modelId).trim().toLowerCase();
  return models.some(m => typeof m === 'string' && m.trim().toLowerCase() === target);
}

/** Online providers a channel can be opened with (the same set the marketplace lists). */
function isUsableProvider(p) {
  return p && p.available !== false && p.supportsChannels !== false;
}

function findCheapestProvider(modelId) {
  const active = cachedProviders.filter(p => isUsableProvider(p) && providerSupportsModel(p, modelId));
  if (active.length === 0) return null;
  // Sort by lowest output token price per 1k tokens, then input price
  active.sort((a, b) => {
    const outDiff = (a.pricing?.outputPer1k ?? Infinity) - (b.pricing?.outputPer1k ?? Infinity);
    if (outDiff !== 0) return outDiff;
    return (a.pricing?.inputPer1k ?? Infinity) - (b.pricing?.inputPer1k ?? Infinity);
  });
  return { cheapest: active[0], count: active.length, all: active };
}

function renderIntelligentModelSelect(preferredModel) {
  const select = document.getElementById('model-select');
  if (!select) return;
  const currentVal = preferredModel || select.value || 'gemini-1.5-pro';

  // Build grouped structure starting with KNOWN_MODELS
  const groupsMap = new Map();
  for (const g of KNOWN_MODELS) {
    groupsMap.set(g.group, {
      group: g.group,
      models: g.models.map(m => ({ ...m }))
    });
  }

  // Set of all registered model IDs (lowercase)
  const registeredIds = new Set();
  for (const g of groupsMap.values()) {
    for (const m of g.models) {
      registeredIds.add(m.id.toLowerCase());
    }
  }

  // Dynamically place active provider models into their appropriate family group
  for (const p of cachedProviders) {
    const pModels = Array.isArray(p.supportedModels) ? p.supportedModels : (p.models || [p.model]);
    for (const rawM of pModels) {
      if (!rawM) continue;
      const mId = String(rawM).trim();
      const mIdLower = mId.toLowerCase();

      if (!registeredIds.has(mIdLower)) {
        registeredIds.add(mIdLower);
        const family = getModelFamily(mId);
        if (!groupsMap.has(family)) {
          groupsMap.set(family, { group: family, models: [] });
        }
        groupsMap.get(family).models.push({
          id: mId,
          name: formatModelDisplayName(mId)
        });
      }
    }
  }

  const desiredOrder = [
    'Google Gemini',
    'OpenAI (ChatGPT & Reasoning)',
    'Anthropic Claude',
    'DeepSeek & Open Weights',
    'Other Network Models'
  ];

  const orderedGroups = [];
  for (const name of desiredOrder) {
    if (groupsMap.has(name) && groupsMap.get(name).models.length > 0) {
      orderedGroups.push(groupsMap.get(name));
      groupsMap.delete(name);
    }
  }
  for (const g of groupsMap.values()) {
    if (g.models.length > 0) orderedGroups.push(g);
  }

  select.innerHTML = '';
  let selectedFound = false;
  let firstAvailableModel = null;

  for (const g of orderedGroups) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = g.group;

    for (const m of g.models) {
      const match = findCheapestProvider(m.id);
      const opt = document.createElement('option');
      opt.value = m.id;

      if (match) {
        opt.disabled = false;
        const rate = match.cheapest.pricing ? `${match.cheapest.pricing.outputPer1k} sats/1k` : 'Online';
        opt.textContent = `${m.name} — from ${rate} (${match.count} node${match.count > 1 ? 's' : ''})`;
        if (!firstAvailableModel) firstAvailableModel = m.id;
        if (m.id.toLowerCase() === currentVal.toLowerCase()) {
          opt.selected = true;
          selectedFound = true;
        }
      } else {
        opt.disabled = true;
        opt.textContent = `${m.name} — No active nodes (Offline)`;
      }
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }

  // If previous selection is disabled or offline, fallback to the first active model
  if (!selectedFound && firstAvailableModel) {
    select.value = firstAvailableModel;
  }
}

function autoRouteModel(modelId) {
  if (!modelId) return;
  const match = findCheapestProvider(modelId);
  const text = document.getElementById('selected-provider-text');
  const link = document.getElementById('selected-provider-link');
  const existing = getSelectedProvider();

  // Keep a provider picked in the marketplace, but only while it is still online: a saved choice
  // for a provider that went away would make every request fail with "provider offline"
  const live = existing && cachedProviders.find(p => p.id === existing.providerId);
  if (existing && !existing.autoRouted && isUsableProvider(live) && providerSupportsModel(live, modelId)) {
    text.innerHTML = `Selected node: <b>${existing.providerName}</b> · ${existing.pricing.inputPer1k}/${existing.pricing.outputPer1k} sats per 1K`;
    link.textContent = 'Change';
    link.href = '/market.html';
    return;
  }

  if (match) {
    const cheapest = match.cheapest;
    const selectionData = {
      providerId: cheapest.id,
      providerName: cheapest.name,
      model: modelId,
      models: cheapest.supportedModels || (cheapest.models || [cheapest.model]),
      pricing: cheapest.pricing,
      autoRouted: true
    };
    localStorage.setItem(SELECTION_KEY, JSON.stringify(selectionData));

    text.innerHTML = `<span class="badge success" style="margin-right:6px;">AUTO ROUTED</span>` +
      `Cheapest node: <b>${cheapest.name}</b> · ${cheapest.pricing.inputPer1k}/${cheapest.pricing.outputPer1k} sats per 1K · <span class="muted">${match.count} node${match.count > 1 ? 's' : ''} online</span>`;
    link.textContent = `Compare all (${match.count}) →`;
    link.href = `/market.html?model=${encodeURIComponent(modelId)}`;
  } else {
    // No online provider for this model
    localStorage.removeItem(SELECTION_KEY);
    text.innerHTML = `<span class="badge subtle" style="margin-right:6px;">OFFLINE</span>` +
      `No active providers currently offer <b>${modelId}</b>.`;
    link.textContent = 'Host this model →';
    link.href = '/provider.html';
  }
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
            <div style="font-size:0.7rem; color:var(--text-muted);">${s.model}</div>
          </div>
          <div class="swap-sats">+${s.sats} sats</div>
        </div>
      `).join('');
    } else {
      swapsContainer.innerHTML = '<div class="empty-state">No swaps yet. Be the first to swap!</div>';
    }
  } catch (_) {}

  // Refresh Providers list & intelligent model routing
  try {
    const data = await safeFetchJson('/api/providers');
    cachedProviders = data.providers || [];

    const provContainer = document.getElementById('providers-list');
    if (cachedProviders.length > 0) {
      provContainer.innerHTML = cachedProviders.map(p => `
        <div class="provider-card">
          <div class="name-row">
            <span>${p.name}</span>
            <span class="pricing">${p.pricing ? `${p.pricing.inputPer1k}/${p.pricing.outputPer1k} sats per 1K` : '-'}</span>
          </div>
          <div class="addr" title="${p.identityKey || p.bsvAddress}">
            ${p.identityKey ? `ID Key: ${p.identityKey.slice(0, 12)}...${p.identityKey.slice(-8)}` : `Payout: ${p.bsvAddress}`}
          </div>
          <div style="font-size:0.75rem; color:var(--green);">● Online (${(p.supportedModels || [p.model]).join(', ')})</div>
        </div>
      `).join('');
    } else {
      provContainer.innerHTML = '<div class="empty-state">No active providers found. Start a provider node!</div>';
    }

    const select = document.getElementById('model-select');
    const chosen = select.value || getSelectedProvider()?.model;
    renderIntelligentModelSelect(chosen);
    autoRouteModel(select.value);

    if (!lastQuote) updateQuote();
  } catch (_) {}
}

function getMaxOutputTokens() {
  const el = document.getElementById('max-output-select');
  return el ? parseInt(el.value, 10) : undefined;
}

function renderQuote(q) {
  document.getElementById('display-fee-sats').textContent = `${q.amountSats} Sats`;
  document.getElementById('display-fee-usd').textContent = `~$${q.estimatedUsd} USD`;
  const source = q.tokenCountSource === 'gemini' ? 'Gemini tokenizer' : 'estimated';
  document.getElementById('quote-breakdown').textContent =
    `Input: ${q.inputTokens} tokens (${source}) = ${q.inputSats} sats · ` +
    `Output cap: ${q.maxOutputTokens} tokens = ${q.outputSats} sats · ` +
    `Total: ${q.amountSats} sats (min ${q.pricing.minSats})`;
}

async function updateQuote() {
  const prompt = document.getElementById('prompt-input').value.trim();
  const breakdown = document.getElementById('quote-breakdown');
  const model = document.getElementById('model-select').value;
  if (!prompt) {
    breakdown.textContent = 'Enter a prompt to see the price estimate.';
    return;
  }
  const sel = getSelectedProvider();
  if (!sel) {
    breakdown.textContent = `No active providers offer ${model}. Select an available model above.`;
    return;
  }
  try {
    const q = await safeFetchJson('/api/quote', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        model,
        maxOutputTokens: getMaxOutputTokens(),
        providerId: sel.providerId
      })
    });
    lastQuote = q;
    renderQuote(q);
  } catch (err) {
    breakdown.textContent = `Could not fetch quote: ${err.message}`;
  }
}

function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(updateQuote, 350);
}

document.getElementById('prompt-input').addEventListener('input', scheduleQuote);
document.getElementById('prompt-input').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    const askBtn = document.getElementById('btn-channel-ask');
    const openView = document.getElementById('channel-open-view');
    if (openView && !openView.classList.contains('hidden') && askBtn && !askBtn.disabled) {
      askBtn.click();
    } else {
      const openBtn = document.getElementById('btn-channel-open');
      if (openBtn && !openBtn.disabled) openBtn.click();
    }
  }
});

document.getElementById('max-output-select').addEventListener('change', updateQuote);

const modelSelect = document.getElementById('model-select');
modelSelect.addEventListener('change', () => {
  autoRouteModel(modelSelect.value);
  updateQuote();
});

// Initialize: signed-in users only
Session.requireLogin().then(() => {
  const initialSel = getSelectedProvider();
  if (initialSel?.model) {
    modelSelect.value = initialSel.model;
  }
  refreshState();
  setInterval(refreshState, 5000);
});
