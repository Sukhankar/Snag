import 'server-only';
import { cookies } from 'next/headers';
import { cache } from 'react';
import type { Me } from './types';

// The session cookie holds an opaque token issued by the Go server, which stores only its
// hash and checks it (plus the user's permissions) on every request. Sign-out, password
// changes and deactivation revoke it server-side.

export const SESSION_COOKIE = 'snag_session';

export function apiBase(): string {
  const base = process.env.SNAG_API_URL;
  if (!base) throw new Error('SNAG_API_URL must be set');
  return base;
}

export async function getToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function setSession(token: string, expiresAt: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== 'false',
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** The signed-in user with their effective permissions, or null. Cached per request. */
export const getMe = cache(async (): Promise<Me | null> => {
  const token = await getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${apiBase()}/api/v1/admin/me`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    return res.ok ? ((await res.json()) as Me) : null;
  } catch {
    return null;
  }
});
