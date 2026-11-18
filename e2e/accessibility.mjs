// Automated WCAG checks supplement, but do not replace, assistive-technology testing.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { launchBrowser } from './browser.mjs';
const require = createRequire(import.meta.url);
const SITE = process.env.SITE_URL, DASH = process.env.DASH_URL;
if (!SITE || !DASH) throw Error('Explicit isolated SITE_URL and DASH_URL required');
const browser = await launchBrowser();
const results = [];
let failures = 0;
async function audit(page, name) {
  await page.addScriptTag({path: require.resolve('axe-core/axe.min.js')});
  const result = await page.evaluate(async () => {
    await document.fonts.ready;
    return axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});
  });
  const violations = result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));
  results.push({name, violations, incomplete:result.incomplete.map(v=>v.id)});
  failures += violations.length;
  console.log(violations.length ? 'FAIL' : 'PASS',name,JSON.stringify(violations));
}
try {
  // CSP bypass is confined to audit contexts so axe can be injected; application CSP is unchanged.
  const ctx = await browser.newContext({bypassCSP:true, reducedMotion:"reduce"});
  const page = await ctx.newPage();
  const routes = ['/', ...['getting-started','architecture','widget','deployment','api','security','configuration','testing','troubleshooting','contributing'].map(x=>`/docs/${x}/`), ...['terms','privacy','cookies'].map(x=>`/legal/${x}/`), '/missing-audit-page'];
  for (const theme of ['light','dark']) {
    for (const route of routes) {
      await page.goto(SITE+route);
      await page.locator(`[data-theme-value=${theme}]`).click();
      await page.waitForTimeout(200);
      await audit(page,`${theme} ${route}`);
    }
  }
  await page.goto(SITE);
  await page.locator('.storage-notice [data-storage-open]').click();
  await audit(page,'storage dialog');
  for (let i=0;i<15;i++) {
    await page.keyboard.press('Tab');
    assert(await page.evaluate(()=>document.activeElement === document.body || document.querySelector('#storage-dialog').contains(document.activeElement)), 'modal must prevent focus on background controls');
  }
  await page.keyboard.press('Escape');
  assert(await page.locator('.storage-notice [data-storage-open]').evaluate(e=>e===document.activeElement),'dialog returns focus');
  const dark=page.locator('[data-theme-value=dark]');
  await dark.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[data-theme-value=system]').getAttribute('aria-checked'),'true');
  console.log('PASS keyboard dialog focus, Escape restoration and appearance arrow keys');
  await page.goto(DASH+'/login'); await audit(page,'dashboard login');
  await page.fill('input[name=email]', process.env.OWNER_EMAIL || 'owner@example.com');
  await page.fill('input[name=password]', process.env.OWNER_PASSWORD || 'change-me-now-please');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.waitForURL(DASH+'/');
  for (const colorScheme of ['light','dark']) {
    await page.emulateMedia({colorScheme});
    for (const route of ['/','/board','/projects','/users','/roles','/reports','/account']) {
      await page.goto(DASH+route); await page.waitForTimeout(500);
      await audit(page,`dashboard ${colorScheme} ${route}`);
    }
  }
  console.log(JSON.stringify({scans:results.length,violations:failures,results},null,2));
} finally { await browser.close(); }
if(failures) process.exitCode=1;
