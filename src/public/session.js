/**
 * Shared session helpers for every page: who is signed in, redirect to the
 * sign-in page when needed, BSV Desktop calls, and the top navigation.
 */
(function () {
  const WALLET_URL = 'http://localhost:3321';

  async function api(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { throw new Error(`[HTTP ${res.status}] ${text.slice(0, 120)}`); }
    if (!res.ok) {
      const err = new Error(data.error || data.message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function wallet(method, args) {
    try {
      return await api(`${WALLET_URL}/${method}`, { method: 'POST', body: JSON.stringify(args) });
    } catch (err) {
      if (err instanceof TypeError || /Failed to fetch/i.test(err.message)) {
        throw new Error('BSV Desktop\'a ulaşılamadı. Uygulamanın açık olduğundan emin olun.');
      }
      throw err;
    }
  }

  async function me() {
    try {
      return await api('/api/me');
    } catch (err) {
      if (err.status === 401) return null;
      throw err;
    }
  }

  /** Return the signed-in user, or send the browser to the sign-in page. */
  async function requireLogin() {
    const user = await me();
    if (!user) {
      location.href = `/signin.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      return new Promise(() => {}); // stop the caller while navigating
    }
    renderNav(user);
    return user;
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
    location.href = '/signin.html';
  }

  function shortKey(key) {
    return `${key.slice(0, 8)}…${key.slice(-6)}`;
  }

  /** Links + signed-in pill, appended to the page's .nav-metrics bar. */
  function renderNav(user) {
    const bar = document.querySelector('.nav-metrics');
    if (!bar || bar.querySelector('.session-nav')) return;
    const links = [
      ['/market.html', 'Pazaryeri'],
      ['/', 'Soru Sor'],
      user.isProvider ? ['/provider.html', 'Provider Paneli'] : null,
      ['/locked.html', 'Kilitli Para']
    ].filter(Boolean);
    const nav = document.createElement('div');
    nav.className = 'session-nav';
    nav.innerHTML = links.map(([href, label]) =>
      `<a class="metric-pill nav-link${location.pathname === href ? ' active' : ''}" href="${href}">${label}</a>`
    ).join('') +
      `<span class="metric-pill" title="${user.identityKey}"><span class="dot green"></span>${shortKey(user.identityKey)}</span>` +
      '<button type="button" class="metric-pill nav-link" id="btn-logout">Çıkış</button>';
    bar.appendChild(nav);
    nav.querySelector('#btn-logout').addEventListener('click', logout);
  }

  window.Session = { api, wallet, me, requireLogin, logout, renderNav, shortKey };
})();
