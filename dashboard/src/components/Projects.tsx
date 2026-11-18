'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import type { Project } from '@/lib/types';
import { useCan } from './me';

// Tenant management: project keys, CORS origin whitelist, embed snippet, signed reporters.

const parseOrigins = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

function snippet(p: Project, apiUrl: string) {
  return `<script src="${apiUrl}/widget.min.js"
        data-project-key="${p.project_key}"
        data-app-version="YOUR_APP_VERSION"
        async></script>`;
}

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  const [apiUrl, setApiUrl] = useState('https://snag.example.com');
  const can = useCan();
  const manage = can('projects.manage');

  useEffect(() => {
    api.projects().then(setProjects, (e) => setError(e.message));
    setApiUrl(localStorage.getItem('snag:apiUrl') || 'https://snag.example.com');
  }, []);

  const replace = (p: Project) => setProjects((ps) => ps.map((x) => (x.id === p.id ? p : x)));
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 p-6">
        <header>
          <h1 className="text-lg font-semibold">Projects</h1>
          <p className="text-zinc-600 dark:text-zinc-400">Each client deployment gets a project key. Widget requests are accepted only from its whitelisted origins.</p>
        </header>

        {error && (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </p>
        )}

        {manage && (
        <form
          className="grid gap-3 rounded-lg border border-zinc-200 p-4 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end dark:border-zinc-800"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const p = await api.createProject(name.trim(), parseOrigins(origins));
              setProjects((ps) => [...ps, p].sort((a, b) => a.name.localeCompare(b.name)));
              setName('');
              setOrigins('');
            });
          }}
        >
          <label className="space-y-1">
            <span className="label">New project</span>
            <input className="input" required placeholder="Acme POS" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="label">Allowed origins</span>
            <input className="input" required placeholder="https://pos.acme.com, https://*.acme.com" value={origins} onChange={(e) => setOrigins(e.target.value)} />
          </label>
          <button className="btn-primary">Create</button>
        </form>
        )}

        <label className="flex items-center gap-2 text-[12px] text-zinc-600 dark:text-zinc-400">
          Snag API URL for snippets
          <input
            className="input max-w-xs"
            value={apiUrl}
            onChange={(e) => {
              setApiUrl(e.target.value);
              localStorage.setItem('snag:apiUrl', e.target.value);
            }}
          />
        </label>

        <ul className="space-y-4">
          {projects.map((p) => (
            <ProjectCard key={p.id + p.project_key} p={p} apiUrl={apiUrl} manage={manage} onChange={replace} run={run} />
          ))}
        </ul>

        <p className="text-[12px] text-zinc-600 dark:text-zinc-400">
          Teams and their members are managed on the{' '}
          <a className="text-indigo-600 hover:underline dark:text-indigo-400" href="/teams">
            Teams
          </a>{' '}
          page.
        </p>
      </div>
    </div>
  );
}

function ProjectCard({ p, apiUrl, manage, onChange, run }: { p: Project; apiUrl: string; manage: boolean; onChange: (p: Project) => void; run: (fn: () => Promise<unknown>) => void }) {
  const [origins, setOrigins] = useState(p.allowed_origins.join('\n'));
  const [copied, setCopied] = useState('');
  const dirty = origins.trim() !== p.allowed_origins.join('\n');

  const copy = (label: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 1500);
    });
  };

  return (
    <li className={`rounded-lg border border-zinc-200 p-4 dark:border-zinc-800 ${p.is_active ? '' : 'bg-zinc-50 dark:bg-zinc-900'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{p.name}</h3>
        {!p.is_active && <span className="rounded bg-zinc-200 px-1.5 text-[11px] dark:bg-zinc-800">Disabled</span>}
        <div className={manage ? 'ml-auto flex gap-2' : 'hidden'}>
          <button className="btn" onClick={() => run(async () => onChange(await api.patchProject(p.id, { is_active: !p.is_active })))}>
            {p.is_active ? 'Disable' : 'Enable'}
          </button>
          <button
            className="btn"
            onClick={() => {
              if (confirm(`Rotate the key for ${p.name}? Every deployed widget using the old key stops working until updated.`))
                run(async () => onChange(await api.patchProject(p.id, { rotate_key: true })));
            }}
          >
            Rotate key
          </button>
        </div>
      </div>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <span className="label">Project key</span>
          <div className="flex gap-2">
            <code className="flex-1 truncate rounded bg-zinc-100 px-2 py-1.5 font-mono text-[12px] dark:bg-zinc-900">{p.project_key}</code>
            <button className="btn" onClick={() => copy('key', p.project_key)}>
              {copied === 'key' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <span className="label mt-3 block">Embed snippet</span>
          <pre tabIndex={0} aria-label="Widget installation snippet" className="overflow-x-auto rounded bg-zinc-950 p-2 font-mono text-[11px] text-zinc-200">{snippet(p, apiUrl)}</pre>
          <button className="btn" onClick={() => copy('snippet', snippet(p, apiUrl))}>
            {copied === 'snippet' ? 'Copied' : 'Copy snippet'}
          </button>
        </div>
        <label className="space-y-1">
          <span className="label">Allowed origins (one per line)</span>
          <textarea className="input min-h-[110px] font-mono text-[12px]" readOnly={!manage} value={origins} onChange={(e) => setOrigins(e.target.value)} />
          <button className={manage ? 'btn' : 'hidden'} disabled={!dirty} onClick={() => run(async () => onChange(await api.patchProject(p.id, { allowed_origins: parseOrigins(origins) })))}>
            Save origins
          </button>
        </label>
      </div>
      <Identity p={p} manage={manage} onChange={onChange} run={run} />
    </li>
  );
}

// Signed reporter identities: the host app's server signs its user id with this secret, so a
// reporter keeps their tickets across browsers, devices and cleared data. The secret is shown
// once, right after it is generated, and must only ever live in the host app's server env.
function Identity({ p, manage, onChange, run }: { p: Project; manage: boolean; onChange: (p: Project) => void; run: (fn: () => Promise<unknown>) => void }) {
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);

  const rotate = () => {
    const ask = p.identity_enabled
      ? `Rotate the identity secret for ${p.name}? The current secret stops working immediately: signed-in reporters get an error until the app's server has the new secret.`
      : `Turn on signed reporters for ${p.name}? You will see the secret once.`;
    if (!confirm(ask)) return;
    run(async () => {
      const r = await api.rotateIdentity(p.id);
      setSecret(r.secret);
      onChange(r.project);
    });
  };

  return (
    <section className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800" aria-label={`Signed reporters for ${p.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="label">Signed reporters</span>
        <span className={`rounded px-1.5 text-[11px] ${p.identity_enabled ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-zinc-200 dark:bg-zinc-800'}`}>
          {p.identity_enabled ? (p.identity_required ? 'On · required' : 'On') : 'Off'}
        </span>
        {p.identity_rotated_at && <span className="text-[12px] text-zinc-600 dark:text-zinc-400">secret from {new Date(p.identity_rotated_at).toLocaleString()}</span>}
        <div className={manage ? 'ml-auto flex flex-wrap gap-2' : 'hidden'}>
          <button className="btn" onClick={rotate}>
            {p.identity_enabled ? 'Rotate secret' : 'Generate secret'}
          </button>
          {p.identity_enabled && (
            <>
              <button
                className="btn"
                aria-pressed={p.identity_required}
                onClick={() => {
                  if (!p.identity_required && !confirm('Require signed reporters? People who are not signed in to the app (login screens, public pages) can no longer send reports.')) return;
                  run(async () => onChange(await api.patchProject(p.id, { identity_required: !p.identity_required })));
                }}
              >
                {p.identity_required ? 'Allow anonymous' : 'Require signed'}
              </button>
              <button
                className="btn"
                onClick={() => {
                  if (confirm(`Turn off signed reporters for ${p.name}? The secret is destroyed; reporters fall back to per-browser tickets.`)) {
                    setSecret('');
                    run(async () => onChange(await api.disableIdentity(p.id)));
                  }
                }}
              >
                Turn off
              </button>
            </>
          )}
        </div>
      </div>
      <p className="mt-1 text-[12px] text-zinc-600 dark:text-zinc-400">
        {p.identity_enabled
          ? "Reporters signed by the app's server keep their tickets on any browser or device. Anonymous browser tokens " + (p.identity_required ? 'are refused.' : 'still work for people who are not signed in.')
          : 'Off: tickets are tied to the browser that sent them. Turn on to tie them to the signed-in user of the app.'}
      </p>
      {secret && (
        <div role="alert" className="mt-2 space-y-2 rounded border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
          <p className="font-medium text-amber-900 dark:text-amber-200">Copy this secret now. It will not be shown again.</p>
          <div className="flex gap-2">
            <code className="flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-[12px] dark:bg-zinc-950">{secret}</code>
            <button
              className="btn"
              onClick={() =>
                navigator.clipboard.writeText(secret).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-[12px] text-amber-900 dark:text-amber-200">
            Put it in the app&apos;s <strong>server</strong> environment (for example SNAG_IDENTITY_SECRET). Never in browser code, a NEXT_PUBLIC_ variable, a repository or a chat.
          </p>
          <button className="btn" onClick={() => setSecret('')}>
            I have stored it
          </button>
        </div>
      )}
    </section>
  );
}
