let currentInvoice = null;
let autoDetectTimer = null;

// Create a BRC-100 WalletClient proxy backed directly by BSV Desktop on localhost:3321
function createBridgeWalletClient() {
  return new Proxy({}, {
    get(_, method) {
      if (method === 'then' || typeof method === 'symbol') return undefined;
      return async (args = {}) => {
        const res = await fetch(`http://localhost:3321/${String(method)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.message || data.description || `Wallet ${String(method)} failed (${res.status})`);
        }
        return data;
      };
    }
  });
}

// Deliver BRC-29 PeerPay payment token to recipient's BSV Desktop payment_inbox via MessageBox
async function deliverPeerPayTokenToRecipient({ recipientIdentityKey, derivationPrefix, derivationSuffix, atomicBeef, amountSats }) {
  if (!window.messageBoxClient || !window.messageBoxClient.MessageBoxClient) {
    console.warn('[PeerPay] messagebox-bundle.js not loaded');
    return false;
  }
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(recipientIdentityKey)) {
    return false;
  }

  const paymentToken = {
    customInstructions: {
      derivationPrefix,
      derivationSuffix
    },
    transaction: atomicBeef,
    amount: amountSats,
    outputIndex: 0
  };

  const walletClient = createBridgeWalletClient();
  const hosts = [
    'https://messagebox.bsvblockchain.tech',
    'https://message-box-us-1.bsvb.tech',
    'https://messagebox.babbage.systems'
  ];

  let delivered = false;
  for (const host of hosts) {
    try {
      const mbClient = new window.messageBoxClient.MessageBoxClient({
        host,
        walletClient,
        enableLogging: true
      });
      await mbClient.sendLiveMessage({
        recipient: recipientIdentityKey.toLowerCase(),
        messageBox: 'payment_inbox',
        body: JSON.stringify(paymentToken)
      }, host);
      console.log(`[PeerPay] Delivered payment token to ${recipientIdentityKey} via ${host}`);
      delivered = true;
    } catch (err) {
      console.warn(`[PeerPay] Delivery via ${host} warning:`, err.message);
    }
  }
  return delivered;
}

// Accept any pending incoming PeerPay payments in local BSV Desktop's payment_inbox
async function acceptIncomingPeerPayPayments(showAlert = false) {
  if (!window.messageBoxClient || !window.messageBoxClient.PeerPayClient) {
    if (showAlert) alert('MessageBox istemcisi yüklenemedi.');
    return 0;
  }
  const walletClient = createBridgeWalletClient();
  const hosts = [
    'https://messagebox.bsvblockchain.tech',
    'https://message-box-us-1.bsvb.tech',
    'https://messagebox.babbage.systems'
  ];
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
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();

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
    console.warn('Status refresh error:', err);
  }

  // Refresh Providers list
  try {
    const res = await fetch('/api/providers');
    if (!res.ok) return;
    const data = await res.json();

    const provContainer = document.getElementById('providers-list');
    if (data.providers && data.providers.length > 0) {
      provContainer.innerHTML = data.providers.map(p => `
        <div class="provider-card">
          <div class="name-row">
            <span>${p.name}</span>
            <span class="pricing">${p.priceSats} sats</span>
          </div>
          <div class="addr" title="${p.identityKey || p.bsvAddress}">
            ${p.identityKey ? `ID Key: ${p.identityKey.slice(0, 12)}...${p.identityKey.slice(-8)}` : `Payout: ${p.bsvAddress}`}
          </div>
          <div style="font-size:0.75rem; color:#10b981;">● Online (${p.model})</div>
        </div>
      `).join('');

      const best = data.providers[0];
      if (best) {
        document.getElementById('display-fee-sats').textContent = `${best.priceSats} Sats`;
        const usd = ((best.priceSats * 50) / 1e8).toFixed(4);
        document.getElementById('display-fee-usd').textContent = `~$${usd} USD`;

        // Pre-populate recipient Identity Key if empty
        if (recipientInput && !recipientInput.value.trim() && best.identityKey) {
          recipientInput.value = best.identityKey;
        }
      }
    } else {
      provContainer.innerHTML = '<div class="empty-state">Aktif provider bulunamadı. Provider node çalıştırın!</div>';
    }
  } catch (err) {
    console.warn('Providers refresh error:', err);
  }
}

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
  btn.disabled = true;
  btn.innerHTML = '<span>⚡ BSV Desktop Bağlanıyor...</span>';

  try {
    // 1. Get invoice and locking script from Gateway
    const res = await fetch('/api/invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        model,
        recipientIdentityKey: customRecipientKey || undefined
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Fatura oluşturulamadı');
    }

    currentInvoice = data;

    // Populate fallback invoice fields
    document.getElementById('inv-provider-address').value = data.providerAddress;
    document.getElementById('inv-amount-sats').value = `${data.amountSats} satoshis`;

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
          const idRes = await fetch('http://localhost:3321/getPublicKey', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identityKey: true })
          });
          if (idRes.ok) {
            const idData = await idRes.json();
            senderIdentityKey = idData.publicKey;
          }

          const brc29Res = await fetch('http://localhost:3321/getPublicKey', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              protocolID: [2, '3241645161d8'],
              keyID: `${data.derivationPrefix} ${data.derivationSuffix}`,
              counterparty: targetIdentityKey
            })
          });

          if (brc29Res.ok) {
            const brc29Data = await brc29Res.json();
            if (brc29Data.publicKey) {
              const scriptRes = await fetch('/api/derive-locking-script', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  invoiceId: data.invoiceId,
                  publicKey: brc29Data.publicKey,
                  senderIdentityKey
                })
              });
              if (scriptRes.ok) {
                const scriptData = await scriptRes.json();
                targetLockingScript = scriptData.lockingScriptHex;
                document.getElementById('inv-provider-address').value = scriptData.address;
                console.log('[BSV Desktop Bridge] Derived BRC-29 payment address:', scriptData.address, 'for recipient:', targetIdentityKey);
              } else {
                const errObj = await scriptRes.json().catch(() => ({}));
                throw new Error(`BRC-29 script derivation failed: ${errObj.error || scriptRes.status}`);
              }
            }
          } else {
            throw new Error(`BSV Desktop BRC-29 getPublicKey failed (${brc29Res.status})`);
          }
        } catch (brc29Err) {
          console.error('[BSV Desktop Bridge] BRC-29 derivation error:', brc29Err.message);
          throw brc29Err;
        }
      }

      // If BSV Desktop pauses for an interactive permission prompt (>400ms), bring BSV Desktop app to front
      const focusTimer = setTimeout(() => {
        fetch('/api/focus-wallet', { method: 'POST' }).catch(() => {});
      }, 400);

      const bridgeRes = await fetch('http://localhost:3321/createAction', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
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

      const bridgeData = await bridgeRes.json();
      console.log('[BSV Desktop Bridge] Response:', bridgeData);

      if (bridgeRes.ok) {
        // Extraction of TXID from BSV Desktop response
        const txid = bridgeData.txid ||
                     bridgeData.sendWithResults?.[0]?.txid ||
                     (typeof bridgeData.tx === 'string' ? bridgeData.tx : null);

        if (txid && typeof txid === 'string' && txid.length === 64) {
          console.log('[BSV Desktop Bridge] Payment signed & broadcast! TXID:', txid);
          btn.innerHTML = '<span>✔ 500 Sats Gönderildi! Karşı Cüzdana & Gemini\'ye İletiliyor...</span>';

          // Deliver PeerPay payment token to recipient's BSV Desktop MessageBox (payment_inbox)
          if (targetIdentityKey && Array.isArray(bridgeData.tx)) {
            deliverPeerPayTokenToRecipient({
              recipientIdentityKey: targetIdentityKey,
              derivationPrefix: data.derivationPrefix,
              derivationSuffix: data.derivationSuffix,
              atomicBeef: bridgeData.tx,
              amountSats: data.amountSats
            }).then((delivered) => {
              const helperEl = document.getElementById('identity-helper-text');
              if (helperEl && delivered) {
                helperEl.innerHTML = `<span style="color:#10b981;">✔ <b>${data.amountSats} satoshi</b> hem blokzincire (WhatsOnChain) yazıldı hem de <code>${targetIdentityKey.slice(0, 12)}...</code> cüzdanının BSV Desktop <b>Transfer (payment_inbox)</b> kutusuna iletildi!</span>`;
              }
            }).catch((e) => console.warn('[PeerPay] Async delivery error:', e));
          }

          // Send TXID + AtomicBEEF (bridgeData.tx) to Gateway for instant 0ms verification & Gemini execution!
          await executeVerification({
            invoiceId: data.invoiceId,
            txid,
            atomicBeef: Array.isArray(bridgeData.tx) ? bridgeData.tx : null,
            senderIdentityKey
          });
          return;
        }
      } else {
        console.warn('[BSV Desktop Bridge] Bridge returned status', bridgeRes.status, bridgeData);
      }
    } catch (bridgeErr) {
      console.warn('[BSV Desktop Bridge] Direct bridge call failed or rejected:', bridgeErr.message);
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
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceId,
          autoDetect: true
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
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
      console.warn('Auto-detect poll error:', err);
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
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoiceId: currentInvoice.invoiceId,
        txid
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Doğrulama başarısız.');
    }

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
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Doğrulama başarısız');
    }

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

  resultCard.scrollIntoView({ behavior: 'smooth' });
  refreshState();
}

// Initialize polling
refreshState();
setInterval(refreshState, 5000);
