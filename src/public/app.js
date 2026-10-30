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

// Create a BRC-100 WalletClient proxy backed directly by BSV Desktop on localhost:3321
function createBridgeWalletClient() {
  return new Proxy({}, {
    get(_, method) {
      if (method === 'then' || typeof method === 'symbol') return undefined;
      return async (args = {}) => {
        return await safeFetchJson(`http://localhost:3321/${String(method)}`, {
          method: 'POST',
          body: JSON.stringify(args)
        });
      };
    }
  });
}

// MessageBox hosts where BSV Desktop listens for PeerPay payments (primary first)
const MESSAGEBOX_HOSTS = [
  'https://messagebox.bsvblockchain.tech',
  'https://message-box-us-1.bsvb.tech',
  'https://messagebox.babbage.systems'
];

// Accept any pending incoming PeerPay payments in local BSV Desktop's payment_inbox
async function acceptIncomingPeerPayPayments(showAlert = false) {
  if (!window.messageBoxClient || !window.messageBoxClient.PeerPayClient) {
    if (showAlert) alert('MessageBox istemcisi yüklenemedi.');
    return 0;
  }
  const walletClient = createBridgeWalletClient();
  const hosts = MESSAGEBOX_HOSTS;
  let acceptedCount = 0;

  for (const host of hosts) {
    try {
      const ppClient = new window.messageBoxClient.PeerPayClient({
        messageBoxHost: host,
        walletClient,
        enableLogging: true
      });
      const incoming = await ppClient.listIncomingPayments(host);
      if (Array.isArray(incoming) && incoming.length > 0) {
        for (const p of incoming) {
          try {
            await ppClient.acceptPayment(p);
            acceptedCount++;
          } catch (acceptErr) {
            console.warn('[PeerPay] acceptPayment warning:', acceptErr.message);
          }
        }
      }
    } catch (err) {
      console.warn(`[PeerPay] listIncomingPayments on ${host} warning:`, err.message);
    }
  }

  if (showAlert) {
    if (acceptedCount > 0) {
      alert(`✔ ${acceptedCount} adet gelen ödeme BSV Desktop cüzdan bakiyenize başarıyla eklendi!`);
    } else {
      alert('Bekleyen yeni bir gelen ödeme (payment_inbox) bulunamadı.');
    }
  }
  return acceptedCount;
}

// Initialize Recipient Identity Key field from localStorage
const recipientInput = document.getElementById('recipient-identity-input');
const savedRecipientKey = localStorage.getItem('bsv_recipient_identity_key');
if (savedRecipientKey && recipientInput) {
  recipientInput.value = savedRecipientKey;
}
if (recipientInput) {
  recipientInput.addEventListener('input', () => {
    localStorage.setItem('bsv_recipient_identity_key', recipientInput.value.trim());
  });
}

// Button: Fill user's own BSV Desktop Identity Key for self-testing
const btnUseMyIdentity = document.getElementById('btn-use-my-identity');
if (btnUseMyIdentity) {
  btnUseMyIdentity.addEventListener('click', async () => {
    try {
      const res = await fetch('http://localhost:3321/getPublicKey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityKey: true })
      });
      const data = await res.json();
      if (res.ok && data.publicKey) {
        recipientInput.value = data.publicKey;
        localStorage.setItem('bsv_recipient_identity_key', data.publicKey);
        document.getElementById('identity-helper-text').innerHTML =
          `<span style="color:#10b981;">✔ Kendi BSV Desktop Identity Key'iniz seçildi (<code>${data.publicKey.slice(0, 14)}...</code>). Gönderdiğiniz 500 satoshi aynı anda hem cüzdanınızdan çıkacak hem de <b>+500 satoshis</b> olarak geri girecek!</span>`;
      } else {
        alert('BSV Desktop açık değil veya Identity Key alınamadı.');
      }
    } catch (err) {
      alert('BSV Desktop bağlantısı kurulamadı: ' + err.message);
    }
  });
}

// Button: Accept incoming payments from MessageBox payment_inbox into BSV Desktop
const btnAcceptIncoming = document.getElementById('btn-accept-incoming');
if (btnAcceptIncoming) {
  btnAcceptIncoming.addEventListener('click', async () => {
    btnAcceptIncoming.disabled = true;
    btnAcceptIncoming.textContent = '⏳ Kontrol Ediliyor...';
    try {
      await acceptIncomingPeerPayPayments(true);
    } finally {
      btnAcceptIncoming.disabled = false;
      btnAcceptIncoming.textContent = '📥 Gelen Ödemeleri Cüzdana Al';
    }
  });
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
          <div style="font-size:0.75rem; color:#10b981;">● Online (${p.model})</div>
        </div>
      `).join('');

      const best = data.providers[0];
      if (best) {
        if (!lastQuote) updateQuote();

        // Pre-populate recipient Identity Key if empty
        if (recipientInput && !recipientInput.value.trim() && best.identityKey) {
          recipientInput.value = best.identityKey;
        }
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

// Every answer may use up to this many output tokens; prices and estimates are based on it
const MAX_OUTPUT_TOKENS = 4096;

function getMaxOutputTokens() {
  return MAX_OUTPUT_TOKENS;
}

// Headline shows the typical (average) cost; the output cap price is the most it can cost
function renderQuote(q) {
  if (q.expectedSats === undefined) {
    // Gateway without usage stats: only the cap price is known
    document.getElementById('display-fee-sats').textContent = `≤ ${q.amountSats} Sats`;
    document.getElementById('display-fee-usd').textContent = `≤ $${q.estimatedUsd} USD`;
    document.getElementById('quote-breakdown').textContent = `En fazla: ${q.amountSats} sats (${q.maxOutputTokens} token tavanı)`;
    return;
  }
  document.getElementById('display-fee-sats').textContent = `≈ ${q.expectedSats} Sats`;
  document.getElementById('display-fee-usd').textContent = `≈ $${q.expectedUsd} USD`;
  const source = q.tokenCountSource === 'gemini' ? 'Gemini tokenizer' : 'tahmini';
  const basis = q.expectedSource === 'history'
    ? `son ${q.expectedSampleCount} cevabın ortalaması`
    : 'henüz geçmiş yok, tavanın yarısı varsayıldı';
  document.getElementById('quote-breakdown').textContent =
    `Ortalama: ≈ ${q.expectedSats} sats (${q.inputTokens} girdi token [${source}] + ≈ ${q.expectedOutputTokens} çıktı token, ${basis}) · ` +
    `En fazla: ${q.amountSats} sats (${q.maxOutputTokens} token tavanı)`;
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
document.getElementById('model-select').addEventListener('change', updateQuote);

// Initialize polling
refreshState();
setInterval(refreshState, 5000);
