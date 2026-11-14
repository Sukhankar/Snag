// Snag widget bootstrap.
//
//   <script src="https://snag.example.com/widget.min.js"
//           data-project-key="pk_..."              (required)
//           data-api="https://snag.example.com"   (default: the script's own origin)
//           data-app-version="2.4.1"
//           data-user-name="Jane" data-user-email="jane@acme.com"
//           data-fab="false"                       (hotkey/API only, no floating button)
//           data-mask-text="true"                  (don't record clicked element text)
//           data-theme="light|dark"  data-accent="#0ea5e9"
//           async></script>
//
// Or call window.Snag.init({...}) yourself. Alt+B toggles the panel.
import { render } from 'preact';
import { Api } from './api';
import { App, type Bus, type Config } from './App';
import { css } from './styles';
import { installTelemetry } from './telemetry';

export interface InitOptions {
  projectKey: string;
  api?: string;
  appVersion?: string;
  user?: { name?: string; email?: string };
  fab?: boolean;
  maskText?: boolean;
  theme?: 'light' | 'dark';
  accent?: string;
}

const script = document.currentScript as HTMLScriptElement | null;
const bus: Bus = {};
let host: HTMLElement | null = null;
let cfg: Config | null = null;
let opts: InitOptions | null = null;

function mount(o: InitOptions) {
  const api = new Api(o.api || (script?.src ? new URL(script.src).origin : location.origin), o.projectKey);
  installTelemetry(api.isOwn, () => host, !!o.maskText);
  cfg = { api, fab: o.fab !== false, appVersion: o.appVersion, user: o.user || {} };

  const attach = () => {
    host = document.createElement('snag-widget');
    if (o.theme) host.setAttribute('data-theme', o.theme);
    // Closed root: host-page scripts and styles cannot reach into the widget.
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = css + (o.accent && /^#[0-9a-f]{3,8}$/i.test(o.accent) ? `:host{--ac:${o.accent}}` : '');
    root.appendChild(style);
    // Keep typing inside the widget from triggering host-app shortcuts (common in POS UIs).
    for (const t of ['keydown', 'keyup', 'keypress']) host.addEventListener(t, (e) => e.stopPropagation());
    document.body.appendChild(host);
    render(<App cfg={cfg!} bus={bus} />, root);
  };
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });

  // Alt+B — `code` rather than `key` so it works on macOS (Option+B types "∫") and
  // non-Latin layouts.
  addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyB') {
        e.preventDefault();
        bus.toggle?.();
      }
    },
    true,
  );
}

const Snag = {
  init(o: InitOptions) {
    if (opts) return; // idempotent: script tag + manual init must not double-mount
    if (!o?.projectKey) throw new Error('Snag.init: projectKey is required');
    opts = o;
    mount(o);
  },
  open: () => bus.toggle?.(true),
  close: () => bus.toggle?.(false),
  toggle: () => bus.toggle?.(),
  /** Prefill reporter identity, e.g. after the host app's login. */
  identify(user: { name?: string; email?: string }) {
    if (cfg) cfg.user = { ...cfg.user, ...user };
  },
};

declare global {
  interface Window {
    Snag?: typeof Snag;
  }
}

if (!window.Snag) {
  window.Snag = Snag;
  const d = script?.dataset;
  if (d?.projectKey) {
    Snag.init({
      projectKey: d.projectKey,
      api: d.api,
      appVersion: d.appVersion,
      user: { name: d.userName, email: d.userEmail },
      fab: d.fab !== 'false',
      maskText: d.maskText === 'true',
      theme: d.theme === 'dark' || d.theme === 'light' ? d.theme : undefined,
      accent: d.accent,
    });
  }
}
