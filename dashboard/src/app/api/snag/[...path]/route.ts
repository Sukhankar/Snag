import type { NextRequest } from 'next/server';
import { apiBase, SESSION_COOKIE } from '@/lib/session';

// Backend-for-frontend proxy to the Go admin API.
//  * The browser holds the session token only in an httpOnly cookie; this route forwards it
//    as a bearer token. The Go server authenticates it and enforces permissions.
//  * Only allow-listed endpoints are reachable (the upstream path is never free-form).
//  * Mutations require a same-origin Origin header and a JSON body (CSRF defence on top of
//    the SameSite=Lax cookie).
//  * Responses are streamed, so the SSE endpoint passes straight through.

export const dynamic = 'force-dynamic';

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const re = (s: string) => new RegExp(`^${s.replaceAll(':id', ID)}$`);
const ALLOW: Record<string, RegExp[]> = {
  GET: ['tickets', 'tickets/:id', 'attachments/:id', 'projects', 'teams', 'stream', 'me', 'permissions', 'users', 'users/directory', 'roles', 'reports/amc'].map(re),
  POST: ['tickets/:id/(messages|broadcast)', 'projects', 'teams', 'users', 'roles', 'me/password'].map(re),
  PATCH: ['tickets/:id', 'projects/:id', 'teams/:id', 'users/:id', 'roles/:id'].map(re),
  DELETE: ['roles/:id', 'teams/:id'].map(re),
};

const json = (status: number, error: string) => Response.json({ error }, { status });

async function proxy(req: NextRequest, ctx: RouteContext<'/api/snag/[...path]'>) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return json(401, 'unauthorized');

  const path = (await ctx.params).path.join('/');
  if (!ALLOW[req.method]?.some((r) => r.test(path))) return json(404, 'not_found');

  let body: string | undefined;
  if (req.method !== 'GET') {
    const origin = req.headers.get('origin');
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    if (!origin || !host || new URL(origin).host !== host) return json(403, 'bad_origin');
    if (req.method !== 'DELETE') {
      if (!req.headers.get('content-type')?.startsWith('application/json')) return json(415, 'json_required');
      body = await req.text();
      if (body.length > 512 * 1024) return json(413, 'payload_too_large');
    }
  }

  const upstream = new URL(`/api/v1/admin/${path}`, apiBase());
  if (req.method === 'GET') upstream.search = req.nextUrl.search;

  let res: Response;
  try {
    res = await fetch(upstream, {
      method: req.method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      body,
      signal: req.signal, // closes the upstream SSE stream when the browser disconnects
      cache: 'no-store',
    });
  } catch {
    return json(502, 'snag_unreachable');
  }

  const headers = new Headers({ 'Content-Type': res.headers.get('content-type') ?? 'application/json' });
  if (path === 'stream') {
    headers.set('Cache-Control', 'no-cache, no-transform');
    headers.set('X-Accel-Buffering', 'no');
  } else {
    headers.set('Cache-Control', res.headers.get('cache-control') ?? 'no-store');
  }
  return new Response(res.status === 204 ? null : res.body, { status: res.status, headers });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
