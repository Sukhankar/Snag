'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, type ListParams } from '@/lib/client';
import { relTime, SCOPE_LABEL } from '@/lib/format';
import type { Project, Status, TicketSummary } from '@/lib/types';
import { PRIORITIES, SCOPES } from '@/lib/types';
import { PriorityDot, ScopeChip, StatusBadge } from './badges';
import { useSnagEvents } from './stream';
import { Workspace } from './Workspace';

const VIEWS: { id: string; label: string; status: Status[] }[] = [
  { id: 'open', label: 'Open', status: ['new', 'triaged', 'in_progress'] },
  { id: 'new', label: 'New', status: ['new'] },
  { id: 'done', label: 'Resolved', status: ['resolved', 'closed'] },
  { id: 'all', label: 'All', status: [] },
];

interface Filters {
  view: string;
  q: string;
  project_id: string;
  scope_class: string;
  priority: string;
  top_level: boolean;
}
const DEFAULTS: Filters = { view: 'open', q: '', project_id: '', scope_class: '', priority: '', top_level: false };

function toParams(f: Filters): ListParams {
  return {
    status: VIEWS.find((v) => v.id === f.view)?.status,
    q: f.q.trim() || undefined,
    project_id: f.project_id || undefined,
    scope_class: f.scope_class || undefined,
    priority: f.priority || undefined,
    top_level: f.top_level,
    limit: 50,
  };
}

function matches(t: TicketSummary, f: Filters): boolean {
  const status = VIEWS.find((v) => v.id === f.view)?.status ?? [];
  const q = f.q.trim().toLowerCase();
  return (
    (!status.length || status.includes(t.status)) &&
    (!f.project_id || t.project_id === f.project_id) &&
    (!f.scope_class || t.scope_class === f.scope_class) &&
    (!f.priority || t.priority === f.priority) &&
    (!f.top_level || !t.parent_ticket_id) &&
    (!q || t.title.toLowerCase().includes(q) || t.ticket_code.toLowerCase().includes(q))
  );
}

export function Inbox() {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('t');

  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const [debouncedQ, setDebouncedQ] = useState('');
  const [items, setItems] = useState<TicketSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const sentinel = useRef<HTMLLIElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const effective = { ...filters, q: debouncedQ };
  const key = JSON.stringify(effective);

  useEffect(() => {
    api.projects().then(setProjects, () => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(filters.q), 250);
    return () => clearTimeout(t);
  }, [filters.q]);

  // First page whenever filters change.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError('');
    api.listTickets(toParams(effective), ctrl.signal).then(
      (page) => {
        setItems(page.items);
        setCursor(page.next_cursor);
        setLoading(false);
      },
      (e) => {
        if (e.name !== 'AbortError') {
          setError(e.message);
          setLoading(false);
        }
      },
    );
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loadMore = useCallback(() => {
    if (!cursor || loading) return;
    setLoading(true);
    api.listTickets({ ...toParams(effective), cursor }).then(
      (page) => {
        setItems((xs) => {
          const seen = new Set(xs.map((x) => x.id));
          return [...xs, ...page.items.filter((x) => !seen.has(x.id))];
        });
        setCursor(page.next_cursor);
        setLoading(false);
      },
      (e) => {
        setError(e.message);
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, loading, key]);

  // Keyset "infinite scroll".
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && loadMore(), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  useSnagEvents((e) => {
    if (e.type === 'ticket.created') {
      if (!matches(e.data, effective)) return;
      setItems((xs) => (xs.some((x) => x.id === e.data.id) ? xs : [e.data, ...xs]));
      setFresh((s) => new Set(s).add(e.data.id));
    } else if (e.type === 'ticket.updated') {
      setItems((xs) => xs.map((x) => (x.id === e.data.id ? e.data : x)));
    }
  });

  const select = useCallback(
    (id: string | null) => {
      router.replace(id ? `/?t=${id}` : '/', { scroll: false });
      if (id) setFresh((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : s));
    },
    [router],
  );

  // j / k to move through the inbox.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const idx = items.findIndex((x) => x.id === selected);
      const next = items[Math.min(items.length - 1, Math.max(0, idx + (e.key === 'j' ? 1 : -1)))];
      if (next) {
        select(next.id);
        listRef.current?.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, selected, select]);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  return (
    <div className="flex h-full">
      <aside className={`${selected ? 'hidden xl:flex' : 'flex'} w-full min-w-0 flex-col border-r border-zinc-200 xl:w-[400px] xl:shrink-0 dark:border-zinc-800`}>
        <div className="space-y-2 border-b border-zinc-200 p-2.5 dark:border-zinc-800">
          <input className="input" type="search" placeholder="Search title, SNAG-code, reporter email…" value={filters.q} onChange={(e) => set('q', e.target.value)} />
          <div className="flex gap-1" role="tablist">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                role="tab"
                aria-selected={filters.view === v.id}
                onClick={() => set('view', v.id)}
                className={`rounded px-2 py-1 text-[12px] ${filters.view === v.id ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'}`}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <select aria-label="Project" className="select max-w-[140px]" value={filters.project_id} onChange={(e) => set('project_id', e.target.value)}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select aria-label="Scope" className="select" value={filters.scope_class} onChange={(e) => set('scope_class', e.target.value)}>
              <option value="">Any scope</option>
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABEL[s]}
                </option>
              ))}
            </select>
            <select aria-label="Priority" className="select" value={filters.priority} onChange={(e) => set('priority', e.target.value)}>
              <option value="">Any priority</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p.replace('_', ' ')}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-[12px] text-zinc-600 dark:text-zinc-400">
              <input type="checkbox" checked={filters.top_level} onChange={(e) => set('top_level', e.target.checked)} />
              Hide duplicates
            </label>
          </div>
        </div>

        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto" aria-label="Tickets">
          {items.map((t) => (
            <li key={t.id} data-id={t.id}>
              <button
                onClick={() => select(t.id)}
                aria-current={t.id === selected ? 'true' : undefined}
                className={`block w-full border-b border-zinc-100 px-3 py-2 text-left dark:border-zinc-800/70 ${t.id === selected ? 'bg-indigo-50 dark:bg-indigo-500/10' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900'}`}
              >
                <div className="flex items-center gap-2">
                  <PriorityDot priority={t.priority} />
                  <span className="font-mono text-[11px] text-zinc-500">{t.ticket_code}</span>
                  {fresh.has(t.id) && <span className="rounded bg-indigo-600 px-1 text-[10px] font-semibold text-white">NEW</span>}
                  <span className="truncate text-[11px] text-zinc-500">{t.project_name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-zinc-400" title={t.created_at}>
                    {relTime(t.created_at)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className={`truncate ${t.status === 'new' ? 'font-semibold' : ''}`}>{t.title}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
                  <StatusBadge status={t.status} />
                  <ScopeChip scope={t.scope_class} />
                  {t.parent_ticket_id && <span className="text-zinc-400">duplicate</span>}
                  {t.duplicate_count > 0 && (
                    <span className="rounded bg-zinc-100 px-1 dark:bg-zinc-800" title="Linked duplicates">
                      ×{t.duplicate_count + 1} reports
                    </span>
                  )}
                  {t.has_attachments && <span title="Has attachments">📎</span>}
                  <span className="ml-auto truncate">{t.reporter_name || t.reporter_email}</span>
                </div>
              </button>
            </li>
          ))}
          {!loading && items.length === 0 && !error && <li className="p-8 text-center text-zinc-500">No tickets match these filters.</li>}
          {error && (
            <li className="p-4 text-center text-red-600" role="alert">
              {error}
            </li>
          )}
          <li ref={sentinel} className="p-3 text-center text-[11px] text-zinc-400">
            {loading ? 'Loading…' : cursor ? '' : items.length > 0 ? 'End of inbox' : ''}
          </li>
        </ul>
      </aside>

      <section className={`${selected ? 'flex' : 'hidden xl:flex'} min-w-0 flex-1`}>
        {selected ? (
          <Workspace key={selected} id={selected} onBack={() => select(null)} onOpen={select} />
        ) : (
          <div className="m-auto text-center text-zinc-500">
            <p className="text-sm">Select a ticket to triage</p>
            <p className="mt-1 text-[12px] text-zinc-400">
              <kbd className="rounded border px-1">j</kbd> / <kbd className="rounded border px-1">k</kbd> to move through the inbox
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
