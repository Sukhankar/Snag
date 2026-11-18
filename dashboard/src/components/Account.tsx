'use client';

import { useState } from 'react';
import { api } from '@/lib/client';
import { useMe } from './me';

export function Account() {
  const me = useMe();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-8 p-6">
        <header>
          <h1 className="text-lg font-semibold">My account</h1>
        </header>

        {me.must_change_password && (
          <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <strong className="block">Choose your own password to continue.</strong>
            You signed in with a temporary password set by an administrator. Set a new one below to start using Snag.
          </p>
        )}

        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-zinc-600 dark:text-zinc-400">Name</dt>
            <dd className="font-medium">{me.name}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">Email</dt>
            <dd>{me.email}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">Role</dt>
            <dd>{me.is_owner ? '👑 Owner — full access to everything' : me.role_name}</dd>
          </dl>
          <div className="mt-3">
            <span className="label">What you can do</span>
            <ul className="mt-1 flex flex-wrap gap-1">
              {me.permissions.map((p) => (
                <li key={p} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] dark:bg-zinc-800">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <form
          className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
          onSubmit={async (e) => {
            e.preventDefault();
            if (next !== confirmPw) return setMsg({ ok: false, text: 'The new passwords do not match.' });
            setBusy(true);
            setMsg(null);
            try {
              await api.changePassword(current, next);
              setCurrent('');
              setNext('');
              setConfirmPw('');
              setMsg({ ok: true, text: 'Password changed. Your other devices have been signed out.' });
              if (me.must_change_password) window.location.href = '/';
            } catch (err) {
              setMsg({ ok: false, text: (err as Error).message });
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2 className="font-semibold">Change password</h2>
          <label className="block space-y-1">
            <span className="label">Current password</span>
            <input className="input" type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="label">New password (at least 10 characters)</span>
            <input className="input" type="password" required minLength={10} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="label">Confirm new password</span>
            <input className="input" type="password" required minLength={10} autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
          </label>
          {msg && (
            <p role="alert" className={`text-sm ${msg.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
              {msg.text}
            </p>
          )}
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </form>
      </div>
    </div>
  );
}
