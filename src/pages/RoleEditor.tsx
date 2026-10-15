import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Check, Copy, Lock, MailCheck, Search, Trash2, User as UserIcon, Users as UsersIcon } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { apiDelete, apiPatch, apiPost } from '../lib/api-client';
import { rolePermissions, type Role } from '../lib/access';
import { Badge, ErrorState, LoadingState, inputClass, primaryButtonClass, secondaryButtonClass } from '../components/ui';

interface CatalogResource {
  resource: string;
  label: string;
  description: string;
  permissions: { name: string; action: string; description: string }[];
}
interface Holder { id: string; roleId: string; principalType: 'USER' | 'GROUP'; principalName: string; principalDetail: string | null; groupId: string | null; state: string }

const ACTION_ORDER = ['view', 'read', 'create', 'update', 'assign', 'approve', 'delete', 'manage'];
const actionLabel = (a: string) => a.charAt(0).toUpperCase() + a.slice(1);

export default function RoleEditor() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const from = params.get('from');
  const isNew = !id;
  const catalog = useApi<{ resources: CatalogResource[] }>('/roles/catalog');
  const source = useApi<Role>(id ? `/roles/${id}` : from ? `/roles/${from}` : null);
  const allRoles = useApi<{ roles: Role[] }>(isNew ? '/roles' : null);
  const holders = useApi<{ assignments: Holder[] }>(id ? '/roles/assignments' : null);

  if (catalog.error) return <div className="p-6"><ErrorState error={catalog.error} onRetry={catalog.reload} /></div>;
  if (source.error) return <div className="p-6"><ErrorState error={source.error} onRetry={source.reload} /></div>;
  if (!catalog.data || ((id || from) && !source.data)) return <LoadingState />;

  return (
    <Editor
      key={`${id ?? 'new'}:${from ?? ''}`}
      role={id ? source.data! : null}
      template={!id && source.data ? source.data : null}
      catalog={catalog.data.resources}
      roles={allRoles.data?.roles ?? []}
      holders={(holders.data?.assignments ?? []).filter((a) => a.roleId === id)}
      onSaved={source.reload}
    />
  );
}

function Editor({ role, template, catalog, roles, holders, onSaved }: {
  role: Role | null;
  template: Role | null;
  catalog: CatalogResource[];
  roles: Role[];
  holders: Holder[];
  onSaved: () => Promise<void>;
}) {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const original = useMemo(() => new Set(role ? rolePermissions(role) : []), [role]);
  const [name, setName] = useState(role?.name ?? (template ? `${template.name} (copy)` : ''));
  const [description, setDescription] = useState(role?.description ?? template?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(role ? rolePermissions(role) : template ? rolePermissions(template).filter((p) => hasPermission(p)) : []));
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>((location.state as { notice?: string } | null)?.notice ?? null);

  const canManage = hasPermission('roles:manage');
  const builtIn = !!role?.isSystem;
  const editable = canManage && !builtIn;
  const known = useMemo(() => new Set(catalog.flatMap((r) => r.permissions.map((p) => p.name))), [catalog]);
  // A role that already grants more than you hold can't be changed by you (the server says the same)
  const beyondMe = role ? [...original].filter((p) => !hasPermission(p)) : [];
  const locked = editable && beyondMe.length > 0;
  const permsEditable = editable && !locked;

  const added = [...selected].filter((p) => !original.has(p));
  const removed = [...original].filter((p) => !selected.has(p));
  const dirty = !role
    || name.trim() !== role.name
    || (description.trim() || null) !== (role.description || null)
    || added.length > 0 || removed.length > 0;
  const unknown = [...selected].filter((p) => !known.has(p));
  const activeHolders = holders.filter((h) => h.state !== 'EXPIRED');

  useEffect(() => {
    if (!dirty || !editable) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, editable]);

  const toggle = (perm: string, on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    if (on) next.add(perm);
    else next.delete(perm);
    return next;
  });
  const toggleResource = (r: CatalogResource, on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    for (const p of r.permissions) if (hasPermission(p.name)) (on ? next.add(p.name) : next.delete(p.name));
    return next;
  });
  const startFrom = (roleId: string) => {
    const t = roles.find((r) => r.id === roleId);
    setSelected(new Set(t ? rolePermissions(t).filter((p) => hasPermission(p)) : []));
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    const body = { name: name.trim(), description: description.trim(), permissions: [...selected].filter((p) => known.has(p)) };
    try {
      if (role) {
        await apiPatch(`/roles/${role.id}`, permsEditable ? body : { name: body.name, description: body.description });
        await onSaved();
        setNotice(activeHolders.length ? `Saved. The change applies now to ${activeHolders.length} ${activeHolders.length === 1 ? 'holder' : 'holders'}.` : 'Saved');
      } else {
        const created = await apiPost<{ id: string }>('/roles', body);
        navigate(`/roles/${created.id}`, { replace: true, state: { notice: `${body.name} created. Assign it from Role assignments.` } });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the role');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!role || !confirm(`Delete the role ${role.name}?`)) return;
    try {
      await apiDelete(`/roles/${role.id}`);
      navigate('/role-assignments?tab=roles', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the role');
    }
  };

  const term = filter.trim().toLowerCase();
  const visible = catalog
    .map((r) => ({
      ...r,
      permissions: [...r.permissions]
        .sort((a, b) => ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action))
        .filter((p) => !term || [r.label, r.description, p.name, p.description].some((s) => s.toLowerCase().includes(term))),
    }))
    .filter((r) => r.permissions.length > 0);

  const title = role ? role.name : template ? `Duplicate ${template.name}` : 'New role';

  return (
    <form onSubmit={save} className="p-6 space-y-6">
      <div>
        <Link to="/role-assignments?tab=roles" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
          <ArrowLeft size={14} />Roles
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-800 dark:text-white">{title}</h1>
          {builtIn && <Badge value="BUILT_IN" />}
        </div>
        {builtIn && (
          <p className="mt-1 text-sm text-slate-500">
            Built-in roles match the user types and can't be changed. Duplicate it to make a version you can edit.
          </p>
        )}
      </div>

      {notice && <p role="status" className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400"><MailCheck size={16} />{notice}</p>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] items-start">
        <div className="space-y-6 min-w-0">
          <section aria-label="Details" className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5 space-y-4">
            <label className="block text-sm">
              <span className="text-slate-600 dark:text-slate-300">Name</span>
              <input required minLength={2} maxLength={50} value={name} disabled={!editable} onChange={(e) => setName(e.target.value)}
                className={`${inputClass} mt-1`} placeholder="e.g. Support agent" />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600 dark:text-slate-300">Description</span>
              <textarea rows={2} maxLength={500} value={description} disabled={!editable} onChange={(e) => setDescription(e.target.value)}
                className={`${inputClass} mt-1`} placeholder="What is this role for?" />
            </label>
            {!role && roles.length > 0 && (
              <label className="block text-sm">
                <span className="text-slate-600 dark:text-slate-300">Start from</span>
                <select aria-label="Start from" defaultValue={template?.id ?? ''} onChange={(e) => startFrom(e.target.value)} className={`${inputClass} mt-1`}>
                  <option value="">Nothing (empty role)</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                <span className="block mt-1 text-xs text-slate-500">Copies that role's permissions (those you hold) as a starting point.</span>
              </label>
            )}
          </section>

          {locked && (
            <div role="note" className="flex gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 text-sm text-amber-800 dark:text-amber-300">
              <AlertTriangle size={18} className="shrink-0 mt-0.5" />
              <p>This role grants access you don't have ({beyondMe.slice(0, 3).join(', ')}{beyondMe.length > 3 ? ', …' : ''}), so you can rename it but not change its permissions.</p>
            </div>
          )}

          <section aria-label="Permissions" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-800 dark:text-white">Permissions</h2>
              <div className="relative w-full sm:w-72">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input aria-label="Filter permissions" placeholder="Filter permissions" value={filter} onChange={(e) => setFilter(e.target.value)} className={`${inputClass} pl-9`} />
              </div>
            </div>
            {visible.length === 0 && <p className="text-sm text-slate-500">No permissions match "{filter}".</p>}
            <div className="grid gap-3 md:grid-cols-2">
              {visible.map((r) => {
                const grantable = r.permissions.filter((p) => hasPermission(p.name));
                const on = r.permissions.filter((p) => selected.has(p.name)).length;
                const allOn = grantable.length > 0 && grantable.every((p) => selected.has(p.name));
                return (
                  <fieldset key={r.resource} aria-label={r.label}
                    className={`bg-white dark:bg-slate-800 rounded-xl border p-4 ${on > 0 ? 'border-blue-300 dark:border-blue-500/40' : 'border-slate-200 dark:border-slate-700'}`}>
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div>
                        <legend className="font-medium text-slate-800 dark:text-white">{r.label}</legend>
                        <p className="text-xs text-slate-500">{r.description}</p>
                      </div>
                      {permsEditable && grantable.length > 1 && (
                        <button type="button" onClick={() => toggleResource(r, !allOn)} className="shrink-0 text-xs font-medium text-blue-600 hover:text-blue-700">
                          {allOn ? 'Clear' : 'All'}
                        </button>
                      )}
                    </div>
                    <ul className="space-y-1">
                      {r.permissions.map((p) => {
                        const mine = hasPermission(p.name);
                        const checked = selected.has(p.name);
                        const disabled = !permsEditable || !mine;
                        return (
                          <li key={p.name}>
                            <label title={!mine && editable ? "You don't have this permission, so you can't grant it" : undefined}
                              className={`flex items-start gap-2.5 px-2 py-1.5 rounded-md text-sm ${disabled ? '' : 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/40'}`}>
                              <input type="checkbox" className="mt-0.5 rounded" checked={checked} disabled={disabled}
                                aria-label={p.name} onChange={(e) => toggle(p.name, e.target.checked)} />
                              <span className="min-w-0">
                                <span className={`font-medium ${disabled && !checked ? 'text-slate-400' : 'text-slate-700 dark:text-slate-200'}`}>{actionLabel(p.action)}</span>
                                {!mine && editable && <Lock size={12} className="inline ml-1 -mt-0.5 text-slate-400" aria-label="not yours to grant" />}
                                <span className="block text-xs text-slate-500">{p.description}</span>
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                );
              })}
            </div>
          </section>
        </div>

        <aside aria-label="Summary" className="lg:sticky lg:top-6 space-y-4">
          <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5 space-y-4">
            <div>
              <p className="text-3xl font-bold text-slate-800 dark:text-white">{selected.size}</p>
              <p className="text-sm text-slate-500">{selected.size === 1 ? 'permission' : 'permissions'} selected</p>
            </div>

            {role && (added.length > 0 || removed.length > 0) && (
              <div className="text-sm space-y-1" aria-label="Unsaved changes">
                <p className="font-medium text-slate-700 dark:text-slate-200">Unsaved changes</p>
                {added.map((p) => <p key={p} className="font-mono text-xs text-green-700 dark:text-green-400">+ {p}</p>)}
                {removed.map((p) => <p key={p} className="font-mono text-xs text-red-600 dark:text-red-400">− {p}</p>)}
              </div>
            )}
            {unknown.length > 0 && editable && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {unknown.join(', ')} {unknown.length === 1 ? 'is' : 'are'} no longer offered and will be dropped when you save.
              </p>
            )}
            {role && activeHolders.length > 0 && editable && (added.length > 0 || removed.length > 0) && (
              <p className="flex gap-2 text-xs text-slate-600 dark:text-slate-300">
                <AlertTriangle size={14} className="shrink-0 text-amber-500" />
                Saving changes access right away for {activeHolders.length} {activeHolders.length === 1 ? 'holder' : 'holders'}.
              </p>
            )}

            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

            {editable ? (
              <div className="flex flex-col gap-2">
                <button type="submit" disabled={saving || !dirty || name.trim().length < 2} className={`${primaryButtonClass} justify-center`}>
                  <Check size={16} />{saving ? 'Saving…' : role ? 'Save changes' : 'Create role'}
                </button>
                {role && dirty && (
                  <button type="button" className={`${secondaryButtonClass} justify-center`} onClick={() => {
                    setName(role.name);
                    setDescription(role.description ?? '');
                    setSelected(new Set(original));
                  }}>Discard changes</button>
                )}
              </div>
            ) : null}
            {role && canManage && (
              <button type="button" onClick={() => navigate(`/roles/new?from=${role.id}`)} className={`${secondaryButtonClass} w-full justify-center`}>
                <Copy size={14} />Duplicate
              </button>
            )}
            {role && editable && (
              <button type="button" onClick={remove} disabled={holders.length > 0}
                title={holders.length > 0 ? 'Remove its assignments first' : undefined}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent">
                <Trash2 size={14} />Delete role
              </button>
            )}
          </div>

          {role && (
            <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5" aria-label="Held by">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-slate-800 dark:text-white">Held by</h3>
                <Link to={`/role-assignments?role=${encodeURIComponent(role.name)}`} className="text-xs text-blue-600 hover:text-blue-700">Manage</Link>
              </div>
              {holders.length === 0 ? (
                <p className="text-sm text-slate-500">Nobody yet.</p>
              ) : (
                <ul className="space-y-2">
                  {holders.slice(0, 8).map((h) => {
                    const Icon = h.principalType === 'USER' ? UserIcon : UsersIcon;
                    return (
                      <li key={h.id} className={`flex items-center gap-2 text-sm ${h.state === 'EXPIRED' ? 'opacity-50' : ''}`}>
                        <Icon size={14} className="text-slate-400 shrink-0" />
                        <span className="truncate text-slate-700 dark:text-slate-200">{h.principalName}</span>
                        {h.principalDetail && h.principalType === 'GROUP' && <span className="text-xs text-slate-400 shrink-0">{h.principalDetail}</span>}
                      </li>
                    );
                  })}
                  {holders.length > 8 && <li className="text-xs text-slate-500">and {holders.length - 8} more</li>}
                </ul>
              )}
            </div>
          )}
        </aside>
      </div>
    </form>
  );
}

