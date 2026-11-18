// Browser E2E for users, roles & permissions (owner → creates a user → permission grid →
// that user's restricted view). Needs the stack on :8080 / :3000.
import { chromium } from 'playwright-core';

const DASH = process.env.DASH_URL || 'http://localhost:3000';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'owner@example.com';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'change-me-now-please';
const RUN = Date.now().toString(36);
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + extra}`); };
const shot = (p, name) => p.screenshot({ path: new URL(`./screenshots/${name}.png`, import.meta.url).pathname });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const errors = [];
async function signIn(email, password) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(DASH + '/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL((u) => u.pathname === '/' || u.pathname === '/account', { waitUntil: 'commit' });
  return page;
}
const nav = (page) => page.$$eval('nav a', (as) => as.map((a) => a.textContent.trim()).filter(Boolean));

console.log('== owner');
const owner = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
await owner.waitForSelector('nav >> text=Users');
const ownerNav = await nav(owner);
check('owner sees Users and Roles in nav', ownerNav.includes('Users') && ownerNav.includes('Roles'), JSON.stringify(ownerNav));
check('owner badge shown', (await owner.textContent('nav')).includes('👑'));

console.log('== create a role in the permission grid');
await owner.goto(DASH + '/roles');
await owner.waitForSelector('text=Roles & permissions');
await owner.click('button:has-text("+ New role")');
await owner.fill('input[placeholder="e.g. QA Tester"]', `QA ${RUN}`);
await owner.fill('input[placeholder="What this role is for"]', 'Reads tickets and replies to clients');
await owner.click('button:has-text("Create role")');
await owner.waitForSelector(`th:has-text("QA ${RUN}")`);
check('new role column appears', true);
const box = (perm) => owner.locator(`input[aria-label="${perm} for QA ${RUN}"]`);
await box('Reply to clients').check();
await owner.waitForTimeout(500);
check('ticking a permission saves it', await box('Reply to clients').isChecked());
check('Owner column is locked', await owner.locator('input[aria-label="Manage roles for Owner"]').isDisabled());
await shot(owner, 'roles-grid');

console.log('== create a user');
await owner.goto(DASH + '/users');
await owner.click('button:has-text("+ New user")');
await owner.fill('label:has-text("Full name") input', `Asha ${RUN}`);
await owner.fill('label:has-text("Email (used to sign in)") input', `asha-${RUN}@example.com`);
await owner.selectOption('label:has-text("Role") select', { label: `QA ${RUN}` });
const password = await owner.inputValue('input.font-mono');
check('temporary password generated', password.length >= 10, password);
await owner.click('button:has-text("Create user")');
await owner.waitForSelector(`text=Asha ${RUN} can now sign in`);
check('credentials card shown once', (await owner.textContent('[role=status]')).includes(password));
check('owner row cannot be deactivated or reset', (await owner.locator('tr:has-text("👑 Owner · full access") button:has-text("Deactivate"), tr:has-text("👑 Owner · full access") button:has-text("Reset password")').count()) === 0);
check('new user flagged as temporary password', (await owner.textContent(`tr:has-text("asha-${RUN}")`)).includes('Temporary password'));
await owner.click(`tr:has-text("asha-${RUN}") button:has-text("Edit")`);
await owner.fill('form >> label:has-text("Full name") input', `Asha K ${RUN}`);
await owner.click('form >> button:has-text("Save")');
await owner.waitForSelector(`tr:has-text("Asha K ${RUN}")`);
check('owner edits a user name', true);
await shot(owner, 'users');

console.log('== the new user sees only what the role allows');
const asha = await signIn(`asha-${RUN}@example.com`, password);
await asha.waitForURL(DASH + '/account');
await asha.waitForSelector('text=Choose your own password to continue.');
check('temporary password: sent to My account first', true);
check('temporary password: no navigation until changed', !(await nav(asha)).includes('Inbox'), JSON.stringify(await nav(asha)));
await asha.goto(DASH + '/board');
await asha.waitForURL(DASH + '/account');
check('temporary password: other pages redirect back', true);
await asha.fill('label:has-text("Current password") input', password);
await asha.fill('label:has-text("New password") input', `Asha-own-${RUN}`);
await asha.fill('label:has-text("Confirm new password") input', `Asha-own-${RUN}`);
await asha.click('button:has-text("Change password")');
await asha.waitForURL(DASH + '/');
await asha.waitForSelector('ul[aria-label=Tickets] li');
check('own password chosen → dashboard unlocked', true);
const ashaNav = await nav(asha);
check('nav: Inbox + Board only', ashaNav.join(',').startsWith('Inbox,Board') && !ashaNav.includes('Users') && !ashaNav.includes('Projects'), JSON.stringify(ashaNav));
await asha.click('ul[aria-label=Tickets] li button');
await asha.waitForSelector('text=Auto-captured telemetry');
check('status locked without tickets.update', await asha.locator('select:near(:text("Status"))').first().isDisabled());
check('internal-note toggle disabled', await asha.locator('role=radio[name=/Internal note/]').isDisabled());
check('public reply allowed', !(await asha.locator('role=radio[name="Public reply"]').isDisabled()));
await asha.goto(DASH + '/users');
check('direct URL to /users shows no-access', (await asha.textContent('main')).includes("You don't have access"));
await shot(asha, 'restricted-user');

console.log('== permission granted live by the owner');
await owner.goto(DASH + '/roles');
await box('Update tickets').check();
await owner.waitForTimeout(500);
await asha.goto(DASH + '/');
await asha.click('ul[aria-label=Tickets] li button');
await asha.waitForSelector('text=Auto-captured telemetry');
check('status editable after grant', !(await asha.locator('select:near(:text("Status"))').first().isDisabled()));
const statusSelect = asha.locator('select:near(:text("Status"))').first();
await statusSelect.selectOption((await statusSelect.inputValue()) === 'in_progress' ? 'triaged' : 'in_progress');
await asha.waitForSelector(`text=/Asha K ${RUN}\\s*changed status/`);
check('activity log shows who changed the status', true);

console.log('== deactivate');
await owner.goto(DASH + '/users');
owner.once('dialog', (d) => d.accept());
await owner.click(`tr:has-text("asha-${RUN}") button:has-text("Deactivate")`);
await owner.waitForSelector(`tr:has-text("asha-${RUN}") >> text=Deactivated`);
await asha.goto(DASH + '/');
check('deactivated user is bounced to login', asha.url().endsWith('/login'));

console.log('== reports');
await owner.goto(DASH + '/reports');
await owner.waitForSelector('text=AMC report');
await owner.waitForSelector('table tbody tr td:not(:has-text("Loading"))');
check('AMC report renders', (await owner.locator('section[aria-label=Totals]').textContent()).includes('Tickets'));
await owner.click('button:has-text("Last 12 months")');
await owner.waitForSelector('table tbody tr td:not(:has-text("Loading"))');
check('report has project rows for the last 12 months', (await owner.locator('table tbody tr').count()) >= 1);
await shot(owner, 'reports');

console.log('== my account');
await owner.goto(DASH + '/account');
check('account page shows owner', (await owner.textContent('main')).includes('Owner — full access'));

check('no client-side exceptions', errors.length === 0, JSON.stringify(errors));
await browser.close();
console.log(`\npassed: ${pass}  failed: ${fail}`);
process.exit(fail ? 1 : 0);
