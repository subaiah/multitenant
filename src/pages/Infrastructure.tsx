import { Database, HardDrive, Plug, Users } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Card, DataView, PageHeader, StatCard, humanize } from '../components/ui';

/** The organization's data, measured (backend lib/app-figures.ts) */
interface DatabaseFigures {
  mode: 'SHARED_TABLES' | 'SCHEMA_PER_TENANT' | 'DATABASE_PER_TENANT';
  sizeBytes: number | null;
  rows: { label: string; table: string; count: number }[];
  connections: { open: number; active: number; idle: number; limit: number | null };
  slowQueries: { query: string; calls: number; meanMs: number }[] | null;
  measuredAt: string;
}
interface DatabaseConfig {
  strategy: string;
  provider: string;
  region: string;
  maxConnections: number;
  storageLimit: string;
}

const MODE_NOTE: Record<DatabaseFigures['mode'], string> = {
  SHARED_TABLES: "Your data sits in tables shared with other organizations, kept apart row by row, so its size can't be measured on its own.",
  SCHEMA_PER_TENANT: 'Your data has its own schema in a shared database.',
  DATABASE_PER_TENANT: 'Your data has a database of its own.',
};

function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export default function Infrastructure() {
  const figures = useApi<DatabaseFigures>('/infrastructure');
  const db = useApi<DatabaseConfig>('/database');

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Infrastructure" description="Your organization's data: the room it takes, what's in it, and its open connections" />
      <DataView {...figures}>
        {(f) => {
          const people = f.rows.find((r) => r.table === 'users')?.count ?? 0;
          return (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard label="Data size" value={f.sizeBytes === null ? 'Shared' : formatBytes(f.sizeBytes)} icon={HardDrive} tone="blue"
                  hint={f.sizeBytes === null ? 'Not measurable on its own' : undefined} />
                <StatCard label="Open connections" value={f.connections.limit ? `${f.connections.open} / ${f.connections.limit}` : f.connections.open}
                  icon={Plug} tone={f.connections.limit && f.connections.open >= f.connections.limit * 0.8 ? 'red' : 'green'}
                  hint={`${f.connections.active} working, ${f.connections.idle} idle`} />
                <StatCard label="People" value={people.toLocaleString()} icon={Users} tone="purple" />
                <StatCard label="Isolation" value={humanize(f.mode)} icon={Database} tone="amber" />
              </div>

              <Card title="What's in it" description={`${MODE_NOTE[f.mode]} Measured ${new Date(f.measuredAt).toLocaleTimeString()}.`}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-200 dark:border-slate-700">
                      <th className="py-2 font-medium">Records</th>
                      <th className="py-2 font-medium text-right">Rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.rows.map((r) => (
                      <tr key={r.table} className="border-b border-slate-100 dark:border-slate-700/50 last:border-0">
                        <td className="py-2 text-slate-700 dark:text-slate-200">{r.label}</td>
                        <td className="py-2 text-right tabular-nums text-slate-800 dark:text-white">{r.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              {f.slowQueries && (
                <Card title="Slowest queries" description="The kinds of query that take longest on average on your connections (since the database's statistics were last reset)">
                  {f.slowQueries.length === 0 ? (
                    <p className="text-sm text-slate-500">None recorded yet.</p>
                  ) : (
                    <ul className="space-y-3">
                      {f.slowQueries.map((q, i) => (
                        <li key={i} className="text-sm">
                          <code className="block whitespace-pre-wrap break-all text-xs bg-slate-50 dark:bg-slate-900 rounded p-2 text-slate-700 dark:text-slate-300">{q.query}</code>
                          <span className="text-xs text-slate-500">{q.meanMs} ms on average, {q.calls.toLocaleString()} runs</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}
            </>
          );
        }}
      </DataView>

      <Card title="Database settings" actions={<Database size={18} className="text-slate-400" />}>
        <DataView {...db}>
          {(c) => (
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              {[
                ['Engine', humanize(c.provider)],
                ['Region', c.region],
                ['Storage limit', c.storageLimit],
                ['Max connections', String(c.maxConnections)],
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
