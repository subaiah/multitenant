/** Platform roles: the list (with custom roles) and a dialog to set a person's roles. */
import { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { apiDelete, apiPost, apiPut } from '../lib/api-client';
import { Card, inputClass, primaryButtonClass, secondaryButtonClass } from './ui';

export interface PlatformRole {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  holders: number;
}
export interface RoleCatalog {
  roles: PlatformRole[];
  permissions: { name: string; description: string }[];
}

export function PlatformRolesCard({ catalog, canManage, onChange }: { catalog: RoleCatalog; canManage: boolean; onChange: () => void }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async (r: PlatformRole) => {
    if (!window.confirm(`Delete the ${r.name} role? ${r.holders} ${r.holders === 1 ? 'person loses' : 'people lose'} it.`)) return;
    setError(null);
    try {
      await apiDelete(`/platform-roles/${r.id}`);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete');
    }
  };
  return (
    <Card
      title="Platform roles"
      description="What platform staff can do beyond their user type. Platform roles never include tenant data: that needs a support session."
      actions={canManage && <button className={secondaryButtonClass} onClick={() => setCreating(true)}><Plus size={14} />New role</button>}
    >
      {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
      {creating && <NewRole catalog={catalog} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); onChange(); }} />}
      <ul className="divide-y divide-slate-100 dark:divide-slate-700">
        {catalog.roles.map((r) => (
          <li key={r.id} className="py-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-slate-800 dark:text-white">
                {r.name} {r.isSystem && <span className="ml-1 text-xs font-normal text-slate-400">built-in</span>}
                <span className="ml-2 text-xs font-normal text-slate-400">{r.holders} {r.holders === 1 ? 'person' : 'people'}</span>
              </p>
              {r.description && <p className="text-xs text-slate-500">{r.description}</p>}
              <div className="mt-1 flex flex-wrap gap-1">
                {r.permissions.map((p) => <span key={p} className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-[11px] font-mono text-slate-600 dark:text-slate-300">{p}</span>)}
              </div>
            </div>
            {canManage && !r.isSystem && (
              <button aria-label={`Delete ${r.name}`} className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10" onClick={() => void remove(r)}>
                <Trash2 size={16} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function NewRole({ catalog, onClose, onSaved }: { catalog: RoleCatalog; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await apiPost('/platform-roles', { name, description: description || undefined, permissions });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the role');
    }
  };
  return (
    <form onSubmit={save} className="mb-4 p-4 rounded-lg border border-slate-200 dark:border-slate-700 space-y-3">
      <div className="grid sm:grid-cols-2 gap-3">
        <input aria-label="Role name" required minLength={2} placeholder="Role name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        <input aria-label="Description" placeholder="What it's for" value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-1">
        {catalog.permissions.map((p) => (
          <label key={p.name} className="flex items-start gap-2 text-xs" title={p.description}>
            <input type="checkbox" checked={permissions.includes(p.name)} onChange={(e) => setPermissions(e.target.checked ? [...permissions, p.name] : permissions.filter((x) => x !== p.name))} />
            <span><span className="font-mono">{p.name}</span><br /><span className="text-slate-400">{p.description}</span></span>
          </label>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className={primaryButtonClass} disabled={!name || permissions.length === 0}>Create role</button>
        <button type="button" className={secondaryButtonClass} onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

export function UserRolesDialog({ user, catalog, onClose, onSaved }: {
  user: { id: string; email: string; roles: { id: string; name: string }[] };
  catalog: RoleCatalog;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(user.roles.map((r) => r.id));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPut(`/platform-roles/users/${user.id}`, { roleIds: selected });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      setSaving(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div role="dialog" aria-label={`Platform roles for ${user.email}`} onClick={(e) => e.stopPropagation()} className="w-full max-w-lg bg-white dark:bg-slate-800 rounded-lg p-6 space-y-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800 dark:text-white">Platform roles for {user.email}</h3>
          <button aria-label="Close" onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700"><X size={18} /></button>
        </div>
        <ul className="space-y-2 max-h-80 overflow-y-auto">
          {catalog.roles.map((r) => (
            <li key={r.id}>
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" className="mt-1" checked={selected.includes(r.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, r.id] : selected.filter((x) => x !== r.id))} />
                <span><span className="font-medium text-slate-800 dark:text-white">{r.name}</span><br /><span className="text-xs text-slate-500">{r.description}</span></span>
              </label>
            </li>
          ))}
        </ul>
        <p className="text-xs text-slate-500">You can only give or take away roles whose permissions you hold yourself.</p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className={secondaryButtonClass} onClick={onClose}>Cancel</button>
          <button className={primaryButtonClass} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
