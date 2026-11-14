import type { Category, Priority, Scope, Status } from './types';

export function relTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  if (s < 86400 * 30) return Math.round(s / 86400) + 'd';
  return new Date(iso).toLocaleDateString();
}

export const fullTime = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export const STATUS_LABEL: Record<Status, string> = {
  new: 'New',
  triaged: 'Triaged',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const STATUS_STYLE: Record<Status, string> = {
  new: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  triaged: 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300',
  in_progress: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  resolved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  closed: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700/50 dark:text-zinc-300',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  P0_Critical: 'P0 Critical',
  P1_High: 'P1 High',
  P2_Normal: 'P2 Normal',
  P3_Low: 'P3 Low',
};

export const PRIORITY_DOT: Record<Priority, string> = {
  P0_Critical: 'bg-red-600',
  P1_High: 'bg-orange-500',
  P2_Normal: 'bg-sky-500',
  P3_Low: 'bg-zinc-400',
};

export const CATEGORY_LABEL: Record<Category, string> = {
  bug: 'Bug',
  feature: 'Feature',
  query: 'Query',
  amc_request: 'AMC request',
};

export const SCOPE_LABEL: Record<Scope, string> = {
  unclassified: 'Unclassified',
  bug: 'Bug · AMC covered',
  change_request: 'Change request · Billable',
};

export const SCOPE_STYLE: Record<Scope, string> = {
  unclassified: 'text-zinc-500',
  bug: 'text-emerald-700 dark:text-emerald-400',
  change_request: 'text-fuchsia-700 dark:text-fuchsia-400',
};

export function bytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
