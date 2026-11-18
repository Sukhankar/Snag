'use client';

import { Fragment, useEffect, useState } from 'react';
import { api, generatePassword } from '@/lib/client';
import { relTime } from '@/lib/format';
import type { Role, Team, User } from '@/lib/types';
import { useMe } from './me';

// User management. Mirrors the server's rules so the UI only offers what will succeed:
// the owner is untouchable by others, you can only assign roles whose permissions you hold,
// and you can't deactivate yourself.

const subset = (perms: string[], of: string[]) => perms.every((p) => of.includes(p));

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function Users() {
  const me = useMe();
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<{ title: string; email: string; password: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editingTeams, setEditingTeams] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const manageTeams = me.permissions.includes('teams.manage');

  useEffect(() => {
    api.users().then(setUsers, (e) => setError(e.message));
    api.roles().then(setRoles, (e) => setError(e.message));
    api.teams().then(setTeams, () => {});
  }, []);
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name;

  const assignable = roles.filter((r) => !r.is_system && subset(r.permissions, me.permissions));
  const canEdit = (u: User) => (u.is_owner ? me.is_owner : subset(u.permissions, me.permissions));

  const replace = (u: User) => setUsers((us) => us.map((x) => (x.id === u.id ? u : x)));
  const run = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const resetPassword = (u: User) =>
    run(async () => {
      if (!confirm(`Reset the password for ${u.name}? They will be signed out everywhere.`)) return;
      const password = generatePassword();
      replace(await api.patchUser(u.id, { password }));
      setCredentials({ title: `New password for ${u.name}`, email: u.email, password });
    });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-lg font-semibold">Users</h1>
            <p className="text-zinc-600 dark:text-zinc-400">Everyone who can sign in to Snag. What each person can do comes from their role.</p>
          </div>
          <button className="btn-primary ml-auto" onClick={() => setCreating((c) => !c)} aria-expanded={creating}>
            {creating ? 'Cancel' : '+ New user'}
          </button>
        </header>

        {error && (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </p>
        )}

        {credentials && <CredentialsCard {...credentials} onClose={() => setCredentials(null)} />}

        {creating && (
          <CreateUser
            roles={assignable}
            teams={manageTeams ? teams : []}
            onCreated={(u, password) => {
              setUsers((us) => [...us, u]);
              setCreating(false);
              setCredentials({ title: `${u.name} can now sign in`, email: u.email, password });
            }}
            onError={setError}
          />
        )}

        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left">
            <thead className="bg-zinc-50 text-[11px] tracking-wide text-zinc-600 dark:text-zinc-400 uppercase dark:bg-zinc-900">
              <tr>
                <th className="px-3 py-2 font-semibold">User</th>
                <th className="px-3 py-2 font-semibold">Role</th>
                <th className="px-3 py-2 font-semibold">Teams</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Last sign-in</th>
                <th className="px-3 py-2 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {users.map((u) => {
                const editable = canEdit(u);
                const self = u.id === me.id;
                return (
                  <Fragment key={u.id}>
                  <tr className={u.is_active ? '' : 'bg-zinc-50 dark:bg-zinc-900'}>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className={`grid size-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${u.is_owner ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300' : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'}`}>
                          {initials(u.name)}
                        </span>
                        <div className="min-w-0">
                          <div className="font-medium">
                            {u.name}
                            {self && <span className="ml-1.5 text-[11px] font-normal text-zinc-600 dark:text-zinc-400">(you)</span>}
                          </div>
                          <div className="truncate text-[12px] text-zinc-600 dark:text-zinc-400">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {u.is_owner ? (
                        <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-[12px] font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30" title="The ultimate user: full access, cannot be restricted or deactivated">
                          👑 Owner · full access
                        </span>
                      ) : editable ? (
                        <select
                          aria-label={`Role for ${u.name}`}
                          className="select"
                          value={u.role_id}
                          onChange={(e) => run(async () => replace(await api.patchUser(u.id, { role_id: e.target.value })))}
                        >
                          {!assignable.some((r) => r.id === u.role_id) && <option value={u.role_id}>{u.role_name}</option>}
                          {assignable.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-zinc-600 dark:text-zinc-400" title="This user has permissions you don't have">
                          {u.role_name}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex max-w-[16rem] flex-wrap items-center gap-1">
                        {(u.team_ids ?? []).map((id) => teamName(id) && (
                          <span key={id} className="rounded bg-zinc-100 px-1.5 py-px text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                            {teamName(id)}
                          </span>
                        ))}
                        {!(u.team_ids ?? []).length && <span className="text-[12px] text-zinc-600 dark:text-zinc-400">None</span>}
                        {manageTeams && teams.length > 0 && (
                          <button
                            className="text-[12px] text-indigo-600 hover:underline dark:text-indigo-400"
                            aria-label={`Change teams for ${u.name}`}
                            aria-expanded={editingTeams === u.id}
                            onClick={() => setEditingTeams((x) => (x === u.id ? null : u.id))}
                          >
                            Change
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`rounded px-1.5 py-px text-[11px] font-medium ${u.is_active ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700/50 dark:text-zinc-300'}`}
                      >
                        {u.is_active ? 'Active' : 'Deactivated'}
                      </span>
                      {u.must_change_password && u.is_active && (
                        <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-px text-[11px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" title="Signs in with a temporary password and must choose a new one">
                          Temporary password
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-zinc-600 dark:text-zinc-400">{u.last_login_at ? relTime(u.last_login_at) + ' ago' : 'Never'}</td>
                    <td className="px-3 py-2.5">
                      {editable && (
                        <div className="flex justify-end gap-1.5">
                          <button className="btn" aria-expanded={editing === u.id} onClick={() => setEditing((x) => (x === u.id ? null : u.id))}>
                            Edit
                          </button>
                          {!self && (
                            <button className="btn" onClick={() => resetPassword(u)}>
                              Reset password
                            </button>
                          )}
                          {!u.is_owner && !self && (
                            <button
                              className="btn"
                              onClick={() =>
                                run(async () => {
                                  if (u.is_active && !confirm(`Deactivate ${u.name}? They are signed out immediately and can't sign in.`)) return;
                                  replace(await api.patchUser(u.id, { is_active: !u.is_active }));
                                })
                              }
                            >
                              {u.is_active ? 'Deactivate' : 'Reactivate'}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                  {editingTeams === u.id && (
                    <tr>
                      <td colSpan={6} className="bg-zinc-50 px-3 py-3 dark:bg-zinc-900/60">
                        <TeamPicker
                          teams={teams}
                          initial={u.team_ids ?? []}
                          label={`Teams for ${u.name}`}
                          onCancel={() => setEditingTeams(null)}
                          onSave={(ids) =>
                            run(async () => {
                              const r = await api.setUserTeams(u.id, ids);
                              replace({ ...u, team_ids: r.team_ids });
                              setEditingTeams(null);
                            })
                          }
                        />
                      </td>
                    </tr>
                  )}
                  {editing === u.id && (
                    <tr>
                      <td colSpan={6} className="bg-zinc-50 px-3 py-3 dark:bg-zinc-900/60">
                        <EditUser
                          user={u}
                          onCancel={() => setEditing(null)}
                          onSave={(patch) =>
                            run(async () => {
                              replace(await api.patchUser(u.id, patch));
                              setEditing(null);
                            })
                          }
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[12px] text-zinc-600 dark:text-zinc-400">
          Deactivated users keep their history (replies and notes stay attributed) but can&apos;t sign in. Manage what each role can do on the{' '}
          {me.permissions.includes('roles.manage') ? (
            <a className="text-indigo-600 dark:text-indigo-400 hover:underline" href="/roles">
              Roles
            </a>
          ) : (
            'Roles'
          )}{' '}
          page.
        </p>
      </div>
    </div>
  );
}

function TeamPicker({ teams, initial, label, onSave, onCancel }: { teams: Team[]; initial: string[]; label: string; onSave: (ids: string[]) => void; onCancel: () => void }) {
  const [ids, setIds] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(ids);
      }}
    >
      <fieldset className="space-y-2">
        <legend className="label">{label}</legend>
        <TeamChecks teams={teams} ids={ids} setIds={setIds} />
      </fieldset>
      <div className="mt-2 flex gap-2">
        <button className="btn-primary">Save teams</button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function TeamChecks({ teams, ids, setIds }: { teams: Team[]; ids: string[]; setIds: (f: (ids: string[]) => string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {teams.map((t) => (
        <label key={t.id} className="flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" checked={ids.includes(t.id)} onChange={(e) => setIds((x) => (e.target.checked ? [...x, t.id] : x.filter((y) => y !== t.id)))} />
          {t.name}
        </label>
      ))}
    </div>
  );
}

function CreateUser({ roles, teams, onCreated, onError }: { roles: Role[]; teams: Team[]; onCreated: (u: User, password: string) => void; onError: (m: string) => void }) {
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [password, setPassword] = useState(() => generatePassword());
  const [busy, setBusy] = useState(false);
  const role = roles.find((r) => r.id === roleId);

  useEffect(() => {
    if (!roleId && roles.length) setRoleId(roles.find((r) => r.name === 'Support Agent')?.id ?? roles[roles.length - 1].id);
  }, [roles, roleId]);

  return (
    <form
      className="grid gap-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-4 sm:grid-cols-2 dark:border-indigo-500/30 dark:bg-indigo-500/5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        onError('');
        try {
          const u = await api.createUser({ name: name.trim(), email: email.trim(), role_id: roleId, password });
          if (teamIds.length) u.team_ids = (await api.setUserTeams(u.id, teamIds)).team_ids;
          onCreated(u, password);
        } catch (err) {
          onError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="space-y-1">
        <span className="label">Full name</span>
        <input className="input" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="space-y-1">
        <span className="label">Email (used to sign in)</span>
        <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="space-y-1">
        <span className="label">Role</span>
        <select className="select w-full py-1.5" required value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        {role && <span className="block text-[11px] text-zinc-600 dark:text-zinc-400">{role.description || `${role.permissions.length} permissions`}</span>}
      </label>
      <label className="space-y-1">
        <span className="label">Temporary password</span>
        <div className="flex gap-2">
          <input className="input font-mono" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="button" className="btn shrink-0" onClick={() => setPassword(generatePassword())}>
            Generate
          </button>
        </div>
        <span className="block text-[11px] text-zinc-600 dark:text-zinc-400">At least 10 characters. They can change it under My account.</span>
      </label>
      {teams.length > 0 && (
        <fieldset className="space-y-1 sm:col-span-2">
          <legend className="label">Teams (optional, any number)</legend>
          <TeamChecks teams={teams} ids={teamIds} setIds={setTeamIds} />
        </fieldset>
      )}
      <div className="sm:col-span-2">
        <button className="btn-primary" disabled={busy || !roleId}>
          {busy ? 'Creating…' : 'Create user'}
        </button>
      </div>
    </form>
  );
}

function CredentialsCard({ title, email, password, onClose }: { title: string; email: string; password: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `Snag sign-in\nURL: ${typeof window !== 'undefined' ? window.location.origin : ''}\nEmail: ${email}\nTemporary password: ${password}`;
  return (
    <div role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-emerald-900 dark:text-emerald-200">{title}</p>
          <p className="mt-0.5 text-[12px] text-emerald-800 dark:text-emerald-300">Share these credentials securely — the password is not shown again. They will be asked to choose their own password when they first sign in.</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-[12px]">
            <dt className="text-zinc-600 dark:text-zinc-400">Email</dt>
            <dd>{email}</dd>
            <dt className="text-zinc-600 dark:text-zinc-400">Password</dt>
            <dd className="select-all">{password}</dd>
          </dl>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            className="btn"
            onClick={() =>
              navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function EditUser({ user, onSave, onCancel }: { user: User; onSave: (patch: { name?: string; email?: string }) => void; onCancel: () => void }) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const patch: { name?: string; email?: string } = {};
        if (name.trim() !== user.name) patch.name = name.trim();
        if (email.trim().toLowerCase() !== user.email) patch.email = email.trim();
        if (Object.keys(patch).length) onSave(patch);
        else onCancel();
      }}
    >
      <label className="space-y-1">
        <span className="label">Full name</span>
        <input className="input" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="space-y-1">
        <span className="label">Email (used to sign in)</span>
        <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <button className="btn-primary">Save</button>
      <button type="button" className="btn" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
