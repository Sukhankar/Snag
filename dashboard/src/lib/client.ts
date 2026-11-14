import type { AMCRow, AttachmentMeta, DirectoryEntry, Message, Page, PermissionDef, Project, Role, Team, TicketDetail, TicketSummary, User } from './types';

// Browser-side API client. Everything goes through the same-origin BFF proxy at
// /api/snag/*, which attaches the admin token server-side.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const res = await fetch('/api/snag/' + path, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init?.signal,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new ApiError('Session expired', 401);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.error === 'password_change_required' && window.location.pathname !== '/account') {
    window.location.href = '/account';
    throw new ApiError(data.message, 403);
  }
  if (res.status === 204) return undefined as T;
  if (!res.ok) throw new ApiError(data.message || data.error || `Request failed (${res.status})`, res.status);
  return data as T;
}

export interface ListParams {
  cursor?: string | null;
  limit?: number;
  status?: string[];
  project_id?: string;
  scope_class?: string;
  priority?: string;
  category?: string;
  q?: string;
  top_level?: boolean;
  /** A user id, `me`, or `none` for unassigned tickets. */
  assignee_id?: string;
}

function qs(p: ListParams): string {
  const s = new URLSearchParams();
  if (p.cursor) s.set('cursor', p.cursor);
  if (p.limit) s.set('limit', String(p.limit));
  if (p.status?.length) s.set('status', p.status.join(','));
  for (const k of ['project_id', 'scope_class', 'priority', 'category', 'q', 'assignee_id'] as const) if (p[k]) s.set(k, p[k]!);
  if (p.top_level) s.set('top_level', '1');
  const out = s.toString();
  return out ? '?' + out : '';
}

export type TicketPatch = Partial<Pick<TicketSummary, 'status' | 'priority' | 'category' | 'scope_class' | 'team_id' | 'assignee_id' | 'parent_ticket_id'>>;

export interface UserPatch {
  name?: string;
  email?: string;
  role_id?: string;
  is_active?: boolean;
  password?: string;
}

export const api = {
  listTickets: (p: ListParams, signal?: AbortSignal) => call<Page<TicketSummary>>('tickets' + qs(p), { signal }),
  getTicket: (id: string, signal?: AbortSignal) => call<TicketDetail>('tickets/' + id, { signal }),
  patchTicket: (id: string, patch: TicketPatch) => call<TicketSummary>('tickets/' + id, { method: 'PATCH', body: patch }),
  postMessage: (id: string, body: string, isInternal: boolean) =>
    call<Message>(`tickets/${id}/messages`, { method: 'POST', body: { body, is_internal: isInternal } }),
  broadcast: (id: string, body: string) => call<{ delivered: number }>(`tickets/${id}/broadcast`, { method: 'POST', body: { body } }),
  attachment: (id: string) => call<AttachmentMeta & { payload_b64: string }>('attachments/' + id),
  projects: () => call<{ items: Project[] }>('projects').then((r) => r.items),
  createProject: (name: string, allowed_origins: string[]) => call<Project>('projects', { method: 'POST', body: { name, allowed_origins } }),
  patchProject: (id: string, patch: { name?: string; allowed_origins?: string[]; is_active?: boolean; rotate_key?: boolean }) =>
    call<Project>('projects/' + id, { method: 'PATCH', body: patch }),
  teams: () => call<{ items: Team[] }>('teams').then((r) => r.items),
  createTeam: (name: string, description: string) => call<Team>('teams', { method: 'POST', body: { name, description } }),
  patchTeam: (id: string, patch: { name?: string; description?: string }) => call<Team>('teams/' + id, { method: 'PATCH', body: patch }),
  deleteTeam: (id: string) => call<void>('teams/' + id, { method: 'DELETE' }),
  amcReport: (p: { from?: string; to?: string; project_id?: string }) => {
    const s = new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]);
    return call<{ from: string; to: string; items: AMCRow[] }>('reports/amc' + (s.size ? '?' + s : ''));
  },

  users: () => call<{ items: User[] }>('users').then((r) => r.items),
  directory: () => call<{ items: DirectoryEntry[] }>('users/directory').then((r) => r.items),
  createUser: (u: { name: string; email: string; role_id: string; password: string }) => call<User>('users', { method: 'POST', body: u }),
  patchUser: (id: string, patch: UserPatch) => call<User>('users/' + id, { method: 'PATCH', body: patch }),
  roles: () => call<{ items: Role[] }>('roles').then((r) => r.items),
  permissions: () => call<{ items: PermissionDef[] }>('permissions').then((r) => r.items),
  createRole: (r: { name: string; description: string; permissions: string[] }) => call<Role>('roles', { method: 'POST', body: r }),
  patchRole: (id: string, patch: { name?: string; description?: string; permissions?: string[] }) => call<Role>('roles/' + id, { method: 'PATCH', body: patch }),
  deleteRole: (id: string) => call<void>('roles/' + id, { method: 'DELETE' }),
  changePassword: (current_password: string, new_password: string) =>
    call<void>('me/password', { method: 'POST', body: { current_password, new_password } }),
};

/** A random, readable temporary password (no look-alike characters). */
export function generatePassword(length = 14): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
