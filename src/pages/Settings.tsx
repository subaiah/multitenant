import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { SupportAccessCard } from '../components/SupportAccessCard';
import { CustomDomainCard } from '../components/CustomDomainCard';
import { CloseOrganizationCard } from '../components/CloseOrganizationCard';
import { apiPatch } from '../lib/api-client';
import { Badge, Card, DataView, PageHeader, formatDate, humanize, inputClass, primaryButtonClass, secondaryButtonClass } from '../components/ui';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  customDomain: string | null;
  trialEndsAt: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  loginTitle: string | null;
  loginSubtitle: string | null;
  createdAt: string;
  updatedAt: string;
  _count: { users: number; applications: number };
}

export default function SettingsPage() {
  const tenant = useApi<Tenant>('/tenants/current');
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Settings" description="Your organization's profile and login page" />
      <DataView {...tenant}>{(t) => <TenantSettings tenant={t} onSaved={tenant.reload} />}</DataView>
    </div>
  );
}

function TenantSettings({ tenant, onSaved }: { tenant: Tenant; onSaved: () => Promise<void> }) {
  const { hasPermission, reload: reloadSession, previewFeatures } = useAuth();
  const canEdit = hasPermission('settings:manage');
  const initial = {
    name: tenant.name,
    logoUrl: tenant.logoUrl ?? '',
    primaryColor: tenant.primaryColor ?? '#3b82f6',
    loginTitle: tenant.loginTitle ?? '',
    loginSubtitle: tenant.loginSubtitle ?? '',
  };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(initial), [tenant.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`/tenants/${tenant.id}`, form);
      await onSaved();
      if (form.name !== tenant.name) await reloadSession(); // sidebar shows the tenant name
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof typeof form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block text-sm">
      <span className="text-slate-600 dark:text-slate-300">{label}</span>
      <input {...props} disabled={!canEdit} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className={`${inputClass} mt-1`} />
    </label>
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <Card title="Organization">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {field('name', 'Name', { required: true, minLength: 2, maxLength: 100 })}
            <div className="text-sm">
              <span className="text-slate-600 dark:text-slate-300">Sign-in address</span>
              <p className="mt-2 font-mono text-slate-800 dark:text-white">/{tenant.slug}/login</p>
            </div>
          </div>
        </Card>

        <CustomDomainCard />

        <Card title="Login page branding" description="Shown to people when they sign in to your organization">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {field('loginTitle', 'Title', { placeholder: `Welcome to ${tenant.name}`, maxLength: 100 })}
            {field('loginSubtitle', 'Subtitle', { placeholder: 'Sign in to continue', maxLength: 200 })}
            {field('logoUrl', 'Logo URL', { type: 'url', placeholder: 'https://…/logo.png' })}
            <label className="block text-sm">
              <span className="text-slate-600 dark:text-slate-300">Brand colour</span>
              <span className="flex gap-2 mt-1">
                <input type="color" aria-label="Pick brand colour" disabled={!canEdit} value={form.primaryColor}
                  onChange={(e) => setForm({ ...form, primaryColor: e.target.value })} className="h-9 w-12 rounded border border-slate-300 dark:border-slate-600 bg-transparent" />
                <input aria-label="Brand colour hex" disabled={!canEdit} value={form.primaryColor}
                  onChange={(e) => setForm({ ...form, primaryColor: e.target.value })} className={`${inputClass} font-mono`} />
              </span>
            </label>
          </div>
          <figure className="mt-5 p-5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
            <figcaption className="text-xs text-slate-500 mb-4">How your sign-in page starts</figcaption>
            {form.logoUrl ? (
              <img src={form.logoUrl} alt="" className="h-10 w-auto" />
            ) : (
              <div aria-hidden className="w-10 h-10 rounded-lg flex items-center justify-center text-white text-lg font-semibold" style={{ backgroundColor: form.primaryColor }}>
                {form.name.charAt(0)}
              </div>
            )}
            <p className="mt-3 text-xl font-semibold tracking-tight text-slate-800 dark:text-white">{form.loginTitle || `Sign in to ${form.name}`}</p>
            <p className="text-slate-600 dark:text-slate-400">{form.loginSubtitle || 'Use the account your organization gave you.'}</p>
            <div className="mt-4 h-9 max-w-xs rounded-md text-white text-sm font-medium flex items-center justify-center" style={{ backgroundColor: form.primaryColor }} aria-hidden>Sign in</div>
          </figure>

          {error && <p className="text-sm text-red-600 mt-3" role="alert">{error}</p>}
          {canEdit ? (
            <div className="flex justify-end gap-2 mt-4">
              <button className={secondaryButtonClass} disabled={!dirty || saving} onClick={() => setForm(initial)}>Reset</button>
              <button className={primaryButtonClass} disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : saved ? 'Saved' : 'Save'}</button>
            </div>
          ) : (
            <p className="text-xs text-slate-500 mt-4">Only tenant admins can change these settings.</p>
          )}
        </Card>

        <CloseOrganizationCard name={tenant.name} slug={tenant.slug} />
      </div>

      <div className="space-y-6">
        <Card title="Subscription">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Plan</dt><dd className="font-medium">{humanize(tenant.plan)}</dd></div>
            <div className="flex justify-between items-center"><dt className="text-slate-500">Status</dt><dd><Badge value={tenant.status} /></dd></div>
            {tenant.status === 'TRIAL' && tenant.trialEndsAt && <div className="flex justify-between"><dt className="text-slate-500">Trial ends</dt><dd>{formatDate(tenant.trialEndsAt)}</dd></div>}
            <div className="flex justify-between"><dt className="text-slate-500">Users</dt><dd className="tabular-nums">{tenant._count.users}</dd></div>
            {previewFeatures && <div className="flex justify-between"><dt className="text-slate-500">Deployed apps</dt><dd className="tabular-nums">{tenant._count.applications}</dd></div>}
            <div className="flex justify-between"><dt className="text-slate-500">Member since</dt><dd>{formatDate(tenant.createdAt)}</dd></div>
          </dl>
          <p className="text-xs text-slate-500 mt-4">Plan changes are handled by the platform team.</p>
        </Card>
        <SupportAccessCard />
        <Card title="Related settings">
          <ul className="space-y-2 text-sm">
            <li><Link className="text-blue-600 hover:underline" to="/authentication">Sign-in methods and security</Link></li>
            <li><Link className="text-blue-600 hover:underline" to="/api">API access</Link></li>
            <li><Link className="text-blue-600 hover:underline" to="/data-isolation">Data isolation</Link></li>
            <li><Link className="text-blue-600 hover:underline" to="/notifications?tab=organization">Notifications your organization sends</Link></li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
