import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { UserPlus, Search, X, ChevronLeft, ChevronRight, Users as UsersIcon, MailCheck } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { apiDelete, apiPatch, apiPost } from '../lib/api-client';
import { TENANT_USER_TYPES, canManageUserType } from '../lib/permissions';
import {
  Badge, Card, DataView, EmptyState, PageHeader, formatRelative, humanize, inputClass, primaryButtonClass, secondaryButtonClass, selectClass,
} from '../components/ui';

interface TenantUser {
  id: string;
  email: string;
  name: string | null;
  userType: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  mfaEnabled: boolean;
}
interface UserPage {
  data: TenantUser[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

const STATUSES = ['ACTIVE', 'PENDING', 'INACTIVE'];
const PAGE_SIZE = 25;
const typeLabel = (t: string) => humanize(t.replace('TENANT_', ''));

export default function Users() {
  const { user: me, hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const userType = params.get('userType') ?? '';
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? '1');
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  if (search) query.set('search', search);
  if (userType) query.set('userType', userType);
  if (status) query.set('status', status);
  const list = useApi<UserPage>(`/users?${query}`);

  const canCreate = hasPermission('users:create');
  const canUpdate = hasPermission('users:update');
  const canDelete = hasPermission('users:delete');
  const canReviewAccess = hasPermission('roles:read');
  const myType = me?.userType ?? '';
  const assignableTypes = TENANT_USER_TYPES.filter((t) => canManageUserType(myType, t));

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const act = async (fn: () => Promise<unknown>, success?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (success) setNotice(success);
      await list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Users"
        description="People in your organization"
        actions={canCreate && <button className={primaryButtonClass} onClick={() => setInviting(true)}><UserPlus size={16} />Invite user</button>}
      />

      {notice && <p role="status" className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400"><MailCheck size={16} />{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input aria-label="Search users" placeholder="Search by name or email" defaultValue={search}
            onKeyDown={(e) => e.key === 'Enter' && update('search', (e.target as HTMLInputElement).value.trim())}
            onBlur={(e) => e.target.value.trim() !== search && update('search', e.target.value.trim())}
            className={`${inputClass} pl-9`} />
        </div>
        <select aria-label="Filter by type" value={userType} onChange={(e) => update('userType', e.target.value)} className={selectClass}>
          <option value="">All types</option>
          {TENANT_USER_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
        </select>
        <select aria-label="Filter by status" value={status} onChange={(e) => update('status', e.target.value)} className={selectClass}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s === 'PENDING' ? 'Invited' : humanize(s)}</option>)}
        </select>
      </div>

      <DataView {...list}>
        {(l) =>
          l.data.length === 0 ? (
            <Card><EmptyState icon={UsersIcon} title={search || userType || status ? 'No users match these filters' : 'No users yet'} /></Card>
          ) : (
            <>
              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-900/50 text-left text-xs uppercase text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="px-5 py-3 font-medium">User</th>
                      <th className="px-5 py-3 font-medium">Type</th>
                      <th className="px-5 py-3 font-medium">Status</th>
                      <th className="px-5 py-3 font-medium">Last sign-in</th>
                      <th className="px-5 py-3 font-medium">Two-factor</th>
                      <th className="px-5 py-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                    {l.data.map((u) => {
                      const isMe = u.id === me?.id;
                      const manageable = !isMe && canManageUserType(myType, u.userType);
                      return (
                        <tr key={u.id}>
                          <td className="px-5 py-3">
                            <p className="font-medium text-slate-800 dark:text-white">
                              {u.name || u.email} {isMe && <span className="text-xs font-normal text-slate-400">(you)</span>}
                            </p>
                            <p className="text-xs text-slate-500">{u.email}</p>
                          </td>
                          <td className="px-5 py-3">
                            {canUpdate && manageable ? (
                              <select aria-label={`Type for ${u.email}`} value={u.userType} className={selectClass}
                                onChange={(e) => act(() => apiPatch(`/users/${u.id}`, { userType: e.target.value }), `${u.email} is now ${typeLabel(e.target.value)}`)}>
                                {assignableTypes.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
                              </select>
                            ) : (
                              <span className="text-slate-600 dark:text-slate-300">{typeLabel(u.userType)}</span>
                            )}
                          </td>
                          <td className="px-5 py-3"><Badge value={u.status === 'PENDING' ? 'INVITED' : u.status} /></td>
                          <td className="px-5 py-3 text-slate-500">{u.status === 'PENDING' ? '—' : formatRelative(u.lastLoginAt)}</td>
                          <td className="px-5 py-3">
                            <span className={u.mfaEnabled ? 'text-green-600 dark:text-green-400' : 'text-slate-400'}>{u.mfaEnabled ? 'On' : 'Off'}</span>
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex justify-end gap-2">
                              {(canReviewAccess || isMe) && (
                                <Link to={`/access-review/${u.id}`} className="px-3 py-2 text-sm font-medium rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">Access</Link>
                              )}
                              {u.status === 'PENDING' && canCreate && manageable && (
                                <button className={secondaryButtonClass} onClick={() => act(() => apiPost(`/users/${u.id}/resend-invite`, {}), `Invitation resent to ${u.email}`)}>Resend invite</button>
                              )}
                              {u.status !== 'PENDING' && canUpdate && manageable && (
                                <button className={secondaryButtonClass}
                                  onClick={() => (u.status !== 'ACTIVE' || confirm(`Deactivate ${u.email}? They'll be signed out everywhere right away.`))
                                    && act(() => apiPatch(`/users/${u.id}`, { status: u.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
                                      `${u.email} ${u.status === 'ACTIVE' ? 'deactivated and signed out' : 'reactivated'}`)}>
                                  {u.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
                                </button>
                              )}
                              {u.mfaEnabled && canUpdate && manageable && (
                                <button className={secondaryButtonClass} title="For a lost phone: they set up two-factor again at their next sign-in"
                                  onClick={() => confirm(`Reset two-factor for ${u.email}? They'll set it up again the next time they sign in.`)
                                    && act(() => apiPost(`/users/${u.id}/mfa/reset`, {}), `Two-factor reset for ${u.email}`)}>
                                  Reset 2FA
                                </button>
                              )}
                              {canDelete && manageable && (
                                <button className="px-3 py-2 text-sm font-medium rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
                                  onClick={() => confirm(`Remove ${u.email}? This can't be undone.`) && act(() => apiDelete(`/users/${u.id}`), `${u.email} removed`)}>
                                  Remove
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {l.pagination.pages > 1 && (
                <div className="flex items-center justify-between text-sm text-slate-500">
                  <span>Page {l.pagination.page} of {l.pagination.pages} · {l.pagination.total} users</span>
                  <div className="flex gap-2">
                    <button disabled={page <= 1} onClick={() => update('page', String(page - 1))} className={secondaryButtonClass}><ChevronLeft size={14} />Previous</button>
                    <button disabled={page >= l.pagination.pages} onClick={() => update('page', String(page + 1))} className={secondaryButtonClass}>Next<ChevronRight size={14} /></button>
                  </div>
                </div>
              )}
            </>
          )
        }
      </DataView>

      {inviting && (
        <InviteDialog
          types={assignableTypes}
          onClose={() => setInviting(false)}
          onInvited={async (email) => {
            setInviting(false);
            setNotice(`Invitation sent to ${email}`);
            await list.reload();
          }}
        />
      )}
    </div>
  );
}

function InviteDialog({ types, onClose, onInvited }: { types: readonly string[]; onClose: () => void; onInvited: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [userType, setUserType] = useState(types.includes('TENANT_USER') ? 'TENANT_USER' : types[types.length - 1] ?? 'TENANT_VIEWER');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost('/users', { email: email.trim(), name: name.trim(), userType });
      await onInvited(email.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the invitation');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <form role="dialog" aria-label="Invite user" onSubmit={submit} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-white dark:bg-slate-800 rounded-xl p-6 space-y-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800 dark:text-white">Invite user</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700"><X size={18} /></button>
        </div>
        <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Email</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={`${inputClass} mt-1`} /></label>
        <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Name</span>
          <input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mt-1`} /></label>
        <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Type</span>
          <select value={userType} onChange={(e) => setUserType(e.target.value)} className={`${inputClass} mt-1`}>
            {types.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
          </select></label>
        <p className="text-xs text-slate-500">They'll get an email with a link to set their password. The link works for 7 days.</p>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>Cancel</button>
          <button type="submit" disabled={saving} className={primaryButtonClass}>{saving ? 'Sending…' : 'Send invitation'}</button>
        </div>
      </form>
    </div>
  );
}
