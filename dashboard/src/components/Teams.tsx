'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client';
import type { Team } from '@/lib/types';
import { useCan } from './me';

// Teams and who is in them. A person can belong to any number of teams; a ticket's team
// decides whose names come first when assigning it.

interface Person {
  id: string;
  name: string;
  email?: string;
  active: boolean;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

export function Teams() {
  const can = useCan();
  const manage = can('teams.manage');
  const listUsers = can('users.manage');
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.teams().then(setTeams, (e) => setError(e.message));
    // Full user list (with email and inactive users) for user managers; names otherwise.
    if (listUsers) {
      api.users().then((us) => setPeople(us.map((u) => ({ id: u.id, name: u.name, email: u.email, active: u.is_active }))), () => {});
    } else {
      api.directory().then((ds) => setPeople(ds.map((d) => ({ id: d.id, name: d.name, active: true }))), () => {});
    }
  }, [listUsers]);

  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const run = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const replace = (t: Team) => setTeams((ts) => (ts ?? []).map((x) => (x.id === t.id ? t : x)));

  const q = query.trim().toLowerCase();
  const shown = (teams ?? []).filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.member_ids.some((id) => byId.get(id)?.name.toLowerCase().includes(q)),
  );
  const unteamed = people.filter((p) => p.active && !(teams ?? []).some((t) => t.member_ids.includes(p.id)));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-lg font-semibold">Teams</h1>
            <p className="text-zinc-600 dark:text-zinc-400">Group people by what they work on. One person can be in several teams.</p>
          </div>
          {manage && (
            <button className="btn-primary ml-auto" aria-expanded={creating} onClick={() => setCreating((c) => !c)}>
              {creating ? 'Cancel' : '+ New team'}
            </button>
          )}
        </header>

        {error && (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </p>
        )}

        {creating && (
          <CreateTeam
            people={people.filter((p) => p.active)}
            onCreate={(name, description, members) =>
              run(async () => {
                const t = await api.createTeam(name, description, members);
                setTeams((ts) => [...(ts ?? []), t].sort((a, b) => a.name.localeCompare(b.name)));
                setCreating(false);
              })
            }
          />
        )}

        <div className="flex flex-wrap items-center gap-3">
          <input className="input max-w-xs" type="search" placeholder="Find a team or person…" aria-label="Find a team or person" value={query} onChange={(e) => setQuery(e.target.value)} />
          {teams && (
            <span className="text-[12px] text-zinc-600 dark:text-zinc-400">
              {teams.length} {teams.length === 1 ? 'team' : 'teams'}
              {unteamed.length > 0 && ` · ${unteamed.length} active ${unteamed.length === 1 ? 'person is' : 'people are'} in no team`}
            </span>
          )}
        </div>

        {teams === null && !error && <p className="text-zinc-600 dark:text-zinc-400">Loading…</p>}
        {teams?.length === 0 && (
          <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
            No teams yet.{manage ? ' Create one to group people and route tickets.' : ''}
          </p>
        )}
        {teams && teams.length > 0 && shown.length === 0 && <p className="text-zinc-600 dark:text-zinc-400">Nothing matches “{query}”.</p>}

        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {shown.map((t) => (
            <TeamCard key={t.id} team={t} people={people} byId={byId} manage={manage} run={run} onChange={replace} onDelete={() => setTeams((ts) => (ts ?? []).filter((x) => x.id !== t.id))} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function CreateTeam({ people, onCreate }: { people: Person[]; onCreate: (name: string, description: string, members: string[]) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const f = filter.trim().toLowerCase();
  return (
    <form
      className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate(name.trim(), description.trim(), members);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="label">Team name</span>
          <input className="input" required maxLength={100} placeholder="e.g. POS Core" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="space-y-1">
          <span className="label">Description (optional)</span>
          <input className="input" maxLength={2000} placeholder="What this team looks after" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="label">Members ({members.length} selected)</legend>
        <input className="input max-w-xs" type="search" placeholder="Filter people…" aria-label="Filter people" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2">
          {people
            .filter((p) => !f || p.name.toLowerCase().includes(f) || p.email?.toLowerCase().includes(f))
            .map((p) => (
              <label key={p.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <input
                  type="checkbox"
                  checked={members.includes(p.id)}
                  onChange={(e) => setMembers((m) => (e.target.checked ? [...m, p.id] : m.filter((x) => x !== p.id)))}
                />
                <span className="truncate">{p.name}</span>
                {p.email && <span className="truncate text-[12px] text-zinc-600 dark:text-zinc-400">{p.email}</span>}
              </label>
            ))}
        </div>
      </fieldset>
      <button className="btn-primary">Create team</button>
    </form>
  );
}

function TeamCard({
  team,
  people,
  byId,
  manage,
  run,
  onChange,
  onDelete,
}: {
  team: Team;
  people: Person[];
  byId: Map<string, Person>;
  manage: boolean;
  run: (fn: () => Promise<void>) => void;
  onChange: (t: Team) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? '');
  const candidates = people.filter((p) => p.active && !team.member_ids.includes(p.id));
  const setMembers = (ids: string[]) => run(async () => onChange(await api.setTeamMembers(team.id, ids)));

  return (
    <li className="flex min-w-0 flex-col rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const patch: { name?: string; description?: string } = {};
            if (name.trim() !== team.name) patch.name = name.trim();
            if (description.trim() !== (team.description ?? '')) patch.description = description.trim();
            run(async () => {
              if (Object.keys(patch).length) onChange(await api.patchTeam(team.id, patch));
              setEditing(false);
            });
          }}
        >
          <input className="input" required maxLength={100} aria-label="Team name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <input className="input" maxLength={2000} aria-label="Description" placeholder="What this team looks after" value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn-primary">Save</button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex items-start gap-2">
          <div className="min-w-0">
            <h2 className="font-semibold">{team.name}</h2>
            {team.description && <p className="text-[13px] text-zinc-600 dark:text-zinc-400">{team.description}</p>}
          </div>
          <span className="ml-auto shrink-0 rounded bg-zinc-100 px-1.5 text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {team.member_ids.length} {team.member_ids.length === 1 ? 'member' : 'members'}
          </span>
        </div>
      )}

      <ul className="mt-3 flex-1 space-y-1" aria-label={`Members of ${team.name}`}>
        {team.member_ids.length === 0 && <li className="text-[13px] text-zinc-600 dark:text-zinc-400">No members yet.</li>}
        {team.member_ids.map((id) => {
          const p = byId.get(id);
          const label = p?.name ?? 'Inactive user';
          return (
            <li key={id} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-900">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
                {initials(label)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {label}
                {p && !p.active && <span className="ml-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">(deactivated)</span>}
                {p?.email && <span className="block truncate text-[12px] text-zinc-600 dark:text-zinc-400">{p.email}</span>}
              </span>
              {manage && (
                <button className="text-[12px] text-red-600 hover:underline" aria-label={`Remove ${label} from ${team.name}`} onClick={() => setMembers(team.member_ids.filter((x) => x !== id))}>
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {manage && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <select
            className="select min-w-0 flex-1"
            aria-label={`Add a person to ${team.name}`}
            value=""
            disabled={candidates.length === 0}
            onChange={(e) => e.target.value && setMembers([...team.member_ids, e.target.value])}
          >
            <option value="">{candidates.length ? '+ Add a person…' : 'Everyone is already in this team'}</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.email ? ` — ${p.email}` : ''}
              </option>
            ))}
          </select>
          {!editing && (
            <button className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          <button
            className="btn"
            onClick={() => {
              if (!confirm(`Delete the team "${team.name}"? Its members stay, and its tickets keep everything except the team.`)) return;
              run(async () => {
                await api.deleteTeam(team.id);
                onDelete();
              });
            }}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
}
