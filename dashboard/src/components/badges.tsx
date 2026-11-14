import { PRIORITY_DOT, PRIORITY_LABEL, STATUS_LABEL, STATUS_STYLE } from '@/lib/format';
import type { Priority, Status } from '@/lib/types';

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`inline-flex shrink-0 rounded px-1.5 py-px text-[11px] font-medium ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>;
}

export function PriorityDot({ priority }: { priority: Priority }) {
  return <span title={PRIORITY_LABEL[priority]} aria-label={PRIORITY_LABEL[priority]} className={`inline-block size-2 shrink-0 rounded-full ${PRIORITY_DOT[priority]}`} />;
}

export function ScopeChip({ scope }: { scope: 'unclassified' | 'bug' | 'change_request' }) {
  if (scope === 'unclassified') return null;
  return scope === 'bug' ? (
    <span className="rounded bg-emerald-50 px-1 py-px text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200 ring-inset dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30">AMC</span>
  ) : (
    <span className="rounded bg-fuchsia-50 px-1 py-px text-[10px] font-semibold text-fuchsia-700 ring-1 ring-fuchsia-200 ring-inset dark:bg-fuchsia-500/10 dark:text-fuchsia-300 dark:ring-fuchsia-500/30">
      BILLABLE
    </span>
  );
}
