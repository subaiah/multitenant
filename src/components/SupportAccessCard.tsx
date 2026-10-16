/** The organization's view of platform support: who had access, why, and ending it. */
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { apiPost } from '../lib/api-client';
import { Badge, Card, formatRelative, formatDateTime } from './ui';

interface Access {
  id: string;
  staff: string;
  staffEmail: string;
  approvedBy: string | null;
  reason: string;
  access: 'READ_ONLY' | 'READ_WRITE';
  permissions: string[];
  status: string;
  validFrom: string | null;
  validTo: string | null;
}

export function SupportAccessCard() {
  const { hasPermission } = useAuth();
  const list = useApi<Access[]>(hasPermission('audit:read') ? '/support-access' : null);
  if (!hasPermission('audit:read')) return null;
  const canEnd = hasPermission('settings:manage');
  const end = async (id: string) => {
    if (!window.confirm('End this support session now? Platform support loses access at once.')) return;
    await apiPost(`/support-access/${id}/end`).catch(() => {});
    await list.reload();
  };
  return (
    <Card title="Platform support access" description="Platform staff can only see your organization's data during a session someone approved, for a limited time. Everything they do is in the audit log.">
      {!list.data?.length ? (
        <p className="text-sm text-slate-500">{list.loading ? 'Loading…' : 'No platform support sessions yet.'}</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-700 text-sm">
          {list.data.map((s) => (
            <li key={s.id} className="py-2.5 flex flex-wrap items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-slate-800 dark:text-white">
                  {s.staff} · {s.access === 'READ_ONLY' ? 'read-only' : `read-write (${s.permissions.join(', ')})`}
                </p>
                <p className="text-xs text-slate-500">{s.reason}</p>
                <p className="text-xs text-slate-400">
                  {s.validFrom && `from ${formatDateTime(s.validFrom)}`}{s.validTo && ` until ${formatDateTime(s.validTo)}`}
                  {s.approvedBy && ` · approved by ${s.approvedBy}`}
                </p>
              </div>
              <Badge value={s.status} />
              {s.status === 'ACTIVE' && canEnd && (
                <button className="text-sm font-medium text-red-600 hover:text-red-700" onClick={() => void end(s.id)}>End now</button>
              )}
              {s.status !== 'ACTIVE' && <span className="text-xs text-slate-400">{formatRelative(s.validTo)}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
