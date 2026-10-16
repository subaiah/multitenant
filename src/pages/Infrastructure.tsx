import { Link } from 'react-router-dom';
import { Cpu, MemoryStick, Activity, Server, Database } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Badge, Card, DataView, EmptyState, PageHeader, StatCard, humanize } from '../components/ui';

interface Deployment {
  id: string;
  name: string;
  status: string;
  environment: string;
  cpu: number;
  memory: number;
  requests: number;
}
interface DatabaseConfig {
  strategy: string;
  provider: string;
  region: string;
  maxConnections: number;
  storageLimit: string;
  backupEnabled: boolean;
  encryptionAtRest: boolean;
}

function Meter({ value }: { value: number }) {
  const color = value >= 85 ? 'bg-red-500' : value >= 65 ? 'bg-amber-500' : 'bg-green-500';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 rounded-full bg-slate-100 dark:bg-slate-700">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="text-xs tabular-nums text-slate-600 dark:text-slate-300 w-9">{value}%</span>
    </div>
  );
}

export default function Infrastructure() {
  const apps = useApi<{ deployments: Deployment[] }>('/deployments');
  const db = useApi<DatabaseConfig>('/database');

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Infrastructure" description="Resource usage reported by your deployed applications" />
      <DataView {...apps}>
        {({ deployments }) => {
          const running = deployments.filter((d) => d.status === 'RUNNING');
          const avg = (key: 'cpu' | 'memory') =>
            running.length ? Math.round(running.reduce((sum, d) => sum + d[key], 0) / running.length) : 0;
          const totalRequests = deployments.reduce((sum, d) => sum + d.requests, 0);
          const sorted = [...deployments].sort((a, b) => b.cpu + b.memory - (a.cpu + a.memory));
          return (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard label="Applications running" value={`${running.length}/${deployments.length}`} icon={Server} tone="green" />
                <StatCard label="Average CPU (running)" value={`${avg('cpu')}%`} icon={Cpu} tone={avg('cpu') >= 85 ? 'red' : 'blue'} />
                <StatCard label="Average memory (running)" value={`${avg('memory')}%`} icon={MemoryStick} tone={avg('memory') >= 85 ? 'red' : 'purple'} />
                <StatCard label="Requests (all apps)" value={totalRequests.toLocaleString()} icon={Activity} tone="amber" />
              </div>

              <Card title="Applications by resource use" description="Latest values reported by each application"
                actions={<Link to="/applications" className="text-xs font-medium text-blue-600 hover:text-blue-700">All applications</Link>}>
                {deployments.length === 0 ? (
                  <EmptyState icon={Server} title="No deployed applications" />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-[13px] text-slate-500 dark:text-slate-400">
                        <tr>
                          <th className="pb-2 font-medium">Application</th>
                          <th className="pb-2 font-medium">Status</th>
                          <th className="pb-2 font-medium">CPU</th>
                          <th className="pb-2 font-medium">Memory</th>
                          <th className="pb-2 font-medium text-right">Requests</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                        {sorted.map((d) => (
                          <tr key={d.id}>
                            <td className="py-2.5">
                              <p className="font-medium text-slate-800 dark:text-white">{d.name}</p>
                              <p className="text-xs text-slate-500">{humanize(d.environment)}</p>
                            </td>
                            <td className="py-2.5"><Badge value={d.status} /></td>
                            <td className="py-2.5"><Meter value={d.cpu} /></td>
                            <td className="py-2.5"><Meter value={d.memory} /></td>
                            <td className="py-2.5 text-right tabular-nums">{d.requests.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          );
        }}
      </DataView>

      <Card title="Database" actions={<Database size={18} className="text-slate-400" />}>
        <DataView {...db}>
          {(c) => (
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              {[
                ['Engine', humanize(c.provider)],
                ['Region', c.region],
                ['Isolation', humanize(c.strategy)],
                ['Storage limit', c.storageLimit],
                ['Max connections', String(c.maxConnections)],
                ['Backups', c.backupEnabled ? 'Enabled' : 'Off'],
                ['Encryption at rest', c.encryptionAtRest ? 'Enabled' : 'Off'],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-slate-500">{label}</dt>
                  <dd className="mt-0.5 font-medium text-slate-800 dark:text-white">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </DataView>
      </Card>
    </div>
  );
}
