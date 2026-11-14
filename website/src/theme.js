/* Apply saved appearance before paint; first visits open in dark. */
(() => {
  let theme = 'dark';
  try {
    const settings = JSON.parse(localStorage.getItem('snag-site:settings:v1'));
    const version = document.querySelector('meta[name="snag-consent"]')?.content || '1';
    if (settings?.remember && settings.expires > Date.now() && settings.version === version) {
      const saved = localStorage.getItem('snag-site:theme:v1');
      if (['system', 'light', 'dark'].includes(saved)) theme = saved;
    }
  } catch { /* Storage may be unavailable; dark appearance still applies. */ }
  document.documentElement.dataset.theme = theme;
})();
