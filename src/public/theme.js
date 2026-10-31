/* Browser-local visual accent. Never touches wallet or API credentials. */
(function () {
  const el = (id) => document.getElementById(id);
  const DEFAULT_ACCENT = '#2fb8bc'; // tile turquoise
  const OLD_DEFAULTS = ['#9b6dff', '#2dd4bf']; // earlier defaults (violet, mint), never a visitor's choice
  let current = DEFAULT_ACCENT;


  function normalizeHex(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
    if (/^#[0-9a-f]{3}$/.test(trimmed)) {
      return '#' + trimmed.slice(1).split('').map(c => c + c).join('');
    }
    return null;
  }

  function apply(rawColor) {
    const color = normalizeHex(rawColor);
    if (!color) return;
    current = color;

    const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    const strong = '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
    // Hover tint: a step lighter than the accent
    const light = rgb.map(v => Math.round(v + (255 - v) * 0.28));
    const linear = rgb.map(v => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    const rgbStr = rgb.join(', ');
    const accentLight = `rgb(${light.join(', ')})`;
    const accentSoft = `rgba(${rgbStr}, 0.14)`;
    const buttonInk = luminance > 0.22 ? '#0a1033' : '#ffffff';

    [document.documentElement, document.body].forEach(node => {
      if (!node) return;
      node.style.setProperty('--accent-rgb', rgbStr);
      node.style.setProperty('--accent-strong', strong);
      node.style.setProperty('--accent', accentLight);
      node.style.setProperty('--accent-soft', accentSoft);
      node.style.setProperty('--border-focus', strong);
      node.style.setProperty('--button-ink', buttonInk);
    });

    const picker = el('custom-accent');
    if (picker && picker.value.toLowerCase() !== color) picker.value = color;
    const label = el('accent-value');
    if (label) label.textContent = color.toUpperCase();

    document.querySelectorAll('.accent-preview').forEach(dot => {
      dot.style.backgroundColor = color;
    });

    document.querySelectorAll('[data-accent]').forEach(btn => {
      const match = normalizeHex(btn.dataset.accent) === color;
      btn.setAttribute('aria-pressed', String(match));
    });

    try { localStorage.setItem('bsv_ai_accent', color); } catch (_) {}
  }

  let saved = null;
  try { saved = localStorage.getItem('bsv_ai_accent'); } catch (_) {}
  // Earlier defaults were never a choice; move those browsers to the current one
  if (OLD_DEFAULTS.includes(normalizeHex(saved))) saved = null;

  document.querySelectorAll('[data-accent]').forEach(btn => {
    const swatchColor = normalizeHex(btn.dataset.accent);
    if (swatchColor) btn.style.backgroundColor = swatchColor;
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      apply(btn.dataset.accent);
    });
  });

  apply(saved || DEFAULT_ACCENT);

  const customInput = el('custom-accent');
  if (customInput) {
    customInput.addEventListener('input', (event) => apply(event.target.value));
    customInput.addEventListener('change', (event) => apply(event.target.value));
  }

  document.addEventListener('click', (event) => {
    const menu = el('accent-menu');
    if (menu && menu.open && !event.target.closest('.palette-menu')) menu.open = false;
  });
  document.addEventListener('keydown', (event) => {
    const menu = el('accent-menu');
    if (event.key === 'Escape' && menu && menu.open) menu.open = false;
  });
})();
