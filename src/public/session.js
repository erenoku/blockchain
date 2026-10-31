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
        throw new Error('Could not reach BSV Desktop. Make sure the application is running.');
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
    if (!key) return '';
    return `${key.slice(0, 8)}…${key.slice(-6)}`;
  }

  /** Render primary navigation and user status in the navbar */
  function renderNav(user) {
    // 1. Ensure primary navigation tabs exist next to brand
    const brand = document.querySelector('.nav-brand');
    if (brand) {
      let nav = document.getElementById('primary-nav');
      if (!nav) {
        nav = document.createElement('nav');
        nav.id = 'primary-nav';
        nav.className = 'nav-segmented';
        brand.after(nav);
      }
      const links = [
        ['/', 'Ask AI'],
        ['/market.html', 'Marketplace'],
        ['/provider.html', user.isProvider ? 'Provider Console' : 'Become a Provider'],
        ['/locked.html', 'Locked Funds']
      ];
      const currentPath = location.pathname.replace(/\/index\.html$/, '/') || '/';
      nav.innerHTML = links.map(([href, label]) => {
        const isActive = (href === '/' && (currentPath === '/' || currentPath === '/index.html')) ||
                         (href !== '/' && currentPath.startsWith(href));
        return `<a class="nav-tab${isActive ? ' active' : ''}" href="${href}">${label}</a>`;
      }).join('');
    }

    // 2. User account badge and sign out in user cluster
    let cluster = document.getElementById('nav-user-cluster') || document.querySelector('.nav-user-cluster');
    if (!cluster) {
      const parent = document.querySelector('.nav-user-actions') || document.querySelector('.nav-metrics') || document.querySelector('.nav-inner');
      if (parent) {
        cluster = document.createElement('div');
        cluster.id = 'nav-user-cluster';
        cluster.className = 'nav-user-cluster';
        parent.appendChild(cluster);
      }
    }

    if (cluster) {
      cluster.innerHTML = `
        <span class="user-identity-badge" title="${user.identityKey}">
          <span class="dot green"></span>
          <span class="key-text">${shortKey(user.identityKey)}</span>
        </span>
        <button type="button" class="btn-logout" id="btn-logout" aria-label="Sign out">Sign out</button>
      `;
      cluster.querySelector('#btn-logout')?.addEventListener('click', logout);
    }
  }

  window.Session = { api, wallet, me, requireLogin, logout, renderNav, shortKey };
})();
