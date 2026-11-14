// Browser E2E for the dashboard (with the widget driving live events).
import { chromium } from 'playwright-core';

const DASH = 'http://localhost:3000';
const API = 'http://localhost:8080';
const KEY = 'pk_demo_0000000000000000000000000000';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'owner@example.com';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'change-me-now-please';
const OWNER_NAME = process.env.OWNER_NAME || 'Owner';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + extra}`); };
const shot = (p, name) => p.screenshot({ path: new URL(`./screenshots/${name}.png`, import.meta.url).pathname });

// Widget-side helper: create a ticket as a client of the demo project.
const widget = (path, token, body) =>
  fetch(`${API}/api/v1/widget${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Origin: 'http://localhost:5173', 'X-Project-Key': KEY, 'X-Reporter-Token': token, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  }).then((r) => r.json());

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

console.log('== auth & proxy');
let r = await fetch(DASH + '/api/snag/tickets');
check('proxy without session → 401', r.status === 401);
await page.goto(DASH + '/');
check('unauthenticated page → /login', page.url().endsWith('/login'));
await page.fill('input[name=email]', OWNER_EMAIL);
await page.fill('input[name=password]', 'wrong-password');
await page.click('button:has-text("Sign in")');
await page.waitForSelector('text=Incorrect email or password.');
check('wrong password rejected (email kept)', (await page.inputValue('input[name=email]')) === OWNER_EMAIL);
await page.fill('input[name=password]', OWNER_PASSWORD);
await page.click('button:has-text("Sign in")');
await page.waitForURL(DASH + '/', { waitUntil: 'commit' });
check('login → inbox', true);
const cookie = (await ctx.cookies()).find((c) => c.name === 'snag_session');
check('session cookie httpOnly + SameSite=Lax', cookie?.httpOnly && cookie?.sameSite === 'Lax');
const ch = { Cookie: `snag_session=${cookie.value}` };
check('proxy blocks non-allow-listed path', (await fetch(DASH + '/api/snag/../widget/tickets', { headers: ch })).status === 404 && (await fetch(DASH + '/api/snag/tickets/not-a-uuid', { headers: ch })).status === 404);
check('proxy blocks cross-site mutation (CSRF)', (await fetch(DASH + '/api/snag/teams', { method: 'POST', headers: { ...ch, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"name":"x"}' })).status === 403);
check('forged session token rejected', (await fetch(DASH + '/api/snag/tickets', { headers: { Cookie: 'snag_session=' + 'A'.repeat(43) } })).status === 401);

console.log('== live inbox');
await page.waitForSelector('text=Live');
check('SSE connected (Live indicator)', true);
const token = 'dash_e2e_' + Date.now();
const created = await widget('/tickets', token, {
  title: 'Receipt printer prints blank after update ' + Date.now(), description: 'Since v2.5 the printer outputs blank receipts on terminal 2.',
  category: 'bug', priority: 'P0_Critical', reporter_name: 'Store 12', reporter_email: 'store12@example.com', app_version: '2.5.0',
  telemetry: { v: 1, captured_at: new Date().toISOString(), env: { url: 'https://pos.example.com/checkout', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131', vw: 1366, vh: 768, dpr: 1, tz: 'Asia/Kolkata', lang: 'en-IN', online: true },
    events: [{ t: Date.now() - 4000, k: 'click', el: 'button#print', text: 'Print receipt' }, { t: Date.now() - 3000, k: 'http', m: 'POST', url: '/api/print', status: 502, ms: 812 }, { t: Date.now() - 2900, k: 'console', msg: 'PrinterError: spooler offline' }] },
});
await page.waitForSelector(`text=${created.ticket_code}`, { timeout: 5000 }).then(() => check(`new ticket ${created.ticket_code} appears live`, true), () => check('new ticket appears live', false));
check('NEW marker on live ticket', await page.locator(`li:has-text("${created.ticket_code}") span:text-is("NEW")`).count() === 1);

console.log('== split-view workspace');
await page.click(`text=${created.ticket_code}`);
await page.waitForSelector('text=Auto-captured telemetry');
check('URL deep-links selection', page.url().includes('?t='));
check('telemetry timeline renders', await page.locator('text=PrinterError: spooler offline').count() === 1 && await page.locator('code:has-text("/api/print")').count() >= 1);
await page.click('role=radio[name=/Change request/]');
await page.waitForTimeout(400);
const tid = new URL(page.url()).searchParams.get('t');
let detail = await fetch(`${DASH}/api/snag/tickets/${tid}`, { headers: ch }).then((r) => r.json());
check('AMC classifier persisted change_request', detail.scope_class === 'change_request');
await page.selectOption('select:near(:text("Status"))', 'in_progress');
await page.waitForTimeout(400);
detail = await fetch(`${DASH}/api/snag/tickets/${tid}`, { headers: ch }).then((r) => r.json());
check('status change persisted', detail.status === 'in_progress');
check('client was pushed the status', (await widget('/tickets/' + created.ticket_code, token)).status === 'in_progress');

console.log('== internal vs public');
await page.click('role=radio[name=/Internal note/]');
await page.fill('textarea[aria-label="Internal note"]', 'Root cause: ESC/POS driver regression in 2.5');
await page.click('button:has-text("Add note")');
await page.waitForSelector('text=Root cause: ESC/POS driver regression');
await page.click('role=radio[name="Public reply"]');
await page.fill('textarea[aria-label="Public reply"]', 'Thanks — a hotfix is on the way.');
await page.keyboard.press('Control+Enter');
await page.waitForSelector('text=Thanks — a hotfix is on the way.');
const clientView = await widget('/tickets/' + created.ticket_code, token);
check('client sees public reply', clientView.messages.some((m) => m.body.includes('hotfix')));
check('client does NOT see internal note', !JSON.stringify(clientView).includes('ESC/POS'));
detail = await fetch(`${DASH}/api/snag/tickets/${tid}`, { headers: ch }).then((r) => r.json());
check('actor recorded from session', detail.messages.find((m) => m.is_internal)?.author_id === OWNER_NAME);
await widget(`/tickets/${created.ticket_code}/messages`, token, { body: 'Terminal 3 is affected as well.' });
await page.waitForSelector('text=Terminal 3 is affected as well.', { timeout: 5000 }).then(() => check('client reply appears live in thread', true), () => check('client reply appears live in thread', false));

console.log('== dedupe + cascade');
const dupToken = 'dash_e2e_dup_' + Date.now();
const dup = await widget('/tickets', dupToken, { title: 'Blank receipts on all terminals', reporter_name: 'Store 40' });
await page.goto(`${DASH}/?t=${tid}`);
await page.waitForSelector('text=Auto-captured telemetry');
// open the duplicate, link it to the parent through the search box
const dupId = (await fetch(`${DASH}/api/snag/tickets?q=${dup.ticket_code}`, { headers: ch }).then((r) => r.json())).items[0].id;
await page.goto(`${DASH}/?t=${dupId}`);
await page.fill('input[aria-label="Find parent ticket"]', created.ticket_code);
await page.click(`ul[aria-label="Matching tickets"] button:has-text("${created.ticket_code}")`);
await page.waitForSelector('text=Tracked under');
check('linked as duplicate via search', true);
await page.click(`button.font-mono:has-text("${created.ticket_code}")`);
await page.waitForSelector('text=2 clients');
check('parent shows duplicate count', true);
await page.fill('input[placeholder^="Broadcast"]', 'Hotfix 2.5.1 is rolling out tonight.');
await page.click('button:has-text("Broadcast")');
await page.waitForSelector('text=Sent to 2 reporters.');
check('broadcast delivered to both reporters', (await widget('/tickets/' + dup.ticket_code, dupToken)).messages.some((m) => m.body.includes('2.5.1')));
await page.selectOption('select:near(:text("Status"))', 'resolved');
await page.waitForTimeout(600);
const dupView = await widget('/tickets/' + dup.ticket_code, dupToken);
check('resolving parent cascades to duplicate', dupView.status === 'resolved');
check('duplicate reporter got system notice', dupView.messages.some((m) => m.author_type === 'system' && m.body.includes(created.ticket_code)));
await shot(page, 'dash-workspace');

console.log('== lightbox (image + gzip log)');
const webp = await page.evaluate(async () => {
  const c = new OffscreenCanvas(1200, 700); const g = c.getContext('2d'); g.fillStyle = '#1e293b'; g.fillRect(0, 0, 1200, 700); g.fillStyle = '#f43f5e'; g.font = '64px sans-serif'; g.fillText('Blank receipt', 300, 360);
  const toB64 = async (b) => { const a = new Uint8Array(await b.arrayBuffer()); let s = ''; for (const x of a) s += String.fromCharCode(x); return btoa(s); };
  const t = new OffscreenCanvas(150, 88); t.getContext('2d').drawImage(c, 0, 0, 150, 88);
  const gz = await new Response(new Blob(['[ERROR] spooler offline\n'.repeat(50)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  return { full: await toB64(await c.convertToBlob({ type: 'image/webp', quality: 0.72 })), thumb: await toB64(await t.convertToBlob({ type: 'image/webp', quality: 0.5 })), gz: await toB64(gz) };
});
const withAtt = await widget('/tickets', token, { title: 'Screenshot of blank receipt', attachments: [
  { file_name: 'receipt.webp', mime_type: 'image/webp', compression_type: 'webp_canvas', payload_b64: webp.full, thumbnail_b64: webp.thumb },
  { file_name: 'spooler.log', mime_type: 'text/plain', compression_type: 'gzip', payload_b64: webp.gz }] });
const attTicket = (await fetch(`${DASH}/api/snag/tickets?q=${withAtt.ticket_code}`, { headers: ch }).then((r) => r.json())).items[0];
await page.goto(`${DASH}/?t=${attTicket.id}`);
await page.click('button[title^="receipt.webp"]');
await page.waitForSelector('[role=dialog] img');
const nat = await page.$eval('[role=dialog] img', (i) => [i.naturalWidth, i.naturalHeight]);
check('lightbox renders full WebP from base64', nat[0] === 1200 && nat[1] === 700, JSON.stringify(nat));
await shot(page, 'dash-lightbox');
await page.keyboard.press('ArrowRight');
await page.waitForSelector('[role=dialog] pre');
check('lightbox inflates gzip log in browser', (await page.textContent('[role=dialog] pre')).startsWith('[ERROR] spooler offline'));
await page.keyboard.press('Escape');

console.log('== kanban');
await page.goto(DASH + '/board');
await page.waitForSelector(`text=${withAtt.ticket_code}`);
const card = page.locator(`li[draggable]:has-text("${withAtt.ticket_code}")`);
await card.dragTo(page.locator('section[aria-label="In progress"]'));
await page.waitForTimeout(500);
check('drag to In progress persisted', (await fetch(`${DASH}/api/snag/tickets/${attTicket.id}`, { headers: ch }).then((r) => r.json())).status === 'in_progress');
check('duplicate hidden from board', await page.locator(`li[draggable]:has-text("${dup.ticket_code}")`).count() === 0);
await fetch(`${DASH}/api/snag/tickets/${attTicket.id}`, { method: 'PATCH', headers: { ...ch, Origin: DASH, 'Content-Type': 'application/json' }, body: '{"status":"triaged"}' });
await page.waitForFunction((code) => document.querySelector('section[aria-label="Triaged"]')?.textContent.includes(code), withAtt.ticket_code, { timeout: 5000 }).then(() => check('board moves card on live update', true), () => check('board moves card on live update', false));
await shot(page, 'dash-board');

console.log('== projects');
await page.goto(DASH + '/projects');
await page.waitForSelector('text=Demo Project');
check('projects page lists demo project', true);
await shot(page, 'dash-projects');

await page.goto(DASH + '/');
await page.waitForSelector('ul[aria-label=Tickets] li');
await page.setViewportSize({ width: 1600, height: 950 });
await page.goto(`${DASH}/?t=${tid}`);
await page.waitForSelector('text=Auto-captured telemetry');
await shot(page, 'dash-inbox');

check('no client-side exceptions', errors.length === 0, JSON.stringify(errors));
await browser.close();
console.log(`\npassed: ${pass}  failed: ${fail}`);
process.exit(fail ? 1 : 0);
