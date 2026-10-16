/**
 * Support sessions (platform portal): ask for access to a tenant, approve or
 * reject requests, end sessions, and open the workspace of an active one.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LifeBuoy, Check, X, LogIn, Square } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { apiPost } from '../lib/api-client';
import { Badge, Card, DataView, EmptyState, PageHeader, formatRelative, inputClass, primaryButtonClass, secondaryButtonClass, selectClass } from '../components/ui';

export interface SupportSessionRow {
  id: string;
  platformUserId: string;
  tenantId: string;
  reason: string;
  access: 'READ_ONLY' | 'READ_WRITE';
  permissions: string[];
  durationMinutes: number;
  status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'REVOKED' | 'EXPIRED';
  validFrom: string | null;
  validTo: string | null;
  decisionNote: string | null;
  createdAt: string;
  platformUser: { id: string; email: string; name: string | null };
  approver: { email: string } | null;
  tenant: { id: string; name: string; slug: string };
}
interface SessionList {
  sessions: SupportSessionRow[];
  canApprove: boolean;
  selfApproval: boolean;
  maxMinutes: number;
  writePermissions: { name: string; description: string }[];
}

const until = (iso: string | null) => {
  if (!iso) return '';
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  return mins > 0 ? `${mins >= 60 ? `${Math.floor(mins / 60)} h ` : ''}${mins % 60} min left` : 'ended';
};

export default function Support() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const list = useApi<SessionList>('/support-sessions');
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Support" description="Time-limited access to a tenant's data, approved by someone else and visible to the tenant" />
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <DataView {...list}>
        {(l) => (
          <>
            <RequestForm list={l} onDone={() => list.reload()} />
            <Card title="Sessions" description={l.canApprove ? 'Requests you can approve, and everyone’s sessions' : 'Your requests and sessions'} className="!p-0">
              {l.sessions.length === 0 ? (
                <div className="p-6"><EmptyState icon={LifeBuoy} title="No support sessions yet" /></div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-[13px] border-b border-slate-200 dark:border-slate-700 text-slate-500">
                      <tr>
                        <th className="px-5 py-3 font-medium">Tenant</th>
                        <th className="px-5 py-3 font-medium">Who</th>
                        <th className="px-5 py-3 font-medium">Access</th>
                        <th className="px-5 py-3 font-medium">Status</th>
                        <th className="px-5 py-3 font-medium">Reason</th>
                        <th className="px-5 py-3 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                      {l.sessions.map((s) => {
                        const mine = s.platformUserId === user?.id;
                        const canDecide = s.status === 'PENDING' && l.canApprove && (!mine || l.selfApproval);
                        return (
                          <tr key={s.id} className="align-top">
                            <td className="px-5 py-3 font-medium text-slate-800 dark:text-white">{s.tenant.name}</td>
                            <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{s.platformUser.email}{mine && <span className="text-xs text-slate-400"> (you)</span>}</td>
                            <td className="px-5 py-3">
                              <span className={s.access === 'READ_ONLY' ? 'text-slate-600 dark:text-slate-300' : 'text-amber-700 dark:text-amber-400 font-medium'}>
                                {s.access === 'READ_ONLY' ? 'Read-only' : 'Read-write'}
                              </span>
                              {s.access === 'READ_WRITE' && <p className="text-xs text-slate-400">{s.permissions.join(', ')}</p>}
                              <p className="text-xs text-slate-400">{s.durationMinutes} min</p>
                            </td>
                            <td className="px-5 py-3">
                              <Badge value={s.status} />
                              <p className="text-xs text-slate-400 mt-1">
                                {s.status === 'ACTIVE' ? until(s.validTo) : s.status === 'PENDING' ? `asked ${formatRelative(s.createdAt)}` : s.approver ? `by ${s.approver.email}` : ''}
                              </p>
                            </td>
                            <td className="px-5 py-3 text-slate-600 dark:text-slate-300 max-w-xs">{s.reason}{s.decisionNote && <p className="text-xs text-slate-400 mt-1">Note: {s.decisionNote}</p>}</td>
                            <td className="px-5 py-3">
                              <div className="flex justify-end flex-wrap gap-2">
                                {canDecide && (
                                  <>
                                    <button className={secondaryButtonClass} onClick={() => act(() => apiPost(`/support-sessions/${s.id}/decide`, { approved: true }))}><Check size={14} />Approve</button>
                                    <button className={secondaryButtonClass} onClick={() => {
                                      const note = window.prompt('Why is it rejected? (shown to the requester)') ?? undefined;
                                      void act(() => apiPost(`/support-sessions/${s.id}/decide`, { approved: false, note }));
                                    }}><X size={14} />Reject</button>
                                  </>
                                )}
                                {s.status === 'ACTIVE' && mine && (
                                  <button className={primaryButtonClass} onClick={() => navigate(`/platform/support/${s.id}`)}><LogIn size={14} />Open</button>
                                )}
                                {(s.status === 'ACTIVE' || s.status === 'PENDING') && (mine || l.canApprove) && (
                                  <button className="px-3 py-2 text-sm font-medium rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 inline-flex items-center gap-1"
                                    onClick={() => act(() => apiPost(`/support-sessions/${s.id}/revoke`))}>
                                    <Square size={14} />{s.status === 'PENDING' ? 'Withdraw' : 'End'}
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
              )}
            </Card>
          </>
        )}
      </DataView>
    </div>
  );
}

function RequestForm({ list, onDone }: { list: SessionList; onDone: () => void }) {
  const tenants = useApi<{ data: { id: string; name: string; provisioningStatus?: string }[] }>('/tenants?limit=100');
  const [tenantId, setTenantId] = useState('');
  const [reason, setReason] = useState('');
  const [access, setAccess] = useState<'READ_ONLY' | 'READ_WRITE'>('READ_ONLY');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!tenantId && tenants.data?.data.length) setTenantId(tenants.data.data[0].id);
  }, [tenants.data, tenantId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const s = await apiPost<SupportSessionRow>('/support-sessions/request', { tenantId, reason, access, permissions, durationMinutes: minutes });
      setMessage({ ok: true, text: s.status === 'ACTIVE' ? 'Approved and started.' : 'Requested. Someone with support approval rights will review it.' });
      setReason('');
      setPermissions([]);
      onDone();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Request failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Ask for access" description={`Read-only unless you need more. At most ${Math.floor(list.maxMinutes / 60)} hours. The tenant's admins are told, and everything you do is in their audit log.`}>
      <form onSubmit={submit} className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Tenant</span>
          <select aria-label="Tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)} className={`${selectClass} mt-1 w-full`}>
            {(tenants.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">For how long (minutes)</span>
          <input type="number" min={5} max={list.maxMinutes} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={`${inputClass} mt-1`} />
        </label>
        <label className="block text-sm md:col-span-2"><span className="text-slate-600 dark:text-slate-300">Reason (the tenant sees this)</span>
          <textarea aria-label="Reason" required minLength={10} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className={`${inputClass} mt-1`} placeholder="Ticket #, what you need to look at and why" />
        </label>
        <fieldset className="md:col-span-2 text-sm">
          <legend className="text-slate-600 dark:text-slate-300 mb-1">Access</legend>
          <label className="mr-4"><input type="radio" name="access" checked={access === 'READ_ONLY'} onChange={() => setAccess('READ_ONLY')} /> Read-only</label>
          <label><input type="radio" name="access" checked={access === 'READ_WRITE'} onChange={() => setAccess('READ_WRITE')} /> Read-write (choose what)</label>
          {access === 'READ_WRITE' && (
            <div className="mt-2 grid sm:grid-cols-2 lg:grid-cols-3 gap-1 max-h-48 overflow-y-auto p-2 rounded-lg border border-slate-200 dark:border-slate-700">
              {list.writePermissions.map((p) => (
                <label key={p.name} className="flex items-start gap-2 text-xs" title={p.description}>
                  <input type="checkbox" checked={permissions.includes(p.name)}
                    onChange={(e) => setPermissions(e.target.checked ? [...permissions, p.name] : permissions.filter((x) => x !== p.name))} />
                  <span><span className="font-mono">{p.name}</span><br /><span className="text-slate-400">{p.description}</span></span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <div className="md:col-span-2 flex items-center gap-3">
          <button type="submit" className={primaryButtonClass} disabled={busy || !tenantId}>{busy ? 'Sending…' : 'Ask for access'}</button>
          {message && <span role="status" className={`text-sm ${message.ok ? 'text-green-600' : 'text-red-600'}`}>{message.text}</span>}
        </div>
      </form>
    </Card>
  );
}
