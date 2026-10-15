import { useEffect, useState } from 'react';
import { Database, ShieldCheck, HardDrive, Plug, Lock } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiPatch } from '../lib/api-client';
import { Card, DataView, PageHeader, StatCard, formatRelative, humanize, inputClass, primaryButtonClass, secondaryButtonClass } from '../components/ui';

interface DatabaseConfig {
  strategy: string;
  provider: string;
  region: string;
  backupEnabled: boolean;
  encryptionAtRest: boolean;
  maxConnections: number;
  storageLimit: string;
  schemaName: string | null;
  databaseName: string | null;
  tenantColumn: string | null;
  dbRoleName: string | null;
  lastMigration: string | null;
  migratedAt: string | null;
  migrationError: string | null;
  hasConnectionString: boolean;
  updatedAt: string;
}
interface Strategy {
  id: string;
  name: string;
  description: string;
  pros: string[];
  cons: string[];
  bestFor: string;
}

const PROVIDER_NAMES: Record<string, string> = { POSTGRESQL: 'PostgreSQL', MYSQL: 'MySQL', MONGODB: 'MongoDB', SQLSERVER: 'SQL Server' };

export default function DataIsolation() {
  const config = useApi<DatabaseConfig>('/database');
  const strategies = useApi<Strategy[]>('/database/strategies');

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Data Isolation" description="How your organization's data is separated from other tenants" />
      <DataView {...config}>
        {(c) => (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard label="Isolation strategy" value={strategies.data?.find((s) => s.id === c.strategy)?.name ?? humanize(c.strategy)} icon={Database} tone="blue" />
              <StatCard label="Database" value={PROVIDER_NAMES[c.provider] ?? c.provider} icon={Plug} tone="purple" hint={c.region} />
              <StatCard label="Storage limit" value={c.storageLimit} icon={HardDrive} tone="amber" />
              <StatCard label="Protection" value={[c.backupEnabled && 'Backups', c.encryptionAtRest && 'Encrypted'].filter(Boolean).join(' · ') || 'None'}
                icon={ShieldCheck} tone={c.backupEnabled && c.encryptionAtRest ? 'green' : 'red'} />
            </div>
            <DatabaseForm config={c} strategies={strategies.data ?? []} onSaved={config.reload} />
          </>
        )}
      </DataView>
    </div>
  );
}

/** Where the data lives: chosen when the tenant was created and fixed after that */
function Placement({ config, strategy }: { config: DatabaseConfig; strategy?: Strategy }) {
  const where =
    config.strategy === 'DATABASE_PER_TENANT' ? ['Database', config.databaseName]
    : config.strategy === 'SCHEMA_PER_TENANT' ? ['Schema', config.schemaName]
    : ['Shared tables, separated by column', config.tenantColumn ?? 'tenant_id'];
  const rows: [string, React.ReactNode][] = [
    [where[0] as string, <code className="font-mono">{where[1]}</code>],
    ['Database role', <code className="font-mono">{config.dbRoleName ?? '—'}</code>],
    ['Row-level security', <span className="text-green-700 dark:text-green-400">On for every table: this organization's role only sees its own rows</span>],
    ['Schema version', config.migrationError
      ? <span className="text-red-600">Last update failed: {config.migrationError}</span>
      : <span>{config.lastMigration ?? '—'}{config.migratedAt && <span className="text-slate-500"> · updated {formatRelative(config.migratedAt).toLowerCase()}</span>}</span>],
  ];
  return (
    <Card title="Where your data lives">
      <div className="flex items-start gap-3 p-4 rounded-lg bg-slate-50 dark:bg-slate-900">
        <Lock size={18} className="mt-0.5 text-slate-400 shrink-0" />
        <div className="text-sm">
          <p className="font-medium text-slate-800 dark:text-white">{strategy?.name ?? humanize(config.strategy)}</p>
          {strategy && <p className="text-slate-500 mt-1">{strategy.description}</p>}
          <p className="text-slate-500 mt-2">Chosen when your organization was set up. It can't be changed here, because moving existing data between modes needs a dedicated migration.</p>
        </div>
      </div>
      <dl className="mt-4 divide-y divide-slate-100 dark:divide-slate-700 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col sm:flex-row sm:gap-4 py-2">
            <dt className="sm:w-56 shrink-0 text-slate-500">{label}</dt>
            <dd className="text-slate-800 dark:text-slate-200 break-all">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function DatabaseForm({ config, strategies, onSaved }: { config: DatabaseConfig; strategies: Strategy[]; onSaved: () => Promise<void> }) {
  const initial = {
    backupEnabled: config.backupEnabled,
    encryptionAtRest: config.encryptionAtRest,
    storageLimit: config.storageLimit,
  };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setForm(initial), [config.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPatch('/database', form);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Placement config={config} strategy={strategies.find((s) => s.id === config.strategy)} />

      <Card title="Settings">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Storage limit</span>
            <input value={form.storageLimit} onChange={(e) => setForm({ ...form, storageLimit: e.target.value })} placeholder="50 GB" className={`${inputClass} mt-1`} /></label>
          <div />
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"><input type="checkbox" checked={form.backupEnabled} onChange={(e) => setForm({ ...form, backupEnabled: e.target.checked })} /> Automated backups</label>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"><input type="checkbox" checked={form.encryptionAtRest} onChange={(e) => setForm({ ...form, encryptionAtRest: e.target.checked })} /> Encryption at rest</label>
        </div>
        {error && <p className="text-sm text-red-600 mt-3" role="alert">{error}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button className={secondaryButtonClass} disabled={!dirty || saving} onClick={() => setForm(initial)}>Reset</button>
          <button className={primaryButtonClass} disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </Card>
    </>
  );
}
