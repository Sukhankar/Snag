/* Shared site behaviour. Storage is optional and isolated from the Snag app. */
const rootURL = new URL('.', document.currentScript.src);
const SETTINGS = 'snag-site:settings:v1';
const THEME = 'snag-site:theme:v1';
const MAX_AGE = 180 * 24 * 60 * 60 * 1000;
// Consent is tied to the policy version the build stamps into each page; a new version asks again.
const CONSENT_VERSION = document.querySelector('meta[name="snag-consent"]')?.content || '1';
// Browsers that send Global Privacy Control get the defaults (no optional storage) without a prompt.
const GPC = navigator.globalPrivacyControl === true;
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const status = document.querySelector('#storage-status');
const dialog = document.querySelector('#storage-dialog');
const notice = document.querySelector('.storage-notice');
const themeButtons = [...document.querySelectorAll('[data-theme-value]')];
let choice = null;
const DEFAULT_THEME = 'dark';
let theme = document.documentElement.dataset.theme || DEFAULT_THEME;
let storageBusy = false;

function readChoice() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS));
    if (saved && saved.expires > Date.now() && saved.version === CONSENT_VERSION) return saved;
    localStorage.removeItem(SETTINGS);
    localStorage.removeItem(THEME);
  } catch { /* A blocked storage API should not break navigation or appearance. */ }
  return null;
}
choice = readChoice();
function applyTheme(value) {
  theme = ['system', 'light', 'dark'].includes(value) ? value : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
  themeButtons.forEach(button => {
    const on = button.dataset.themeValue === theme;
    button.setAttribute('aria-checked', String(on));
    button.tabIndex = on ? 0 : -1;
  });
  const dark = theme === 'dark' || (theme === 'system' && systemTheme.matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0a0a0a' : '#f3f1e9';
  document.dispatchEvent(new Event('snag:theme'));
  if (choice?.remember) {
    try { localStorage.setItem(THEME, theme); } catch { /* Current-page theme still applies. */ }
  }
}
applyTheme(theme);
themeButtons.forEach((button, index) => {
  button.addEventListener('click', () => applyTheme(button.dataset.themeValue));
  // Radio-group keyboard pattern: arrow keys move and select.
  button.addEventListener('keydown', event => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = themeButtons[(index + step + themeButtons.length) % themeButtons.length];
    applyTheme(next.dataset.themeValue);
    next.focus();
  });
});
systemTheme.addEventListener('change', () => applyTheme(theme));

// The prefix contains the site path so controls do not clear unrelated caches.
const cachePrefix = `snag-docs-${encodeURIComponent(rootURL.pathname)}-`;
async function removeOfflineCopies() {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      const worker = registration.active || registration.waiting || registration.installing;
      if (worker?.scriptURL === new URL('sw.js', rootURL).href) {
        [registration.active, registration.waiting, registration.installing].filter(Boolean).forEach(item => item.postMessage({ type: 'DISABLE_CACHE' }));
        await registration.unregister();
      }
    }
  }
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(cachePrefix)).map(key => caches.delete(key)));
  }
}
async function configureOffline(enabled) {
  if (!enabled) { await removeOfflineCopies(); return; }
  if (!('serviceWorker' in navigator) || !isSecureContext) throw new Error('Offline access requires HTTPS or localhost and service-worker support.');
  await navigator.serviceWorker.register(new URL('sw.js', rootURL), { scope: rootURL.pathname });
}
async function saveChoice(remember, offline) {
  const next = { remember, offline, version: CONSENT_VERSION, savedAt: new Date().toISOString(), gpc: GPC, expires: Date.now() + MAX_AGE };
  // Do not enable a worker if its opt-in cannot be persisted and later honoured.
  try {
    localStorage.setItem(SETTINGS, JSON.stringify(next));
    if (remember) localStorage.setItem(THEME, theme);
    else localStorage.removeItem(THEME);
  } catch { throw new Error('Browser storage is unavailable. Theme changes still work for this page; optional storage remains off.'); }
  choice = next;
  try { await configureOffline(offline); }
  catch (error) {
    choice.offline = false;
    localStorage.setItem(SETTINGS, JSON.stringify(choice));
    document.querySelector('#offline-docs').checked = false;
    throw error;
  }
  notice.hidden = true;
}
function showSettings() {
  document.querySelector('#remember-theme').checked = !!choice?.remember;
  document.querySelector('#offline-docs').checked = !!choice?.offline;
  status.textContent = '';
  dialog.showModal();
}
document.querySelectorAll('[data-storage-open]').forEach(button => button.addEventListener('click', showSettings));
async function storageAction(task) {
  if (storageBusy) return;
  storageBusy = true;
  const buttons = dialog.querySelectorAll('.dialog-actions button');
  buttons.forEach(button => button.disabled = true);
  try { await task(); } catch (error) { status.textContent = error.message; }
  finally { storageBusy = false; buttons.forEach(button => button.disabled = false); }
}
document.querySelector('#save-storage').addEventListener('click', () => storageAction(async () => {
  await saveChoice(document.querySelector('#remember-theme').checked, document.querySelector('#offline-docs').checked);
  status.textContent = choice.offline ? 'Saved. Offline pages are being prepared in the background. Revisit a guide before disconnecting.' : 'Saved. Optional offline copies are disabled.';
}));
document.querySelector('#storage-defaults').addEventListener('click', async () => {
  try { await saveChoice(false, false); }
  catch { notice.hidden = true; /* No preference is remembered when storage is blocked. */ }
});
document.querySelector('#clear-cache').addEventListener('click', () => storageAction(async () => {
  await saveChoice(!!choice?.remember, false);
  document.querySelector('#offline-docs').checked = false;
  status.textContent = 'This site’s offline copies are cleared and offline mode is off. The browser’s ordinary HTTP cache is unchanged.';
}));
document.querySelector('#reset-storage').addEventListener('click', () => storageAction(async () => {
  await removeOfflineCopies();
  try { localStorage.removeItem(SETTINGS); localStorage.removeItem(THEME); } catch { /* Nothing further can be cleared. */ }
  choice = null;
  applyTheme(DEFAULT_THEME);
  document.querySelector('#remember-theme').checked = false;
  document.querySelector('#offline-docs').checked = false;
  status.textContent = 'Preferences and offline copies removed. Appearance is back to the default dark theme.';
  notice.hidden = GPC;
}));
notice.hidden = !!choice || GPC;
configureOffline(!!choice?.offline).catch(() => { /* The online site remains usable. */ });
window.addEventListener('storage', event => {
  if (![SETTINGS, THEME].includes(event.key) && event.key !== null) return;
  choice = readChoice();
  let selected = DEFAULT_THEME;
  try { if (choice?.remember) selected = localStorage.getItem(THEME) || DEFAULT_THEME; } catch { /* Default */ }
  applyTheme(selected);
  notice.hidden = !!choice || GPC;
  configureOffline(!!choice?.offline).catch(() => {});
});

// The workflow preview loops continuously; choosing a step jumps to it and keeps playing.
const stages = [
  ['NEW REPORT', 'The receipt came out blank.', "Payment went through. The printed receipt didn't.", '14:32:01   Click   “Print receipt”\n14:32:02   POST    /receipts\n14:32:02   500     Request failed'],
  ['IN PROGRESS', 'One issue. One investigation.', 'Assigned to the checkout team. Two duplicate reports linked.', 'Priority       P2_Normal\nAssigned       Checkout team\nInternal note  Checking the print service'],
  ['REPLIED', 'A reply, right where it started.', '“The print service is back. Please try your receipt again.”', 'Public reply   Visible to the reporter\nDelivery       Live event stream\nConversation   Kept with the ticket']
];
const demo = document.querySelector('.demo');
if (demo) {
  const SLIDE_MS = 7000;
  let current = 0;
  let timer;
  const slide = document.querySelector('#demo-slide');
  const buttons = [...document.querySelectorAll('[data-stage]')];
  function render() {
    buttons.forEach((button, index) => button.setAttribute('aria-pressed', String(index === current)));
    ['demo-status', 'demo-title', 'demo-description', 'demo-trace'].forEach((id, i) => document.getElementById(id).textContent = stages[current][i]);
    slide.classList.remove('slide-enter');
    void slide.offsetWidth;
    slide.classList.add('slide-enter');
  }
  function schedule() {
    clearTimeout(timer);
    // Restart the progress line on the active step.
    demo.dataset.playing = 'false';
    void demo.offsetWidth;
    if (document.hidden) return;
    demo.dataset.playing = 'true';
    timer = setTimeout(() => { current = (current + 1) % stages.length; render(); schedule(); }, SLIDE_MS);
  }
  buttons.forEach((button, index) => button.addEventListener('click', () => { current = index; render(); schedule(); }));
  document.addEventListener('visibilitychange', schedule);
  schedule();
}

document.addEventListener('click', async event => {
  const button = event.target.closest('.copy');
  if (!button) return;
  const block = button.closest('.codebox').querySelector('code');
  try {
    await navigator.clipboard.writeText(block.textContent);
    button.textContent = 'Copied';
    setTimeout(() => button.textContent = 'Copy', 1800);
  } catch {
    button.textContent = 'Select text';
    const range = document.createRange(); range.selectNodeContents(block);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
});
const search = document.querySelector('#doc-search');
search?.addEventListener('input', () => {
  let visible = 0;
  document.querySelectorAll('.sidebar nav a').forEach(a => { a.hidden = !a.textContent.toLowerCase().includes(search.value.trim().toLowerCase()); if (!a.hidden) visible++; });
  document.querySelector('#search-empty').hidden = visible > 0;
});

// ---------- Ambient backgrounds (decorative; skipped for reduced motion where they move) ----------
(() => {
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const root = document.documentElement;

  // Cursor spotlight over the section dot / grid patterns.
  const lit = [...document.querySelectorAll('.section, .ownership')];
  if (lit.length) {
    let frame = 0;
    let last = null;
    const update = () => {
      frame = 0;
      for (const el of lit) {
        const rect = el.getBoundingClientRect();
        if (last.clientY < rect.top - 260 || last.clientY > rect.bottom + 260) continue;
        // The pattern layer spans the full viewport width, so x is the viewport x.
        el.style.setProperty('--mx', `${last.clientX}px`);
        el.style.setProperty('--my', `${last.clientY - rect.top}px`);
      }
    };
    document.addEventListener('pointermove', event => {
      if (!finePointer.matches || event.pointerType !== 'mouse') return;
      last = event;
      root.style.setProperty('--spot', '1');
      if (!frame) frame = requestAnimationFrame(update);
    }, { passive: true });
    document.documentElement.addEventListener('pointerleave', () => root.style.setProperty('--spot', '0'));
  }

  // Hero dot field: a grid of dots carried by slow travelling waves that swell around the cursor.
  const canvas = document.querySelector('.hero-field');
  const context = canvas?.getContext('2d');
  if (!context) return;
  const GAP = 26;
  const REACH = 170;
  let width = 0;
  let height = 0;
  let colors = { dot: '#fff', hot: '#c7f284' };
  let raf = 0;
  let onScreen = true;
  const pointer = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4 };

  const readColors = () => {
    const style = getComputedStyle(root);
    colors = { dot: style.getPropertyValue('--field-dot').trim() || colors.dot, hot: style.getPropertyValue('--field-hot').trim() || colors.hot };
  };
  const draw = time => {
    // Ease the glow toward the pointer so it trails smoothly.
    pointer.x += (pointer.tx - pointer.x) * 0.18;
    pointer.y += (pointer.ty - pointer.y) * 0.18;
    const t = reducedMotion.matches ? 0 : time;
    context.clearRect(0, 0, width, height);
    for (let y = GAP / 2; y < height; y += GAP) {
      for (let x = GAP / 2; x < width; x += GAP) {
        const wave = Math.sin(x * 0.011 + y * 0.004 - t * 0.0011) + 0.6 * Math.sin(x * 0.0045 - y * 0.012 + t * 0.0007);
        let px = x;
        let py = y + wave * 3;
        let radius = 1;
        let alpha = 0.22 + 0.13 * wave;
        let heat = 0;
        const dx = x - pointer.x;
        const dy = y - pointer.y;
        const distance = Math.hypot(dx, dy);
        if (distance < REACH) {
          const f = 1 - distance / REACH;
          heat = f * f;
          if (distance > 0.5) { px += (dx / distance) * heat * 9; py += (dy / distance) * heat * 9; }
          radius += heat * 1.7;
          alpha += heat * 0.75;
        }
        context.globalAlpha = Math.max(0.04, Math.min(1, alpha));
        context.fillStyle = heat > 0.04 ? colors.hot : colors.dot;
        context.beginPath();
        context.arc(px, py, radius, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.globalAlpha = 1;
  };
  const running = () => onScreen && !document.hidden && !reducedMotion.matches;
  const loop = time => { draw(time); raf = running() ? requestAnimationFrame(loop) : 0; };
  const start = () => { if (!raf && running()) raf = requestAnimationFrame(loop); else if (!running()) draw(0); };
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw(performance.now());
  };

  readColors();
  resize();
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; start(); }).observe(canvas);
  document.addEventListener('visibilitychange', start);
  reducedMotion.addEventListener('change', start);
  document.addEventListener('snag:theme', () => { readColors(); if (!raf) draw(0); });
  window.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse') return;
    const rect = canvas.getBoundingClientRect();
    const entering = pointer.tx < -1000;
    pointer.tx = event.clientX - rect.left;
    pointer.ty = event.clientY - rect.top;
    // Start the glow under the cursor instead of sweeping in from off-screen.
    if (entering) { pointer.x = pointer.tx; pointer.y = pointer.ty; }
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { pointer.tx = -1e4; pointer.ty = -1e4; });
  start();
})();
