import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Building2, Search, X, Users, Package, Clock, Calendar, ChevronLeft, ChevronRight, Plus, Loader2, AlertTriangle, RotateCw, Trash2, Database, KeyRound, ArrowUpCircle } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { apiDelete, apiPatch, apiPost } from '../lib/api-client';
import { Dialog, Field } from '../components/Dialog';
import {
  Badge, Card, DataView, EmptyState, PageHeader, formatDate, formatRelative, humanize, inputClass, selectClass, primaryButtonClass, secondaryButtonClass,
} from '../components/ui';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  primaryColor: string | null;
  customDomain: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  _count: { users: number; applications: number };
  usageRefreshedAt: string | null;
  isolation: Isolation | null;
  provisioningStatus: 'PENDING' | 'PROVISIONING' | 'READY' | 'FAILED' | 'DEPROVISIONING';
  provisioningError: string | null;
  migration: { last: string | null; at: string | null; error: string | null; behind: boolean } | null;
}
type Isolation = 'SHARED_TABLES' | 'SCHEMA_PER_TENANT' | 'DATABASE_PER_TENANT';

const ISOLATION: Record<Isolation, { label: string; description: string }> = {
  SHARED_TABLES: { label: 'Shared tables', description: 'Rows in the shared database, kept apart by row-level security. Cheapest; fine for most tenants.' },
  SCHEMA_PER_TENANT: { label: 'Own schema', description: 'Its own schema in the shared database. Stronger separation; easy per-tenant export.' },
  DATABASE_PER_TENANT: { label: 'Own database', description: 'A database of its own. Strongest separation; for regulated or large customers.' },
};

/** Provisioning in progress: the card shows it, and the list refreshes until it's done */
const busy = (t: Tenant) => t.provisioningStatus === 'PENDING' || t.provisioningStatus === 'PROVISIONING' || (t.provisioningStatus === 'DEPROVISIONING' && !t.provisioningError);

function ProvisioningBadge({ tenant }: { tenant: Tenant }) {
  if (tenant.provisioningStatus === 'READY') return null;
  if (tenant.provisioningStatus === 'FAILED' || tenant.provisioningError) {
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400"><AlertTriangle size={12} />{tenant.provisioningStatus === 'DEPROVISIONING' ? 'Delete failed' : 'Setup failed'}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
      <Loader2 size={12} className="animate-spin" />{tenant.provisioningStatus === 'DEPROVISIONING' ? 'Deleting…' : 'Setting up…'}
    </span>
  );
}
interface TenantList {
  data: Tenant[];
  migrations: { latest: string | null; tenantsBehind: number };
  statusCounts: Record<string, number>;
  pagination: { page: number; limit: number; total: number; pages: number };
}

const STATUSES = ['ACTIVE', 'TRIAL', 'SUSPENDED'];
const PLANS = ['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE'];
const PAGE_SIZE = 12;

export default function Tenants() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const plan = params.get('plan') ?? '';
  const search = params.get('search') ?? '';
  const page = Number(params.get('page') ?? '1');
  const [selected, setSelected] = useState<Tenant | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { hasPermission } = useAuth();

  const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  if (status) query.set('status', status);
  if (plan) query.set('plan', plan);
  if (search) query.set('search', search);
  const list = useApi<TenantList>(`/tenants?${query}`);

  // Follow tenants being set up or deleted until they're done
  const anyBusy = list.data?.data.some(busy) ?? false;
  useEffect(() => {
    if (!anyBusy) return;
    const timer = setInterval(() => void list.reload(), 2000);
    return () => clearInterval(timer);
  }, [anyBusy, list.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Tenants" description="Every organization on the platform"
        actions={hasPermission('tenants:manage') && (
          <button onClick={() => setCreating(true)} className={primaryButtonClass}><Plus size={16} />New tenant</button>
        )} />
      {notice && <p role="status" className="text-sm text-green-700 dark:text-green-400">{notice}</p>}
      {list.data && list.data.migrations.tenantsBehind > 0 && (
        <MigrationBanner migrations={list.data.migrations} canRun={hasPermission('tenants:manage')}
          onDone={async (msg) => { setNotice(msg); await list.reload(); }} />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 p-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
          {['', ...STATUSES].map((s) => {
            const counts = list.data?.statusCounts ?? {};
            const count = s ? counts[s] ?? 0 : Object.values(counts).reduce((a, b) => a + b, 0);
            return (
              <button key={s || 'all'} onClick={() => update('status', s)}
                className={`px-3 py-1.5 text-sm rounded-md ${status === s ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 font-medium' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'}`}>
                {s ? humanize(s) : 'All'} <span className="ml-1 text-xs text-slate-400 tabular-nums">{list.data ? count : ''}</span>
              </button>
            );
          })}
        </div>
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input aria-label="Search tenants" placeholder="Search by name or slug" defaultValue={search}
            onKeyDown={(e) => e.key === 'Enter' && update('search', (e.target as HTMLInputElement).value.trim())}
            onBlur={(e) => e.target.value.trim() !== search && update('search', e.target.value.trim())}
            className={`${inputClass} pl-9`} />
        </div>
        <select aria-label="Filter by plan" value={plan} onChange={(e) => update('plan', e.target.value)} className={`${selectClass}`}>
          <option value="">All plans</option>
          {PLANS.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
        </select>
      </div>

      <DataView {...list}>
        {(l) =>
          l.data.length === 0 ? (
            <Card><EmptyState icon={Building2} title="No tenants match these filters" /></Card>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {l.data.map((t) => (
                  <button key={t.id} onClick={() => setSelected(t)}
                    className="text-left bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-500/50 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold" style={{ backgroundColor: t.primaryColor ?? '#3b82f6' }}>
                        {t.name.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-800 dark:text-white truncate">{t.name}</p>
                        <p className="text-xs text-slate-500">{t.slug}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-3">
                      <Badge value={t.plan} className="!bg-slate-100 dark:!bg-slate-700" />
                      <Badge value={t.status} />
                      {t.isolation && t.isolation !== 'SHARED_TABLES' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-300"><Database size={12} />{ISOLATION[t.isolation].label}</span>
                      )}
                      <ProvisioningBadge tenant={t} />
                      {t.migration?.behind && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"><ArrowUpCircle size={12} />Older schema</span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-4 text-sm text-slate-600 dark:text-slate-300">
                      <span className="flex items-center gap-1.5"><Users size={14} className="text-slate-400" />{t._count.users} users</span>
                      <span className="flex items-center gap-1.5"><Package size={14} className="text-slate-400" />{t._count.applications} apps</span>
                    </div>
                    <p className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 text-xs text-slate-400">
                      Created {formatDate(t.createdAt)} · Active {formatRelative(t.lastActiveAt).toLowerCase()}
                    </p>
                  </button>
                ))}
              </div>
              {l.pagination.pages > 1 && (
                <div className="flex items-center justify-between text-sm text-slate-500">
                  <span>Page {l.pagination.page} of {l.pagination.pages} · {l.pagination.total} tenants</span>
                  <div className="flex gap-2">
                    <button disabled={page <= 1} onClick={() => update('page', String(page - 1))} className={secondaryButtonClass}><ChevronLeft size={14} />Previous</button>
                    <button disabled={page >= l.pagination.pages} onClick={() => update('page', String(page + 1))} className={secondaryButtonClass}>Next<ChevronRight size={14} /></button>
                  </div>
                </div>
              )}
            </>
          )
        }
      </DataView>

      {selected && (
        <TenantPanel tenant={list.data?.data.find((t) => t.id === selected.id) ?? selected} onClose={() => setSelected(null)}
          onSaved={async () => { setSelected(null); await list.reload(); }}
          onChanged={async (msg) => { setNotice(msg); await list.reload(); }}
          onDeleted={async (msg) => { setSelected(null); setNotice(msg); await list.reload(); }} />
      )}
      {creating && (
        <NewTenantDialog onClose={() => setCreating(false)} onCreated={async (msg) => { setCreating(false); setNotice(msg); await list.reload(); }} />
      )}
    </div>
  );
}

function TenantPanel({ tenant, onClose, onSaved, onChanged, onDeleted }: {
  tenant: Tenant;
  onClose: () => void;
  onSaved: () => void;
  onChanged: (message: string) => Promise<void>;
  onDeleted: (message: string) => Promise<void>;
}) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('tenants:manage');
  const [plan, setPlan] = useState(tenant.plan);
  const [status, setStatus] = useState(tenant.status);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<'retry' | 'delete' | 'rotate' | null>(null);
  const dirty = plan !== tenant.plan || status !== tenant.status;

  const retry = async () => {
    setWorking('retry');
    setError(null);
    try {
      await apiPost(`/tenants/${tenant.id}/provision`);
      await onChanged(`Setting up ${tenant.name} again…`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setWorking(null);
    }
  };

  const rotate = async () => {
    if (!confirm(`Give ${tenant.name}'s database role a new password? Open connections finish normally; new ones use the new password.`)) return;
    setWorking('rotate');
    setError(null);
    try {
      await apiPost(`/tenants/${tenant.id}/rotate-credentials`);
      await onChanged(`${tenant.name}'s database credentials were rotated.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rotation failed');
    } finally {
      setWorking(null);
    }
  };

  const remove = async () => {
    const what = tenant.isolation === 'DATABASE_PER_TENANT' ? 'its database' : tenant.isolation === 'SCHEMA_PER_TENANT' ? 'its schema' : 'all its data';
    if (prompt(`This deletes ${tenant.name}, ${what} and its database role. It can't be undone.\n\nType the address "${tenant.slug}" to confirm.`) !== tenant.slug) return;
    setWorking('delete');
    setError(null);
    try {
      await apiDelete(`/tenants/${tenant.id}`);
      await onDeleted(`${tenant.name} was deleted.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      await onChanged('');
    } finally {
      setWorking(null);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`/tenants/${tenant.id}`, { plan, status });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <aside role="dialog" aria-label={tenant.name} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md h-full overflow-y-auto bg-white dark:bg-slate-800 p-6 space-y-6 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 dark:text-white">{tenant.name}</h3>
            <p className="text-sm text-slate-500">{tenant.slug}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700"><X size={18} /></button>
        </div>

        <dl className="grid grid-cols-2 gap-4 text-sm">
          {[
            [Users, 'Users', tenant._count.users],
            [Package, 'Deployed apps', tenant._count.applications],
            [Calendar, 'Created', formatDate(tenant.createdAt)],
            [Clock, 'Last activity', formatRelative(tenant.lastActiveAt)],
          ].map(([Icon, label, value]) => {
            const I = Icon as typeof Users;
            return (
              <div key={label as string} className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900">
                <dt className="flex items-center gap-1.5 text-xs text-slate-500"><I size={13} />{label as string}</dt>
                <dd className="mt-1 font-medium text-slate-800 dark:text-white">{value as string}</dd>
              </div>
            );
          })}
        </dl>
        {tenant.customDomain && <p className="text-sm text-slate-600 dark:text-slate-300">Custom domain: <span className="font-mono">{tenant.customDomain}</span></p>}
        {tenant.usageRefreshedAt && <p className="-mt-3 text-xs text-slate-400">Counts as of {formatRelative(tenant.usageRefreshedAt).toLowerCase()}</p>}

        <section aria-label="Data isolation" className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 text-sm space-y-1">
          <p className="flex items-center gap-2 font-medium text-slate-800 dark:text-white"><Database size={14} />{tenant.isolation ? ISOLATION[tenant.isolation].label : '—'} · PostgreSQL<ProvisioningBadge tenant={tenant} /></p>
          {tenant.isolation && <p className="text-xs text-slate-500">{ISOLATION[tenant.isolation].description} Fixed once created.</p>}
          {tenant.migration?.last && (
            <p className="text-xs text-slate-500">Schema version <span className="font-mono">{tenant.migration.last}</span>
              {tenant.migration.behind && <span className="text-amber-700 dark:text-amber-300"> · older than the newest migration</span>}</p>
          )}
          {tenant.migration?.error && <p className="text-xs text-red-600">Last migration failed: {tenant.migration.error}</p>}
          {tenant.provisioningError && <p role="alert" className="text-xs text-red-600 break-words">{tenant.provisioningError}</p>}
          {canManage && tenant.provisioningStatus === 'READY' && (
            <button onClick={rotate} disabled={working !== null} className={`${secondaryButtonClass} mt-2`}>
              {working === 'rotate' ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}Rotate credentials
            </button>
          )}
          {canManage && tenant.provisioningStatus === 'FAILED' && (
            <button onClick={retry} disabled={working !== null} className={`${secondaryButtonClass} mt-2`}>
              <RotateCw size={14} className={working === 'retry' ? 'animate-spin' : ''} />Retry setup
            </button>
          )}
        </section>

        <div className="space-y-3">
          <label className="block text-sm">
            <span className="text-slate-600 dark:text-slate-300">Plan</span>
            <select value={plan} disabled={!canManage} onChange={(e) => setPlan(e.target.value)} className={`${inputClass} mt-1`}>
              {PLANS.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-slate-600 dark:text-slate-300">Status</span>
            <select value={status} disabled={!canManage} onChange={(e) => setStatus(e.target.value)} className={`${inputClass} mt-1`}>
              {STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </select>
          </label>
          {!canManage && <p className="text-xs text-slate-500">Only platform admins can change plan or status.</p>}
          {status === 'SUSPENDED' && tenant.status !== 'SUSPENDED' && (
            <p className="text-xs text-red-600 dark:text-red-400">Suspending blocks every user in this tenant from signing in.</p>
          )}
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
          {canManage && (
            <button onClick={save} disabled={!dirty || saving} className={primaryButtonClass}>{saving ? 'Saving…' : 'Save changes'}</button>
          )}
        </div>

        {canManage && (
          <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
            <button onClick={remove} disabled={working !== null || busy(tenant)}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent">
              {working === 'delete' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              {tenant.provisioningStatus === 'DEPROVISIONING' ? 'Delete again' : 'Delete tenant'}
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

function NewTenantDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (message: string) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [plan, setPlan] = useState('FREE');
  const [status, setStatus] = useState('ACTIVE');
  const [strategy, setStrategy] = useState<Isolation>('SHARED_TABLES');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const t = await apiPost<{ name: string; adminInvited: string }>('/tenants', { name, slug, plan, status, strategy, adminName, adminEmail });
      onCreated(`${t.name} is being set up. ${t.adminInvited} gets an invitation once it's ready.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the tenant');
      setSaving(false);
    }
  };

  return (
    <Dialog title="New tenant" onClose={onClose} onSubmit={submit} wide>
      <Field label="Organization name">
        <input required minLength={2} value={name} autoFocus className={inputClass}
          onChange={(e) => { setName(e.target.value); if (!slugEdited) setSlug(slugify(e.target.value)); }} />
      </Field>
      <Field label="Sign-in address" hint="Lowercase letters, digits and hyphens. Users sign in with this; it can't be changed later.">
        <input required pattern="[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?" value={slug} className={`${inputClass} font-mono`}
          onChange={(e) => { setSlug(e.target.value.toLowerCase()); setSlugEdited(true); }} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Plan">
          <select value={plan} onChange={(e) => setPlan(e.target.value)} className={inputClass}>
            {PLANS.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
            {['ACTIVE', 'TRIAL'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </select>
        </Field>
      </div>
      <fieldset>
        <legend className="text-sm text-slate-600 dark:text-slate-300">Data isolation</legend>
        <div className="mt-1 space-y-2">
          {(Object.keys(ISOLATION) as Isolation[]).map((key) => (
            <label key={key} className={`flex gap-3 p-3 rounded-lg border cursor-pointer ${strategy === key ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10' : 'border-slate-200 dark:border-slate-700'}`}>
              <input type="radio" name="strategy" value={key} checked={strategy === key} onChange={() => setStrategy(key)} className="mt-1" />
              <span className="text-sm">
                <span className="block font-medium text-slate-800 dark:text-white">{ISOLATION[key].label}</span>
                <span className="block text-xs text-slate-500">{ISOLATION[key].description}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-500">All three run on PostgreSQL, the only supported database (isolation relies on its roles and row-level security). Can't be changed once the tenant has data.</p>
      </fieldset>
      <p className="pt-2 text-sm font-medium text-slate-700 dark:text-slate-200">First administrator</p>
      <Field label="Name">
        <input required minLength={2} value={adminName} onChange={(e) => setAdminName(e.target.value)} className={inputClass} />
      </Field>
      <Field label="Email" hint="They get an invitation to set a password.">
        <input required type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className={inputClass} />
      </Field>
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className={secondaryButtonClass}>Cancel</button>
        <button type="submit" disabled={saving} className={primaryButtonClass}>{saving ? 'Creating…' : 'Create tenant'}</button>
      </div>
    </Dialog>
  );
}

function MigrationBanner({ migrations, canRun, onDone }: {
  migrations: { latest: string | null; tenantsBehind: number };
  canRun: boolean;
  onDone: (message: string) => Promise<void>;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await apiPost<{ succeeded: unknown[]; failed: { target: string; error: string }[]; tenantsBehind: number }>('/platform/tenant-migrations');
      if (r.failed.length) setError(`${r.failed.length} failed: ${r.failed.map((f) => `${f.target} (${f.error})`).join('; ')}`);
      await onDone(`Migrations ran on ${r.succeeded.length} tenant location${r.succeeded.length === 1 ? '' : 's'} (databases and schemas).${r.tenantsBehind ? ` ${r.tenantsBehind} still behind.` : ''}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Running migrations failed');
    } finally {
      setRunning(false);
    }
  };
  const n = migrations.tenantsBehind;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 p-3 rounded-lg border border-amber-200 bg-amber-50 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      <ArrowUpCircle size={16} />
      <span className="flex-1 min-w-[200px]">
        {n} tenant{n === 1 ? ' is' : 's are'} on an older schema than <span className="font-mono">{migrations.latest}</span>.
        {error && <span className="block text-red-700 dark:text-red-300 mt-1">{error}</span>}
      </span>
      {canRun && (
        <button onClick={run} disabled={running} className={secondaryButtonClass}>
          {running ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}Run migrations
        </button>
      )}
    </div>
  );
}
