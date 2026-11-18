import type { Attachment } from './compress';

// Captured before telemetry patches window.fetch, so widget traffic is never recorded and
// can never recurse through the hook.
const nativeFetch = window.fetch.bind(window);

export interface Ticket {
  ticket_code: string;
  title: string;
  category: string;
  priority: string;
  status: string;
  created_at: string;
  updated_at: string;
}
export interface Message {
  id: string;
  author_type: 'client' | 'developer' | 'system';
  body: string;
  created_at: string;
}
export interface TicketDetail extends Ticket {
  description: string | null;
  messages: Message[];
  attachments: { id: string; message_id: string | null; file_name: string; mime_type: string; thumbnail_b64: string | null }[];
}

type Wire = Omit<Attachment, 'size'>;
const wire = (a: Attachment[]): Wire[] => a.map(({ size: _s, ...rest }) => rest);

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function store(key: string, value?: string): string | null {
  const s = storage();
  try {
    if (value !== undefined) s?.setItem('snag:' + key, value);
    return s?.getItem('snag:' + key) ?? null;
  } catch {
    return null;
  }
}

/** Anonymous per-browser identity that scopes "My Tickets". */
function reporterToken(projectKey: string): string {
  let t = store('rt:' + projectKey);
  if (!t || !/^[A-Za-z0-9_-]{16,64}$/.test(t)) {
    const b = crypto.getRandomValues(new Uint8Array(24));
    t = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    store('rt:' + projectKey, t);
  }
  return t;
}

/** Shape of a signed reporter token minted by the host application's server. */
const identityRe = /^v1\.[A-Za-z0-9_-]{1,200}\.\d{1,12}\.[A-Za-z0-9_-]{43}$/;
export const validIdentity = (t: unknown): t is string => typeof t === 'string' && t.length <= 512 && identityRe.test(t);

const friendly: Record<string, string> = {
  identity_expired: 'Your sign-in for reporting has expired. Reload the page and try again.',
  identity_invalid: 'Your sign-in for reporting could not be verified. Reload the page and try again.',
  identity_not_enabled: 'Signed-in reporting is not set up for this app yet.',
  identity_required: 'Please sign in to the app to report a problem.',
};

export class Api {
  readonly base: string;
  readonly token: string;
  /**
   * Signed reporter token from the host app (Snag.identify({ token })). Kept in memory only —
   * never written to storage — and sent instead of the anonymous browser token.
   */
  private identity: string | null = null;

  constructor(apiOrigin: string, readonly key: string) {
    this.base = apiOrigin.replace(/\/+$/, '') + '/api/v1/widget';
    this.token = reporterToken(key);
  }

  get signed() {
    return this.identity !== null;
  }
  /** Returns true when the effective reporter changed. */
  setIdentity(token: string | null): boolean {
    const next = validIdentity(token) ? token : null;
    if (next === this.identity) return false;
    this.identity = next;
    return true;
  }
  private reporterHeaders(): Record<string, string> {
    return this.identity ? { 'X-Reporter-Identity': this.identity } : { 'X-Reporter-Token': this.token };
  }

  isOwn = (url: string) => url.startsWith(this.base);

  private async req<T>(path: string, body?: unknown): Promise<T> {
    const res = await nativeFetch(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Project-Key': this.key, ...this.reporterHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        res.status === 429 ? 'Too many requests — please wait a moment.' : res.status === 413 ? 'Attachments are too large.' : friendly[data.error] || data.message || data.error || `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data as T;
  }

  createTicket(t: Record<string, unknown>, attachments: Attachment[]) {
    return this.req<{ ticket_code: string; status: string }>('/tickets', { ...t, attachments: wire(attachments) });
  }
  listTickets() {
    return this.req<{ items: Ticket[] }>('/tickets').then((r) => r.items);
  }
  getTicket(code: string) {
    return this.req<TicketDetail>('/tickets/' + encodeURIComponent(code));
  }
  reply(code: string, body: string, attachments: Attachment[]) {
    return this.req<Message>('/tickets/' + encodeURIComponent(code) + '/messages', { body, attachments: wire(attachments) });
  }

  /**
   * Live updates for this reporter. The reporter's headers are exchanged for a single-use,
   * 60-second stream ticket, so no credential ever appears in a URL (or a proxy's access log).
   * Reconnects with backoff, fetching a fresh ticket each time.
   */
  stream(on: (event: string, data: any) => void): () => void {
    let es: EventSource | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let connected = false;
    const retry = () => {
      if (stopped) return;
      timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** attempt++) + Math.random() * 500);
    };
    const open = async () => {
      let ticket: string;
      try {
        ticket = (await this.req<{ ticket: string }>('/stream-ticket', {})).ticket;
      } catch {
        return retry();
      }
      if (stopped) return;
      const src = new EventSource(`${this.base}/stream?key=${encodeURIComponent(this.key)}&ticket=${encodeURIComponent(ticket)}`);
      es = src;
      src.addEventListener('ready', () => {
        attempt = 0;
        if (connected) on('reconnected', {});
        connected = true;
      });
      for (const ev of ['ticket.created', 'ticket.updated', 'message.created']) {
        src.addEventListener(ev, (e) => {
          try {
            on(ev, JSON.parse((e as MessageEvent).data));
          } catch {
            /* ignore malformed frame */
          }
        });
      }
      // Tickets are single-use, so never let EventSource retry the same URL itself.
      src.onerror = () => {
        src.close();
        if (es === src) es = null;
        retry();
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      es?.close();
    };
  }
}
