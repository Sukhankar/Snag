// Small local diagnostic workload, not a production capacity benchmark.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const API = process.env.SNAG_URL,
  SITE = process.env.SITE_URL;
if (!API || !SITE || !process.env.ADMIN_TOKEN)
  throw Error("Set isolated SNAG_URL, SITE_URL, ADMIN_TOKEN");
const requests = Number(process.env.PERF_REQUESTS || 100);
const workers = Number(process.env.PERF_CONCURRENCY || 10);
if (!Number.isInteger(requests) || requests < 1 || requests > 100000 ||
    !Number.isInteger(workers) || workers < 1 || workers > 100 || workers > requests)
  throw Error("PERF_REQUESTS must be 1..100000; PERF_CONCURRENCY 1..100 and <= requests");
const headers = { Authorization: "Bearer " + process.env.ADMIN_TOKEN };
const results = [];
for (const [path, n, concurrency] of [
  ["/healthz", requests, workers],
  ["/api/v1/admin/tickets?limit=50", requests, workers],
  ["/api/v1/admin/reports/amc", requests, workers],
]) {
  let next = 0,
    errors = 0;
  const ms = [];
  const begin = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next++ < n) {
        const start = performance.now();
        const response = await fetch(API + path, { headers, signal: AbortSignal.timeout(10000) });
        await response.arrayBuffer();
        if (!response.ok) errors++;
        ms.push(performance.now() - start);
      }
    }),
  );
  const elapsed = performance.now() - begin;
  ms.sort((a, b) => a - b);
  results.push({
    path,
    requests: n,
    concurrency,
    errors,
    elapsed_ms: Math.round(elapsed),
    requests_per_second: Math.round((n * 1000) / elapsed),
    p50_ms: +ms[Math.floor(n * 0.5)].toFixed(2),
    p95_ms: +ms[Math.floor(n * 0.95)].toFixed(2),
    p99_ms: +ms[Math.floor(n * 0.99)].toFixed(2),
    max_ms: +ms.at(-1).toFixed(2),
  });
  assert.equal(errors, 0);
}
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: true,
});
try {
  const p = await browser.newPage();
  await p.goto(SITE, { waitUntil: "networkidle" });
  results.push({
    website: await p.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      return {
        dom_content_loaded_ms: n.domContentLoadedEventEnd,
        load_ms: n.loadEventEnd,
        transfer_bytes: n.transferSize,
        paints: performance
          .getEntriesByType("paint")
          .map((p) => ({ name: p.name, ms: p.startTime })),
      };
    }),
  });
} finally {
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
