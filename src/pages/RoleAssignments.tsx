import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, KeyRound, MailCheck, Plus, Search, Shield, User as UserIcon, Users as UsersIcon } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { apiDelete } from '../lib/api-client';
import { SCOPE_LABEL, rolePermissions, validityText, type AssignmentState, type Role, type ScopeType } from '../lib/access';
import { AssignRoleDialog } from '../components/AssignRoleDialog';
import { Badge, Card, DataView, EmptyState, PageHeader, inputClass, primaryButtonClass, selectClass } from '../components/ui';

interface Assignment {
  id: string;
  roleId: string;
  roleName: string;
  principalType: 'USER' | 'GROUP';
  userId: string | null;
  groupId: string | null;
  principalName: string;
  principalDetail: string | null;
  scopeType: ScopeType;
  scopeId: string;
  scopeName: string;
  validFrom: string;
  validTo: string | null;
  state: AssignmentState;
  permissions: string[];
}

const STATES: AssignmentState[] = ['ACTIVE', 'SCHEDULED', 'EXPIRED'];

export default function RoleAssignments() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'roles' ? 'roles' : 'assignments';
  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    if (t === 'roles') next.set('tab', 'roles');
    else next.delete('tab');
    setParams(next, { replace: true });
  };

  return (
    <div className="p-6 space-y-6">
      <div role="tablist" aria-label="Access" className="flex gap-1 border-b border-slate-200 dark:border-slate-700">
        {[['assignments', 'Assignments'], ['roles', 'Roles']].map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`px-4 py-2 -mb-px text-sm font-medium border-b-2 ${tab === key
              ? 'border-blue-600 text-blue-700 dark:text-blue-300'
              : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'roles' ? <RolesTab /> : <AssignmentsTab />}
    </div>
  );
}

function AssignmentsTab() {
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const roleFilter = params.get('role') ?? '';
  const who = params.get('who') ?? '';
  const state = params.get('state') ?? '';
  const [assigning, setAssigning] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useApi<{ assignments: Assignment[] }>('/roles/assignments');
  const canAssign = hasPermission('roles:assign');
  const covers = (perms: string[]) => perms.every((p) => hasPermission(p));

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const filtered = useMemo(() => {
    const term = search.toLowerCase();
    return (list.data?.assignments ?? []).filter((a) =>
      (!term || [a.principalName, a.principalDetail ?? '', a.roleName, a.scopeName].some((s) => s.toLowerCase().includes(term)))
      && (!roleFilter || a.roleName === roleFilter)
      && (!who || a.principalType === who)
      && (!state || a.state === state));
  }, [list.data, search, roleFilter, who, state]);
  const roleNames = useMemo(() => [...new Set((list.data?.assignments ?? []).map((a) => a.roleName))].sort(), [list.data]);

  const remove = async (a: Assignment) => {
    if (!confirm(`Remove ${a.roleName} from ${a.principalName}?`)) return;
    setError(null);
    setNotice(null);
    try {
      await apiDelete(`/roles/assignments/${a.id}`);
      await list.reload();
      setNotice(`${a.roleName} removed from ${a.principalName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the assignment');
    }
  };

  return (
    <>
      <PageHeader
        title="Role assignments"
        description="Who holds which role, and where it applies. Roles given to a group apply to all of its members."
        actions={canAssign && <button className={primaryButtonClass} onClick={() => setAssigning(true)}><KeyRound size={16} />Assign role</button>}
      />

      {notice && <p role="status" className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400"><MailCheck size={16} />{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input aria-label="Search assignments" placeholder="Search people, groups, roles" value={search}
            onChange={(e) => update('search', e.target.value)} className={`${inputClass} pl-9`} />
        </div>
        <select aria-label="Filter by role" value={roleFilter} onChange={(e) => update('role', e.target.value)} className={selectClass}>
          <option value="">All roles</option>
          {roleNames.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select aria-label="Filter by holder" value={who} onChange={(e) => update('who', e.target.value)} className={selectClass}>
          <option value="">People and groups</option>
          <option value="USER">People</option>
          <option value="GROUP">Groups</option>
        </select>
        <select aria-label="Filter by state" value={state} onChange={(e) => update('state', e.target.value)} className={selectClass}>
          <option value="">Any state</option>
          {STATES.map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
        </select>
      </div>

      <DataView {...list}>
        {() => filtered.length === 0 ? (
          <Card>
            <EmptyState icon={Shield}
              title={list.data!.assignments.length === 0 ? 'No roles assigned yet' : 'No assignments match these filters'}
              message={list.data!.assignments.length === 0 ? 'Everyone has the access that comes with their user type. Assign a role to give someone more.' : undefined} />
          </Card>
        ) : (
          <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/50 text-left text-xs uppercase text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-5 py-3 font-medium">Holder</th>
                  <th className="px-5 py-3 font-medium">Role</th>
                  <th className="px-5 py-3 font-medium">Applies to</th>
                  <th className="px-5 py-3 font-medium">Valid</th>
                  <th className="px-5 py-3 font-medium">State</th>
                  <th className="px-5 py-3 font-medium text-right"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {filtered.map((a) => {
                  const open = expanded === a.id;
                  const removable = canAssign && covers(a.permissions);
                  return (
                    <AssignmentRow key={a.id} a={a} open={open} onToggle={() => setExpanded(open ? null : a.id)}
                      onRemove={canAssign ? () => remove(a) : undefined} removable={removable} />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </DataView>

      {assigning && (
        <AssignRoleDialog onClose={() => setAssigning(false)} onAssigned={async (msg) => {
          setAssigning(false);
          setError(null);
          await list.reload();
          setNotice(msg);
        }} />
      )}
    </>
  );
}

function AssignmentRow({ a, open, onToggle, onRemove, removable }: {
  a: Assignment; open: boolean; onToggle: () => void; onRemove?: () => void; removable: boolean;
}) {
  const Icon = a.principalType === 'USER' ? UserIcon : UsersIcon;
  return (
    <>
      <tr className={a.state === 'EXPIRED' ? 'opacity-60' : ''}>
        <td className="px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500"><Icon size={15} /></span>
            <div>
              {a.principalType === 'GROUP' && a.groupId ? (
                <Link to={`/groups?group=${a.groupId}`} className="font-medium text-slate-800 dark:text-white hover:text-blue-600">{a.principalName}</Link>
              ) : (
                <p className="font-medium text-slate-800 dark:text-white">{a.principalName}</p>
              )}
              {a.principalDetail && <p className="text-xs text-slate-500">{a.principalDetail}</p>}
            </div>
          </div>
        </td>
        <td className="px-5 py-3">
          <button onClick={onToggle} aria-expanded={open} className="inline-flex items-center gap-1 font-medium text-slate-700 dark:text-slate-200 hover:text-blue-600">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{a.roleName}
          </button>
          <p className="ml-5 text-xs text-slate-500">{a.permissions.length} permissions</p>
        </td>
        <td className="px-5 py-3 text-slate-600 dark:text-slate-300">
          {a.scopeName}
          {a.scopeType !== 'TENANT' && <span className="block text-xs text-slate-500">{SCOPE_LABEL[a.scopeType]}</span>}
        </td>
        <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{validityText(a.validFrom, a.validTo)}</td>
        <td className="px-5 py-3"><Badge value={a.state} /></td>
        <td className="px-5 py-3 text-right">
          {onRemove && (
            <button onClick={onRemove} disabled={!removable}
              title={removable ? undefined : "This role includes access you don't have, so you can't remove it"}
              className="px-3 py-2 text-sm font-medium rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent">
              Remove
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="bg-slate-50/60 dark:bg-slate-900/30">
          <td colSpan={6} className="px-5 py-3">
            <PermissionChips permissions={a.permissions} />
          </td>
        </tr>
      )}
    </>
  );
}

function PermissionChips({ permissions }: { permissions: string[] }) {
  if (permissions.length === 0) return <p className="text-xs text-slate-500">This role has no permissions.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {[...permissions].sort().map((p) => (
        <code key={p} className="px-2 py-0.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300">{p}</code>
      ))}
    </div>
  );
}

function RolesTab() {
  const { hasPermission } = useAuth();
  const roles = useApi<{ roles: Role[] }>('/roles');
  const canManage = hasPermission('roles:manage');
  return (
    <>
      <PageHeader title="Roles" description="The roles available in this tenant and what each one allows."
        actions={canManage && <Link to="/roles/new" className={primaryButtonClass}><Plus size={16} />New role</Link>} />
      <DataView {...roles}>
        {({ roles: list }) => list.length === 0 ? (
          <Card><EmptyState icon={Shield} title="No roles yet" /></Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {list.map((r) => {
              const perms = rolePermissions(r);
              const areas = [...new Set(perms.map((p) => p.split(':')[0]))].sort();
              return (
                <div key={r.id} className="flex flex-col bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <Link to={`/roles/${r.id}`} className="font-semibold text-slate-800 dark:text-white hover:text-blue-600">{r.name}</Link>
                    {r.isSystem && <Badge value="BUILT_IN" />}
                  </div>
                  {r.description && <p className="mt-1 text-sm text-slate-500">{r.description}</p>}
                  <p className="mt-3 text-xs text-slate-500">
                    {perms.length} {perms.length === 1 ? 'permission' : 'permissions'}{areas.length > 0 && ` across ${areas.length} ${areas.length === 1 ? 'area' : 'areas'}`}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {areas.slice(0, 8).map((a) => <span key={a} className="px-2 py-0.5 rounded-md text-xs bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">{a}</span>)}
                    {areas.length > 8 && <span className="px-2 py-0.5 text-xs text-slate-400">+{areas.length - 8}</span>}
                  </div>
                  <div className="mt-auto pt-4 flex items-center justify-between gap-2 text-sm">
                    <Link to={`/role-assignments?role=${encodeURIComponent(r.name)}`} className="text-slate-500 hover:text-blue-600">
                      {r._count.roleAssignments} {r._count.roleAssignments === 1 ? 'assignment' : 'assignments'}
                    </Link>
                    <div className="flex gap-3">
                      {canManage && <Link to={`/roles/new?from=${r.id}`} className="font-medium text-slate-600 dark:text-slate-300 hover:text-blue-600">Duplicate</Link>}
                      <Link to={`/roles/${r.id}`} className="font-medium text-blue-600 hover:text-blue-700">{canManage && !r.isSystem ? 'Edit' : 'View'}</Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DataView>
    </>
  );
}
