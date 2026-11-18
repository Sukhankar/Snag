import { launchBrowser } from "./browser.mjs";
import assert from "node:assert/strict";
const BASE = process.env.SITE_URL;
if (!BASE) throw Error("Set SITE_URL to an isolated website preview");
const browser = await launchBrowser();
let passed = 0,
  failed = 0;
const results = [];
async function test(name, fn) {
  const start = performance.now();
  try {
    await fn();
    passed++;
    console.log("PASS", name);
  } catch (e) {
    failed++;
    console.error("FAIL", name, e.message);
  }
  results.push({ name, ms: Math.round(performance.now() - start) });
}
try {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await test("all 14 routes return 200 with a heading and no broken local assets", async () => {
    for (const path of [
      "/",
      "/docs/getting-started/",
      "/docs/architecture/",
      "/docs/widget/",
      "/docs/deployment/",
      "/docs/api/",
      "/docs/security/",
      "/docs/configuration/",
      "/docs/testing/",
      "/docs/troubleshooting/",
      "/docs/contributing/",
      "/legal/terms/",
      "/legal/privacy/",
      "/legal/cookies/",
    ]) {
      const r = await p.goto(BASE + path);
      assert.equal(r.status(), 200, path);
      assert(await p.locator("h1").count(), path);
      assert.equal(
        await p
          .locator("img")
          .evaluateAll(
            (xs) =>
              xs.filter((i) => !i.complete || i.naturalWidth === 0).length,
          ),
        0,
        path,
      );
    }
  });
  await test("unknown route is a real 404 with a usable home link", async () => {
    const r = await p.goto(BASE + "/missing-regression-page");
    assert.equal(r.status(), 404);
    assert((await p.locator("a[href]").count()) > 0);
  });
  await p.goto(BASE);
  await test("first visit uses current dark default without optional preferences", async () => {
    assert.equal(await p.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(
      await p.evaluate(() => localStorage.getItem("snag-site:settings:v1")),
      null,
    );
  });
  await test("theme buttons and system preference respond correctly", async () => {
    for (const theme of ["light", "dark", "system"]) {
      await p.locator(`[data-theme-value=${theme}]`).click();
      assert.equal(await p.locator("html").getAttribute("data-theme"), theme);
    }
    await p.emulateMedia({ colorScheme: "light" });
    await p.waitForFunction(
      () =>
        document.querySelector("meta[name=theme-color]").content === "#f3f1e9",
    );
    assert.equal(
      await p.locator("meta[name=theme-color]").getAttribute("content"),
      "#f3f1e9",
    );
    await p.emulateMedia({ colorScheme: "dark" });
    await p.waitForFunction(
      () =>
        document.querySelector("meta[name=theme-color]").content === "#0a0a0a",
    );
    assert.equal(
      await p.locator("meta[name=theme-color]").getAttribute("content"),
      "#0a0a0a",
    );
  });
  await test("carousel advances automatically and supports manual selection", async () => {
    const before = await p.locator("#demo-title").innerText();
    await p.waitForTimeout(7200);
    assert.notEqual(await p.locator("#demo-title").innerText(), before);
    const steps = p.locator("[data-stage]");
    assert.equal(await steps.count(), 3);
    await steps.nth(0).click();
    assert.equal(await p.locator("#demo-title").innerText(), before);
  });
  await test("desktop, tablet and phone pages have no horizontal overflow", async () => {
    for (const width of [1440, 768, 390]) {
      await p.setViewportSize({ width, height: 900 });
      for (const path of ["/", "/docs/getting-started/", "/legal/privacy/"]) {
        await p.goto(BASE + path);
        assert(
          await p.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          `${width} ${path}`,
        );
      }
    }
  });
  await p.goto(BASE);
  await test("blocked browser storage does not break theme or navigation", async () => {
    const c = await browser.newContext();
    await c.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw Error("blocked");
      };
      Storage.prototype.setItem = () => {
        throw Error("blocked");
      };
    });
    const page = await c.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.goto(BASE);
    await page.locator("[data-theme-value=light]").click();
    assert.equal(
      await page.locator("html").getAttribute("data-theme"),
      "light",
    );
    assert.deepEqual(errs, []);
    await c.close();
  });
  await test("expired stored preferences are discarded", async () => {
    await p.evaluate(() => {
      localStorage.setItem(
        "snag-site:settings:v1",
        JSON.stringify({ remember: true, expires: 1, version: "invalid" }),
      );
      localStorage.setItem("snag-site:theme:v1", "light");
    });
    await p.reload();
    assert.equal(await p.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(
      await p.evaluate(() => localStorage.getItem("snag-site:theme:v1")),
      null,
    );
  });
  await test("remembered theme persists and synchronizes between tabs", async () => {
    await p.locator("[data-theme-value=light]").click();
    await p.locator("[data-storage-open]:visible").last().click();
    await p.locator("#remember-theme").check();
    await p.locator("#save-storage").click();
    await p.waitForFunction(() =>
      document
        .querySelector("#storage-status")
        .textContent.startsWith("Saved."),
    );
    await p.keyboard.press("Escape");
    await p.reload();
    assert.equal(await p.locator("html").getAttribute("data-theme"), "light");
    const other = await ctx.newPage();
    await other.goto(BASE);
    await p.locator("[data-theme-value=dark]").click();
    await other.waitForFunction(
      () => document.documentElement.dataset.theme === "dark",
    );
    await other.close();
  });
  await test("offline opt-in caches guides; withdrawal removes its worker and cache", async () => {
    await p.locator("[data-storage-open]:visible").last().click();
    await p.locator("#offline-docs").check();
    await p.locator("#save-storage").click();
    await p.waitForFunction(() =>
      document
        .querySelector("#storage-status")
        .textContent.startsWith("Saved."),
    );
    await p.keyboard.press("Escape");
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.goto(BASE + "/docs/getting-started/");
    await p.waitForFunction(() => !!navigator.serviceWorker.controller);
    await ctx.setOffline(true);
    const r = await p.reload();
    assert.equal(r.status(), 200);
    assert(await p.locator("h1").count());
    await ctx.setOffline(false);
    await p.locator("[data-storage-open]:visible").last().click();
    await p.locator("#clear-cache").click();
    await p.waitForFunction(() =>
      document.querySelector("#storage-status").textContent.includes("cleared"),
    );
    assert.equal(
      await p.evaluate(
        async () =>
          (await caches.keys()).filter((k) => k.startsWith("snag-docs-"))
            .length,
      ),
      0,
    );
    assert.equal(
      await p.evaluate(
        async () => (await navigator.serviceWorker.getRegistrations()).length,
      ),
      0,
    );
    await p.locator("#reset-storage").click();
    await p.waitForFunction(() =>
      document.querySelector("#storage-status").textContent.includes("removed"),
    );
    assert.equal(
      await p.evaluate(() => localStorage.getItem("snag-site:settings:v1")),
      null,
    );
    await p.keyboard.press("Escape");
  });
  await test("documentation search handles matches and empty results", async () => {
    await p.goto(BASE + "/docs/getting-started/");
    await p.locator("#doc-search").fill("zzzz-no-such-guide");
    assert(await p.locator("#search-empty").isVisible());
    await p.locator("#doc-search").fill("");
    assert(!(await p.locator("#search-empty").isVisible()));
    assert((await p.locator(".sidebar nav a:visible").count()) > 0);
  });
  await test("no uncaught JavaScript errors across public routes", async () =>
    assert.deepEqual(errors, []));
  console.log(JSON.stringify({ passed, failed, results }, null, 2));
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
