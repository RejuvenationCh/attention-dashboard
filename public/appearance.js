// Theme, accent colour and reduced effects, from Settings. Loaded in <head> before the page
// paints, so a dark page never flashes white. Kept per browser in localStorage.
(() => {
  const KEY = 'attention-appearance-v1';
  const ACCENTS = {
    blue:   ['#3b82f6', '#2170e4', '59,130,246'],
    teal:   ['#0d9488', '#0f766e', '13,148,136'],
    purple: ['#7c3aed', '#6d28d9', '124,58,237'],
    rose:   ['#e11d48', '#be123c', '225,29,72'],
    amber:  ['#d97706', '#b45309', '217,119,6'],
  };
  // A custom accent: '#3b82f6' or '#38f'. Its hover shade is the same colour 15% darker.
  const parseHex = hex => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  };
  const toHex = rgb => '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  function fromHex(hex) {
    const rgb = parseHex(hex);
    return rgb && [toHex(rgb), toHex(rgb.map(v => v * 0.85)), rgb.join(',')];
  }
  // Light accents (yellow, pale green) get dark text on their buttons instead of white.
  const isLight = rgb => {
    const [r, g, b] = rgb.split(',').map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45;
  };
  const dark = matchMedia('(prefers-color-scheme: dark)');
  // size: page zoom · compact: tighter spacing · clock: '24' | '12' · hide: cards switched off
  const DEFAULTS = { theme: 'system', accent: 'blue', customAccent: '#3b82f6', reduce: false, size: '1', compact: false, clock: '24', hide: [], lang: 'auto' };
  const CARDS = ['ring', 'tiles', 'courses', 'schedule', 'search', 'week'];
  const read = () => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY)) }; }
    catch { return { ...DEFAULTS }; }
  };
  function apply(a = read()) {
    const root = document.documentElement;
    root.dataset.theme = a.theme === 'system' ? (dark.matches ? 'dark' : 'light') : a.theme;
    const [p, deep, rgb] = a.accent === 'custom' ? fromHex(a.customAccent) || ACCENTS.blue : ACCENTS[a.accent] || ACCENTS.blue;
    root.style.setProperty('--primary', p);
    root.style.setProperty('--primary-deep', deep);
    root.style.setProperty('--a', rgb);
    root.style.setProperty('--on-primary', a.accent === 'custom' && isLight(rgb) ? '#16181d' : '#fff');
    root.classList.toggle('reduce-effects', !!a.reduce);
    root.classList.toggle('compact', !!a.compact);
    root.classList.toggle('clock12', a.clock === '12');
    root.style.setProperty('--zoom', String(Number(a.size) || 1));
    for (const c of CARDS) root.classList.toggle('hide-' + c, (a.hide || []).includes(c));
  }
  function save(a) {
    try { localStorage.setItem(KEY, JSON.stringify(a)); } catch {}
    apply(a);
  }
  dark.addEventListener('change', () => apply());   // "System" follows the OS live
  apply();
  window.appearance = { read, save, apply, CARDS, parseHex, toHex };
})();
