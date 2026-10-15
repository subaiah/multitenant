import { useEffect, useState } from 'react';
import { Database, ShieldCheck, HardDrive, Plug } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiPatch } from '../lib/api-client';
import { Card, DataView, PageHeader, StatCard, humanize, inputClass, primaryButtonClass, secondaryButtonClass } from '../components/ui';

interface DatabaseConfig {
  strategy: string;
  provider: string;
  region: string;
  backupEnabled: boolean;
  encryptionAtRest: boolean;
  maxConnections: number;
  storageLimit: string;
  schemaName: string | null;
  tenantColumn: string | null;
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

const PROVIDERS = ['POSTGRESQL', 'MYSQL', 'MONGODB', 'SQLSERVER'];
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
              <StatCard label="Storage limit" value={c.storageLimit} icon={HardDrive} tone="amber" hint={`${c.maxConnections} connections`} />
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

function DatabaseForm({ config, strategies, onSaved }: { config: DatabaseConfig; strategies: Strategy[]; onSaved: () => Promise<void> }) {
  const initial = {
    strategy: config.strategy,
    provider: config.provider,
    region: config.region,
    backupEnabled: config.backupEnabled,
    encryptionAtRest: config.encryptionAtRest,
    maxConnections: config.maxConnections,
    storageLimit: config.storageLimit,
    schemaName: config.schemaName ?? '',
    tenantColumn: config.tenantColumn ?? '',
    connectionString: '',
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
      const { connectionString, schemaName, tenantColumn, ...rest } = form;
      await apiPatch('/database', {
        ...rest,
        ...(schemaName && { schemaName }),
        ...(tenantColumn && { tenantColumn }),
        ...(connectionString && { connectionString }),
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card title="Isolation strategy" description="Changing this updates the configuration only. Moving existing data is a separate migration.">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {strategies.map((s) => (
            <label key={s.id} className={`block p-4 rounded-lg border-2 cursor-pointer ${form.strategy === s.id ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10' : 'border-slate-200 dark:border-slate-700'}`}>
              <span className="flex items-center gap-2">
                <input type="radio" name="strategy" checked={form.strategy === s.id} onChange={() => setForm({ ...form, strategy: s.id })} />
                <span className="font-medium text-slate-800 dark:text-white">{s.name}</span>
              </span>
              <span className="block text-xs text-slate-500 mt-2">{s.description}</span>
              <span className="block text-xs text-slate-500 mt-2"><span className="font-medium">Best for:</span> {s.bestFor}</span>
              <span className="block text-xs text-green-700 dark:text-green-400 mt-2">+ {s.pros.slice(0, 2).join(', ')}</span>
              <span className="block text-xs text-red-700 dark:text-red-400">− {s.cons.slice(0, 2).join(', ')}</span>
            </label>
          ))}
        </div>
        {form.strategy === 'DATABASE_PER_TENANT' && (
          <label className="block text-sm mt-4">
            <span className="text-slate-600 dark:text-slate-300">Connection string</span>
            <input type="password" autoComplete="off" value={form.connectionString} onChange={(e) => setForm({ ...form, connectionString: e.target.value })}
              placeholder={config.hasConnectionString ? 'Set (leave blank to keep)' : 'postgresql://user:password@host:5432/db'} className={`${inputClass} mt-1 font-mono`} />
            <span className="block text-xs text-slate-500 mt-1">Stored server-side and never shown again.</span>
          </label>
        )}
        {form.strategy === 'SCHEMA_PER_TENANT' && (
          <label className="block text-sm mt-4"><span className="text-slate-600 dark:text-slate-300">Schema name</span>
            <input value={form.schemaName} onChange={(e) => setForm({ ...form, schemaName: e.target.value })} className={`${inputClass} mt-1 font-mono`} /></label>
        )}
        {form.strategy === 'SHARED_TABLES' && (
          <label className="block text-sm mt-4"><span className="text-slate-600 dark:text-slate-300">Tenant column</span>
            <input value={form.tenantColumn} onChange={(e) => setForm({ ...form, tenantColumn: e.target.value })} placeholder="tenant_id" className={`${inputClass} mt-1 font-mono`} /></label>
        )}
      </Card>

      <Card title="Database settings">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Database engine</span>
            <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} className={`${inputClass} mt-1`}>
              {PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_NAMES[p]}</option>)}
            </select></label>
          <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Region</span>
            <input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} className={`${inputClass} mt-1`} /></label>
          <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Max connections</span>
            <input type="number" min={1} max={1000} value={form.maxConnections} onChange={(e) => setForm({ ...form, maxConnections: Number(e.target.value) })} className={`${inputClass} mt-1`} /></label>
          <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Storage limit</span>
            <input value={form.storageLimit} onChange={(e) => setForm({ ...form, storageLimit: e.target.value })} placeholder="50 GB" className={`${inputClass} mt-1`} /></label>
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
