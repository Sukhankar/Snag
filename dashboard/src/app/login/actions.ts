'use server';

import { redirect } from 'next/navigation';
import { apiBase, clearSession, getToken, setSession } from '@/lib/session';

export interface LoginState {
  error: string | null;
  email: string; // echoed back: React resets the form after an action
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) return { error: 'Enter your email and password.', email };

  let res: Response;
  try {
    res = await fetch(`${apiBase()}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
    });
  } catch {
    return { error: 'Cannot reach the Snag server.', email };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.message || 'Sign-in failed.', email };

  await setSession(data.token, data.expires_at);
  redirect('/');
}

export async function logout(): Promise<void> {
  const token = await getToken();
  if (token) {
    await fetch(`${apiBase()}/api/v1/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }
  await clearSession();
  redirect('/login');
}
