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
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const read = () => {
    try { return { theme: 'system', accent: 'blue', reduce: false, ...JSON.parse(localStorage.getItem(KEY)) }; }
    catch { return { theme: 'system', accent: 'blue', reduce: false }; }
  };
  function apply(a = read()) {
    const root = document.documentElement;
    root.dataset.theme = a.theme === 'system' ? (dark.matches ? 'dark' : 'light') : a.theme;
    const [p, deep, rgb] = ACCENTS[a.accent] || ACCENTS.blue;
    root.style.setProperty('--primary', p);
    root.style.setProperty('--primary-deep', deep);
    root.style.setProperty('--a', rgb);
    root.classList.toggle('reduce-effects', !!a.reduce);
  }
  function save(a) {
    try { localStorage.setItem(KEY, JSON.stringify(a)); } catch {}
    apply(a);
  }
  dark.addEventListener('change', () => apply());   // "System" follows the OS live
  apply();
  window.appearance = { read, save, apply };
})();
