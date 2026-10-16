import { useSearchParams } from 'react-router-dom';
import { Search, Activity, Rocket, Settings, Users, DollarSign, AlertTriangle, KeyRound, Code, ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Card, DataView, EmptyState, PageHeader, StatCard, formatRelative, humanize, inputClass, selectClass, secondaryButtonClass, formatDateTime } from '../components/ui';

interface ActivityRow {
  id: string;
  action: string;
  target: string;
  type: string;
  createdAt: string;
  user: { name: string | null; email: string } | null;
}
interface ActivityPage {
  data: ActivityRow[];
  pagination: { page: number; limit: number; total: number; pages: number };
}
interface ActivityStats {
  total: number;
  last24Hours: number;
  last7Days: number;
  byType: Record<string, number>;
}

const TYPES: Record<string, { icon: LucideIcon; color: string }> = {
  DEPLOY: { icon: Rocket, color: 'bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400' },
  CONFIG: { icon: Settings, color: 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400' },
  USER: { icon: Users, color: 'bg-green-100 text-green-600 dark:bg-green-500/20 dark:text-green-400' },
  AUTH: { icon: KeyRound, color: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-400' },
  API: { icon: Code, color: 'bg-slate-100 text-slate-600 dark:bg-slate-500/20 dark:text-slate-300' },
  BILLING: { icon: DollarSign, color: 'bg-purple-100 text-purple-600 dark:bg-purple-500/20 dark:text-purple-400' },
  ALERT: { icon: AlertTriangle, color: 'bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-400' },
};
const PAGE_SIZE = 25;

export default function ActivityLog() {
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const type = params.get('type') ?? '';
  const page = Number(params.get('page') ?? '1');

  const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  if (type) query.set('type', type);
  if (search) query.set('search', search);
  const list = useApi<ActivityPage>(`/activities?${query}`);
  const stats = useApi<ActivityStats>('/activities/stats');

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Activity Log" description="Everything that has happened in your organization" />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard label="Events, last 24 hours" value={stats.data?.last24Hours ?? '—'} icon={Activity} tone="blue" />
        <StatCard label="Events, last 7 days" value={stats.data?.last7Days ?? '—'} icon={Activity} tone="green" />
        <StatCard label="Events, all time" value={stats.data?.total.toLocaleString() ?? '—'} icon={Activity} tone="slate" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input aria-label="Search activity" placeholder="Search actions and targets" defaultValue={search}
            onKeyDown={(e) => e.key === 'Enter' && update('search', (e.target as HTMLInputElement).value.trim())}
            onBlur={(e) => e.target.value.trim() !== search && update('search', e.target.value.trim())}
            className={`${inputClass} pl-9`} />
        </div>
        <select aria-label="Filter by type" value={type} onChange={(e) => update('type', e.target.value)} className={`${selectClass}`}>
          <option value="">All types</option>
          {Object.keys(TYPES).map((t) => (
            <option key={t} value={t}>{humanize(t)}{stats.data ? ` (${stats.data.byType[t] ?? 0})` : ''}</option>
          ))}
        </select>
      </div>

      <DataView {...list}>
        {(l) =>
          l.data.length === 0 ? (
            <Card><EmptyState title={search || type ? 'No activity matches these filters' : 'No activity yet'} /></Card>
          ) : (
            <>
              <Card className="!p-0">
                <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                  {l.data.map((a) => {
                    const cfg = TYPES[a.type] ?? TYPES.API;
                    const Icon = cfg.icon;
                    return (
                      <li key={a.id} className="flex items-center gap-4 px-5 py-3">
                        <span className={`p-2 rounded-lg ${cfg.color}`}><Icon size={16} /></span>
                        <div className="min-w-0 flex-1 text-sm">
                          <p className="text-slate-700 dark:text-slate-200">
                            <span className="font-medium">{a.user?.name || a.user?.email || 'System'}</span> {a.action}{' '}
                            <span className="text-slate-500 dark:text-slate-400">{a.target}</span>
                          </p>
                          <p className="text-xs text-slate-400 mt-0.5">{humanize(a.type)} · {formatDateTime(a.createdAt)}</p>
                        </div>
                        <span className="text-xs text-slate-400 shrink-0">{formatRelative(a.createdAt)}</span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
              {l.pagination.pages > 1 && (
                <div className="flex items-center justify-between text-sm text-slate-500">
                  <span>Page {l.pagination.page} of {l.pagination.pages} · {l.pagination.total} events</span>
                  <div className="flex gap-2">
                    <button disabled={page <= 1} onClick={() => update('page', String(page - 1))} className={secondaryButtonClass}><ChevronLeft size={14} />Newer</button>
                    <button disabled={page >= l.pagination.pages} onClick={() => update('page', String(page + 1))} className={secondaryButtonClass}>Older<ChevronRight size={14} /></button>
                  </div>
                </div>
              )}
            </>
          )
        }
      </DataView>
    </div>
  );
}
