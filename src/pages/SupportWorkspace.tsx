/**
 * Working in a tenant during an active support session: the tenant's own
 * pages, with every request naming the tenant (setActingTenant). The server
 * decides what's allowed: reading, plus whatever a read-write session was
 * approved for.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Eye, PenLine, Square } from 'lucide-react';
import { apiGet, apiPost, setActingTenant } from '../lib/api-client';
import { ErrorState, LoadingState, secondaryButtonClass } from '../components/ui';
import type { SupportSessionRow } from './Support';
import Users from './Users';
import Groups from './Groups';
import AuditLog from './AuditLog';
import ActivityLog from './ActivityLog';

const TABS = [
  { id: 'users', label: 'Users', render: () => <Users /> },
  { id: 'groups', label: 'Groups', render: () => <Groups /> },
  { id: 'audit', label: 'Audit log', render: () => <AuditLog scope="tenant" /> },
  { id: 'activity', label: 'Activity', render: () => <ActivityLog /> },
];

export default function SupportWorkspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<SupportSessionRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('users');
  const [, tick] = useState(0);

  useEffect(() => {
    let live = true;
    apiGet<SupportSessionRow[]>('/support-sessions/mine')
      .then((mine) => {
        const s = mine.find((x) => x.id === id && x.status === 'ACTIVE');
        if (!live) return;
        if (!s) return setError('This support session is not active (it may have ended or not been approved yet).');
        setActingTenant(s.tenantId);
        setSession(s);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load the session'));
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => {
      live = false;
      clearInterval(timer);
      setActingTenant(null);
    };
  }, [id]);

  const end = async () => {
    await apiPost(`/support-sessions/${id}/revoke`).catch(() => {});
    setActingTenant(null);
    navigate('/platform/support');
  };

  if (error) return <div className="p-6 space-y-4"><ErrorState error={error} /><Link className="text-blue-600" to="/platform/support">Back to Support</Link></div>;
  if (!session) return <LoadingState />;
  const minutesLeft = Math.max(0, Math.round((new Date(session.validTo!).getTime() - Date.now()) / 60_000));
  const readOnly = session.access === 'READ_ONLY';
  const current = TABS.find((t) => t.id === tab)!;

  return (
    <div>
      <div role="status" className={`sticky top-0 z-20 flex flex-wrap items-center gap-3 px-6 py-3 border-b text-sm ${readOnly
        ? 'bg-sky-50 border-sky-200 text-sky-900 dark:bg-sky-500/10 dark:border-sky-500/30 dark:text-sky-200'
        : 'bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-200'}`}>
        {readOnly ? <Eye size={16} /> : <PenLine size={16} />}
        <span>
          Support session in <strong>{session.tenant.name}</strong> · {readOnly ? 'read-only: changes are refused' : `read-write: ${session.permissions.join(', ')}`} · {minutesLeft} min left
        </span>
        <span className="text-xs opacity-75">Everything you do is in {session.tenant.name}'s audit log.</span>
        <div className="ml-auto flex gap-2">
          <Link to="/platform/support" className={secondaryButtonClass}>Leave</Link>
          <button className={secondaryButtonClass} onClick={end}><Square size={14} />End session</button>
        </div>
      </div>
      <div role="tablist" className="flex gap-1 px-6 pt-4 border-b border-slate-200 dark:border-slate-700">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div key={tab}>{current.render()}</div>
    </div>
  );
}
