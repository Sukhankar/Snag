'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { logout } from '@/app/login/actions';
import type { Me } from '@/lib/types';
import { MeProvider } from './me';
import { StreamProvider, useStreamStatus } from './stream';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  perms: string[]; // shown when the user holds any of these
}

const NAV: NavItem[] = [
  { href: '/', label: 'Inbox', icon: 'M3 13h4l2 3h6l2-3h4M5 5h14l2 8v6H3v-6z', perms: ['tickets.view'] },
  { href: '/board', label: 'Board', icon: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z', perms: ['tickets.view'] },
  { href: '/projects', label: 'Projects', icon: 'M3 7h7l2 2h9v10H3zM3 7V5h7', perms: ['projects.view'] },
  { href: '/users', label: 'Users', icon: 'M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 10a3 3 0 100-6 3 3 0 000 6zM22 19v-1a4 4 0 00-3-3.9M16 4.1a3 3 0 010 5.8', perms: ['users.manage'] },
  { href: '/reports', label: 'Reports', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2', perms: ['tickets.view'] },
  { href: '/roles', label: 'Roles', icon: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z M9 12l2 2 4-4', perms: ['roles.manage'] },
];

function LiveDot() {
  const live = useStreamStatus();
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400" title={live ? 'Live updates connected' : 'Reconnecting…'}>
      <span className={`size-1.5 rounded-full ${live ? 'bg-emerald-500' : 'animate-pulse bg-amber-500'}`} />
      {live ? 'Live' : 'Offline'}
    </span>
  );
}

export function Shell({ me, children }: { me: Me; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const locked = me.must_change_password; // temporary password: only My account until it is changed
  const nav = locked ? [] : NAV.filter((n) => n.perms.some((p) => me.permissions.includes(p)));
  const canStream = !locked && me.permissions.includes('tickets.view');

  useEffect(() => {
    if (locked && path !== '/account') router.replace('/account');
  }, [locked, path, router]);

  const body = (
    <div className="flex h-dvh flex-col md:flex-row">
      <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-200 bg-zinc-50 px-2 py-1.5 md:w-48 md:flex-col md:items-stretch md:border-r md:border-b-0 md:px-2 md:py-3 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="mr-2 px-2 font-semibold tracking-tight text-indigo-600 dark:text-indigo-400 md:mr-0 md:mb-3">Snag</div>
        {nav.map((n) => {
          const active = n.href === '/' ? path === '/' : path.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active ? 'page' : undefined}
              className={`flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${active ? 'bg-white font-medium shadow-sm dark:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/60'}`}
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d={n.icon} />
              </svg>
              {n.label}
            </Link>
          );
        })}
        <div className="ml-auto flex shrink-0 items-center gap-3 px-2 md:mt-auto md:ml-0 md:flex-col md:items-start md:gap-1.5">
          {canStream && <LiveDot />}
          <Link href="/account" className="hidden min-w-0 rounded-md py-1 text-left hover:text-indigo-600 md:block" title="My account">
            <span className="block truncate text-[12px] font-medium">
              {me.is_owner && <span title="Owner — full access">👑 </span>}
              {me.name}
            </span>
            <span className="block truncate text-[11px] text-zinc-600 dark:text-zinc-400">{me.is_owner ? 'Owner' : me.role_name}</span>
          </Link>
          <Link href="/account" className="text-[12px] text-zinc-600 dark:text-zinc-400 md:hidden">
            Account
          </Link>
          <form action={logout}>
            <button className="text-[12px] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100">Sign out</button>
          </form>
        </div>
      </nav>
      <main className="min-h-0 min-w-0 flex-1">{children}</main>
    </div>
  );

  return <MeProvider me={me}>{canStream ? <StreamProvider>{body}</StreamProvider> : body}</MeProvider>;
}
