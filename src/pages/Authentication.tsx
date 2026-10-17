import { useEffect, useState } from 'react';
import { Plus, Trash2, X, ShieldCheck, KeyRound } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiDelete, apiPatch, apiPost } from '../lib/api-client';
import { Badge, Card, DataView, EmptyState, PageHeader, humanize, inputClass, primaryButtonClass, secondaryButtonClass } from '../components/ui';

interface Provider {
  id: string;
  provider: string;
  enabled: boolean;
  clientId: string | null;
  idpTenantId: string | null;
  domain: string | null;
  scopes: string[];
  autoProvision: boolean;
}
interface AuthConfig {
  mfaEnabled: boolean;
  sessionTimeout: number;
  maxSessionHours: number;
  passwordPolicy: string;
  ssoOnly: boolean;
  otpEnabled: boolean;
  otpExpiry: number;
  providers: Provider[];
  /** Register this with each identity provider */
  ssoRedirectUri: string;
}
interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  features: string[];
}

const POLICIES = ['STANDARD', 'STRONG', 'VERY_STRONG'];

/** Providers that need to know where the identity provider lives */
const DOMAIN_FIELD: Record<string, { label: string; placeholder: string }> = {
  OKTA: { label: 'Okta domain', placeholder: 'your-org.okta.com' },
  AUTH0: { label: 'Auth0 domain', placeholder: 'your-tenant.auth0.com' },
  CUSTOM_OIDC: { label: 'Issuer URL', placeholder: 'https://login.example.com' },
};

export default function Authentication() {
  const config = useApi<AuthConfig>('/auth-config');
  const catalog = useApi<ProviderInfo[]>('/auth-config/available-providers');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerName = (id: string) => catalog.data?.find((p) => p.id === id)?.name ?? humanize(id);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await config.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Authentication & SSO"
        description="How people in your organization sign in"
        actions={<button onClick={() => setAdding(true)} className={primaryButtonClass}><Plus size={16} />Add provider</button>}
      />
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      <DataView {...config}>
        {(c) => (
          <>
            <SecuritySettings config={c} onSave={(patch) => run(() => apiPatch('/auth-config', patch))} />

            <Card title="Identity providers" description="Single sign-on connections for this organization">
              <p className="mb-3 text-xs text-slate-500">
                Register this redirect URI with each provider: <code className="font-mono select-all text-slate-700 dark:text-slate-300">{c.ssoRedirectUri}</code>
              </p>
              {c.providers.length === 0 ? (
                <EmptyState icon={KeyRound} title="No identity providers" message="People sign in with a password or one-time code until you add one." />
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                  {c.providers.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-4 py-3">
                      <div>
                        <p className="font-medium text-slate-800 dark:text-white">{providerName(p.provider)}</p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {p.clientId ? <>Client ID <span className="font-mono">{p.clientId}</span></> : 'No client ID set'}
                          {p.domain && <> · {p.domain}</>}
                          {p.autoProvision && <> · auto-provisions users</>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge value={p.enabled ? 'ACTIVE' : 'INACTIVE'} />
                        <button className={secondaryButtonClass} onClick={() => run(() => apiPatch(`/auth-config/providers/${p.id}`, { enabled: !p.enabled }))}>
                          {p.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button aria-label={`Remove ${providerName(p.provider)}`} className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
                          onClick={() => confirm(`Remove ${providerName(p.provider)}?`) && run(() => apiDelete(`/auth-config/providers/${p.id}`))}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </DataView>

      {adding && (
        <AddProviderDialog
          catalog={catalog.data ?? []}
          onClose={() => setAdding(false)}
          onAdd={async (body) => {
            await apiPost('/auth-config/providers', body);
            setAdding(false);
            await config.reload();
          }}
        />
      )}
    </div>
  );
}

function SecuritySettings({ config, onSave }: { config: AuthConfig; onSave: (patch: Partial<AuthConfig>) => Promise<void> }) {
  const initial = {
    mfaEnabled: config.mfaEnabled,
    sessionTimeout: config.sessionTimeout,
    maxSessionHours: config.maxSessionHours,
    passwordPolicy: config.passwordPolicy,
    ssoOnly: config.ssoOnly,
    otpEnabled: config.otpEnabled,
    otpExpiry: config.otpExpiry,
  };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(initial), [JSON.stringify(initial)]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const toggle = (key: 'mfaEnabled' | 'ssoOnly' | 'otpEnabled', label: string, hint: string) => (
    <label className="flex items-start justify-between gap-4 p-3 rounded-lg bg-slate-50 dark:bg-slate-900">
      <span>
        <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
        <span className="block text-xs text-slate-500 mt-0.5">{hint}</span>
      </span>
      <input type="checkbox" className="mt-1 h-4 w-4" checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} />
    </label>
  );

  return (
    <Card title="Sign-in security" actions={<ShieldCheck size={18} className="text-slate-400" />}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {toggle('mfaEnabled', 'Require two-factor sign-in', 'Everyone signing in with a password or emailed code also enters a code from an authenticator app (single sign-on relies on your identity provider)')}
        {toggle('ssoOnly', 'SSO only', 'Disable password and one-time-code sign-in')}
        {toggle('otpEnabled', 'One-time codes', 'Allow sign-in with an emailed code')}
        <label className="block p-3 rounded-lg bg-slate-50 dark:bg-slate-900 text-sm">
          <span className="font-medium text-slate-700 dark:text-slate-200">Code lifetime (minutes)</span>
          <input type="number" min={1} max={60} value={form.otpExpiry} disabled={!form.otpEnabled}
            onChange={(e) => setForm({ ...form, otpExpiry: Number(e.target.value) })} className={`${inputClass} mt-1`} />
        </label>
        <label className="block p-3 rounded-lg bg-slate-50 dark:bg-slate-900 text-sm">
          <span className="font-medium text-slate-700 dark:text-slate-200">Password policy</span>
          <select value={form.passwordPolicy} onChange={(e) => setForm({ ...form, passwordPolicy: e.target.value })} className={`${inputClass} mt-1`}>
            {POLICIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
          </select>
        </label>
        <label className="block p-3 rounded-lg bg-slate-50 dark:bg-slate-900 text-sm">
          <span className="font-medium text-slate-700 dark:text-slate-200">Sign out after inactivity (minutes)</span>
          <input type="number" min={5} max={1440} value={form.sessionTimeout}
            onChange={(e) => setForm({ ...form, sessionTimeout: Number(e.target.value) })} className={`${inputClass} mt-1`} />
          <span className="block text-xs text-slate-500 mt-1">A session with no activity for this long ends.</span>
        </label>
        <label className="block p-3 rounded-lg bg-slate-50 dark:bg-slate-900 text-sm">
          <span className="font-medium text-slate-700 dark:text-slate-200">Maximum session length (hours)</span>
          <input type="number" min={1} max={720} value={form.maxSessionHours}
            onChange={(e) => setForm({ ...form, maxSessionHours: Number(e.target.value) })} className={`${inputClass} mt-1`} />
          <span className="block text-xs text-slate-500 mt-1">People sign in again after this long, however active.</span>
        </label>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button className={secondaryButtonClass} disabled={!dirty || saving} onClick={() => setForm(initial)}>Reset</button>
        <button className={primaryButtonClass} disabled={!dirty || saving}
          onClick={async () => { setSaving(true); try { await onSave(form); } finally { setSaving(false); } }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Card>
  );
}

function AddProviderDialog({ catalog, onClose, onAdd }: {
  catalog: ProviderInfo[];
  onClose: () => void;
  onAdd: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [provider, setProvider] = useState(catalog[0]?.id ?? 'GOOGLE');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [domain, setDomain] = useState('');
  const [directoryId, setDirectoryId] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [autoProvision, setAutoProvision] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = catalog.find((p) => p.id === provider);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onAdd({
        provider, enabled, autoProvision,
        ...(clientId && { clientId }),
        ...(clientSecret && { clientSecret }),
        ...(domain && { domain }),
        ...(directoryId && { directoryId }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add provider');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <form role="dialog" aria-label="Add identity provider" onSubmit={submit} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-white dark:bg-slate-800 rounded-lg p-6 space-y-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800 dark:text-white">Add identity provider</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700"><X size={18} /></button>
        </div>
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-300">Provider</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} className={`${inputClass} mt-1`}>
            {catalog.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {info && <span className="block text-xs text-slate-500 mt-1">{info.description} · {info.features.join(', ')}</span>}
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Client ID</span>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} className={`${inputClass} mt-1`} /></label>
          <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Client secret</span>
            <input type="password" autoComplete="new-password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} className={`${inputClass} mt-1`} /></label>
          {DOMAIN_FIELD[provider] && (
            <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">{DOMAIN_FIELD[provider].label}</span>
              <input value={domain} onChange={(e) => setDomain(e.target.value)} required placeholder={DOMAIN_FIELD[provider].placeholder} className={`${inputClass} mt-1`} /></label>
          )}
          {provider === 'ENTRA' && (
            <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Directory (tenant) ID</span>
              <input value={directoryId} onChange={(e) => setDirectoryId(e.target.value)} className={`${inputClass} mt-1`} /></label>
          )}
        </div>
        <p className="text-xs text-slate-500">The client secret is stored server-side and is never shown again.</p>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enable now</label>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"><input type="checkbox" checked={autoProvision} onChange={(e) => setAutoProvision(e.target.checked)} /> Create accounts for new users on first sign-in</label>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>Cancel</button>
          <button type="submit" disabled={saving} className={primaryButtonClass}>{saving ? 'Adding…' : 'Add provider'}</button>
        </div>
      </form>
    </div>
  );
}
