import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { Api, Message, Ticket, TicketDetail } from './api';
import { store } from './api';
import { processFile, type Attachment } from './compress';
import { environment, snapshot } from './telemetry';

export interface Config {
  api: Api;
  fab: boolean;
  appVersion?: string;
  user: { name?: string; email?: string };
}

export interface Identity {
  name?: string;
  email?: string;
  /** Signed reporter token from the host app's server; null returns to the anonymous browser token. */
  token?: string | null;
}

/** Lets the global hotkey and window.Snag drive the UI. */
export interface Bus {
  toggle?: (open?: boolean) => void;
  /** Pushes a new reporter identity into the form (Snag.identify after the widget rendered). */
  identify?: (user: Identity) => void;
}

type Tab = 'new' | 'list' | 'thread';
type Pos = { side: 'l' | 'r'; y: number };

const when = (s: string) => new Date(s).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const label = (s: string) => s.replace(/_/g, ' ');
const kb = (n: number) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB');

const Icon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 016 0v1.1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 014-4h4a4 4 0 014 4v3c0 3.3-2.7 6-6 6zM12 20v-9M6.5 9C4.6 8.8 3 7.2 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4" />
  </svg>
);

export function App({ cfg, bus }: { cfg: Config; bus: Bus }) {
  const { api } = cfg;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('new');
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [thread, setThread] = useState<TicketDetail | null>(null);
  const [unread, setUnread] = useState<string[]>([]);

  // composer state (shared by the new-ticket form and the thread reply box)
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [reply, setReply] = useState('');
  const [category, setCategory] = useState('bug');
  const [priority, setPriority] = useState('P2_Normal');
  const [name, setName] = useState(cfg.user.name || store('name') || '');
  const [email, setEmail] = useState(cfg.user.email || store('email') || '');
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  const [drag, setDrag] = useState(false);

  const [pos, setPos] = useState<Pos>(() => {
    try {
      const saved = JSON.parse(store('fab') || '') as unknown;
      if (saved && typeof saved === 'object' && 'side' in saved && 'y' in saved &&
          (saved.side === 'l' || saved.side === 'r') &&
          typeof saved.y === 'number' && Number.isFinite(saved.y)) {
        return { side: saved.side, y: Math.max(12, Math.min(saved.y, Math.max(12, window.innerHeight - 68))) };
      }
      return { side: 'r', y: 24 };
    } catch {
      return { side: 'r', y: 24 };
    }
  });
  const [dragAt, setDragAt] = useState<{ x: number; y: number } | null>(null);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const view = useRef({ open, tab, code: '' });
  view.current = { open, tab, code: thread?.ticket_code || '' };
  const firstField = useRef<HTMLInputElement>(null);
  const streamOff = useRef<(() => void) | null>(null);

  bus.toggle = (v) => setOpen((o) => v ?? !o);
  bus.identify = (u) => {
    if (u.name !== undefined) setName(u.name);
    if (u.email !== undefined) setEmail(u.email);
    // A different reporter: drop everything shown for the previous one and reconnect as the new one.
    if (u.token !== undefined && api.setIdentity(u.token)) {
      streamOff.current?.();
      streamOff.current = null;
      requestedThread.current = '';
      setThread(null);
      setTickets(null);
      setUnread([]);
      if (view.current.tab !== 'new') go('list');
      if (api.signed || view.current.open || store('has:' + api.key)) connect();
    }
  };

  const navigation = useRef(0);
  const requestedThread = useRef('');
  const threadRequest = useRef(0);
  const refreshThread = (code: string) => {
    const request = ++threadRequest.current;
    return api.getTicket(code).then((data) => {
      if (request === threadRequest.current && requestedThread.current === code) setThread(data);
    }, (e) => {
      if (request === threadRequest.current && requestedThread.current === code) setErr(e.message);
    });
  };

  const reset = () => {
    navigation.current++;
    threadRequest.current++;
    setPending(0);
    setReply('');
    setAtts([]);
    setErr('');
  };

  const go = (t: Tab) => {
    reset();
    setDone('');
    setTab(t);
    requestedThread.current = '';
    const version = navigation.current;
    if (t === 'list') api.listTickets().then((data) => {
      if (version === navigation.current) setTickets(data);
    }, (e) => { if (version === navigation.current) setErr(e.message); });
  };

  const openThread = (code: string) => {
    reset();
    setTab('thread');
    requestedThread.current = code;
    setThread(null);
    setUnread((u) => u.filter((c) => c !== code));
    refreshThread(code);
  };

  // Realtime: connect once the user has opened the widget or has tickets from before.
  const connect = () => {
    if (streamOff.current) return;
    streamOff.current = api.stream((ev, d) => {
      const v = view.current;
      if (ev === 'reconnected') {
        const version = navigation.current;
        api.listTickets().then((data) => { if (version === navigation.current) setTickets(data); }, (e) => { if (version === navigation.current) setErr(e.message); });
        if (requestedThread.current) refreshThread(requestedThread.current);
      } else if (ev === 'message.created') {
        const m = d.message as Message;
        const viewing = v.open && v.tab === 'thread' && v.code === d.ticket_code;
        if (viewing) setThread((t) => (t && !t.messages.some((x) => x.id === m.id) ? { ...t, messages: [...t.messages, m] } : t));
        else if (m.author_type !== 'client') setUnread((u) => (u.includes(d.ticket_code) ? u : [...u, d.ticket_code]));
      } else if (ev === 'ticket.updated') {
        setTickets((ts) => ts && ts.map((t) => (t.ticket_code === d.ticket_code ? { ...t, status: d.status } : t)));
        setThread((t) => (t && t.ticket_code === d.ticket_code ? { ...t, status: d.status } : t));
      } else if (ev === 'ticket.created') {
        setTickets((ts) => ts && (ts.some((t) => t.ticket_code === d.ticket_code) ? ts : [d as Ticket, ...ts]));
      }
    });
  };

  useEffect(() => {
    if (api.signed || store('has:' + api.key)) connect();
    return () => { navigation.current++; threadRequest.current++; streamOff.current?.(); };
  }, []);

  useEffect(() => {
    if (!open) return;
    connect();
    if (tab === 'new' && !done) firstField.current?.focus();
  }, [open]);

  const addFiles = async (files: File[]) => {
    const version = navigation.current;
    setErr('');
    const room = 10 - atts.length - pending;
    if (files.length > room) setErr('You can attach up to 10 files.');
    const batch = files.slice(0, Math.max(0, room));
    setPending((p) => p + batch.length);
    for (const f of batch) {
      try {
        const named = f.name === 'image.png' ? new File([f], `screenshot-${Date.now()}.png`, { type: f.type }) : f;
        const a = await processFile(named);
        if (version === navigation.current) setAtts((xs) => [...xs, a]);
      } catch (e) {
        if (version === navigation.current) setErr((e as Error).message);
      } finally {
        if (version === navigation.current) setPending((p) => p - 1);
      }
    }
  };

  const onPaste = (e: JSX.TargetedClipboardEvent<HTMLElement>) => {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean) as File[];
    if (files.length && tab !== 'list') {
      e.preventDefault();
      addFiles(files);
    }
  };
  const onDrop = (e: JSX.TargetedDragEvent<HTMLElement>) => {
    e.preventDefault();
    setDrag(false);
    if (tab !== 'list' && e.dataTransfer?.files.length) addFiles([...e.dataTransfer.files]);
  };
  const onDragOver = (e: JSX.TargetedDragEvent<HTMLElement>) => {
    if (tab === 'list') return;
    e.preventDefault();
    setDrag(true);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!title.trim() || busy || pending) return;
    setBusy(true);
    setErr('');
    const version = navigation.current;
    try {
      store('name', name);
      store('email', email);
      const r = await api.createTicket(
        {
          title: title.trim(),
          description: desc.trim(),
          category,
          priority,
          reporter_name: name.trim(),
          reporter_email: email.trim(),
          app_version: cfg.appVersion,
          telemetry: { v: 1, captured_at: new Date().toISOString(), env: environment(), events: snapshot() },
        },
        atts,
      );
      store('has:' + api.key, '1');
      connect();
      if (version !== navigation.current) return;
      setDone(r.ticket_code);
      setTitle('');
      setDesc('');
      setAtts([]);
    } catch (e) {
      if (version === navigation.current) setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async (e: Event) => {
    e.preventDefault();
    if (!thread || !reply.trim() || busy || pending) return;
    setBusy(true);
    setErr('');
    const version = navigation.current;
    try {
      const m = await api.reply(thread.ticket_code, reply.trim(), atts);
      if (version !== navigation.current) return;
      setThread((t) => (t && t.ticket_code === thread.ticket_code && !t.messages.some((x) => x.id === m.id) ? { ...t, messages: [...t.messages, m] } : t));
      setReply('');
      await refreshThread(thread.ticket_code);
      if (version !== navigation.current) return;
      setAtts([]);
    } catch (e) {
      if (version === navigation.current) setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ---- FAB: tap to toggle, drag to move (touch + mouse via Pointer Events) ----
  const fabDown = (e: PointerEvent) => {
    press.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const fabMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8) return;
    p.moved = true;
    setDragAt({ x: e.clientX - 26, y: e.clientY - 26 });
  };
  const fabUp = (e: PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (!p.moved) return setOpen((o) => !o);
    const next: Pos = { side: e.clientX < innerWidth / 2 ? 'l' : 'r', y: Math.round(Math.min(Math.max(innerHeight - e.clientY - 26, 8), innerHeight - 64)) };
    setPos(next);
    setDragAt(null);
    store('fab', JSON.stringify(next));
  };

  const side = pos.side === 'r' ? 'right' : 'left';
  const fabStyle = dragAt ? { left: dragAt.x + 'px', top: dragAt.y + 'px' } : { [side]: '16px', bottom: pos.y + 'px' };
  const panelStyle = cfg.fab ? { [side]: '16px', [side === 'right' ? 'left' : 'right']: 'auto', bottom: pos.y + 64 + 'px' } : { bottom: '16px' };

  const attList = (atts.length > 0 || pending > 0) && (
    <div class="atts">
      {atts.map((a, i) => (
        <div class="att" key={i} title={`${a.file_name} · ${kb(a.size)}`}>
          {a.thumbnail_b64 ? <img alt={a.file_name} src={`data:${a.mime_type};base64,${a.thumbnail_b64}`} /> : a.file_name}
          <button type="button" aria-label={'Remove ' + a.file_name} onClick={() => setAtts((xs) => xs.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      {pending > 0 && <div class="att">Compressing…</div>}
    </div>
  );

  const fileButton = (
    <label class="ghost" style={{ cursor: 'pointer', flexDirection: 'row', fontSize: '13px', color: 'var(--fg)' }}>
      Attach
      <input
        type="file"
        multiple
        hidden
        accept="image/*,.txt,.log,.csv,.json,.xml,.pdf"
        onChange={(e) => {
          const input = e.currentTarget;
          addFiles([...(input.files || [])]);
          input.value = '';
        }}
      />
    </label>
  );

  let body: JSX.Element;
  if (tab === 'new' && done) {
    body = (
      <div class="ok">
        <b>Thanks — ticket {done} created</b>
        <span class="hint">We captured recent app activity to help us reproduce it. You'll see replies under My tickets.</span>
        <button class="ghost" onClick={() => openThread(done)}>
          View ticket
        </button>
        <button class="ghost" onClick={() => setDone('')}>
          Report another
        </button>
      </div>
    );
  } else if (tab === 'new') {
    body = (
      <form id="snag-new" onSubmit={submit} style={{ display: 'contents' }}>
        <label>
          What went wrong?
          <input ref={firstField} value={title} maxLength={255} required placeholder="Short summary" onInput={(e) => setTitle(e.currentTarget.value)} />
        </label>
        <label>
          Details
          <textarea value={desc} maxLength={20000} placeholder="Steps to reproduce, what you expected… Paste screenshots with Ctrl+V." onInput={(e) => setDesc(e.currentTarget.value)} />
        </label>
        <div class="row">
          <label>
            Type
            <select value={category} onChange={(e) => setCategory(e.currentTarget.value)}>
              <option value="bug">Bug</option>
              <option value="feature">Feature request</option>
              <option value="query">Question</option>
              <option value="amc_request">AMC / support request</option>
            </select>
          </label>
          <label>
            Urgency
            <select value={priority} onChange={(e) => setPriority(e.currentTarget.value)}>
              <option value="P0_Critical">Critical — blocked</option>
              <option value="P1_High">High</option>
              <option value="P2_Normal">Normal</option>
              <option value="P3_Low">Low</option>
            </select>
          </label>
        </div>
        {cfg.user.name && cfg.user.email ? (
          <span class="hint">
            Reporting as {cfg.user.name} · {cfg.user.email}
          </span>
        ) : (
          <div class="row">
            <label>
              Name
              <input value={name} maxLength={150} autocomplete="name" onInput={(e) => setName(e.currentTarget.value)} />
            </label>
            <label>
              Email
              <input type="email" value={email} maxLength={150} autocomplete="email" onInput={(e) => setEmail(e.currentTarget.value)} />
            </label>
          </div>
        )}
        {attList}
        <span class="hint">Drop or paste screenshots and log files — they're compressed on your device.</span>
      </form>
    );
  } else if (tab === 'list') {
    body = !tickets ? (
      <div class="empty">Loading…</div>
    ) : tickets.length === 0 ? (
      <div class="empty">You haven't reported anything yet.</div>
    ) : (
      <>
        {tickets.map((t) => (
          <button class="li" key={t.ticket_code} onClick={() => openThread(t.ticket_code)}>
            <span class="top">
              <strong>
                {unread.includes(t.ticket_code) ? '● ' : ''}
                {t.title}
              </strong>
              <span class={'st ' + t.status}>{label(t.status)}</span>
            </span>
            <small>
              {t.ticket_code} · {when(t.created_at)}
            </small>
          </button>
        ))}
      </>
    );
  } else {
    body = !thread ? (
      <div class="empty">Loading…</div>
    ) : (
      <>
        <button class="back" onClick={() => go('list')}>
          ← All tickets
        </button>
        <div class="li" style={{ border: 0, padding: 0 }}>
          <span class="top">
            <strong>{thread.title}</strong>
            <span class={'st ' + thread.status}>{label(thread.status)}</span>
          </span>
          <small>{thread.ticket_code}</small>
        </div>
        {thread.messages.map((m) => (
          <div class={'msg ' + m.author_type} key={m.id}>
            {m.body}
            {thread.attachments.some((a) => a.message_id === m.id && a.thumbnail_b64) && (
              <div class="atts" style={{ marginTop: '6px' }}>
                {thread.attachments
                  .filter((a) => a.message_id === m.id && a.thumbnail_b64)
                  .map((a) => (
                    <div class="att" key={a.id}>
                      <img alt={a.file_name} src={`data:image/webp;base64,${a.thumbnail_b64}`} />
                    </div>
                  ))}
              </div>
            )}
            <small>
              {m.author_type === 'developer' ? 'Support · ' : ''}
              {when(m.created_at)}
            </small>
          </div>
        ))}
        {attList}
      </>
    );
  }

  return (
    <>
      {cfg.fab && (
        <button
          class="fab"
          style={fabStyle}
          aria-label={open ? 'Close issue reporter' : 'Report an issue (Alt+B)'}
          aria-expanded={open}
          title="Report an issue (Alt+B)"
          onPointerDown={fabDown}
          onPointerMove={fabMove}
          onPointerUp={fabUp}
          onPointerCancel={() => ((press.current = null), setDragAt(null))}
          onClick={(e) => e.detail === 0 && setOpen((o) => !o) /* keyboard activation only */}
        >
          <Icon />
          {unread.length > 0 && <span class="badge">{unread.length}</span>}
        </button>
      )}
      {open && (
        <div
          class="panel"
          role="dialog"
          aria-label="Report an issue"
          style={panelStyle}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          onPaste={onPaste}
          onDragOver={onDragOver}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          <div class="hd" role="tablist">
            <button class="tab" role="tab" aria-selected={tab === 'new'} onClick={() => go('new')}>
              Report issue
            </button>
            <button class="tab" role="tab" aria-selected={tab !== 'new'} onClick={() => go('list')}>
              My tickets{unread.length ? ` (${unread.length})` : ''}
            </button>
            <button class="x" aria-label="Close" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <div class={'bd' + (drag ? ' drag' : '')}>
            {body}
            {err && (
              <p class="err" role="alert">
                {err}
              </p>
            )}
          </div>
          {tab === 'new' && !done && (
            <div class="ft">
              {fileButton}
              <span class="hint">Alt+B</span>
              <button class="btn" type="submit" form="snag-new" disabled={busy || pending > 0 || !title.trim()}>
                {busy ? 'Sending…' : 'Submit'}
              </button>
            </div>
          )}
          {tab === 'thread' && thread && thread.status !== 'closed' && (
            <form class="ft" onSubmit={sendReply}>
              {fileButton}
              <textarea
                value={reply}
                placeholder="Reply…"
                aria-label="Reply"
                onInput={(e) => setReply(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && sendReply(e)}
              />
              <button class="btn" disabled={busy || pending > 0 || !reply.trim()}>
                Send
              </button>
            </form>
          )}
        </div>
      )}
    </>
  );
}
