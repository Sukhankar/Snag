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

export class Api {
  readonly base: string;
  readonly token: string;

  constructor(apiOrigin: string, readonly key: string) {
    this.base = apiOrigin.replace(/\/+$/, '') + '/api/v1/widget';
    this.token = reporterToken(key);
  }

  isOwn = (url: string) => url.startsWith(this.base);

  private async req<T>(path: string, body?: unknown): Promise<T> {
    const res = await nativeFetch(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Project-Key': this.key, 'X-Reporter-Token': this.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        res.status === 429 ? 'Too many requests — please wait a moment.' : res.status === 413 ? 'Attachments are too large.' : data.message || data.error || `Request failed (${res.status})`;
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

  /** Live updates for this reporter. EventSource reconnects on its own. */
  stream(on: (event: string, data: any) => void): () => void {
    const es = new EventSource(`${this.base}/stream?key=${encodeURIComponent(this.key)}&token=${encodeURIComponent(this.token)}`);
    let connected = false;
    es.addEventListener('ready', () => {
      if (connected) on('reconnected', {});
      connected = true;
    });
    for (const ev of ['ticket.created', 'ticket.updated', 'message.created']) {
      es.addEventListener(ev, (e) => {
        try {
          on(ev, JSON.parse((e as MessageEvent).data));
        } catch {
          /* ignore malformed frame */
        }
      });
    }
    return () => es.close();
  }
}
