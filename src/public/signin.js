/**
 * Sign-in page: BSV Desktop signs a one-time challenge, then the user picks a role.
 */
(function () {
  const el = (id) => document.getElementById(id);
  const next = new URLSearchParams(location.search).get('next');

  function message(id, text, color = 'var(--text-muted)') {
    el(id).innerHTML = `<span style="color:${color}">${text}</span>`;
  }

  function homeFor(user) {
    if (next && next.startsWith('/') && !next.startsWith('//')) return next;
    if (user.isProvider && !user.provider) return '/provider.html';
    if (user.isCustomer) return '/market.html';
    return '/provider.html';
  }

  function afterLogin(user) {
    if (!user.isCustomer && !user.isProvider) {
      el('step-signin').classList.add('hidden');
      el('step-role').classList.remove('hidden');
      return;
    }
    location.href = homeFor(user);
  }

  async function signIn() {
    const btn = el('btn-signin');
    btn.disabled = true;
    try {
      message('signin-message', 'BSV Desktop kimliği alınıyor...');
      const { publicKey: identityKey } = await Session.wallet('getPublicKey', { identityKey: true });
      const challenge = await Session.api('/api/auth/challenge', { method: 'POST', body: '{}' });

      message('signin-message', 'BSV Desktop\'ta giriş isteğini onaylayın...');
      const focusTimer = setTimeout(() => fetch('/api/focus-wallet', { method: 'POST' }).catch(() => {}), 400);
      let signed;
      try {
        signed = await Session.wallet('createSignature', {
          data: Array.from(new TextEncoder().encode(challenge.message)),
          protocolID: challenge.protocolID,
          keyID: challenge.keyID,
          counterparty: 'anyone'
        });
      } finally {
        clearTimeout(focusTimer);
      }

      await Session.api('/api/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ identityKey, nonce: challenge.nonce, signature: signed.signature })
      });
      afterLogin(await Session.me());
    } catch (err) {
      message('signin-message', `⚠ ${err.message}`, 'var(--gold)');
    } finally {
      btn.disabled = false;
    }
  }

  document.querySelectorAll('[data-role]').forEach(card => {
    card.addEventListener('click', async () => {
      try {
        await Session.api('/api/me/role', { method: 'POST', body: JSON.stringify({ role: card.dataset.role }) });
        location.href = card.dataset.role === 'provider' ? '/provider.html' : homeFor({ isCustomer: true });
      } catch (err) {
        message('role-message', `⚠ ${err.message}`, 'var(--gold)');
      }
    });
  });

  el('btn-signin').addEventListener('click', signIn);

  // Already signed in: skip straight to the role step or home
  Session.me().then(user => { if (user) afterLogin(user); }).catch(() => {});
})();
