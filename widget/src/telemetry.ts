// Black-box recorder: a fixed-size circular buffer of the last 20 interesting events
// (clicks, route changes, console.error, uncaught errors, failed HTTP calls). It lives
// only in RAM and is flushed into the ticket when the user submits.

export type TelemetryEvent =
  | { t: number; k: 'click'; el: string; text?: string }
  | { t: number; k: 'route'; to: string }
  | { t: number; k: 'console'; msg: string }
  | { t: number; k: 'error'; msg: string; src?: string }
  | { t: number; k: 'http'; m: string; url: string; status: number; ms: number; err?: string };

const SIZE = 20;
const buf: TelemetryEvent[] = new Array(SIZE);
let head = 0;
let count = 0;

export function record(e: TelemetryEvent): void {
  buf[head] = e;
  head = (head + 1) % SIZE;
  if (count < SIZE) count++;
}

/** Oldest → newest copy of the buffer. */
export function snapshot(): TelemetryEvent[] {
  const out: TelemetryEvent[] = [];
  for (let i = 0; i < count; i++) out.push(buf[(head - count + i + SIZE) % SIZE]);
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Path without query string — queries often carry tokens or PII. */
export function safePath(): string {
  const { pathname, hash } = location;
  return pathname + (hash.startsWith('#/') ? hash.split('?')[0] : '');
}

function safeUrl(input: string): string {
  try {
    const u = new URL(input, location.href);
    return (u.origin === location.origin ? '' : u.origin) + u.pathname;
  } catch {
    return clip(String(input), 200);
  }
}

function describe(el: Element): string {
  let d = el.tagName.toLowerCase();
  if (el.id) d += '#' + el.id;
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2) : [];
  if (cls[0]) d += '.' + cls.join('.');
  return clip(d, 120);
}

function stringify(a: unknown): string {
  if (a instanceof Error) return a.message + (a.stack ? '\n' + a.stack.split('\n').slice(1, 4).join('\n') : '');
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function environment() {
  const n = navigator as Navigator & { deviceMemory?: number };
  return {
    url: location.origin + safePath(),
    ua: n.userAgent,
    lang: n.language,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    vw: innerWidth,
    vh: innerHeight,
    dpr: devicePixelRatio,
    online: n.onLine,
    mem: n.deviceMemory,
  };
}

let installed = false;

/**
 * Install the global hooks. `isOwn` filters out the widget's own API traffic; `host` is the
 * widget's shadow host (clicks inside the widget are not recorded).
 */
export function installTelemetry(isOwn: (url: string) => boolean, host: () => Element | null, maskText: boolean): void {
  if (installed) return;
  installed = true;
  const now = Date.now;

  // Clicks — tag/id/class plus a short label. Never input values.
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as Element | null;
      if (!target || target === host() || !(target instanceof Element)) return;
      const el = target.closest('button,a,[role=button],input,select,label,summary') || target;
      const isField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      const text = maskText || isField ? undefined : clip((el.textContent || '').trim().replace(/\s+/g, ' '), 40) || undefined;
      record({ t: now(), k: 'click', el: describe(el), text });
    },
    true,
  );

  // Route changes — SPA history API plus hash routers.
  let last = safePath();
  const route = () => {
    const p = safePath();
    if (p !== last) record({ t: now(), k: 'route', to: (last = p) });
  };
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m];
    history[m] = function (this: History, ...args: Parameters<History['pushState']>) {
      const r = orig.apply(this, args);
      route();
      return r;
    };
  }
  addEventListener('popstate', route);
  addEventListener('hashchange', route);

  // console.error interception.
  const origError = console.error;
  console.error = function (...args: unknown[]) {
    try {
      record({ t: now(), k: 'console', msg: clip(args.map(stringify).join(' '), 600) });
    } catch {
      /* never break the host's logging */
    }
    return origError.apply(this, args);
  };

  addEventListener('error', (e) => {
    if (e.message) record({ t: now(), k: 'error', msg: clip(e.message, 600), src: e.filename ? safeUrl(e.filename) + ':' + e.lineno : undefined });
  });
  addEventListener('unhandledrejection', (e) => record({ t: now(), k: 'error', msg: clip('Unhandled rejection: ' + stringify(e.reason), 600) }));

  // window.fetch — record 4xx/5xx and network failures.
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const m = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const start = now();
      try {
        const res = await origFetch.call(window, input, init);
        if (res.status >= 400 && !isOwn(url)) record({ t: start, k: 'http', m, url: safeUrl(url), status: res.status, ms: now() - start });
        return res;
      } catch (err) {
        if (!isOwn(url)) record({ t: start, k: 'http', m, url: safeUrl(url), status: 0, ms: now() - start, err: clip(stringify(err), 200) });
        throw err;
      }
    };
  }

  // XMLHttpRequest — many ERP/POS front-ends (jQuery, Angular) still use it.
  const XHR = XMLHttpRequest.prototype;
  const open = XHR.open;
  const send = XHR.send;
  XHR.open = function (this: XMLHttpRequest & { _rc?: [string, string] }, method: string, url: string | URL, ...rest: unknown[]) {
    this._rc = [String(method).toUpperCase(), String(url)];
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XHR.open;
  XHR.send = function (this: XMLHttpRequest & { _rc?: [string, string] }, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = this._rc;
    if (meta && !isOwn(meta[1])) {
      const start = now();
      this.addEventListener('loadend', () => {
        if (this.status === 0 || this.status >= 400)
          record({ t: start, k: 'http', m: meta[0], url: safeUrl(meta[1]), status: this.status, ms: now() - start });
      });
    }
    return send.call(this, body);
  };
}
