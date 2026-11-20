import { useState } from 'react';
import { Activity, Gauge, HeartPulse, Rocket, X } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Card, DataView, EmptyState, LoadingState, PageHeader, StatCard, formatRelative } from '../components/ui';

/** How each application the organization has on is doing (backend lib/app-figures.ts) */
type Status = 'UP' | 'DEGRADED' | 'DOWN' | null;
interface Uptime { uptime: number | null; checks: number }
interface Meter { key: string; label: string; unit: string; total: number; records: number }
interface AppFigures {
  application: { id: string; key: string; name: string; description: string | null; version: string | null };
  state: string;
  setUp: boolean;
  /** Null: the application doesn't take part in health checks */
  health: (Partial<{ day: Uptime & { averageMs: number | null }; week: Uptime; month: Uptime }> & { status: Status; since: string | null; checkedAt: string | null }) | null;
  usage: { month: string; meters: Meter[] };
}
interface AppDetail extends AppFigures {
  days: { day: string; checks: number; uptime: number | null; averageMs: number | null }[];
  lastMonthUsage: { month: string; meters: Meter[] };
}

const STATUS: Record<string, { label: string; className: string }> = {
  UP: { label: 'Up', className: 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400' },
  DEGRADED: { label: 'Slow or degraded', className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' },
  DOWN: { label: 'Down', className: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400' },
  PENDING: { label: 'Not checked yet', className: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300' },
  NONE: { label: 'No health checks', className: 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400' },
};
const statusKey = (a: AppFigures) => (!a.health ? 'NONE' : a.health.status ?? 'PENDING');

function StatusPill({ app }: { app: AppFigures }) {
  const s = STATUS[statusKey(app)];
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${s.className}`}>{s.label}</span>;
}

const percent = (u: Uptime | undefined) => (u?.uptime == null ? '—' : `${(Math.floor(u.uptime * 1000) / 10).toFixed(u.uptime === 1 ? 0 : 1)}%`);
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

export default function Deployments() {
  const list = useApi<{ applications: AppFigures[] }>('/deployments');
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Deployments" description="Whether your applications are up, how reliably over the last month, and what they report using" />
      <DataView {...list}>
        {({ applications }) => {
          if (!applications.length) {
            return <Card><EmptyState icon={Rocket} title="No applications on" message="When your organization turns applications on, how each is doing appears here." /></Card>;
          }
          const checked = applications.filter((a) => a.health?.status);
          const down = checked.filter((a) => a.health!.status === 'DOWN').length;
          const monthly = checked.map((a) => a.health!.month?.uptime).filter((u): u is number => u != null);
          const timed = checked.map((a) => a.health!.day?.averageMs).filter((ms): ms is number => ms != null);
          return (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <StatCard label="Up now" value={`${checked.length - down}/${checked.length}`} icon={HeartPulse} tone={down ? 'red' : 'green'}
                  hint={applications.length > checked.length ? `${applications.length - checked.length} without health checks` : undefined} />
                <StatCard label="Uptime, last 30 days" value={monthly.length ? `${(Math.floor((monthly.reduce((s, u) => s + u, 0) / monthly.length) * 1000) / 10).toFixed(1)}%` : '—'} icon={Activity} tone="blue" hint="Average across applications" />
                <StatCard label="Response time, last day" value={timed.length ? `${Math.round(timed.reduce((s, ms) => s + ms, 0) / timed.length)} ms` : '—'} icon={Gauge} tone="purple" hint="Average of health checks" />
              </div>

              <Card title="Applications" description="Checked every minute by the platform. Select one for its last 30 days.">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate-500 border-b border-slate-200 dark:border-slate-700">
                        <th className="py-2 font-medium">Application</th>
                        <th className="py-2 font-medium">Now</th>
                        <th className="py-2 font-medium text-right">1 day</th>
                        <th className="py-2 font-medium text-right">7 days</th>
                        <th className="py-2 font-medium text-right">30 days</th>
                        <th className="py-2 font-medium text-right">Response</th>
                        <th className="py-2 font-medium pl-4">Usage this month</th>
                      </tr>
                    </thead>
                    <tbody>
                      {applications.map((a) => (
                        <tr key={a.application.id} onClick={() => setOpen(a.application.id)}
                          className="border-b border-slate-100 dark:border-slate-700/50 last:border-0 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30">
                          <td className="py-2.5">
                            <span className="font-medium text-slate-800 dark:text-white">{a.application.name}</span>
                            {a.application.version && <span className="ml-2 text-xs font-mono text-slate-500">{a.application.version}</span>}
                            {!a.setUp && <span className="block text-xs text-amber-600">Still being set up for you</span>}
                          </td>
                          <td className="py-2.5"><StatusPill app={a} />{a.health?.since && a.health.status !== 'UP' && <span className="block text-xs text-slate-500 mt-0.5">since {formatRelative(a.health.since)}</span>}</td>
                          <td className="py-2.5 text-right tabular-nums">{percent(a.health?.day)}</td>
                          <td className="py-2.5 text-right tabular-nums">{percent(a.health?.week)}</td>
                          <td className="py-2.5 text-right tabular-nums">{percent(a.health?.month)}</td>
                          <td className="py-2.5 text-right tabular-nums">{a.health?.day?.averageMs != null ? `${a.health.day.averageMs} ms` : '—'}</td>
                          <td className="py-2.5 pl-4 text-slate-600 dark:text-slate-300">
                            {a.usage.meters.length ? a.usage.meters.map((m) => `${m.total.toLocaleString()} ${m.unit}`).join(' · ') : <span className="text-slate-400">Not reported</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          );
        }}
      </DataView>
      {open && <ApplicationPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function UsageTable({ title, usage }: { title: string; usage: { month: string; meters: Meter[] } }) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">{title}: {monthName(usage.month)}</h4>
      {usage.meters.length === 0 ? <p className="text-sm text-slate-500">This application doesn't report usage.</p> : (
        <dl className="text-sm space-y-1.5">
          {usage.meters.map((m) => (
            <div key={m.key} className="flex justify-between gap-4">
              <dt className="text-slate-500">{m.label}</dt>
              <dd className="tabular-nums text-slate-800 dark:text-white">{m.total.toLocaleString()} {m.unit}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function ApplicationPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useApi<AppDetail>(`/deployments/${id}`);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <aside role="dialog" aria-label="Application details" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md h-full overflow-y-auto bg-white dark:bg-slate-800 p-6 shadow-xl">
        {detail.loading ? <LoadingState /> : (
          <DataView {...detail}>
            {(d) => (
              <div className="space-y-6">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-800 dark:text-white">{d.application.name}</h3>
                    <div className="mt-2"><StatusPill app={d} /></div>
                  </div>
                  <button onClick={onClose} aria-label="Close" className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700"><X size={18} /></button>
                </div>
                {d.application.description && <p className="text-sm text-slate-600 dark:text-slate-300">{d.application.description}</p>}

                {d.health ? (
                  <div>
                    <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Uptime, last 30 days</h4>
                    <div className="flex items-end gap-[3px] h-16" role="img" aria-label="Daily uptime for the last 30 days">
                      {d.days.map((day) => {
                        const u = day.uptime;
                        const color = u == null ? 'bg-slate-200 dark:bg-slate-700' : u >= 0.999 ? 'bg-green-500' : u >= 0.95 ? 'bg-amber-500' : 'bg-red-500';
                        return (
                          <div key={day.day} className="flex-1 flex flex-col justify-end h-full"
                            title={`${new Date(`${day.day}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC' })}: ${u == null ? 'no checks' : `${(u * 100).toFixed(1)}% of ${day.checks} checks`}${day.averageMs != null ? `, ${day.averageMs} ms` : ''}`}>
                            <div className={`rounded-sm ${color}`} style={{ height: u == null ? '15%' : `${Math.max(15, u * 100)}%` }} />
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between text-xs text-slate-500 mt-1"><span>30 days ago</span><span>Today</span></div>
                    <dl className="grid grid-cols-3 gap-3 mt-4 text-sm">
                      {([['Last day', d.health.day], ['7 days', d.health.week], ['30 days', d.health.month]] as const).map(([label, u]) => (
                        <div key={label} className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900">
                          <dt className="text-xs text-slate-500">{label}</dt>
                          <dd className="mt-1 font-semibold tabular-nums text-slate-800 dark:text-white">{percent(u)}</dd>
                        </div>
                      ))}
                    </dl>
                    {d.health.checkedAt && <p className="text-xs text-slate-500 mt-2">Last checked {formatRelative(d.health.checkedAt)}.</p>}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">This application doesn't take part in the platform's health checks.</p>
                )}

                <UsageTable title="Usage" usage={d.usage} />
                <UsageTable title="Last month" usage={d.lastMonthUsage} />
              </div>
            )}
          </DataView>
        )}
      </aside>
    </div>
  );
}
