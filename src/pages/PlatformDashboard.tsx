import { Link } from 'react-router-dom';
import { Building2, Users, Package, ShieldCheck } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { Badge, Card, CHART_TOOLTIP, CATEGORY_COLORS, chartColors, DataView, EmptyState, PageHeader, StatCard, formatRelative, humanize } from '../components/ui';

interface PlatformStats {
  tenants: { total: number; byStatus: Record<string, number>; byPlan: Record<string, number>; byProvisioning: Record<string, number> };
  users: { tenant: number; platform: number };
  applications: { total: number; byStatus: Record<string, number> };
  activityByDay: { date: string; count: number }[];
  recentActivity: { id: string; action: string; target: string; type: string; tenant: string; user: string; timestamp: string }[];
  topTenants: { id: string; name: string; slug: string; plan: string; status: string; users: number; applications: number }[];
  /** Tenant figures come from periodic snapshots; this is the oldest one */
  usageAsOf: string | null;
}

const PLANS = ['ENTERPRISE', 'PROFESSIONAL', 'STARTER', 'FREE'];
const PLAN_COLORS: Record<string, string> = { ENTERPRISE: CATEGORY_COLORS[0], PROFESSIONAL: CATEGORY_COLORS[1], STARTER: CATEGORY_COLORS[2], FREE: CATEGORY_COLORS[3] };

export default function PlatformDashboard() {
  const chart = chartColors(useTheme().dark);
  const { user, previewFeatures } = useAuth();
  const stats = useApi<PlatformStats>('/platform/stats');

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title={`Welcome back${user?.name ? `, ${user.name}` : ''}`}
        description="Overview of every tenant on the platform"
      />
      <DataView {...stats}>
        {(s) => {
          const plans = PLANS.map((p) => ({ name: humanize(p), key: p, value: s.tenants.byPlan[p] ?? 0 }));
          const running = s.applications.byStatus.RUNNING ?? 0;
          const failing = s.applications.byStatus.ERROR ?? 0;
          const days = s.activityByDay.map((d) => ({ ...d, label: d.date.slice(5) }));
          const settingUp = (s.tenants.byProvisioning.PENDING ?? 0) + (s.tenants.byProvisioning.PROVISIONING ?? 0);
          const failedSetup = s.tenants.byProvisioning.FAILED ?? 0;
          return (
            <>
              <p className="-mt-3 text-xs text-slate-500">
                Tenant figures as of {s.usageAsOf ? formatRelative(s.usageAsOf).toLowerCase() : 'the next refresh'} (refreshed every few minutes)
                {settingUp > 0 && <> · {settingUp} being set up</>}
                {failedSetup > 0 && <> · <Link to="/platform/tenants" className="text-red-600 hover:underline">{failedSetup} failed to set up</Link></>}
              </p>
              <div className={`grid grid-cols-1 md:grid-cols-2 gap-4 ${previewFeatures ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
                <StatCard label="Tenants" value={s.tenants.total} icon={Building2} tone="blue"
                  hint={`${s.tenants.byStatus.ACTIVE ?? 0} active · ${s.tenants.byStatus.TRIAL ?? 0} trial`} />
                <StatCard label="Tenant users" value={s.users.tenant.toLocaleString()} icon={Users} tone="slate" />
                {previewFeatures && (
                  <StatCard label="Deployed apps running" value={`${running}/${s.applications.total}`} icon={Package}
                    tone={failing ? 'red' : 'slate'} hint={failing ? `${failing} in error` : undefined} />
                )}
                <StatCard label="Platform users" value={s.users.platform} icon={ShieldCheck} tone="slate" />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <Card title="Activity" description="Events across all tenants, last 14 days" className="lg:col-span-2">
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={days}>
                      <defs>
                        <linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={chart.accent} stopOpacity={0.2} />
                          <stop offset="95%" stopColor={chart.accent} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
                      <XAxis dataKey="label" stroke={chart.axis} fontSize={12} />
                      <YAxis stroke={chart.axis} fontSize={12} allowDecimals={false} />
                      <Tooltip {...CHART_TOOLTIP} formatter={(v) => [v, 'Events']} labelFormatter={(l) => `Date ${l}`} />
                      <Area type="monotone" dataKey="count" stroke={chart.accent} strokeWidth={2} fill="url(#activityFill)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </Card>

                <Card title="Plan distribution" description="Tenants by subscription plan">
                  {s.tenants.total === 0 ? (
                    <EmptyState title="No tenants yet" />
                  ) : (
                    <>
                      <ResponsiveContainer width="100%" height={180}>
                        <PieChart>
                          <Pie data={plans.filter((p) => p.value > 0)} dataKey="value" nameKey="name" innerRadius={50} outerRadius={75} paddingAngle={3}>
                            {plans.filter((p) => p.value > 0).map((p) => <Cell key={p.key} fill={PLAN_COLORS[p.key]} />)}
                          </Pie>
                          <Tooltip {...CHART_TOOLTIP} />
                        </PieChart>
                      </ResponsiveContainer>
                      <ul className="space-y-2 mt-3">
                        {plans.map((p) => (
                          <li key={p.key} className="flex items-center justify-between text-sm">
                            <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: PLAN_COLORS[p.key] }} />
                              {p.name}
                            </span>
                            <span className="font-medium text-slate-800 dark:text-white tabular-nums">{p.value}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </Card>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <Card title="Largest tenants" description="By number of users" className="lg:col-span-2"
                  actions={<Link to="/platform/tenants" className="text-xs font-medium text-blue-600 hover:text-blue-700">All tenants</Link>}>
                  {s.topTenants.length === 0 ? (
                    <EmptyState title="No tenants yet" />
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-[13px] text-slate-500 dark:text-slate-400">
                          <th className="pb-2 font-medium">Tenant</th>
                          <th className="pb-2 font-medium">Plan</th>
                          <th className="pb-2 font-medium">Status</th>
                          <th className="pb-2 font-medium text-right">Users</th>
                          {previewFeatures && <th className="pb-2 font-medium text-right">Apps</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                        {s.topTenants.map((t) => (
                          <tr key={t.id}>
                            <td className="py-2.5">
                              <p className="font-medium text-slate-800 dark:text-white">{t.name}</p>
                              <p className="text-xs text-slate-500">{t.slug}</p>
                            </td>
                            <td className="py-2.5 text-slate-600 dark:text-slate-300">{humanize(t.plan)}</td>
                            <td className="py-2.5"><Badge value={t.status} /></td>
                            <td className="py-2.5 text-right tabular-nums">{t.users}</td>
                            {previewFeatures && <td className="py-2.5 text-right tabular-nums">{t.applications}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>

                <Card title="Recent activity">
                  {s.recentActivity.length === 0 ? (
                    <EmptyState title="No activity yet" />
                  ) : (
                    <ul className="space-y-3">
                      {s.recentActivity.map((a) => (
                        <li key={a.id} className="text-sm">
                          <p className="text-slate-700 dark:text-slate-200">
                            <span className="font-medium">{a.user}</span> {a.action}{' '}
                            <span className="text-slate-500 dark:text-slate-400">{a.target}</span>
                          </p>
                          <p className="text-xs text-slate-400 mt-0.5">{a.tenant} · {formatRelative(a.timestamp)}</p>
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
