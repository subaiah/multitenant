import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Package, Search, X, ExternalLink, Cpu, MemoryStick, Activity } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Badge, Card, DataView, EmptyState, LoadingState, PageHeader, formatDate, formatRelative, humanize, inputClass, selectClass } from '../components/ui';

interface Deployment {
  id: string;
  name: string;
  description: string | null;
  status: string;
  version: string;
  environment: string;
  url: string;
  cpu: number;
  memory: number;
  requests: number;
  lastDeployedAt: string | null;
  createdAt: string;
}
interface DeploymentList {
  deployments: Deployment[];
  counts: { byStatus: Record<string, number>; byEnvironment: Record<string, number> };
}

const STATUSES = ['RUNNING', 'DEPLOYING', 'STOPPED', 'ERROR'];
const ENVIRONMENTS = ['PRODUCTION', 'STAGING', 'DEVELOPMENT'];

export default function Deployments() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const environment = params.get('environment') ?? '';
  const search = params.get('search') ?? '';
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (environment) query.set('environment', environment);
  if (search) query.set('search', search);
  const list = useApi<DeploymentList>(`/deployments?${query}`);

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Deployments" description="Applications deployed for your organization" />

      <div className="flex flex-wrap items-center gap-3">
        {STATUSES.map((s) => (
          <button key={s} onClick={() => update('status', status === s ? '' : s)} aria-pressed={status === s}
            className={`px-3 py-1.5 text-sm rounded-lg border ${status === s ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300'}`}>
            {humanize(s)} <span className="ml-1 text-xs text-slate-400 tabular-nums">{list.data?.counts.byStatus[s] ?? 0}</span>
          </button>
        ))}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input aria-label="Search applications" placeholder="Search applications" defaultValue={search}
            onKeyDown={(e) => e.key === 'Enter' && update('search', (e.target as HTMLInputElement).value.trim())}
            onBlur={(e) => e.target.value.trim() !== search && update('search', e.target.value.trim())}
            className={`${inputClass} pl-9`} />
        </div>
        <select aria-label="Filter by environment" value={environment} onChange={(e) => update('environment', e.target.value)} className={`${selectClass}`}>
          <option value="">All environments</option>
          {ENVIRONMENTS.map((e) => <option key={e} value={e}>{humanize(e)}</option>)}
        </select>
      </div>

      <DataView {...list}>
        {(l) =>
          l.deployments.length === 0 ? (
            <Card>
              <EmptyState icon={Package} title={status || environment || search ? 'No applications match these filters' : 'No applications deployed yet'} />
            </Card>
          ) : (
            <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[13px] border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="px-5 py-3 font-medium">Application</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Environment</th>
                    <th className="px-5 py-3 font-medium">Version</th>
                    <th className="px-5 py-3 font-medium text-right">CPU</th>
                    <th className="px-5 py-3 font-medium text-right">Memory</th>
                    <th className="px-5 py-3 font-medium text-right">Requests</th>
                    <th className="px-5 py-3 font-medium">Last deployed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {l.deployments.map((d) => (
                    <tr key={d.id} onClick={() => setSelectedId(d.id)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/40">
                      <td className="px-5 py-3">
                        <p className="font-medium text-slate-800 dark:text-white">{d.name}</p>
                        {d.description && <p className="text-xs text-slate-500 truncate max-w-xs">{d.description}</p>}
                      </td>
                      <td className="px-5 py-3"><Badge value={d.status} /></td>
                      <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{humanize(d.environment)}</td>
                      <td className="px-5 py-3 font-mono text-xs text-slate-600 dark:text-slate-300">{d.version}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{d.cpu}%</td>
                      <td className="px-5 py-3 text-right tabular-nums">{d.memory}%</td>
                      <td className="px-5 py-3 text-right tabular-nums">{d.requests.toLocaleString()}</td>
                      <td className="px-5 py-3 text-slate-500">{formatRelative(d.lastDeployedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </DataView>

      {selectedId && <DeploymentPanel id={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function DeploymentPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useApi<{ deployment: Deployment; activity: { id: string; action: string; type: string; createdAt: string }[] }>(`/deployments/${id}`);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <aside role="dialog" aria-label="Application details" onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md h-full overflow-y-auto bg-white dark:bg-slate-800 p-6 shadow-xl">
        {detail.loading ? <LoadingState /> : (
          <DataView {...detail}>
            {({ deployment: d, activity }) => (
              <div className="space-y-6">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-800 dark:text-white">{d.name}</h3>
                    <div className="flex gap-2 mt-2"><Badge value={d.status} /><Badge value={d.environment} /></div>
                  </div>
                  <button onClick={onClose} aria-label="Close" className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700"><X size={18} /></button>
                </div>
                {d.description && <p className="text-sm text-slate-600 dark:text-slate-300">{d.description}</p>}
                <a href={d.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline break-all">
                  {d.url} <ExternalLink size={14} />
                </a>
                <div className="grid grid-cols-3 gap-3">
                  {[[Cpu, 'CPU', `${d.cpu}%`], [MemoryStick, 'Memory', `${d.memory}%`], [Activity, 'Requests', d.requests.toLocaleString()]].map(([Icon, label, value]) => {
                    const I = Icon as typeof Cpu;
                    return (
                      <div key={label as string} className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900">
                        <p className="flex items-center gap-1.5 text-xs text-slate-500"><I size={13} />{label as string}</p>
                        <p className="mt-1 font-semibold text-slate-800 dark:text-white tabular-nums">{value as string}</p>
                      </div>
                    );
                  })}
                </div>
                <dl className="text-sm space-y-2">
                  <div className="flex justify-between"><dt className="text-slate-500">Version</dt><dd className="font-mono">{d.version}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Last deployed</dt><dd>{formatRelative(d.lastDeployedAt)}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Created</dt><dd>{formatDate(d.createdAt)}</dd></div>
                </dl>
                <div>
                  <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Recent events</h4>
                  {activity.length === 0 ? (
                    <p className="text-sm text-slate-500">No events recorded for this application.</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {activity.map((a) => (
                        <li key={a.id} className="flex justify-between gap-3">
                          <span className="text-slate-700 dark:text-slate-200">{a.action}</span>
                          <span className="text-xs text-slate-400 shrink-0">{formatRelative(a.createdAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </DataView>
        )}
      </aside>
    </div>
  );
}
