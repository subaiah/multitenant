import { useEffect, useState } from 'react';
import { Network, Gauge, Globe, Layers } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiPatch } from '../lib/api-client';
import { Card, DataView, PageHeader, StatCard, humanize, inputClass, primaryButtonClass, secondaryButtonClass } from '../components/ui';

interface ApiConfig {
  apiGateway: string;
  rateLimit: number;
  authType: string;
  versioning: string;
  corsEnabled: boolean;
  allowedOrigins: string[];
  bffEnabled: boolean;
  bffUrl: string | null;
  updatedAt: string;
}
interface Gateway {
  id: string;
  name: string;
  description: string;
  features: string[];
}

const AUTH_TYPES = ['JWT', 'OAUTH2', 'API_KEY'];
const VERSIONING = ['URL', 'HEADER', 'QUERY'];

export default function ApiManagement() {
  const config = useApi<ApiConfig>('/api-config');
  const gateways = useApi<Gateway[]>('/api-config/gateways');

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="API Management" description="How your organization's APIs are exposed and protected" />
      <DataView {...config}>
        {(c) => (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard label="Gateway" value={gateways.data?.find((g) => g.id === c.apiGateway)?.name ?? humanize(c.apiGateway)} icon={Network} tone="blue" />
              <StatCard label="Rate limit (requests/min)" value={c.rateLimit.toLocaleString()} icon={Gauge} tone="amber" />
              <StatCard label="Allowed origins" value={c.corsEnabled ? c.allowedOrigins.length : 'CORS off'} icon={Globe} tone="green" />
              <StatCard label="Backend for frontend" value={c.bffEnabled ? 'Enabled' : 'Disabled'} icon={Layers} tone="purple" />
            </div>
            <ApiConfigForm config={c} gateways={gateways.data ?? []} onSaved={config.reload} />
          </>
        )}
      </DataView>
    </div>
  );
}

function ApiConfigForm({ config, gateways, onSaved }: { config: ApiConfig; gateways: Gateway[]; onSaved: () => Promise<void> }) {
  const initial = {
    apiGateway: config.apiGateway,
    rateLimit: config.rateLimit,
    authType: config.authType,
    versioning: config.versioning,
    corsEnabled: config.corsEnabled,
    allowedOrigins: config.allowedOrigins.join('\n'),
    bffEnabled: config.bffEnabled,
    bffUrl: config.bffUrl ?? '',
  };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setForm(initial), [config.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const gateway = gateways.find((g) => g.id === form.apiGateway);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPatch('/api-config', {
        apiGateway: form.apiGateway,
        rateLimit: form.rateLimit,
        authType: form.authType,
        versioning: form.versioning,
        corsEnabled: form.corsEnabled,
        allowedOrigins: form.allowedOrigins.split(/[\s,]+/).filter(Boolean),
        bffEnabled: form.bffEnabled,
        ...(form.bffUrl && { bffUrl: form.bffUrl }),
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Configuration">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-300">API gateway</span>
          <select value={form.apiGateway} onChange={(e) => setForm({ ...form, apiGateway: e.target.value })} className={`${inputClass} mt-1`}>
            {(gateways.length ? gateways : [{ id: form.apiGateway, name: humanize(form.apiGateway) }]).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          {gateway && <span className="block text-xs text-slate-500 mt-1">{gateway.description}</span>}
        </label>
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-300">Rate limit (requests per minute)</span>
          <input type="number" min={100} max={100000} step={100} value={form.rateLimit}
            onChange={(e) => setForm({ ...form, rateLimit: Number(e.target.value) })} className={`${inputClass} mt-1`} />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-300">Authentication</span>
          <select value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value })} className={`${inputClass} mt-1`}>
            {AUTH_TYPES.map((t) => <option key={t} value={t}>{t === 'OAUTH2' ? 'OAuth 2.0' : t === 'API_KEY' ? 'API key' : t}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-300">Versioning</span>
          <select value={form.versioning} onChange={(e) => setForm({ ...form, versioning: e.target.value })} className={`${inputClass} mt-1`}>
            {VERSIONING.map((v) => <option key={v} value={v}>{v === 'URL' ? 'URL path (/v1/…)' : v === 'HEADER' ? 'Header' : 'Query parameter'}</option>)}
          </select>
        </label>
        <div className="md:col-span-2 space-y-2">
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={form.corsEnabled} onChange={(e) => setForm({ ...form, corsEnabled: e.target.checked })} /> Allow cross-origin requests (CORS)
          </label>
          <textarea aria-label="Allowed origins" rows={3} disabled={!form.corsEnabled} value={form.allowedOrigins}
            onChange={(e) => setForm({ ...form, allowedOrigins: e.target.value })}
            placeholder={'https://app.example.com\nhttps://admin.example.com'} className={`${inputClass} font-mono`} />
          <p className="text-xs text-slate-500">One origin per line, including the scheme.</p>
        </div>
        <div className="md:col-span-2 space-y-2">
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={form.bffEnabled} onChange={(e) => setForm({ ...form, bffEnabled: e.target.checked })} /> Route the frontend through a dedicated backend-for-frontend
          </label>
          <input aria-label="BFF URL" disabled={!form.bffEnabled} value={form.bffUrl} placeholder="https://bff.example.com"
            onChange={(e) => setForm({ ...form, bffUrl: e.target.value })} className={inputClass} />
        </div>
      </div>
      {error && <p className="text-sm text-red-600 mt-3" role="alert">{error}</p>}
      <div className="flex justify-end gap-2 mt-4">
        <button className={secondaryButtonClass} disabled={!dirty || saving} onClick={() => setForm(initial)}>Reset</button>
        <button className={primaryButtonClass} disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </Card>
  );
}
