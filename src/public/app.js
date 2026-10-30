let currentInvoice = null;
let autoDetectTimer = null;

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

// Deliver BRC-29 PeerPay payment token to recipient's BSV Desktop payment_inbox via MessageBox.
// First resolves the recipient's advertised MessageBox host (where their BSV Desktop listens),
// then falls back through known hosts. Returns { delivered, host, messageId, errors }.
const MESSAGEBOX_HOSTS = [
  'https://messagebox.bsvblockchain.tech',
  'https://message-box-us-1.bsvb.tech',
  'https://messagebox.babbage.systems'
];

async function deliverPeerPayTokenToRecipient({ recipientIdentityKey, derivationPrefix, derivationSuffix, atomicBeef, amountSats }) {
  const result = { delivered: false, host: null, messageId: null, errors: [] };
  if (!window.messageBoxClient || !window.messageBoxClient.MessageBoxClient) {
    result.errors.push('messagebox-bundle.js not loaded');
    return result;
  }
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(recipientIdentityKey)) {
    result.errors.push('invalid recipient identity key');
    return result;
  }

  const message = {
    recipient: recipientIdentityKey.toLowerCase(),
    messageBox: 'payment_inbox',
    body: JSON.stringify({
      customInstructions: { derivationPrefix, derivationSuffix },
      transaction: atomicBeef,
      amount: amountSats,
      outputIndex: 0
    })
  };

  const walletClient = createBridgeWalletClient();
  const attempts = [{ label: 'advertised', override: undefined }, ...MESSAGEBOX_HOSTS.slice(1).map(h => ({ label: h, override: h }))];
  for (const attempt of attempts) {
    try {
      const mbClient = new window.messageBoxClient.MessageBoxClient({
        host: MESSAGEBOX_HOSTS[0],
        walletClient,
        enableLogging: true
      });
      const usedHost = attempt.override || await mbClient.resolveHostForRecipient(message.recipient).catch(() => MESSAGEBOX_HOSTS[0]);
      const sent = await mbClient.sendMessage(message, usedHost);
      result.delivered = true;
      result.host = usedHost;
      result.messageId = sent?.messageId || null;
      console.log(`[PeerPay] ✔ Delivered payment token to ${recipientIdentityKey} via ${usedHost} (messageId: ${result.messageId})`);
      return result;
    } catch (err) {
      console.warn(`[PeerPay] ${attempt.label} delivery failed:`, err.message);
      result.errors.push(`${attempt.label}: ${err.message}`);
    }
  }
  return result;
}

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

// Helpers
function copyText(elementId) {
  const el = document.getElementById(elementId);
  el.select();
  navigator.clipboard.writeText(el.value);
  alert('Kopyalandı: ' + el.value);
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
document.getElementById('model-select').addEventListener('change', updateQuote);

// Main Action: Submit Prompt & Trigger BSV Desktop Bridge (localhost:3321)
document.getElementById('btn-request-invoice').addEventListener('click', async () => {
  const prompt = document.getElementById('prompt-input').value.trim();
  const model = document.getElementById('model-select').value;
  const customRecipientKey = recipientInput ? recipientInput.value.trim() : '';

  if (!prompt) {
    alert('Lütfen bir soru/prompt yazın.');
    return;
  }

  const btn = document.getElementById('btn-request-invoice');

  // Validate recipient Identity Key before doing anything (must be 66 hex chars: 02/03 + 64)
  if (customRecipientKey && !/^(02|03)[0-9a-fA-F]{64}$/.test(customRecipientKey) && !/^[13mn][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(customRecipientKey)) {
    alert(`Alıcı Identity Key geçersiz: ${customRecipientKey.length} karakter girildi, 66 karakter olmalı (02 veya 03 ile başlayan hex).\n\nKarşı bilgisayardaki BSV Desktop'tan Identity Key'i eksiksiz tekrar kopyalayın.`);
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span>⚡ BSV Desktop Bağlanıyor...</span>';

  try {
    // 1. Get invoice and locking script from Gateway
    const data = await safeFetchJson('/api/invoice', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        model,
        maxOutputTokens: getMaxOutputTokens(),
        recipientIdentityKey: customRecipientKey || undefined
      })
    });

    currentInvoice = data;

    // Populate fallback invoice fields
    document.getElementById('inv-provider-address').value = data.providerAddress;
    document.getElementById('inv-amount-sats').value = `${data.amountSats} satoshis`;
    renderQuote(data);

    // 2. Direct Bridge Call to BSV Desktop on localhost:3321
    btn.innerHTML = '<span>🔐 BSV Desktop Cüzdanından Ödeniyor...</span>';
    console.log('[BSV Desktop Bridge] Preparing payment on http://localhost:3321...');

    try {
      let targetLockingScript = data.lockingScriptHex;
      let senderIdentityKey = null;
      const targetIdentityKey = (customRecipientKey && /^(02|03)[0-9a-fA-F]{64}$/.test(customRecipientKey))
        ? customRecipientKey.toLowerCase()
        : data.providerIdentityKey;

      // BRC-29 Wallet-to-Wallet Derivation (so recipient's BSV Desktop receives the UTXO via PeerPay / internalizeAction)
      if (targetIdentityKey && data.derivationPrefix && data.derivationSuffix) {
        try {
          try {
            const idData = await safeFetchJson('http://localhost:3321/getPublicKey', {
              method: 'POST',
              body: JSON.stringify({ identityKey: true })
            });
            senderIdentityKey = idData.publicKey;
          } catch (e) {
            console.warn('[BSV Desktop Bridge] Could not fetch sender identityKey:', e.message);
          }

          const brc29Data = await safeFetchJson('http://localhost:3321/getPublicKey', {
            method: 'POST',
            body: JSON.stringify({
              protocolID: [2, '3241645161d8'],
              keyID: `${data.derivationPrefix} ${data.derivationSuffix}`,
              counterparty: targetIdentityKey
            })
          });

          if (brc29Data && brc29Data.publicKey) {
            const scriptData = await safeFetchJson('/api/derive-locking-script', {
              method: 'POST',
              body: JSON.stringify({
                invoiceId: data.invoiceId,
                publicKey: brc29Data.publicKey,
                senderIdentityKey
              })
            });
            targetLockingScript = scriptData.lockingScriptHex;
            document.getElementById('inv-provider-address').value = scriptData.address;
            console.log('[BSV Desktop Bridge] Derived BRC-29 payment address:', scriptData.address, 'for recipient:', targetIdentityKey);
          }
        } catch (brc29Err) {
          // Do NOT fall back to a plain P2PKH script here: the recipient's BSV Desktop can only
          // internalize outputs locked to the BRC-29 derived key. Abort with a clear error instead.
          throw new Error(`BRC-29 anahtar türetme başarısız, ödeme gönderilmedi: ${brc29Err.message}`);
        }
      }

      // If BSV Desktop pauses for an interactive permission prompt (>400ms), bring BSV Desktop app to front
      const focusTimer = setTimeout(() => {
        fetch('/api/focus-wallet', { method: 'POST' }).catch(() => {});
      }, 400);

      const bridgeData = await safeFetchJson('http://localhost:3321/createAction', {
        method: 'POST',
        body: JSON.stringify({
          description: `Payment for AI Query (${data.model})`,
          labels: ['peerpay', 'brc29'],
          outputs: [
            {
              satoshis: data.amountSats,
              lockingScript: targetLockingScript,
              outputDescription: `AI compute fee to ${data.providerName}`,
              ...(targetIdentityKey ? {
                customInstructions: JSON.stringify({
                  derivationPrefix: data.derivationPrefix,
                  derivationSuffix: data.derivationSuffix,
                  payee: targetIdentityKey
                })
              } : {})
            }
          ],
          options: {
            randomizeOutputs: false
          }
        })
      });

      clearTimeout(focusTimer);
      console.log('[BSV Desktop Bridge] Response:', bridgeData);

      // Extraction of TXID from BSV Desktop response
      const txid = bridgeData.txid ||
                   bridgeData.sendWithResults?.[0]?.txid ||
                   (typeof bridgeData.tx === 'string' ? bridgeData.tx : null);

      if (txid && typeof txid === 'string' && txid.length === 64) {
        console.log('[BSV Desktop Bridge] Payment signed & broadcast! TXID:', txid);
        btn.innerHTML = '<span>✔ 500 Sats Gönderildi! Karşı Cüzdana & Gemini\'ye İletiliyor...</span>';

        // Deliver PeerPay payment token to recipient's BSV Desktop MessageBox (payment_inbox)
        let peerPayDelivery = null;
        if (targetIdentityKey && Array.isArray(bridgeData.tx)) {
          btn.innerHTML = '<span>📨 Ödeme alıcının BSV Desktop kutusuna iletiliyor...</span>';
          peerPayDelivery = await Promise.race([
            deliverPeerPayTokenToRecipient({
              recipientIdentityKey: targetIdentityKey,
              derivationPrefix: data.derivationPrefix,
              derivationSuffix: data.derivationSuffix,
              atomicBeef: bridgeData.tx,
              amountSats: data.amountSats
            }).catch((e) => ({ delivered: false, errors: [e.message] })),
            new Promise((resolve) => setTimeout(() => resolve({ delivered: false, errors: ['browser timeout (20s)'] }), 20000))
          ]);
          console.log('[PeerPay] Browser delivery result:', peerPayDelivery);
        }

        // Send TXID + AtomicBEEF (bridgeData.tx) to Gateway for verification & Gemini execution.
        // If browser delivery failed, the Gateway retries delivery from Node.
        btn.innerHTML = '<span>🤖 Gemini yanıtı alınıyor...</span>';
        await executeVerification({
          invoiceId: data.invoiceId,
          txid,
          atomicBeef: Array.isArray(bridgeData.tx) ? bridgeData.tx : null,
          senderIdentityKey,
          peerPayDelivery
        });
        return;
      }
    } catch (bridgeErr) {
      console.warn('[BSV Desktop Bridge] Direct bridge call failed or rejected:', bridgeErr.message);
      if (bridgeErr.message.startsWith('BRC-29')) {
        throw bridgeErr;
      }
    }

    // 3. Fallback: If bridge had error or was cancelled, show invoice and start mempool auto-detect
    document.getElementById('invoice-modal').classList.remove('hidden');
    document.getElementById('result-card').classList.add('hidden');
    document.getElementById('input-txid').value = '';

    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(data.bip21Uri)}`;
    document.getElementById('invoice-qr').src = qrUrl;

    document.getElementById('invoice-modal').scrollIntoView({ behavior: 'smooth' });
    startAutoDetect(data.invoiceId);

  } catch (err) {
    alert(`Hata: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>⚡ Sor & BSV Desktop\'ta Onayla</span>';
  }
});

// Automatic Mempool Polling
function startAutoDetect(invoiceId) {
  if (autoDetectTimer) clearInterval(autoDetectTimer);

  const statusEl = document.getElementById('auto-detect-status');
  statusEl.textContent = 'BSV Desktop\'tan Onayla\'ya basmanız bekleniyor. Bastığınız an otomatik başlayacak!';

  let attempts = 0;
  autoDetectTimer = setInterval(async () => {
    attempts++;

    try {
      const data = await safeFetchJson('/api/verify', {
        method: 'POST',
        body: JSON.stringify({
          invoiceId,
          autoDetect: true
        })
      });

      if (data && data.success) {
        clearInterval(autoDetectTimer);
        autoDetectTimer = null;
        statusEl.textContent = '✔ Ödeme algılandı! Gemini yanıtı alınıyor...';
        handleCompletion(data);
      } else if (attempts >= 60) {
        clearInterval(autoDetectTimer);
        autoDetectTimer = null;
        statusEl.textContent = 'Mempool taraması zaman aşımına uğradı. Butona tekrar basabilirsiniz.';
      }
    } catch (err) {
      if (attempts >= 60) {
        clearInterval(autoDetectTimer);
        autoDetectTimer = null;
        statusEl.textContent = 'Mempool taraması zaman aşımına uğradı. Butona tekrar basabilirsiniz.';
      }
    }
  }, 1500);
}

// Manual verification fallback
document.getElementById('btn-verify-txid').addEventListener('click', async () => {
  if (!currentInvoice) return;
  const txid = document.getElementById('input-txid').value.trim();

  if (!txid || txid.length !== 64) {
    alert('Lütfen geçerli 64 karakterli TXID girin.');
    return;
  }

  const btn = document.getElementById('btn-verify-txid');
  btn.disabled = true;
  btn.textContent = 'Doğrulanıyor...';

  try {
    const data = await safeFetchJson('/api/verify', {
      method: 'POST',
      body: JSON.stringify({
        invoiceId: currentInvoice.invoiceId,
        txid
      })
    });

    handleCompletion(data);
  } catch (err) {
    alert(`Doğrulama Hatası: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Doğrula';
  }
});

// Common verification handler
async function executeVerification(payload) {
  try {
    const data = await safeFetchJson('/api/verify', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    handleCompletion(data);
  } catch (err) {
    alert(`Hata: ${err.message}`);
  }
}

// Display AI result and on-chain receipt
function handleCompletion(data) {
  if (autoDetectTimer) {
    clearInterval(autoDetectTimer);
    autoDetectTimer = null;
  }

  // Hide invoice modal
  document.getElementById('invoice-modal').classList.add('hidden');

  // Populate Result
  const resultCard = document.getElementById('result-card');
  resultCard.classList.remove('hidden');

  document.getElementById('ai-answer-content').textContent = data.answer;
  const link = document.getElementById('tx-explorer-link');
  link.href = data.explorerUrl;
  link.textContent = `TX: ${data.txid.slice(0, 10)}...${data.txid.slice(-8)} (WhatsOnChain ↗)`;

  const usageEl = document.getElementById('token-usage-summary');
  if (usageEl) {
    const c = data.actualCost;
    usageEl.textContent = c
      ? `Kullanılan: ${c.inputTokens} girdi + ${c.outputTokens} çıktı token (tavan ${data.maxOutputTokens}) · Gerçek maliyet ${c.totalSats} sats / ödenen ${data.quotedSats || data.paidSats} sats`
      : '';
  }

  // Show whether the payment token reached the recipient's BSV Desktop payment_inbox
  const helperEl = document.getElementById('identity-helper-text');
  const d = data.peerPayDelivery;
  if (helperEl && data.recipientIdentityKey) {
    const shortKey = `${data.recipientIdentityKey.slice(0, 12)}...`;
    if (d && d.delivered) {
      helperEl.innerHTML = `<span style="color:#10b981;">✔ Ödeme <code>${shortKey}</code> alıcısının MessageBox <b>payment_inbox</b> kutusuna iletildi (${d.via || ''} → <code>${d.host}</code>, id: <code>${(d.messageId || '').slice(0, 12)}…</code>). Alıcı BSV Desktop açıkken ödemeyi otomatik / “Check incoming payments” ile alır.</span>`;
    } else {
      const why = d && d.errors ? d.errors.join(' | ') : 'bilinmiyor';
      helperEl.innerHTML = `<span style="color:#f59e0b;">⚠ TX blokzincirde, ancak ödeme bildirimi alıcıya iletilemedi: ${why}</span>`;
    }
  }

  resultCard.scrollIntoView({ behavior: 'smooth' });
  refreshState();
}

// Initialize polling
refreshState();
setInterval(refreshState, 5000);
