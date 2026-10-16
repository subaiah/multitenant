import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, KeyRound, MailCheck, Pencil, Plus, Search, Trash2, UserMinus, UserPlus, Users as UsersIcon, X } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { apiDelete, apiPatch, apiPost } from '../lib/api-client';
import { SCOPE_LABEL, validityText, type AssignmentState, type ScopeType } from '../lib/access';
import { AssignRoleDialog } from '../components/AssignRoleDialog';
import { Dialog, Field } from '../components/Dialog';
import {
  Badge, Card, DataView, EmptyState, LoadingState, ErrorState, PageHeader, humanize, inputClass, primaryButtonClass, secondaryButtonClass, selectClass,
} from '../components/ui';

interface GroupSummary {
  id: string;
  name: string;
  description: string | null;
  groupType: string;
  status: 'ACTIVE' | 'INACTIVE';
  roles: string[];
  _count: { members: number; roleAssignments: number };
}

interface GroupDetail extends Omit<GroupSummary, 'roles'> {
  members: { id: string; validFrom: string; validTo: string | null; user: { id: string; email: string; name: string | null; userType: string; status: string } }[];
  roleAssignments: {
    id: string; roleName: string; roleDescription: string | null; scopeType: ScopeType; scopeName: string;
    permissions: string[]; validFrom: string; validTo: string | null; state: AssignmentState;
  }[];
  grants: string[];
}

export default function Groups() {
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const status = params.get('status') ?? '';
  const selected = params.get('group');
  const [creating, setCreating] = useState(false);

  const query = new URLSearchParams({ limit: '100' });
  if (search) query.set('search', search);
  if (status) query.set('status', status);
  const list = useApi<{ groups: GroupSummary[] }>(`/groups?${query}`);

  const update = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: key !== 'group' });
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Groups"
        description="Put people in groups and give the group roles, instead of assigning roles one person at a time."
        actions={hasPermission('groups:create') && <button className={primaryButtonClass} onClick={() => setCreating(true)}><Plus size={16} />New group</button>}
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input aria-label="Search groups" placeholder="Search groups" defaultValue={search}
            onKeyDown={(e) => e.key === 'Enter' && update('search', (e.target as HTMLInputElement).value.trim())}
            onBlur={(e) => e.target.value.trim() !== search && update('search', e.target.value.trim())}
            className={`${inputClass} pl-9`} />
        </div>
        <select aria-label="Filter by status" value={status} onChange={(e) => update('status', e.target.value)} className={selectClass}>
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
      </div>

      <DataView {...list}>
        {({ groups }) => groups.length === 0 ? (
          <Card>
            <EmptyState icon={UsersIcon} title={search || status ? 'No groups match these filters' : 'No groups yet'}
              message={search || status ? undefined : 'Create a group, add people to it, then assign it a role.'} />
          </Card>
        ) : (
          <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[13px] border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-5 py-3 font-medium">Group</th>
                  <th className="px-5 py-3 font-medium">Members</th>
                  <th className="px-5 py-3 font-medium">Roles</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {groups.map((g) => (
                  <tr key={g.id} onClick={() => update('group', g.id)}
                    className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/40 ${selected === g.id ? 'bg-blue-50/60 dark:bg-blue-500/10' : ''}`}>
                    <td className="px-5 py-3">
                      <button className="font-medium text-left text-slate-800 dark:text-white hover:text-blue-600" onClick={(e) => { e.stopPropagation(); update('group', g.id); }}>
                        {g.name}
                      </button>
                      {g.description && <p className="text-xs text-slate-500 line-clamp-1">{g.description}</p>}
                    </td>
                    <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{g._count.members}</td>
                    <td className="px-5 py-3">
                      {g.roles.length === 0 ? <span className="text-slate-400">None</span> : (
                        <div className="flex flex-wrap gap-1">
                          {g.roles.map((r) => <span key={r} className="px-2 py-0.5 rounded-md text-xs bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">{r}</span>)}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3"><Badge value={g.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataView>

      {selected && (
        <GroupPanel key={selected} id={selected} onClose={() => update('group', null)} onChanged={list.reload}
          onDeleted={async () => { update('group', null); await list.reload(); }} />
      )}

      {creating && (
        <GroupForm onClose={() => setCreating(false)} onSaved={async (g) => {
          setCreating(false);
          await list.reload();
          update('group', g.id);
        }} />
      )}
    </div>
  );
}

function GroupForm({ group, onClose, onSaved }: {
  group?: { id: string; name: string; description: string | null };
  onClose: () => void;
  onSaved: (g: { id: string }) => void | Promise<void>;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim() };
      const saved = group ? await apiPatch<{ id: string }>(`/groups/${group.id}`, body) : await apiPost<{ id: string }>('/groups', body);
      await onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the group');
      setSaving(false);
    }
  };

  return (
    <Dialog title={group ? 'Edit group' : 'New group'} onClose={onClose} onSubmit={submit}>
      <Field label="Name">
        <input required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} autoFocus />
      </Field>
      <Field label="Description">
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
      </Field>
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={secondaryButtonClass}>Cancel</button>
        <button type="submit" disabled={saving} className={primaryButtonClass}>{saving ? 'Saving…' : group ? 'Save' : 'Create group'}</button>
      </div>
    </Dialog>
  );
}

function GroupPanel({ id, onClose, onChanged, onDeleted }: {
  id: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const { hasPermission } = useAuth();
  const detail = useApi<GroupDetail>(`/groups/${id}`);
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>, success: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      await Promise.all([detail.reload(), onChanged()]);
      setNotice(success);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  };

  const g = detail.data;
  const missing = g ? g.grants.filter((p) => !hasPermission(p)) : [];
  const canUpdate = hasPermission('groups:update');
  const canChangeAccess = canUpdate && missing.length === 0;
  const canAssign = hasPermission('roles:assign');
  const memberIds = new Set(g?.members.map((m) => m.user.id));

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/20" onClick={onClose}>
      <aside role="complementary" aria-label="Group details" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl h-full overflow-y-auto bg-white dark:bg-slate-800 shadow-2xl border-l border-slate-200 dark:border-slate-700">
        {!g ? (
          detail.error ? <div className="p-6"><ErrorState error={detail.error} onRetry={detail.reload} /></div> : <LoadingState />
        ) : (
          <div className="p-6 space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold text-slate-800 dark:text-white">{g.name}</h2>
                  <Badge value={g.status} />
                </div>
                {g.description && <p className="mt-1 text-sm text-slate-500">{g.description}</p>}
              </div>
              <button onClick={onClose} aria-label="Close group details" className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700"><X size={18} /></button>
            </div>

            <div className="flex flex-wrap gap-2">
              {canUpdate && <button className={secondaryButtonClass} onClick={() => setEditing(true)}><Pencil size={14} />Edit</button>}
              {canChangeAccess && (
                <button className={secondaryButtonClass}
                  onClick={() => act(() => apiPatch(`/groups/${g.id}`, { status: g.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
                    g.status === 'ACTIVE' ? `${g.name} deactivated; its roles no longer apply to members` : `${g.name} reactivated`)}>
                  {g.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
                </button>
              )}
              {hasPermission('groups:delete') && (
                <button disabled={g.members.length > 0 || g.roleAssignments.length > 0}
                  title={g.members.length > 0 || g.roleAssignments.length > 0 ? 'Remove all members and roles first' : undefined}
                  onClick={async () => {
                    if (!confirm(`Delete ${g.name}?`)) return;
                    try {
                      await apiDelete(`/groups/${g.id}`);
                      await onDeleted();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Could not delete the group');
                    }
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent">
                  <Trash2 size={14} />Delete
                </button>
              )}
            </div>

            {g.status === 'INACTIVE' && (
              <p className="text-sm text-slate-500">This group is inactive: its roles don't apply to its members until it's reactivated.</p>
            )}
            {canUpdate && missing.length > 0 && (
              <div role="note" className="flex gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 text-sm text-amber-800 dark:text-amber-300">
                <AlertTriangle size={18} className="shrink-0 mt-0.5" />
                <p>This group grants access you don't have ({missing.slice(0, 3).join(', ')}{missing.length > 3 ? ', …' : ''}), so you can't change its members or turn it off.</p>
              </div>
            )}
            {notice && <p role="status" className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400"><MailCheck size={16} />{notice}</p>}
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

            <section aria-label="Roles">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-slate-800 dark:text-white">Roles</h3>
                {canAssign && <button className={secondaryButtonClass} onClick={() => setAssigning(true)}><KeyRound size={14} />Assign role</button>}
              </div>
              {g.roleAssignments.length === 0 ? (
                <p className="text-sm text-slate-500">No roles yet. Members only have the access that comes with their user type.</p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-700 border border-slate-200 dark:border-slate-700 rounded-lg">
                  {g.roleAssignments.map((a) => {
                    const removable = a.permissions.every((p) => hasPermission(p));
                    return (
                      <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
                        <div>
                          <p className="font-medium text-slate-800 dark:text-white">{a.roleName} <Badge value={a.state} className="ml-1" /></p>
                          <p className="text-xs text-slate-500">
                            {a.scopeType === 'TENANT' ? SCOPE_LABEL.TENANT : `${SCOPE_LABEL[a.scopeType]}: ${a.scopeName}`} · {validityText(a.validFrom, a.validTo)} · {a.permissions.length} permissions
                          </p>
                        </div>
                        {canAssign && (
                          <button disabled={!removable} title={removable ? undefined : "This role includes access you don't have"}
                            onClick={() => confirm(`Remove ${a.roleName} from ${g.name}?`) && act(() => apiDelete(`/roles/assignments/${a.id}`), `${a.roleName} removed from ${g.name}`)}
                            className="px-3 py-1.5 text-sm font-medium rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed">
                            Remove
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <Link to="/role-assignments?who=GROUP" className="inline-block mt-2 text-xs text-blue-600 hover:text-blue-700">All group role assignments</Link>
            </section>

            <section aria-label="Members">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-slate-800 dark:text-white">Members <span className="font-normal text-slate-400">({g.members.length})</span></h3>
                {canChangeAccess && !adding && <button className={secondaryButtonClass} onClick={() => setAdding(true)}><UserPlus size={14} />Add people</button>}
              </div>
              {adding && (
                <AddMembers exclude={memberIds} onDone={() => setAdding(false)}
                  onAdd={(u) => act(() => apiPost(`/groups/${g.id}/members`, { userId: u.id }), `${u.name || u.email} added to ${g.name}`)} />
              )}
              {g.members.length === 0 ? (
                <p className="text-sm text-slate-500">No members yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-700 border border-slate-200 dark:border-slate-700 rounded-lg">
                  {g.members.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="font-medium text-slate-800 dark:text-white truncate">{m.user.name || m.user.email}</p>
                        <p className="text-xs text-slate-500 truncate">
                          {m.user.email} · {humanize(m.user.userType.replace('TENANT_', ''))}
                          {m.user.status !== 'ACTIVE' && ` · ${m.user.status === 'PENDING' ? 'invited' : m.user.status.toLowerCase()}`}
                          {m.validTo && ` · until ${new Date(m.validTo).toLocaleDateString()}`}
                        </p>
                      </div>
                      {canChangeAccess && (
                        <button aria-label={`Remove ${m.user.email}`}
                          onClick={() => act(() => apiDelete(`/groups/${g.id}/members/${m.user.id}`), `${m.user.name || m.user.email} removed from ${g.name}`)}
                          className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10">
                          <UserMinus size={16} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </aside>

      {editing && g && (
        <GroupForm group={g} onClose={() => setEditing(false)} onSaved={async () => {
          setEditing(false);
          await Promise.all([detail.reload(), onChanged()]);
          setNotice('Group updated');
        }} />
      )}
      {assigning && g && (
        <AssignRoleDialog principal={{ type: 'GROUP', id: g.id, name: g.name }} onClose={() => setAssigning(false)} onAssigned={async (msg) => {
          setAssigning(false);
          setError(null);
          await Promise.all([detail.reload(), onChanged()]);
          setNotice(msg);
        }} />
      )}
    </div>
  );
}

function AddMembers({ exclude, onAdd, onDone }: {
  exclude: Set<string>;
  onAdd: (u: { id: string; email: string; name: string | null }) => Promise<void>;
  onDone: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = encodeURIComponent(query.trim());
  const users = useApi<{ data: { id: string; email: string; name: string | null; status: string }[] }>(`/users?limit=8${q ? `&search=${q}` : ''}`);
  const candidates = (users.data?.data ?? []).filter((u) => !exclude.has(u.id));

  return (
    <div className="mb-3 p-3 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50/40 dark:bg-blue-500/5 space-y-2">
      <div className="flex gap-2">
        <input aria-label="Find people to add" placeholder="Search by name or email" value={query} onChange={(e) => setQuery(e.target.value)}
          className={inputClass} autoFocus />
        <button type="button" onClick={onDone} className={secondaryButtonClass}>Done</button>
      </div>
      {candidates.length === 0 ? (
        <p className="text-xs text-slate-500 px-1">{users.loading ? 'Searching…' : 'No one else matches'}</p>
      ) : (
        <ul className="space-y-1">
          {candidates.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-3 px-2 py-1.5 rounded-md hover:bg-white dark:hover:bg-slate-700/50">
              <span className="min-w-0 text-sm truncate">
                <span className="font-medium text-slate-800 dark:text-white">{u.name || u.email}</span>
                <span className="text-slate-500"> · {u.email}</span>
              </span>
              <button type="button" onClick={() => onAdd(u)} className="text-sm font-medium text-blue-600 hover:text-blue-700">Add</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
