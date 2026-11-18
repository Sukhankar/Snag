'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { relTime, STATUS_LABEL } from '@/lib/format';
import type { Project, Status, TicketSummary } from '@/lib/types';
import { STATUSES } from '@/lib/types';
import { PriorityDot, ScopeChip } from './badges';
import { useCan } from './me';
import { useSnagEvents, useStreamGeneration } from './stream';

// Kanban over root tickets (duplicates ride along with their parent). Drag a card to
// change status; resolving a parent cascades to its duplicates server-side.

const PRIORITY_RANK = { P0_Critical: 0, P1_High: 1, P2_Normal: 2, P3_Low: 3 } as const;
const PER_COLUMN = 100;

export function Board() {
  const [cards, setCards] = useState<TicketSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState<Status[]>([]);
  const canMove = useCan()('tickets.update');
  const generation = useStreamGeneration();

  useEffect(() => {
    api.projects().then(setProjects, () => {});
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all(
      STATUSES.map((s) => api.listTickets({ status: [s], limit: PER_COLUMN, top_level: true, project_id: projectId || undefined }, ctrl.signal).then((p) => ({ s, p }))),
    ).then(
      (pages) => {
        setCards(pages.flatMap(({ p }) => p.items));
        setTruncated(pages.filter(({ p }) => p.next_cursor).map(({ s }) => s));
      },
      (e) => e.name !== 'AbortError' && setError(e.message),
    );
    return () => ctrl.abort();
  }, [projectId, generation]);

  useSnagEvents((e) => {
    if (e.type === 'message.created') return;
    const t = e.data;
    if (t.parent_ticket_id || (projectId && t.project_id !== projectId)) {
      setCards((cs) => cs.filter((c) => c.id !== t.id)); // became a duplicate → leave the board
      return;
    }
    setCards((cs) => (cs.some((c) => c.id === t.id) ? cs.map((c) => (c.id === t.id ? t : c)) : [t, ...cs]));
  });

  const pendingMoves = useRef(new Set<string>());
  const [pendingIDs, setPendingIDs] = useState(new Set<string>());
  const move = async (id: string, status: Status) => {
    if (pendingMoves.current.has(id)) return;
    const card = cards.find((c) => c.id === id);
    if (!card || card.status === status) return;
    pendingMoves.current.add(id);
    setPendingIDs(new Set(pendingMoves.current));
    const optimistic = { ...card, status };
    setCards((cs) => cs.map((c) => (c.id === id ? optimistic : c)));
    setError('');
    try {
      const updated = await api.patchTicket(id, { status });
      setCards((cs) => cs.map((c) => (c.id === id ? updated : c)));
    } catch (e) {
      // Fetch authoritative data: live events may have arrived during this request.
      try {
        const current = await api.getTicket(id);
        setCards((cs) => cs.map((c) => (c.id === id ? current : c)));
      } catch {
        setCards((cs) => cs.map((c) => (c === optimistic ? card : c)));
      }
      setError(`${card.ticket_code}: ${(e as Error).message}`);
    } finally {
      pendingMoves.current.delete(id);
      setPendingIDs(new Set(pendingMoves.current));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <h1 className="font-semibold">Board</h1>
        <select aria-label="Project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-zinc-600 dark:text-zinc-400">{canMove ? 'Drag cards between columns.' : 'Read-only.'} Duplicates are grouped under their parent.</span>
        {error && (
          <span role="alert" className="ml-auto text-[12px] text-red-600">
            {error}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {STATUSES.map((status) => {
          const col = cards.filter((c) => c.status === status).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.created_at.localeCompare(a.created_at));
          return (
            <section
              key={status}
              aria-label={STATUS_LABEL[status]}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(status);
              }}
              onDragLeave={() => setOver((o) => (o === status ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                setDragging(null); // the card remounts in its new column, so its dragend never fires
                const id = e.dataTransfer.getData('text/plain');
                if (id) move(id, status);
              }}
              className={`flex w-72 shrink-0 flex-col rounded-lg bg-zinc-100/70 dark:bg-zinc-900 ${over === status ? 'ring-2 ring-indigo-500' : ''}`}
            >
              <header className="flex items-center gap-2 px-3 py-2">
                <span className="text-[12px] font-semibold">{STATUS_LABEL[status]}</span>
                <span className="text-[11px] text-zinc-600 dark:text-zinc-400">
                  {col.length}
                  {truncated.includes(status) && '+'}
                </span>
              </header>
              <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {col.map((c) => (
                  <li
                    key={c.id}
                    draggable={canMove && !pendingIDs.has(c.id)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', c.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragging(c.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    className={`${canMove ? 'cursor-grab active:cursor-grabbing' : ''} rounded-md border border-zinc-200 bg-white p-2.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 ${dragging === c.id ? 'opacity-40' : ''}`}
                  >
                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                      <PriorityDot priority={c.priority} />
                      <span className="font-mono">{c.ticket_code}</span>
                      <ScopeChip scope={c.scope_class} />
                      <span className="ml-auto">{relTime(c.created_at)}</span>
                    </div>
                    <Link href={`/?t=${c.id}`} className="mt-1 line-clamp-2 block font-medium hover:underline">
                      {c.title}
                    </Link>
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                      <span className="truncate">{c.project_name}</span>
                      {c.duplicate_count > 0 && <span className="ml-auto shrink-0 rounded bg-zinc-100 px-1 dark:bg-zinc-800">×{c.duplicate_count + 1} reports</span>}
                    </div>
                    {/* Keyboard-accessible alternative to drag-and-drop */}
                    {canMove && (
                    <select
                      aria-label={`Move ${c.ticket_code}`}
                      disabled={pendingIDs.has(c.id)}
                      className="sr-only focus:not-sr-only focus:mt-2 focus:w-full"
                      value={c.status}
                      onChange={(e) => move(c.id, e.target.value as Status)}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
