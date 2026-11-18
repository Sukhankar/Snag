// Browser E2E for teams: create teams with members, one person in several teams, add/remove
// members, rename, duplicate names, the Users page team column, and team-first assignee lists.
// Needs the stack on :8080 / :3000 and ADMIN_TOKEN (to create throwaway users and a ticket).
import { chromium } from 'playwright-core';

const DASH = process.env.DASH_URL || 'http://localhost:3000';
const API = process.env.SNAG_URL || 'http://localhost:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'owner@example.com';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'change-me-now-please';
const RUN = Date.now().toString(36);
if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN required');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + extra}`); };
const admin = async (path, method = 'GET', body) => {
  const r = await fetch(API + '/api/v1/admin' + path, {
    method,
    headers: { Authorization: 'Bearer ' + ADMIN_TOKEN, 'Content-Type': 'application/json', 'X-Snag-Actor': 'teams-e2e' },
    body: body && JSON.stringify(body),
  });
  return r.status === 204 ? null : r.json();
};

// Two throwaway people.
const roles = (await admin('/roles')).items;
const agent = roles.find((r) => r.name === 'Support Agent') ?? roles.find((r) => !r.is_system);
const mk = (n) => admin('/users', 'POST', { name: `${n} ${RUN}`, email: `team-${n.toLowerCase()}-${RUN}@example.com`, role_id: agent.id, password: 'Temporary-pass-123' });
const asha = await mk('Asha'), ravi = await mk('Ravi');

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(DASH + '/login');
await page.fill('input[name=email]', OWNER_EMAIL);
await page.fill('input[name=password]', OWNER_PASSWORD);
await page.click('button:has-text("Sign in")');
await page.waitForURL((u) => u.pathname === '/' || u.pathname === '/account', { waitUntil: 'commit' });

console.log('== Teams page');
await page.goto(DASH + '/teams');
check('Teams is in the nav', (await page.$$eval('nav a', (as) => as.map((a) => a.textContent.trim()))).includes('Teams'));
const card = (name) => page.locator('li', { has: page.locator('h2', { hasText: name }) });
// Member names only (the card's "Add a person" list also contains names).
const members = (name) => page.locator(`ul[aria-label="Members of ${name}"]`).textContent();

async function createTeam(name, people) {
  await page.click('button:has-text("+ New team")');
  await page.fill('input[placeholder="e.g. POS Core"]', name);
  for (const p of people) await page.locator('label', { hasText: p.email }).locator('input[type=checkbox]').check();
  await page.click('button:has-text("Create team")');
  await card(name).waitFor();
}
const POS = `POS Core ${RUN}`, BILL = `Billing ${RUN}`;
await createTeam(POS, [asha]);
check('team created with its first member', (await members(POS)).includes(asha.name));
await createTeam(BILL, [asha, ravi]);
check('second team has both people', (await members(BILL)).includes(ravi.name));
check('one person in two teams', (await members(POS)).includes(asha.name) && (await members(BILL)).includes(asha.name));

await card(POS).locator('select').selectOption(ravi.id);
await page.waitForFunction((n) => [...document.querySelectorAll('li')].some((li) => li.querySelector('h2')?.textContent === n && li.textContent.includes('2 members')), POS);
check('person added from the card', (await members(POS)).includes(ravi.name));

await card(BILL).getByRole('button', { name: `Remove ${asha.name} from ${BILL}` }).click();
await page.waitForFunction((n) => [...document.querySelectorAll('li')].some((li) => li.querySelector('h2')?.textContent === n && li.textContent.includes('1 member')), BILL);
check('person removed from one team only', !(await members(BILL)).includes(asha.name) && (await members(POS)).includes(asha.name));

await card(BILL).getByRole('button', { name: 'Edit' }).click();
// While editing, the heading is replaced by the form.
const editForm = page.locator('form', { has: page.locator('input[aria-label="Team name"]') });
await editForm.locator('input[aria-label="Team name"]').fill(`${BILL} EU`);
await editForm.getByRole('button', { name: 'Save' }).click();
await card(`${BILL} EU`).waitFor();
check('team renamed', true);

await page.click('button:has-text("+ New team")');
await page.fill('input[placeholder="e.g. POS Core"]', POS.toLowerCase());
await page.click('button:has-text("Create team")');
// Next.js also renders an (empty) role=alert route announcer, so wait for ours by its text.
const dupShown = await page.locator('p[role=alert]', { hasText: /already exists/i }).waitFor({ timeout: 10000 }).then(() => true, () => false);
check('duplicate name refused (case-insensitive)', dupShown);
await page.click('button:has-text("Cancel")');

await page.fill('input[aria-label="Find a team or person"]', ravi.name);
check('search by person shows their teams', (await page.locator('ul.grid > li').count()) === 2);
await page.fill('input[aria-label="Find a team or person"]', '');

console.log('== Users page');
await page.goto(DASH + '/users');
const row = page.locator('tr', { hasText: asha.email });
await row.waitFor();
check('team column lists the team', (await row.textContent()).includes(POS));
await row.getByRole('button', { name: `Change teams for ${asha.name}` }).click();
const picker = page.locator('fieldset', { hasText: `Teams for ${asha.name}` });
await picker.locator('label', { hasText: `${BILL} EU` }).locator('input').check();
await page.click('button:has-text("Save teams")');
await page.waitForFunction((e) => [...document.querySelectorAll('tr')].some((tr) => tr.textContent.includes(e) && tr.textContent.includes('EU')), asha.email);
const teamsOfAsha = (await admin('/users')).items.find((u) => u.id === asha.id).team_ids;
check('teams saved from the Users page', teamsOfAsha.length === 2, JSON.stringify(teamsOfAsha));

console.log('== ticket assignee list puts the team first');
const teams = await admin('/teams');
const pos = teams.items.find((t) => t.name === POS);
const t = await (await fetch(API + '/api/v1/widget/tickets', {
  method: 'POST',
  headers: { Origin: 'http://localhost:5173', 'X-Project-Key': process.env.PROJECT_KEY || 'pk_demo_0000000000000000000000000000', 'X-Reporter-Token': 'teams_e2e_' + RUN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'Teams e2e ' + RUN }),
})).json();
const ticket = (await admin('/tickets?q=' + t.ticket_code)).items[0];
await admin('/tickets/' + ticket.id, 'PATCH', { team_id: pos.id });
await page.goto(`${DASH}/?t=${ticket.id}`);
await page.waitForSelector('select optgroup', { timeout: 15000 }).catch(() => {});
const groups = await page.$$eval('select optgroup', (gs) => gs.map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent)]));
const teamGroup = groups.find(([l]) => l === `${POS} team`);
check('assignee list groups the team first', !!teamGroup && teamGroup[1].includes(asha.name) && teamGroup[1].includes(ravi.name), JSON.stringify(groups).slice(0, 300));

check('no page errors', errors.length === 0, errors.join(' | '));

// Clean up the teams (throwaway users have no delete API; see e2e/README).
for (const tm of (await admin('/teams')).items.filter((x) => x.name.includes(RUN))) await admin('/teams/' + tm.id, 'DELETE');
await browser.close();
console.log(`\npassed: ${pass}  failed: ${fail}`);
process.exit(fail ? 1 : 0);
