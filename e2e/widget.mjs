// Browser E2E for the widget against the live Go server.
import { chromium } from 'playwright-core';

const API = 'http://localhost:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) throw new Error('Set ADMIN_TOKEN to the configured SNAG_ADMIN_TOKEN');
const ADMIN = { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' };
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + extra}`); };
const admin = (path, init = {}) => fetch(API + '/api/v1/admin' + path, { headers: ADMIN, ...init }).then((r) => r.json());

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// Test hook: keep a reference to the (still closed) shadow root.
await page.addInitScript(() => {
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = orig.call(this, init);
    if (this.tagName === 'SNAG-WIDGET') window.__rcRoot = root;
    return root;
  };
});

await page.goto('http://localhost:5173/');
await page.waitForFunction(() => window.__rcRoot && window.__rcRoot.querySelector('.fab'));
const q = (sel) => page.evaluateHandle((s) => window.__rcRoot.querySelector(s), sel);
const text = () => page.evaluate(() => window.__rcRoot.textContent);

console.log('== isolation');
check('shadow root is closed', await page.evaluate(() => document.querySelector('snag-widget').shadowRoot === null));
const fabStyle = await page.evaluate(() => { const s = getComputedStyle(window.__rcRoot.querySelector('.fab')); return { bg: s.backgroundColor, border: s.borderStyle, font: s.fontFamily }; });
check('host button{all:unset} + hotpink did not leak into FAB', fabStyle.bg === 'rgb(79, 70, 229)' && fabStyle.border !== 'dashed', JSON.stringify(fabStyle));

console.log('== telemetry');
await page.click('#err');
await page.click('#f500');
await page.click('#f404');
await page.click('#route');
await page.click('#throw').catch(() => {});
await page.waitForTimeout(400);

console.log('== Alt+B + panel');
await page.keyboard.press('Alt+KeyB');
await page.waitForFunction(() => window.__rcRoot.querySelector('.panel'));
check('Alt+B opens panel', true);
const panelStyle = await page.evaluate(() => { const s = getComputedStyle(window.__rcRoot.querySelector('.panel input')); return { font: s.fontFamily, color: s.color, ls: s.letterSpacing }; });
check('host * {font-family !important} did not leak', !/comic/i.test(panelStyle.font), panelStyle.font);
check('host * {color !important} did not leak', panelStyle.color !== 'rgb(192, 38, 211)', panelStyle.color);
check('host letter-spacing did not leak', panelStyle.ls === 'normal', panelStyle.ls);
check('title input focused', await page.evaluate(() => window.__rcRoot.activeElement?.tagName === 'INPUT'));

// Typing inside the widget must not reach host keydown listeners.
await page.evaluate(() => { window.__hostKeys = 0; document.addEventListener('keydown', () => window.__hostKeys++); });
await page.keyboard.type('Pay button does nothing');
check('keystrokes isolated from host shortcuts', (await page.evaluate(() => window.__hostKeys)) === 0);

console.log('== paste → OffscreenCanvas WebP');
await page.evaluate(async () => {
  // 3200x1800 screenshot-like PNG
  const c = document.createElement('canvas'); c.width = 3200; c.height = 1800;
  const g = c.getContext('2d');
  for (let i = 0; i < 60; i++) { g.fillStyle = `hsl(${i * 6},70%,${40 + (i % 3) * 10}%)`; g.fillRect((i % 10) * 320, Math.floor(i / 10) * 300, 320, 300); }
  g.fillStyle = '#000'; g.font = '80px sans-serif'; g.fillText('Error 500 at checkout', 200, 900);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  window.__pngSize = blob.size;
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
  const ta = window.__rcRoot.querySelector('textarea');
  ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
});
await page.waitForFunction(() => window.__rcRoot.querySelectorAll('.att img').length === 1 && !window.__rcRoot.textContent.includes('Compressing'), null, { timeout: 15000 });
check('pasted image shows thumbnail', true);

// Drop a log file → gzip
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['ERROR db timeout\n'.repeat(2000)], 'pos.log', { type: 'text/plain' }));
  window.__rcRoot.querySelector('.bd').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, composed: true }));
});
await page.waitForFunction(() => window.__rcRoot.querySelectorAll('.att').length === 2 && !window.__rcRoot.textContent.includes('Compressing'), null, { timeout: 10000 });
check('dropped log file attached', true);

await page.evaluate(() => {
  const r = window.__rcRoot;
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const inputs = r.querySelectorAll('.row input');
  if (inputs.length) { set(inputs[0], 'Jane Cashier'); set(inputs[1], 'jane@store.example'); }
});
await page.screenshot({ path: new URL('./screenshots/widget-form.png', import.meta.url).pathname });
await page.evaluate(() => window.__rcRoot.querySelector('.ft .btn').click());
await page.waitForFunction(() => /ticket SNAG-\d+ created/.test(window.__rcRoot.textContent), null, { timeout: 10000 });
const code = (await text()).match(/SNAG-\d+/)[0];
check(`ticket submitted (${code})`, true);

console.log('== server-side verification');
const list = await admin('/tickets?q=' + code);
const t = await admin('/tickets/' + list.items[0].id);
const img = t.attachments.find((a) => a.compression_type === 'webp_canvas');
const log = t.attachments.find((a) => a.compression_type === 'gzip');
check('image stored as image/webp', img?.mime_type === 'image/webp', JSON.stringify(t.attachments.map((a) => [a.mime_type, a.compression_type])));
check('log stored gzip', log?.mime_type === 'text/plain');
const full = await admin('/attachments/' + img.id);
const dims = await page.evaluate(async ([p, th]) => {
  const dec = async (b64) => { const bmp = await createImageBitmap(await (await fetch('data:image/webp;base64,' + b64)).blob()); return [bmp.width, bmp.height]; };
  return { full: await dec(p), thumb: await dec(th) };
}, [full.payload_b64, full.thumbnail_b64]);
check('full image scaled to 1600px wide (aspect kept)', dims.full[0] === 1600 && dims.full[1] === 900, JSON.stringify(dims.full));
check('thumbnail fits 150px box', Math.max(...dims.thumb) === 150, JSON.stringify(dims.thumb));
const thumbBytes = Math.floor(full.thumbnail_b64.length * 3 / 4);
const pngSize = await page.evaluate(() => window.__pngSize);
console.log(`    png ${(pngSize / 1024).toFixed(0)} KB → webp ${(img.compressed_size / 1024).toFixed(0)} KB, thumb ${(thumbBytes / 1024).toFixed(1)} KB, log 34 KB → gzip ${log.compressed_size} B`);
check('thumbnail ≲ 6 KB', thumbBytes < 6144, thumbBytes);

const ev = t.telemetry.events;
const kinds = ev.map((e) => e.k);
check('telemetry: console.error captured', ev.some((e) => e.k === 'console' && e.msg.includes('Payment gateway timeout')));
check('telemetry: fetch 404/500 captured, query stripped', ev.some((e) => e.k === 'http' && e.m === 'GET' && e.url === 'http://localhost:8080/api/v1/does-not-exist'), JSON.stringify(ev.filter((e) => e.k === 'http')));
check('telemetry: XHR 404 captured', ev.some((e) => e.k === 'http' && e.url === '/missing.json' && e.status === 404));
check('telemetry: route change, query stripped', ev.some((e) => e.k === 'route' && e.to === '/orders/42'));
check('telemetry: uncaught error captured', ev.some((e) => e.k === 'error' && e.msg.includes('reading "total"')));
check('telemetry: clicks captured', ev.some((e) => e.k === 'click' && e.el.startsWith('button#err')));
check('telemetry: widget\'s own API calls excluded', !ev.some((e) => e.k === 'http' && e.url.includes('/api/v1/widget')));
check('telemetry: ≤ 20 events', ev.length <= 20, ev.length);
check('telemetry: env captured', t.telemetry.env?.url === 'http://localhost:5173/orders/42' && !!t.telemetry.env.ua);

console.log('== live thread over SSE');
await page.evaluate(() => [...window.__rcRoot.querySelectorAll('button')].find((b) => b.textContent === 'View ticket').click());
await page.waitForFunction(() => window.__rcRoot.querySelectorAll('.msg').length >= 1);
await admin(`/tickets/${t.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'INTERNAL: suspect gateway retry bug', is_internal: true }) });
await admin(`/tickets/${t.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Thanks Jane — we can reproduce it.', is_internal: false }) });
await page.waitForFunction(() => window.__rcRoot.textContent.includes('we can reproduce it'), null, { timeout: 5000 }).then(() => check('developer reply appears live', true), () => check('developer reply appears live', false));
await page.waitForTimeout(300);
check('internal note never reaches widget', !(await text()).includes('INTERNAL'));
check('status badge updated live to triaged', (await text()).includes('triaged'));

await admin(`/tickets/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in_progress' }) });
await page.waitForFunction(() => window.__rcRoot.textContent.includes('in progress'), null, { timeout: 5000 }).then(() => check('status change pushed live', true), () => check('status change pushed live', false));

// Client reply from widget → appears in admin detail
await page.evaluate(() => {
  const ta = window.__rcRoot.querySelector('form.ft textarea');
  ta.value = 'It happens on terminal 3 only'; ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.evaluate(() => window.__rcRoot.querySelector('form.ft .btn').click());
await page.waitForTimeout(500);
check('client reply stored', (await admin('/tickets/' + t.id)).messages.some((m) => m.body === 'It happens on terminal 3 only' && m.author_type === 'client'));
await page.screenshot({ path: new URL('./screenshots/widget-thread.png', import.meta.url).pathname });

console.log('== unread badge when panel closed');
await page.evaluate(() => window.__rcRoot.querySelector('.x').click());
await admin(`/tickets/${t.id}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Fix deployed, please retry.', is_internal: false }) });
await page.waitForFunction(() => window.__rcRoot.querySelector('.badge')?.textContent === '1', null, { timeout: 5000 }).then(() => check('FAB shows unread badge', true), () => check('FAB shows unread badge', false));

console.log('== mobile: FAB drag snaps to edge');
await page.setViewportSize({ width: 390, height: 844 });
const box = await (await q('.fab')).boundingBox();
await page.mouse.move(box.x + 26, box.y + 26);
await page.mouse.down();
await page.mouse.move(80, 400, { steps: 8 });
await page.mouse.up();
const after = await (await q('.fab')).boundingBox();
check('FAB snapped to left edge', Math.abs(after.x + after.width / 2 - 42) < 1, JSON.stringify(after));
check('drag did not open panel', !(await page.evaluate(() => !!window.__rcRoot.querySelector('.panel'))));
await page.evaluate(() => window.__rcRoot.querySelector('.fab').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 400, pointerId: 1 })));
await page.evaluate(() => window.__rcRoot.querySelector('.fab').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 400, pointerId: 1 })));
await page.waitForTimeout(100);
check('tap opens full-screen panel on mobile', await page.evaluate(() => { const p = window.__rcRoot.querySelector('.panel'); return !!p && p.getBoundingClientRect().width === 390; }));
await page.screenshot({ path: new URL('./screenshots/widget-mobile.png', import.meta.url).pathname });

check('no uncaught widget errors', pageErrors.every((m) => m.includes('reading "total"')), JSON.stringify(pageErrors));
await browser.close();
console.log(`\npassed: ${pass}  failed: ${fail}`);
process.exit(fail ? 1 : 0);
