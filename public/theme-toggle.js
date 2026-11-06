const THEME_KEY = 'yieldguard-theme';

function preferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* Storage may be unavailable in private browsing. */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const button = document.querySelector('[data-theme-toggle]');
  if (!button) return;
  const isDark = theme === 'dark';
  button.setAttribute('aria-pressed', String(isDark));
  button.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} mode`);
  button.title = `Switch to ${isDark ? 'light' : 'dark'} mode`;
  button.querySelector('[data-theme-icon]').textContent = isDark ? '☀' : '◐';
  button.querySelector('[data-theme-label]').textContent = isDark ? 'Light' : 'Dark';
}

applyTheme(document.documentElement.dataset.theme || preferredTheme());

document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* Preference remains for this visit. */ }
});
