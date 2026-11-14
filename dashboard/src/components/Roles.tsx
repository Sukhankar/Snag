'use client';

import { Fragment, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import type { PermissionDef, Role } from '@/lib/types';
import { useMe } from './me';

// Permission matrix: rows are permissions (grouped), columns are roles. Ticking a box saves
// immediately. The Owner column is locked, and you can only grant permissions you hold.

export function Roles() {
  const me = useMe();
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<PermissionDef[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.roles().then(setRoles, (e) => setError(e.message));
    api.permissions().then(setCatalog, (e) => setError(e.message));
  }, []);

  const mine = (k: string) => me.permissions.includes(k);
  const editableRole = (r: Role) => !r.is_system && r.permissions.every(mine);
  const groups = [...new Set(catalog.map((p) => p.group))];

  const toggle = async (role: Role, key: string) => {
    const next = role.permissions.includes(key) ? role.permissions.filter((p) => p !== key) : [...role.permissions, key];
    setRoles((rs) => rs.map((r) => (r.id === role.id ? { ...r, permissions: next } : r)));
    setSaving(role.id);
    setError('');
    try {
      const saved = await api.patchRole(role.id, { permissions: next });
      setRoles((rs) => rs.map((r) => (r.id === role.id ? saved : r)));
    } catch (e) {
      setRoles((rs) => rs.map((r) => (r.id === role.id ? role : r)));
      setError((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const remove = async (role: Role) => {
    if (!confirm(`Delete the role "${role.name}"?`)) return;
    setError('');
    try {
      await api.deleteRole(role.id);
      setRoles((rs) => rs.filter((r) => r.id !== role.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rename = async (role: Role) => {
    const name = prompt('Role name', role.name)?.trim();
    if (!name || name === role.name) return;
    setError('');
    try {
      const saved = await api.patchRole(role.id, { name });
      setRoles((rs) => rs.map((r) => (r.id === role.id ? saved : r)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <header className="flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-lg font-semibold">Roles &amp; permissions</h1>
            <p className="text-zinc-500">Tick a box to grant a permission to everyone in that role. Changes apply immediately, even to people already signed in.</p>
          </div>
          <button className="btn-primary ml-auto" onClick={() => setCreating((c) => !c)} aria-expanded={creating}>
            {creating ? 'Cancel' : '+ New role'}
          </button>
        </header>

        {error && (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </p>
        )}

        {creating && (
          <CreateRole
            roles={roles}
            canGrant={(perms) => perms.every(mine)}
            onCreated={(r) => {
              setRoles((rs) => [...rs, r]);
              setCreating(false);
            }}
            onError={setError}
          />
        )}

        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-900">
                <th className="sticky left-0 z-10 min-w-[260px] bg-zinc-50 px-3 py-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:bg-zinc-900">
                  Permission
                </th>
                {roles.map((r) => (
                  <th key={r.id} className="min-w-[120px] border-l border-zinc-200 px-2 py-2 text-center align-top dark:border-zinc-800">
                    <div className="text-[13px] font-semibold">
                      {r.is_system && '👑 '}
                      {r.name}
                    </div>
                    <div className="text-[11px] font-normal text-zinc-500">
                      {r.user_count} {r.user_count === 1 ? 'user' : 'users'}
                      {saving === r.id && ' · saving…'}
                    </div>
                    {editableRole(r) && (
                      <div className="mt-1 flex justify-center gap-2 text-[11px] font-normal">
                        <button className="text-indigo-600 hover:underline" onClick={() => rename(r)}>
                          Rename
                        </button>
                        <button
                          className="text-red-600 hover:underline disabled:cursor-not-allowed disabled:text-zinc-400 disabled:no-underline"
                          disabled={r.user_count > 0}
                          title={r.user_count > 0 ? 'Move its users to another role first' : 'Delete role'}
                          onClick={() => remove(r)}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g}>
                  <tr>
                    <td colSpan={roles.length + 1} className="bg-zinc-100/70 px-3 py-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:bg-zinc-800/50">
                      <span className="sticky left-3">{g}</span>
                    </td>
                  </tr>
                  {catalog
                    .filter((p) => p.group === g)
                    .map((p) => (
                      <tr key={p.key} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className="sticky left-0 z-10 bg-white px-3 py-2 dark:bg-zinc-950">
                          <div className="font-medium">{p.label}</div>
                          <div className="text-[11px] text-zinc-500">{p.description}</div>
                        </td>
                        {roles.map((r) => {
                          const on = r.is_system || r.permissions.includes(p.key);
                          const locked = !editableRole(r) || !mine(p.key);
                          return (
                            <td key={r.id} className="border-l border-zinc-100 text-center dark:border-zinc-800">
                              <input
                                type="checkbox"
                                className="size-4 accent-indigo-600 disabled:opacity-50"
                                checked={on}
                                disabled={locked || saving === r.id}
                                aria-label={`${p.label} for ${r.name}`}
                                title={r.is_system ? 'The Owner always has every permission' : locked ? "You can't change this" : undefined}
                                onChange={() => toggle(r, p.key)}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[12px] text-zinc-500">
          The 👑 Owner role belongs to the ultimate user and always has every permission. You can only grant permissions you have yourself.
        </p>
      </div>
    </div>
  );
}

function CreateRole({ roles, canGrant, onCreated, onError }: { roles: Role[]; canGrant: (p: string[]) => boolean; onCreated: (r: Role) => void; onError: (m: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const sources = roles.filter((r) => !r.is_system && canGrant(r.permissions));

  return (
    <form
      className="grid gap-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-4 sm:grid-cols-[1fr_1.5fr_1fr_auto] sm:items-end dark:border-indigo-500/30 dark:bg-indigo-500/5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        onError('');
        try {
          const perms = roles.find((r) => r.id === copyFrom)?.permissions ?? ['tickets.view'];
          onCreated(await api.createRole({ name: name.trim(), description: description.trim(), permissions: perms }));
        } catch (err) {
          onError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="space-y-1">
        <span className="label">Role name</span>
        <input className="input" required maxLength={60} placeholder="e.g. QA Tester" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="space-y-1">
        <span className="label">Description</span>
        <input className="input" maxLength={500} placeholder="What this role is for" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="space-y-1">
        <span className="label">Start from</span>
        <select className="select w-full py-1.5" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
          <option value="">View tickets only</option>
          {sources.map((r) => (
            <option key={r.id} value={r.id}>
              Copy of {r.name}
            </option>
          ))}
        </select>
      </label>
      <button className="btn-primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create role'}
      </button>
    </form>
  );
}
