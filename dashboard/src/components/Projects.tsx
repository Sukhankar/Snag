'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import type { Project, Team } from '@/lib/types';
import { useCan } from './me';

// Tenant management: project keys, CORS origin whitelist, embed snippet, teams.

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
  const [teams, setTeams] = useState<Team[]>([]);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  const [teamName, setTeamName] = useState('');
  const [apiUrl, setApiUrl] = useState('https://snag.example.com');
  const can = useCan();
  const manage = can('projects.manage');

  useEffect(() => {
    api.projects().then(setProjects, (e) => setError(e.message));
    api.teams().then(setTeams, () => {});
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
          <p className="text-zinc-500">Each client deployment gets a project key. Widget requests are accepted only from its whitelisted origins.</p>
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

        <label className="flex items-center gap-2 text-[12px] text-zinc-500">
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

        <section className="space-y-3">
          <h2 className="font-semibold">Teams</h2>
          <ul className="flex flex-wrap gap-2">
            {teams.map((t) => (
              <li key={t.id} className="rounded-md border border-zinc-200 px-2.5 py-1 dark:border-zinc-800">
                {t.name}
              </li>
            ))}
            {teams.length === 0 && <li className="text-zinc-500">No teams yet.</li>}
          </ul>
          {can('teams.manage') && (
          <form
            className="flex max-w-sm gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const t = await api.createTeam(teamName.trim(), '');
                setTeams((ts) => [...ts, t]);
                setTeamName('');
              });
            }}
          >
            <input className="input" required placeholder="e.g. POS Core" value={teamName} onChange={(e) => setTeamName(e.target.value)} aria-label="Team name" />
            <button className="btn shrink-0">Add team</button>
          </form>
          )}
        </section>
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
    <li className={`rounded-lg border border-zinc-200 p-4 dark:border-zinc-800 ${p.is_active ? '' : 'opacity-60'}`}>
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
          <pre className="overflow-x-auto rounded bg-zinc-950 p-2 font-mono text-[11px] text-zinc-200">{snippet(p, apiUrl)}</pre>
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
    </li>
  );
}
