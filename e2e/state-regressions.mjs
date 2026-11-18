// Run only against an isolated test stack. Creates disposable projects, users and tickets.
import assert from "node:assert/strict";
import { launchBrowser } from "./browser.mjs";
const API = process.env.SNAG_URL,
  DASH = process.env.DASH_URL,
  WIDGET = process.env.WIDGET_URL;
if (!API || !DASH || !WIDGET || !process.env.ADMIN_TOKEN)
  throw Error(
    "Explicit isolated SNAG_URL, DASH_URL, WIDGET_URL and ADMIN_TOKEN required",
  );
const auth = {
  Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
  "Content-Type": "application/json",
};
const stamp = Date.now();
const wh = {
  Origin: WIDGET,
  "X-Project-Key": "pk_demo_0000000000000000000000000000",
  "X-Reporter-Token": `regression_${stamp}`,
  "Content-Type": "application/json",
};
let passed = 0,
  failed = 0;
const durations = [];
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
  durations.push({ name, ms: Math.round(performance.now() - start) });
}
async function req(path, method = "GET", body, headers = auth, status = 200) {
  const r = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  assert.equal(r.status, status, JSON.stringify(data));
  return data;
}
const admin = (p, m, b, status = 200) =>
  req("/api/v1/admin" + p, m, b, auth, status);
async function ticket(title, attachments = []) {
  const c = await req(
    "/api/v1/widget/tickets",
    "POST",
    { title: `${title} ${stamp}`, attachments },
    wh,
    201,
  );
  return (await admin("/tickets?q=" + c.ticket_code)).items[0];
}
const detail = (t) => admin("/tickets/" + t.id);
const patch = (t, p) => admin("/tickets/" + t.id, "PATCH", p);
const reply = (t) =>
  req(
    "/api/v1/widget/tickets/" + t.ticket_code + "/messages",
    "POST",
    { body: "Reporter followup" },
    wh,
    201,
  );
await test("simultaneous reciprocal links reject cycles without server errors (20 rounds)", async () => {
  for (let round = 0; round < 20; round++) {
    const a = await ticket("Concurrent A"), b = await ticket("Concurrent B");
    const results = await Promise.all([[a,b],[b,a]].map(async ([from,to]) => {
      const r = await fetch(API + "/api/v1/admin/tickets/" + from.id, {
        method: "PATCH", headers: auth, body: JSON.stringify({parent_ticket_id:to.id}),
        signal: AbortSignal.timeout(10000),
      });
      return r.status;
    }));
    assert.deepEqual(results.sort(), [200,422]);
    const [ad,bd] = await Promise.all([detail(a),detail(b)]);
    assert.notEqual(ad.parent_ticket_id === b.id && bd.parent_ticket_id === a.id, true);
  }
});
await test("concurrent family linking and completion leave every child completed", async () => {
  for (let round = 0; round < 10; round++) {
    const root = await ticket("Concurrent root"), child = await ticket("Concurrent child");
    await Promise.all([patch(root,{status:"resolved"}), patch(child,{parent_ticket_id:root.id})]);
    const d = await detail(child);
    assert.equal(d.parent_ticket_id,root.id);
    assert.equal(d.status,"resolved");
  }
});
const root = await ticket("Regression root"),
  child = await ticket("Regression child"),
  grandchild = await ticket("Regression grandchild");
await test("linking a family to resolved root finalizes child and grandchild", async () => {
  await patch(grandchild, { parent_ticket_id: child.id });
  await patch(root, { status: "resolved" });
  await patch(child, { parent_ticket_id: root.id });
  for (const t of [child, grandchild]) {
    const d = await detail(t);
    assert.equal(d.status, "resolved");
    assert.equal(d.parent_ticket_id, root.id);
    assert(
      d.messages.some((m) => m.author_type === "system" && !m.is_internal),
    );
    assert(
      d.events.some((e) => e.field === "status" && e.new_value === "resolved"),
    );
  }
});
await test("repeating final status repairs reopened children without duplicate notices", async () => {
  await reply(child);
  assert.equal((await detail(child)).status, "triaged");
  await patch(root, { status: "resolved" });
  const d = await detail(child);
  assert.equal(d.status, "resolved");
  await patch(root, { status: "resolved" });
  assert.equal((await detail(child)).messages.length, d.messages.length);
});
await test("linking new child preserves unrelated reopened sibling", async () => {
  await reply(child);
  const other = await ticket("new sibling");
  await patch(other, { parent_ticket_id: root.id });
  assert.equal((await detail(other)).status, "resolved");
  assert.equal((await detail(child)).status, "triaged");
});
await test("closed root finalizes new duplicate; client cannot reply", async () => {
  await patch(root, { status: "closed" });
  const t = await ticket("closed duplicate");
  await patch(t, { parent_ticket_id: root.id });
  assert.equal((await detail(t)).status, "closed");
  await req(
    "/api/v1/widget/tickets/" + t.ticket_code + "/messages",
    "POST",
    { body: "blocked" },
    wh,
    409,
  );
});
await test("reopening root preserves completed children", async () => {
  await patch(root, { status: "in_progress" });
  assert.equal((await detail(grandchild)).status, "resolved");
});
await test("all 25 admin status transitions accepted and persisted", async () => {
  const t = await ticket("status matrix");
  for (const a of ["new", "triaged", "in_progress", "resolved", "closed"])
    for (const b of ["new", "triaged", "in_progress", "resolved", "closed"]) {
      await patch(t, { status: a });
      assert.equal((await patch(t, { status: b })).status, b);
    }
});
await test("self-link and cycle rejected; unlink clears parent", async () => {
  await admin(
    "/tickets/" + root.id,
    "PATCH",
    { parent_ticket_id: root.id },
    422,
  );
  await admin(
    "/tickets/" + root.id,
    "PATCH",
    { parent_ticket_id: grandchild.id },
    422,
  );
  await patch(grandchild, { parent_ticket_id: null });
  assert.equal((await detail(grandchild)).parent_ticket_id, null);
});
await test("invalid enums and malformed IDs rejected", async () => {
  for (const key of ["status", "priority", "category", "scope_class"])
    await admin("/tickets/" + root.id, "PATCH", { [key]: "invalid" }, 422);
  await admin("/tickets/not-uuid", "GET", undefined, 404);
});
await test("report totals and scope/status partitions agree", async () => {
  const r = await admin("/reports/amc");
  for (const x of r.items) {
    assert.equal(x.total, x.bug + x.change_request + x.unclassified);
    assert.equal(x.total, x.open + x.resolved);
    assert(x.duplicates <= x.total);
  }
});
await test("invalid report dates rejected", async () => {
  await admin("/reports/amc?from=invalid", "GET", undefined, 400);
});
await test("key rotation and project disable invalidate access", async () => {
  const p = await admin(
    "/projects",
    "POST",
    { name: "Regression " + stamp, allowed_origins: [WIDGET] },
    201,
  );
  const h = { ...wh, "X-Project-Key": p.project_key };
  await req("/api/v1/widget/tickets", "GET", undefined, h);
  const rotated = await admin("/projects/" + p.id, "PATCH", {
    rotate_key: true,
  });
  await req("/api/v1/widget/tickets", "GET", undefined, h, 403);
  h["X-Project-Key"] = rotated.project_key;
  await req("/api/v1/widget/tickets", "GET", undefined, h);
  await admin("/projects/" + p.id, "PATCH", { is_active: false });
  await req("/api/v1/widget/tickets", "GET", undefined, h, 403);
});
// Read frames until cancellation; predicate polling is bounded and does not consume stream data.
async function stream(token) {
  const ctrl = new AbortController();
  const response = await fetch(API + "/api/v1/admin/stream", {
    headers: { Authorization: "Bearer " + token },
    signal: ctrl.signal,
  });
  assert.equal(response.status, 200);
  const state = { text: "", closed: false, stop: () => ctrl.abort() };
  (async () => {
    try {
      for await (const c of response.body)
        state.text += new TextDecoder().decode(c);
    } catch {
    } finally {
      state.closed = true;
    }
  })();
  await until(() => state.text.includes("event: ready"));
  return state;
}
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw Error("Timed out waiting for state");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const role = await admin(
  "/roles",
  "POST",
  {
    name: "stream regression " + stamp,
    permissions: ["tickets.view", "tickets.note"],
  },
  201,
);
const user = await admin(
  "/users",
  "POST",
  {
    name: "Stream test",
    email: `stream-${stamp}@example.com`,
    role_id: role.id,
    password: "temporary-password-123",
  },
  201,
);
async function login(password) {
  return req(
    "/api/v1/auth/login",
    "POST",
    { email: user.email, password },
    { "Content-Type": "application/json" },
  );
}
let session = await login("temporary-password-123");
await req(
  "/api/v1/admin/me/password",
  "POST",
  {
    current_password: "temporary-password-123",
    new_password: "permanent-password-456",
  },
  { ...auth, Authorization: "Bearer " + session.token },
  204,
);
await test("live stream stops delivering internal notes after permission removal", async () => {
  const s = await stream(session.token);
  try {
    await admin("/roles/" + role.id, "PATCH", {
      permissions: ["tickets.view"],
    });
    await admin(
      "/tickets/" + root.id + "/messages",
      "POST",
      { body: "PRIVATE_REGRESSION_" + stamp, is_internal: true },
      201,
    );
    await admin(
      "/tickets/" + root.id + "/messages",
      "POST",
      { body: "PUBLIC_REGRESSION_" + stamp },
      201,
    );
    await until(() => s.text.includes("PUBLIC_REGRESSION_"));
    assert(!s.text.includes("PRIVATE_REGRESSION_"));
  } finally {
    s.stop();
  }
});
await test("live stream closes after tickets.view removed", async () => {
  const s = await stream(session.token);
  try {
    await admin("/roles/" + role.id, "PATCH", { permissions: [] });
    await patch(root, { priority: "P1_High" });
    await until(() => s.closed);
  } finally {
    s.stop();
  }
});
await admin("/roles/" + role.id, "PATCH", { permissions: ["tickets.view"] });
await test("live stream closes after logout", async () => {
  const s = await stream(session.token);
  try {
    await req(
      "/api/v1/auth/logout",
      "POST",
      undefined,
      { ...auth, Authorization: "Bearer " + session.token },
      204,
    );
    await patch(root, { priority: "P2_Normal" });
    await until(() => s.closed);
  } finally {
    s.stop();
  }
});
session = await login("permanent-password-456");
await test("live stream closes after deactivation", async () => {
  const s = await stream(session.token);
  try {
    await admin("/users/" + user.id, "PATCH", { is_active: false });
    await patch(root, { priority: "P1_High" });
    await until(() => s.closed);
  } finally {
    s.stop();
  }
});
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.goto(DASH + "/login");
  await page.fill(
    "input[name=email]",
    process.env.OWNER_EMAIL || "owner@example.com",
  );
  await page.fill(
    "input[name=password]",
    process.env.OWNER_PASSWORD || "change-me-now-please",
  );
  await page.click('button:has-text("Sign in")');
  await page.waitForURL(DASH + "/");
  await test("late inbox snapshot preserves a ticket already delivered live", async () => {
    let release, captured;
    const gate = new Promise(resolve => { release = resolve; });
    const snapshot = new Promise(resolve => { captured = resolve; });
    let intercepted = false;
    const handler = async route => {
      if (intercepted || new URL(route.request().url()).pathname !== '/api/snag/tickets') return route.continue();
      intercepted = true;
      const response = await route.fetch();
      captured();
      await gate;
      await route.fulfill({response});
    };
    await page.route('**/api/snag/tickets?*',handler);
    try {
      await page.goto(DASH+'/');
      await Promise.race([snapshot,new Promise((_,reject)=>setTimeout(()=>reject(Error('snapshot not captured')),10000))]);
      await page.locator('[title="Live updates connected"]').waitFor();
      const added = await ticket('Arrived during inbox snapshot');
      await page.getByText(added.ticket_code,{exact:true}).waitFor();
      release();
      await page.waitForFunction(()=>!document.querySelector('ul[aria-label="Tickets"]')?.textContent.includes('Loading'));
      assert.equal(await page.getByText(added.ticket_code,{exact:true}).count(),1);
    } finally { release(); await page.unroute('**/api/snag/tickets?*',handler); }
  });
  const bad = await ticket("Corrupt attachment", [
    {
      file_name: "broken.log",
      mime_type: "text/plain",
      compression_type: "gzip",
      payload_b64: Buffer.from([31, 139, 0, 0]).toString("base64"),
    },
  ]);
  await test("corrupt gzip attachment displays an error instead of infinite loading", async () => {
    await page.goto(DASH + "/?t=" + bad.id);
    await page.getByText("broken.log", { exact: false }).first().click();
    await page.waitForSelector("[role=dialog]");
    await page.waitForFunction(() => {
      const d = document.querySelector("[role=dialog]");
      return d && !d.textContent.includes("Loading…");
    });
    assert(
      !(await page.locator("[role=dialog]").innerText()).includes("Loading…"),
    );
    await page.keyboard.press("Escape");
  });
  await test("workspace blocks overlapping saves and recovers rejected update", async () => {
    await page.goto(DASH + "/?t=" + root.id);
    await page.waitForSelector("select");
    let release;
    const gate = new Promise((r) => (release = r));
    let calls = 0;
    await page.route("**/api/snag/tickets/" + root.id, async (route) => {
      if (route.request().method() === "PATCH") {
        calls++;
        await gate;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: '{"message":"Injected save failure"}',
        });
      } else await route.continue();
    });
    const selects = page
      .locator("label")
      .filter({ has: page.locator("span.label", { hasText: /^Status$/ }) })
      .locator("select");
    await selects.first().selectOption("triaged");
    await page.waitForFunction(() =>
      [...document.querySelectorAll("select")].some((s) => s.disabled),
    );
    assert.equal(calls, 1);
    release();
    await page
      .getByRole("alert")
      .filter({ hasText: "Injected save failure" })
      .waitFor();
    assert.equal(
      await selects.first().inputValue(),
      (await detail(root)).status,
    );
    await page.unroute("**/api/snag/tickets/" + root.id);
  });
  await test("malformed saved widget position recovers with a visible launcher", async () => {
    for (const value of ['null', '42', '{"side":"invalid","y":0}', '{"side":"l","y":999999}', 'broken']) {
      const context = await browser.newContext();
      await context.addInitScript(value => {
        localStorage.setItem('snag:fab',value);
        const original = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(options) {
          const root = original.call(this,options);
          if(this.tagName === 'SNAG-WIDGET') window.testRoot=root;
          return root;
        };
      },value);
      const page = await context.newPage();
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(WIDGET);
      await page.waitForFunction(()=>window.testRoot?.querySelector('.fab'));
      assert(await page.evaluate(()=> {
        const r=window.testRoot.querySelector('.fab').getBoundingClientRect();
        return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight;
      }),value);
      assert.deepEqual(errors,[]);
      await context.close();
    }
  });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const result = original.call(this, options);
      if (this.tagName === "SNAG-WIDGET") window.testRoot = result;
      return result;
    };
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        window.testStream = this;
      }
    };
  });
  const w = await ctx.newPage();
  await w.goto(WIDGET);
  await w.waitForFunction(() => window.testRoot?.querySelector(".fab"));
  await w.evaluate(() => window.Snag.open());
  // Create tickets using the same browser reporter identity.
  const browserHeaders = await w.evaluate(() => ({
    Origin: location.origin,
    "X-Project-Key": "pk_demo_0000000000000000000000000000",
    "X-Reporter-Token": Object.entries(localStorage).find(([k]) =>
      k.includes("rt:"),
    )?.[1],
    "Content-Type": "application/json",
  }));
  const wc = await req(
    "/api/v1/widget/tickets",
    "POST",
    { title: "Browser reconnect " + stamp },
    browserHeaders,
    201,
  );
  const wid = (await admin("/tickets?q=" + wc.ticket_code)).items[0];
  const click = (sel) =>
    w.evaluate((s) => window.testRoot.querySelector(s).click(), sel);
  await click(".tab:nth-child(2)");
  await w.waitForFunction(() => window.testRoot.querySelector(".li"));
  await click(".li");
  await w
    .waitForFunction(() => window.testRoot.querySelector(".st"))
    .catch(() => {});
  await test("widget reconnect fetches missed status and messages", async () => {
    await w.evaluate(() => window.testStream.close());
    await patch(wid, { status: "resolved" });
    await admin(
      "/tickets/" + wid.id + "/messages",
      "POST",
      { body: "Missed during disconnect " + stamp },
      201,
    );
    await w.evaluate(() =>
      window.testStream.dispatchEvent(
        new MessageEvent("ready", { data: "{}" }),
      ),
    );
    await w.waitForFunction(
      (s) => window.testRoot.textContent.includes(s),
      "Missed during disconnect " + stamp,
    );
    assert(
      (await w.evaluate(() => window.testRoot.textContent)).includes(
        "resolved",
      ),
    );
  });
  await test("stale thread response cannot overwrite a later navigation", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    await w.route(
      "**/api/v1/widget/tickets/" + wc.ticket_code,
      async (route) => {
        await gate;
        await route.continue();
      },
    );
    await click(".back");
    await click(".li");
    await click(".tab:first-child");
    release();
    await w.waitForTimeout(300);
    assert(
      await w.evaluate(
        () =>
          window.testRoot
            .querySelector(".tab:first-child")
            .getAttribute("aria-selected") === "true",
      ),
    );
    await w.unroute("**/api/v1/widget/tickets/" + wc.ticket_code);
  });
  await ctx.close();
} finally {
  await browser.close();
}
console.log(JSON.stringify({ passed, failed, durations }, null, 2));
process.exitCode = failed ? 1 : 0;
