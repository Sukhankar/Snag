import { chromium, firefox, webkit } from "playwright-core";
export function launchBrowser() {
  const name = process.env.BROWSER || "chromium";
  const engine = { chromium, firefox, webkit }[name];
  if (!engine) throw new Error(`Unsupported BROWSER: ${name}`);
  return engine.launch({ headless: true, ...(name === "chromium" ? { executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome" } : {}) });
}
