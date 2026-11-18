'use client';

import { useActionState } from 'react';
import { login } from './actions';

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, { error: null, email: '' });
  return (
    <main className="grid min-h-dvh place-items-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <form action={action} className="w-full max-w-sm space-y-4 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <h1 className="text-lg font-semibold">Snag</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Sign in to the operations dashboard</p>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Email</span>
          <input name="email" type="email" required autoComplete="username" defaultValue={state.email} className="input" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Password</span>
          <input name="password" type="password" required autoComplete="current-password" autoFocus={!!state.email} className="input" />
        </label>
        {state.error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </p>
        )}
        <button disabled={pending} className="btn-primary w-full">
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="text-[12px] text-zinc-600 dark:text-zinc-400">No account? Ask your Snag owner or an admin to create one.</p>
      </form>
    </main>
  );
}
