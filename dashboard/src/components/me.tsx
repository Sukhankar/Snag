'use client';

import { createContext, useContext } from 'react';
import type { Me } from '@/lib/types';

// The signed-in user, available to every client component. Used to hide or disable UI the
// user can't use — the Go server enforces the same permissions on every request.

const MeContext = createContext<Me | null>(null);

export function MeProvider({ me, children }: { me: Me; children: React.ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside MeProvider');
  return me;
}

/** True if the signed-in user holds `perm`. */
export function useCan(): (perm: string) => boolean {
  const me = useMe();
  return (perm) => me.permissions.includes(perm);
}

export function NoAccess({ what }: { what: string }) {
  return (
    <div className="m-auto max-w-sm p-10 text-center text-zinc-600 dark:text-zinc-400">
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">You don&apos;t have access to {what}.</p>
      <p className="mt-1 text-[12px]">Ask the owner or an admin to add the permission to your role.</p>
    </div>
  );
}
