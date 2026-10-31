/**
 * Sign-in and start page: full-viewport splash screen transitions smoothly into the
 * main start workspace where BSV Desktop signs a one-time challenge and the user picks a role.
 */
(function () {
  const el = (id) => document.getElementById(id);
  const next = new URLSearchParams(location.search).get('next');
  let explicitRole = 'customer';

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function animateScrollTo(targetEl, duration = 760) {
    if (!targetEl) return;
    const workspace = el('start-workspace');
    if (workspace) workspace.classList.add('is-entered');

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      targetEl.scrollIntoView({ behavior: 'auto', block: 'start' });
      return;
    }

    const startY = window.scrollY || window.pageYOffset;
    const targetY = Math.max(0, targetEl.getBoundingClientRect().top + startY);
    const delta = targetY - startY;
    if (Math.abs(delta) < 2) return;

    const startTime = performance.now();
    function step(now) {
      const elapsed = Math.min(1, (now - startTime) / duration);
      const eased = elapsed < 0.5
        ? 4 * elapsed * elapsed * elapsed
        : 1 - Math.pow(-2 * elapsed + 2, 3) / 2;
      window.scrollTo(0, startY + delta * eased);
      if (elapsed < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  const workspace = el('start-workspace');
  if (workspace && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) workspace.classList.add('is-entered');
      });
    }, { threshold: 0.08 });
    observer.observe(workspace);
  } else if (workspace) {
    workspace.classList.add('is-entered');
  }

  el('btn-get-started')?.addEventListener('click', () => {
    animateScrollTo(el('start-workspace'), 780);
  });

  el('splash-terms-link')?.addEventListener('click', (event) => {
    event.preventDefault();
    animateScrollTo(el('contract-spec'), 860);
  });

  // Segmented Customer / Provider selector on the sign-in card
  document.querySelectorAll('[data-signin-role]').forEach((tab) => {
    tab.addEventListener('click', () => {
      explicitRole = tab.dataset.signinRole;
      document.querySelectorAll('[data-signin-role]').forEach((t) => {
        const active = t === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
      });
      const desc = el('signin-role-desc');
      const label = el('signin-btn-label');
      if (explicitRole === 'provider') {
        if (desc) desc.textContent = 'Connect your BSV Desktop identity to register an OpenAI or Google Gemini API key, set satoshi rates, and receive payouts.';
        if (label) label.textContent = 'Sign in as Provider (BSV Desktop)';
      } else {
        if (desc) desc.textContent = 'Connect your BSV Desktop identity to compare providers, open a 2-of-2 payment channel, and pay per streamed chunk.';
        if (label) label.textContent = 'Sign in as Customer (BSV Desktop)';
      }
    });
  });

  function message(id, text, color = 'var(--text-muted)') {
    const node = el(id);
    if (node) node.innerHTML = `<span style="color:${color}">${text}</span>`;
  }

  function destinationFor(role) {
    if (role === 'provider') return '/provider.html';
    if (next && next.startsWith('/') && !next.startsWith('//') && next !== '/signin.html') {
      return next;
    }
    return '/';
  }

  function homeFor(user) {
    if (next && next.startsWith('/') && !next.startsWith('//') && next !== '/signin.html') {
      return next;
    }
    if (user.isProvider && !user.isCustomer) return '/provider.html';
    return '/';
  }

  function showRolePicker() {
    el('step-signin').classList.add('hidden');
    el('step-role').classList.remove('hidden');
    animateScrollTo(el('start-workspace'), 600);
  }

  async function afterLogin(user, fromSignInClick = false) {
    const role = explicitRole || (user.isProvider ? 'provider' : 'customer');
    try {
      await Session.api('/api/me/role', { method: 'POST', body: JSON.stringify({ role }) });
    } catch (_) {}
    location.href = destinationFor(role);
  }

  async function signIn() {
    const btn = el('btn-signin');
    btn.disabled = true;
    try {
      message('signin-message', 'Reading BSV Desktop identity...');
      const { publicKey: identityKey } = await Session.wallet('getPublicKey', { identityKey: true });
      const challenge = await Session.api('/api/auth/challenge', { method: 'POST', body: '{}' });

      message('signin-message', 'Approve the sign-in request in BSV Desktop...');
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
      await afterLogin(await Session.me(), true);
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

  document.querySelectorAll('[data-trigger-signin]').forEach(btn => {
    btn.addEventListener('click', () => {
      const signinSection = el('step-signin');
      if (signinSection && !signinSection.classList.contains('hidden')) {
        signinSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        signIn();
      } else {
        el('step-role')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });

  async function hydratePublicNetworkData() {
    try {
      const status = await Session.api('/api/status');
      if (el('landing-network') && status.network) {
        el('landing-network').textContent = `BSV ${String(status.network).toUpperCase()}`;
      }
      if (el('landing-providers')) {
        el('landing-providers').textContent = String(status.activeProviders ?? 0);
      }
      if (el('landing-sats')) {
        el('landing-sats').textContent = `${Number(status.totalSatsSwapped || 0).toLocaleString('en-US')} sats`;
      }
    } catch (_) {}

    const tbody = el('landing-market-rows');
    if (!tbody) return;
    try {
      const market = await Session.api('/api/market');
      const providers = Array.isArray(market.providers) ? market.providers : [];
      if (!providers.length) {
        tbody.innerHTML = `
          <tr>
            <td colspan="6" class="muted">
              No provider nodes are online right now. Sign in with BSV Desktop to register the first OpenAI or Google Gemini provider node.
            </td>
          </tr>`;
        return;
      }
      tbody.innerHTML = providers.map(p => {
        const models = (p.models || []).map(m => `<span class="model-pill">${esc(m)}</span>`).join('');
        const statusHtml = p.available
          ? '<span class="status-pill ok">Live</span>'
          : '<span class="status-pill off">Offline</span>';
        return `
          <tr>
            <td><strong>${esc(p.name)}</strong></td>
            <td>${statusHtml}</td>
            <td><div class="model-pill-list">${models}</div></td>
            <td class="num">${Number(p.pricing?.inputPer1k ?? 0).toLocaleString('en-US')} sats</td>
            <td class="num">${Number(p.pricing?.outputPer1k ?? 0).toLocaleString('en-US')} sats</td>
            <td class="num">${Number(p.pricing?.minSats ?? 0).toLocaleString('en-US')} sats</td>
          </tr>`;
      }).join('');
    } catch (_) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="muted">Connect BSV Desktop to view active marketplace providers.</td>
        </tr>`;
    }
  }

  hydratePublicNetworkData();

  // Already signed in: skip straight to destination or home
  Session.me().then(user => {
    if (!user) return;
    if (next && next.startsWith('/') && !next.startsWith('//') && next !== '/signin.html') {
      location.href = next;
      return;
    }
    if (user.isProvider && !user.isCustomer) {
      location.href = '/provider.html';
    } else if (user.isCustomer) {
      location.href = '/';
    }
  }).catch(() => {});
})();
