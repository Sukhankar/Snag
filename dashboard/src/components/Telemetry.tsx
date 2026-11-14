import type { Telemetry as T, TelemetryEvent } from '@/lib/types';

const KIND_STYLE: Record<TelemetryEvent['k'], string> = {
  click: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  route: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  console: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  error: 'bg-red-600 text-white',
  http: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
};

function detail(e: TelemetryEvent): React.ReactNode {
  switch (e.k) {
    case 'click':
      return (
        <>
          <code className="text-zinc-500">{e.el}</code> {e.text && <span>“{e.text}”</span>}
        </>
      );
    case 'route':
      return <code>→ {e.to}</code>;
    case 'http':
      return (
        <>
          <span className="font-semibold">{e.status || 'NETWORK'}</span> <code>{e.m} {e.url}</code> <span className="text-zinc-500">{e.ms}ms</span>
          {e.err && <span className="text-red-600"> {e.err}</span>}
        </>
      );
    case 'error':
      return (
        <>
          <span className="whitespace-pre-wrap">{e.msg}</span>
          {e.src && <code className="block text-zinc-500">{e.src}</code>}
        </>
      );
    case 'console':
      return <span className="whitespace-pre-wrap">{e.msg}</span>;
  }
}

function shortUA(ua: string): string {
  const browser = ua.match(/(Edg|Chrome|Firefox|Safari)\/([\d]+)/);
  const os = ua.match(/\(([^;)]+)/);
  return [browser && `${browser[1] === 'Edg' ? 'Edge' : browser[1]} ${browser[2]}`, os?.[1]].filter(Boolean).join(' · ') || ua;
}

export function Telemetry({ telemetry }: { telemetry: T | null }) {
  if (!telemetry) return <p className="text-zinc-500">No telemetry captured.</p>;
  const env = telemetry.env ?? {};
  const events = telemetry.events ?? [];
  const at = telemetry.captured_at ? new Date(telemetry.captured_at).getTime() : events.at(-1)?.t ?? 0;
  const errors = events.filter((e) => e.k === 'error' || e.k === 'console' || (e.k === 'http' && (e.status >= 500 || e.status === 0))).length;

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        {env.url && (
          <>
            <dt className="text-zinc-500">Page</dt>
            <dd className="truncate font-mono">{String(env.url)}</dd>
          </>
        )}
        {env.ua && (
          <>
            <dt className="text-zinc-500">Client</dt>
            <dd title={String(env.ua)}>{shortUA(String(env.ua))}</dd>
          </>
        )}
        <dt className="text-zinc-500">Screen</dt>
        <dd>
          {String(env.vw)}×{String(env.vh)} @{String(env.dpr)}x · {String(env.tz)} · {String(env.lang)}
          {env.online === false && <span className="ml-1 font-semibold text-red-600">offline</span>}
        </dd>
      </dl>

      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="label">Black box · last {events.length} events</span>
          {errors > 0 && <span className="text-[11px] font-medium text-red-600">{errors} errors</span>}
        </div>
        {events.length === 0 ? (
          <p className="text-zinc-500">No events recorded before submission.</p>
        ) : (
          <ol className="divide-y divide-zinc-100 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {events.map((e, i) => (
              <li key={i} className="flex gap-2 px-2 py-1 text-[12px]">
                <span className="w-14 shrink-0 text-right font-mono text-[11px] text-zinc-400" title={new Date(e.t).toLocaleTimeString()}>
                  {((e.t - at) / 1000).toFixed(1)}s
                </span>
                <span className={`h-fit w-14 shrink-0 rounded px-1 text-center text-[10px] font-semibold uppercase ${KIND_STYLE[e.k]}`}>{e.k}</span>
                <span className="min-w-0 break-words">{detail(e)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
