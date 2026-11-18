'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type TicketPatch } from '@/lib/client';
import { bytes, CATEGORY_LABEL, fullTime, PRIORITY_LABEL, relTime, SCOPE_LABEL, STATUS_LABEL } from '@/lib/format';
import type { AttachmentMeta, DirectoryEntry, Scope, Team, TicketDetail, TicketEvent, TicketSummary } from '@/lib/types';
import { CATEGORIES, PRIORITIES, STATUSES } from '@/lib/types';
import { PriorityDot, StatusBadge } from './badges';
import { Conversation } from './Conversation';
import { Lightbox } from './Lightbox';
import { useCan } from './me';
import { useSnagEvents, useStreamGeneration } from './stream';
import { Telemetry } from './Telemetry';

// Split-view triage: left = metadata, AMC classification, dedupe, attachments, telemetry;
// right = conversation with the public / internal toggle.

const SCOPE_OPTIONS: { value: Scope; title: string; hint: string; active: string }[] = [
  { value: 'unclassified', title: 'Unclassified', hint: 'Not yet assessed', active: 'bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900' },
  { value: 'bug', title: 'Bug', hint: 'Warranty / AMC — no charge', active: 'bg-emerald-600 text-white' },
  { value: 'change_request', title: 'Change request', hint: 'New scope — billable hours', active: 'bg-fuchsia-600 text-white' },
];

export function Workspace({ id, onBack, onOpen }: { id: string; onBack: () => void; onOpen: (id: string) => void }) {
  const [t, setT] = useState<TicketDetail | null>(null);
  const [error, setError] = useState('');
  const [teams, setTeams] = useState<Team[]>([]);
  const [people, setPeople] = useState<DirectoryEntry[]>([]);
  const can = useCan();
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const generation = useStreamGeneration();
  const pendingSave = useRef(false);
  const activeID = useRef(id);
  activeID.current = id;
  const loadVersion = useRef(0);

  const load = useCallback(
    (signal?: AbortSignal) => {
      const version = ++loadVersion.current;
      return api.getTicket(id, signal).then((ticket) => {
        if (activeID.current === id && version === loadVersion.current) { setT(ticket); setError(''); }
      }, (e) => {
        if (activeID.current === id && version === loadVersion.current && e.name !== 'AbortError') setError(e.message);
      });
    },
    [id],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load, generation]);

  useEffect(() => {
    api.teams().then(setTeams, () => {});
    api.directory().then(setPeople, () => {});
  }, []);

  useSnagEvents((e) => {
    if (e.type === 'message.created' && e.data.ticket_id === id && e.data.message.author_type === 'client') {
      load(); // reporter replies can carry screenshots and reopen the ticket
    } else if (e.type === 'message.created' && e.data.ticket_id === id) {
      setT((cur) => (cur && !cur.messages.some((m) => m.id === e.data.message.id) ? { ...cur, messages: [...cur.messages, e.data.message] } : cur));
    } else if (e.type === 'ticket.updated') {
      if (e.data.id === id) {
        setT((cur) => (cur ? { ...cur, ...e.data } : cur));
        load(); // refresh the activity log with the change
      }
      // A duplicate changed (linked, cascaded, reopened) → refresh the dedupe panel.
      else if (e.data.parent_ticket_id === id || t?.duplicates.some((d) => d.id === e.data.id)) load();
    }
  });

  const update = async (patch: TicketPatch) => {
    if (!t || pendingSave.current) return;
    pendingSave.current = true;
    ++loadVersion.current;
    const before = t;
    const optimistic = { ...t, ...patch } as TicketDetail;
    setT(optimistic);
    setSaving(true);
    setError('');
    try {
      const summary = await api.patchTicket(id, patch);
      if (activeID.current !== id) return;
      setT((cur) => (cur ? { ...cur, ...summary } : cur));
      load(); // duplicates, cascades and the activity log
    } catch (e) {
      if (activeID.current !== id) return;
      setT((current) => current === optimistic ? before : current);
      await load();
      if (activeID.current !== id) return;
      setError((e as Error).message);
    } finally {
      pendingSave.current = false;
      setSaving(false);
    }
  };

  if (!t || t.id !== id) {
    return <div className="m-auto text-zinc-600 dark:text-zinc-400">{error || 'Loading…'}</div>;
  }

  const images = t.attachments;
  return (
    <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
      {/* ---------- left pane: metadata & evidence ---------- */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 px-4 py-2.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
          <div className="flex items-center gap-2 text-[12px] text-zinc-600 dark:text-zinc-400">
            <button onClick={onBack} className="xl:hidden" aria-label="Back to inbox">
              ←
            </button>
            <PriorityDot priority={t.priority} />
            <span className="font-mono">{t.ticket_code}</span>
            <span>·</span>
            <span>{t.project_name}</span>
            {t.app_version && <span className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">v{t.app_version}</span>}
            <span className="ml-auto" title={t.created_at}>
              {fullTime(t.created_at)}
            </span>
            {saving && <span className="text-indigo-600 dark:text-indigo-400">Saving…</span>}
          </div>
          <h1 className="mt-1 text-base leading-snug font-semibold">{t.title}</h1>
          <p className="text-[12px] text-zinc-600 dark:text-zinc-400">
            {t.reporter_name || 'Anonymous'}
            {t.reporter_email && (
              <>
                {' · '}
                <a className="hover:underline" href={`mailto:${t.reporter_email}`}>
                  {t.reporter_email}
                </a>
              </>
            )}
          </p>
        </header>

        <div className="space-y-5 p-4">
          {error && (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-700 dark:bg-red-500/10 dark:text-red-300">
              {error}
            </p>
          )}

          <section className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Field label="Status">
              <select className="select w-full" disabled={saving || !can('tickets.update')} value={t.status} onChange={(e) => update({ status: e.target.value as TicketSummary['status'] })}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select className="select w-full" disabled={saving || !can('tickets.update')} value={t.priority} onChange={(e) => update({ priority: e.target.value as TicketSummary['priority'] })}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Category">
              <select className="select w-full" disabled={saving || !can('tickets.update')} value={t.category} onChange={(e) => update({ category: e.target.value as TicketSummary['category'] })}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Team">
              <select className="select w-full" disabled={saving || !can('tickets.update')} value={t.team_id ?? ''} onChange={(e) => update({ team_id: e.target.value || null })}>
                <option value="">No team</option>
                {teams.map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {tm.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Assignee">
              <select className="select w-full" disabled={saving || !can('tickets.assign')} value={t.assignee_id ?? ''} onChange={(e) => update({ assignee_id: e.target.value || null })}>
                <option value="">Unassigned</option>
                {t.assignee_id && !people.some((p) => p.id === t.assignee_id) && <option value={t.assignee_id}>(inactive user)</option>}
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </section>

          <section>
            <h2 className="label mb-1.5">AMC scope classification</h2>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-zinc-200 p-1 dark:border-zinc-800" role="radiogroup" aria-label="AMC scope">
              {SCOPE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  role="radio"
                  aria-checked={t.scope_class === o.value}
                  disabled={saving || !can('tickets.classify')}
                  onClick={() => update({ scope_class: o.value })}
                  className={`rounded-md px-2 py-1.5 text-left disabled:cursor-not-allowed ${t.scope_class === o.value ? o.active : 'hover:bg-zinc-100 disabled:hover:bg-transparent dark:hover:bg-zinc-800'}`}
                >
                  <span className="block text-[12px] font-semibold">{o.title}</span>
                  <span className={`block text-[11px] ${t.scope_class === o.value ? 'opacity-85' : 'text-zinc-600 dark:text-zinc-400'}`}>{o.hint}</span>
                </button>
              ))}
            </div>
          </section>

          <Dedupe t={t} canLink={can('tickets.link')} canBroadcast={can('tickets.broadcast')} onLink={(parent) => update({ parent_ticket_id: parent })} onOpen={onOpen} onBroadcastDone={() => load()} />

          {t.description && (
            <section>
              <h2 className="label mb-1">Description</h2>
              <p className="leading-relaxed whitespace-pre-wrap">{t.description}</p>
            </section>
          )}

          {images.length > 0 && (
            <section>
              <h2 className="label mb-1.5">Attachments · {images.length}</h2>
              <div className="flex flex-wrap gap-2">
                {images.map((a, i) => (
                  <AttachmentTile key={a.id} a={a} onOpen={() => setLightbox(i)} />
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="label mb-1.5">Auto-captured telemetry</h2>
            <Telemetry telemetry={t.telemetry} />
          </section>

          <Activity events={t.events} />
        </div>
      </div>

      {/* ---------- right pane: conversation ---------- */}
      <div className="flex min-h-[420px] w-full flex-col border-t border-zinc-200 lg:w-[420px] lg:shrink-0 lg:border-t-0 lg:border-l dark:border-zinc-800">
        <Conversation
          ticket={t}
          onOpenAttachment={(a) => setLightbox(images.findIndex((x) => x.id === a.id))}
          onSent={(m) => setT((cur) => (cur && !cur.messages.some((x) => x.id === m.id) ? { ...cur, messages: [...cur.messages, m] } : cur))}
        />
      </div>

      {lightbox !== null && images[lightbox] && (
        <Lightbox
          attachment={images[lightbox]}
          onClose={() => setLightbox(null)}
          onStep={images.length > 1 ? (d) => setLightbox((i) => ((i ?? 0) + d + images.length) % images.length) : undefined}
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-0.5">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function AttachmentTile({ a, onOpen }: { a: AttachmentMeta; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      title={`${a.file_name} · ${bytes(a.compressed_size)}`}
      className="group relative size-24 overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
    >
      {a.thumbnail_b64 ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`data:image/webp;base64,${a.thumbnail_b64}`} alt={a.file_name} className="size-full object-cover transition group-hover:scale-105" />
      ) : (
        <span className="flex size-full flex-col items-center justify-center gap-1 p-1 text-[10px] break-all text-zinc-600 dark:text-zinc-400">
          <span className="text-lg">{a.mime_type === 'application/pdf' ? '📄' : '🗒️'}</span>
          {a.file_name}
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 text-[10px] text-white">{bytes(a.compressed_size)}</span>
    </button>
  );
}

// ---- duplicate linking + batch broadcast ----

function Dedupe({
  t,
  canLink,
  canBroadcast,
  onLink,
  onOpen,
  onBroadcastDone,
}: {
  t: TicketDetail;
  canLink: boolean;
  canBroadcast: boolean;
  onLink: (parent: string | null) => void; onOpen: (id: string) => void; onBroadcastDone: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<TicketSummary[]>([]);
  const [broadcast, setBroadcast] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (q.trim().length < 2) return setResults([]);
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api.listTickets({ q: q.trim(), limit: 6, top_level: true }, ctrl.signal).then(
        (p) => setResults(p.items.filter((x) => x.id !== t.id)),
        () => {},
      );
    }, 200);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, t.id]);

  const send = async () => {
    if (!broadcast.trim()) return;
    setSending(true);
    try {
      const r = await api.broadcast(t.id, broadcast.trim());
      setNotice(`Sent to ${r.delivered} reporters.`);
      setBroadcast('');
      onBroadcastDone();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (t.parent) {
    return (
      <section className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
        <h2 className="label mb-1 text-amber-800 dark:text-amber-300">Duplicate</h2>
        <div className="flex items-center gap-2">
          <span>
            Tracked under{' '}
            <button className="font-mono font-medium text-indigo-700 hover:underline dark:text-indigo-300" onClick={() => onOpen(t.parent!.id)}>
              {t.parent.ticket_code}
            </button>{' '}
            — {t.parent.title}
          </span>
          <StatusBadge status={t.parent.status} />
          {canLink && (
            <button className="btn ml-auto" onClick={() => onLink(null)}>
              Unlink
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <h2 className="label">Deduplication</h2>
      {!canLink && t.duplicates.length === 0 && <p className="text-[12px] text-zinc-600 dark:text-zinc-400">No linked duplicates.</p>}
      <div className={canLink ? 'relative' : 'hidden'}>
        <input className="input" placeholder="Link as duplicate of… (search code or title)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find parent ticket" />
        {results.length > 0 && (
          <ul aria-label="Matching tickets" className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            {results.map((r) => (
              <li key={r.id}>
                <button
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  onClick={() => {
                    onLink(r.id);
                    setQ('');
                  }}
                >
                  <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{r.ticket_code}</span>
                  <span className="truncate">{r.title}</span>
                  <span className="ml-auto text-[11px] text-zinc-600 dark:text-zinc-400">{r.project_name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {t.duplicates.length > 0 && (
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="mb-2 text-[12px] text-zinc-600 dark:text-zinc-400">
            <strong>{t.duplicates.length + 1} clients</strong> reported this. Resolving or closing it resolves every open duplicate and notifies each reporter automatically.
          </p>
          <ul className="mb-2 space-y-1">
            {t.duplicates.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <button className="font-mono text-[12px] text-indigo-700 hover:underline dark:text-indigo-300" onClick={() => onOpen(d.id)}>
                  {d.ticket_code}
                </button>
                <span className="truncate">{d.title}</span>
                <span className="ml-auto">
                  <StatusBadge status={d.status} />
                </span>
              </li>
            ))}
          </ul>
          <div className={canBroadcast ? 'flex gap-2' : 'hidden'}>
            <input
              className="input"
              placeholder="Broadcast a public update to all reporters…"
              value={broadcast}
              onChange={(e) => setBroadcast(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
            />
            <button className="btn-primary shrink-0" disabled={sending || !broadcast.trim()} onClick={send}>
              Broadcast
            </button>
          </div>
          {notice && <p className="mt-1 text-[12px] text-zinc-600 dark:text-zinc-400">{notice}</p>}
        </div>
      )}
    </section>
  );
}

// ---- activity log ----

const FIELD_LABEL: Record<TicketEvent['field'], string> = {
  status: 'status',
  priority: 'priority',
  category: 'category',
  scope_class: 'AMC scope',
  team: 'team',
  assignee: 'assignee',
  parent: 'duplicate link',
};

function eventValue(field: TicketEvent['field'], v: string | null): string {
  if (v === null) return field === 'parent' ? 'none' : field === 'assignee' ? 'nobody' : 'none';
  const labels: Record<string, Record<string, string>> = { status: STATUS_LABEL, priority: PRIORITY_LABEL, category: CATEGORY_LABEL, scope_class: SCOPE_LABEL };
  return labels[field]?.[v] ?? v;
}

function Activity({ events }: { events: TicketEvent[] }) {
  const [all, setAll] = useState(false);
  if (!events.length) return null;
  const shown = all ? events : events.slice(-8);
  return (
    <section>
      <h2 className="label mb-1.5">Activity · {events.length}</h2>
      {events.length > shown.length && (
        <button className="mb-1 text-[12px] text-indigo-600 dark:text-indigo-400 hover:underline" onClick={() => setAll(true)}>
          Show {events.length - shown.length} earlier changes
        </button>
      )}
      <ol className="space-y-1 border-l border-zinc-200 pl-3 text-[12px] dark:border-zinc-800">
        {shown.map((e) => (
          <li key={e.id} className="relative">
            <span className="absolute top-1.5 -left-[15px] size-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600" aria-hidden />
            <span className="font-medium">{e.actor ?? 'System'}</span>{' '}
            <span className="text-zinc-600 dark:text-zinc-400">
              changed {FIELD_LABEL[e.field]}
              {!(e.field === 'status' && e.old_value === null) && (
                <>
                  {' '}from <strong className="font-medium">{eventValue(e.field, e.old_value)}</strong>
                </>
              )}{' '}
              to{' '}
              <strong className="font-medium">{eventValue(e.field, e.new_value)}</strong>
              {e.note && <> · {e.note}</>}
            </span>{' '}
            <span className="text-zinc-600 dark:text-zinc-400" title={fullTime(e.created_at)}>
              · {relTime(e.created_at)} ago
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
