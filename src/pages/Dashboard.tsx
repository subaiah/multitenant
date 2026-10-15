import { Link } from 'react-router-dom';
import { Users, Package, Building2, UsersRound, AlertTriangle } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { Badge, Card, CHART_TOOLTIP, DataView, EmptyState, PageHeader, StatCard, formatRelative, humanize } from '../components/ui';

interface TenantDashboard {
  tenant: { name: string; plan: string; status: string };
  applications: { total: number; byStatus: Record<string, number> };
  applicationsByEnvironment: Record<string, number>;
  users: { total: number };
  counts: { groups: number; organizations: number; entitledApplications: number };
  activityByDay: { date: string; count: number }[];
  activityByType: Record<string, number>;
  recentActivities: { id: string; action: string; target: string; type: string; user: string; timestamp: string }[];
}

const ENVIRONMENTS = ['PRODUCTION', 'STAGING', 'DEVELOPMENT'];

export default function Dashboard() {
  const { user, hasPermission } = useAuth();
  const dashboard = useApi<TenantDashboard>('/bff/dashboard');

  return (
    <div className="p-6 space-y-6">
      <DataView {...dashboard}>
        {(d) => {
          const running = d.applications.byStatus.RUNNING ?? 0;
          const failing = d.applications.byStatus.ERROR ?? 0;
          const days = d.activityByDay.map((x) => ({ ...x, label: x.date.slice(5) }));
          const types = Object.entries(d.activityByType).sort((a, b) => b[1] - a[1]);
          const totalEvents = types.reduce((sum, [, n]) => sum + n, 0);
          return (
            <>
              <PageHeader
                title={`Welcome back${user?.name ? `, ${user.name}` : ''}`}
                description={`${d.tenant.name} · ${humanize(d.tenant.plan)} plan`}
                actions={<Badge value={d.tenant.status} />}
              />

              {failing > 0 && (
                <div className="flex items-center gap-3 p-4 rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 text-sm text-red-700 dark:text-red-300">
                  <AlertTriangle size={18} />
                  {failing} deployed application{failing === 1 ? ' is' : 's are'} in an error state.
                  <Link to="/applications?status=ERROR" className="font-medium underline">Review</Link>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard label="Users" value={d.users.total} icon={Users} tone="purple" />
                <StatCard label="Apps running" value={`${running}/${d.applications.total}`} icon={Package} tone={failing ? 'red' : 'green'} />
                <StatCard label="Groups" value={d.counts.groups} icon={UsersRound} tone="blue" />
                <StatCard label="Organizations" value={d.counts.organizations} icon={Building2} tone="amber"
                  hint={`${d.counts.entitledApplications} entitled app${d.counts.entitledApplications === 1 ? '' : 's'}`} />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <Card title="Activity" description="Events in this tenant, last 14 days" className="lg:col-span-2">
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={days}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                      <XAxis dataKey="label" stroke="#94a3b8" fontSize={12} />
                      <YAxis stroke="#94a3b8" fontSize={12} allowDecimals={false} />
                      <Tooltip {...CHART_TOOLTIP} cursor={{ fill: 'rgba(148,163,184,0.1)' }} formatter={(v) => [v, 'Events']} />
                      <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </Card>

                <Card title="Event types" description="All time">
                  {types.length === 0 ? (
                    <EmptyState title="No activity yet" />
                  ) : (
                    <ul className="space-y-3">
                      {types.map(([type, n]) => (
                        <li key={type}>
                          <div className="flex justify-between text-sm mb-1">
                            <span className="text-slate-600 dark:text-slate-300">{humanize(type)}</span>
                            <span className="font-medium text-slate-800 dark:text-white tabular-nums">{n}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-700">
                            <div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${(n / totalEvents) * 100}%` }} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <Card title="Deployed applications" description="By environment">
                  {d.applications.total === 0 ? (
                    <EmptyState icon={Package} title="No deployed applications" />
                  ) : (
                    <ul className="space-y-2">
                      {ENVIRONMENTS.map((env) => (
                        <li key={env} className="flex items-center justify-between text-sm">
                          <span className="text-slate-600 dark:text-slate-300">{humanize(env)}</span>
                          <span className="font-medium text-slate-800 dark:text-white tabular-nums">{d.applicationsByEnvironment[env] ?? 0}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {hasPermission('applications:read') && (
                    <Link to="/applications" className="inline-block mt-4 text-xs font-medium text-blue-600 hover:text-blue-700">View applications</Link>
                  )}
                </Card>

                <Card title="Recent activity" className="lg:col-span-2"
                  actions={hasPermission('activity:read') ? <Link to="/activity" className="text-xs font-medium text-blue-600 hover:text-blue-700">View all</Link> : undefined}>
                  {d.recentActivities.length === 0 ? (
                    <EmptyState title="No activity yet" />
                  ) : (
                    <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                      {d.recentActivities.map((a) => (
                        <li key={a.id} className="flex items-center justify-between gap-4 py-2.5 text-sm">
                          <p className="text-slate-700 dark:text-slate-200 min-w-0 truncate">
                            <span className="font-medium">{a.user}</span> {a.action}{' '}
                            <span className="text-slate-500 dark:text-slate-400">{a.target}</span>
                          </p>
                          <span className="flex items-center gap-2 shrink-0">
                            <Badge value={a.type} />
                            <span className="text-xs text-slate-400 w-20 text-right">{formatRelative(a.timestamp)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </>
          );
        }}
      </DataView>
    </div>
  );
}
