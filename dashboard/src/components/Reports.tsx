'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client';
import type { AMCRow, Project } from '@/lib/types';

// AMC report: per project, how much of the period's work was covered by the maintenance
// contract (bugs) versus billable new scope (change requests), and how much is still open.

const iso = (d: Date) => d.toISOString().slice(0, 10);

function preset(id: string): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const day = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd));
  switch (id) {
    case 'last-month':
      return { from: iso(day(y, m - 1, 1)), to: iso(day(y, m, 0)) };
    case 'quarter': {
      const q = Math.floor(m / 3) * 3;
      return { from: iso(day(y, q, 1)), to: iso(day(y, q + 3, 0)) };
    }
    case 'year':
      return { from: iso(day(y, 0, 1)), to: iso(day(y, 11, 31)) };
    case 'last-12':
      return { from: iso(day(y, m - 11, 1)), to: iso(day(y, m + 1, 0)) };
    default:
      return { from: iso(day(y, m, 1)), to: iso(day(y, m + 1, 0)) };
  }
}

const PRESETS = [
  { id: 'month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'quarter', label: 'This quarter' },
  { id: 'year', label: 'This year' },
  { id: 'last-12', label: 'Last 12 months' },
];

const hours = (h: number | null) => (h === null ? '—' : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`);
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

export function Reports() {
  const [period, setPeriod] = useState('month');
  const [range, setRange] = useState(() => preset('month'));
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [rows, setRows] = useState<AMCRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.projects().then(setProjects, () => {});
  }, []);

  useEffect(() => {
    if (!range.from || !range.to) return;
    setError('');
    setRows(null);
    api.amcReport({ ...range, project_id: projectId || undefined }).then(
      (r) => setRows(r.items),
      (e) => setError(e.message),
    );
  }, [range, projectId]);

  const total = useMemo(() => {
    const t = { total: 0, bug: 0, change_request: 0, unclassified: 0, open: 0, resolved: 0, duplicates: 0 };
    for (const r of rows ?? []) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += r[k];
    return t;
  }, [rows]);

  const downloadCsv = () => {
    const header = ['Project', 'Tickets', 'Bug (covered)', 'Change request (billable)', 'Unclassified', 'Open', 'Resolved', 'Duplicates', 'Avg resolution hours'];
    const esc = (v: string | number | null) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const lines = [header, ...(rows ?? []).map((r) => [r.project_name, r.total, r.bug, r.change_request, r.unclassified, r.open, r.resolved, r.duplicates, r.avg_resolution_hours?.toFixed(1) ?? ''])];
    const blob = new Blob([lines.map((l) => l.map(esc).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `snag-amc-report_${range.from}_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 p-6">
        <header className="flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-lg font-semibold">AMC report</h1>
            <p className="text-zinc-500">Tickets created in the period, split into contract-covered bugs and billable change requests.</p>
          </div>
          <button className="btn ml-auto" onClick={downloadCsv} disabled={!rows?.length}>
            Download CSV
          </button>
        </header>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Period">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                aria-pressed={period === p.id}
                onClick={() => {
                  setPeriod(p.id);
                  setRange(preset(p.id));
                }}
                className={`rounded px-2 py-1 text-[12px] ${period === p.id ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-[12px] text-zinc-500">
            From
            <input
              type="date"
              className="input w-auto py-1"
              value={range.from}
              max={range.to}
              onChange={(e) => {
                setPeriod('custom');
                setRange((r) => ({ ...r, from: e.target.value }));
              }}
            />
          </label>
          <label className="flex items-center gap-1 text-[12px] text-zinc-500">
            To
            <input
              type="date"
              className="input w-auto py-1"
              value={range.to}
              min={range.from}
              onChange={(e) => {
                setPeriod('custom');
                setRange((r) => ({ ...r, to: e.target.value }));
              }}
            />
          </label>
          <select aria-label="Project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </p>
        )}

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Totals">
          <Stat label="Tickets" value={total.total} />
          <Stat label="Bugs · covered" value={total.bug} hint={`${pct(total.bug, total.total)}%`} tone="emerald" />
          <Stat label="Change requests · billable" value={total.change_request} hint={`${pct(total.change_request, total.total)}%`} tone="fuchsia" />
          <Stat label="Still unclassified" value={total.unclassified} hint={total.unclassified ? 'needs triage' : 'all classified'} tone={total.unclassified ? 'amber' : undefined} />
        </section>

        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left tabular-nums">
            <thead className="bg-zinc-50 text-[11px] tracking-wide text-zinc-500 uppercase dark:bg-zinc-900">
              <tr>
                <th className="px-3 py-2 font-semibold">Project</th>
                <th className="px-3 py-2 text-right font-semibold">Tickets</th>
                <th className="px-3 py-2 font-semibold">Scope split</th>
                <th className="px-3 py-2 text-right font-semibold">Bug</th>
                <th className="px-3 py-2 text-right font-semibold">Change req.</th>
                <th className="px-3 py-2 text-right font-semibold">Unclassified</th>
                <th className="px-3 py-2 text-right font-semibold">Open</th>
                <th className="px-3 py-2 text-right font-semibold">Resolved</th>
                <th className="px-3 py-2 text-right font-semibold">Avg. resolution</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows === null && !error && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-zinc-500">
                    Loading…
                  </td>
                </tr>
              )}
              {rows?.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-zinc-500">
                    No tickets were created in this period.
                  </td>
                </tr>
              )}
              {rows?.map((r) => (
                <tr key={r.project_id}>
                  <td className="px-3 py-2 font-medium">{r.project_name}</td>
                  <td className="px-3 py-2 text-right">{r.total}</td>
                  <td className="px-3 py-2">
                    <SplitBar row={r} />
                  </td>
                  <td className="px-3 py-2 text-right">{r.bug}</td>
                  <td className="px-3 py-2 text-right">{r.change_request}</td>
                  <td className={`px-3 py-2 text-right ${r.unclassified ? 'text-amber-700 dark:text-amber-400' : ''}`}>{r.unclassified}</td>
                  <td className="px-3 py-2 text-right">{r.open}</td>
                  <td className="px-3 py-2 text-right">{r.resolved}</td>
                  <td className="px-3 py-2 text-right">{hours(r.avg_resolution_hours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[12px] text-zinc-500">
          Resolution time runs from when a ticket was reported to its first move to Resolved or Closed, and is only known for changes made since the activity log was introduced. Duplicates are counted as separate reports
          {total.duplicates ? ` (${total.duplicates} in this period)` : ''}.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: 'emerald' | 'fuchsia' | 'amber' }) {
  const color = tone === 'emerald' ? 'text-emerald-700 dark:text-emerald-400' : tone === 'fuchsia' ? 'text-fuchsia-700 dark:text-fuchsia-400' : tone === 'amber' ? 'text-amber-700 dark:text-amber-400' : '';
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="label">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="text-[12px] text-zinc-500">{hint}</div>}
    </div>
  );
}

function SplitBar({ row }: { row: AMCRow }) {
  const parts = [
    { n: row.bug, cls: 'bg-emerald-500', label: 'Bug' },
    { n: row.change_request, cls: 'bg-fuchsia-500', label: 'Change request' },
    { n: row.unclassified, cls: 'bg-zinc-300 dark:bg-zinc-600', label: 'Unclassified' },
  ];
  return (
    <div className="flex h-2 w-40 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" role="img" aria-label={parts.map((p) => `${p.label} ${pct(p.n, row.total)}%`).join(', ')}>
      {parts.map((p) =>
        p.n ? <span key={p.label} className={p.cls} style={{ width: `${pct(p.n, row.total)}%` }} title={`${p.label}: ${p.n}`} /> : null,
      )}
    </div>
  );
}
