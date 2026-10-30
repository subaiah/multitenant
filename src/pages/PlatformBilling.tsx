/**
 * Plans and billing for platform staff: each plan's limits, features and
 * per-user prices (made at Razorpay for INR, Stripe for other currencies),
 * and organizations' subscriptions. backend/src/routes/platform-billing.ts.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CreditCard } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { apiDelete, apiPost, apiPut } from '../lib/api-client';
import { formatMoney, intervalLabel, toMinorUnits } from '../lib/money';
import { Badge, Card, DataView, EmptyState, PageHeader, formatDate, inputClass, primaryButtonClass, secondaryButtonClass, selectClass } from '../components/ui';

interface Price { id: string; provider: string; currency: string; interval: 'MONTH' | 'YEAR'; unitAmount: number; active: boolean; providerPriceId: string; createdAt: string }
interface Plan {
  code: string; name: string; description: string | null; public: boolean; sortOrder: number;
  maxUsers: number | null; maxOrganizations: number | null; maxGroups: number | null; allowSso: boolean; allowCustomDomain: boolean;
  organizations: number; subscriptions: number; prices: Price[];
}
interface Plans { providers: string[]; graceDays: number; plans: Plan[] }
interface Sub {
  tenantId: string; tenant: string; slug: string | null; readOnly: boolean; provider: string; plan: string; interval: string; currency: string;
  seats: number; status: string; amount: number; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; pastDueSince: string | null; seatSyncError: string | null;
}

export default function PlatformBillingPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'subscriptions' ? 'subscriptions' : 'plans';
  const tabs = [{ id: 'plans', label: 'Plans' }, { id: 'subscriptions', label: 'Subscriptions' }];
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Plans and billing" description="What each plan allows and costs per user, and who pays for what" />
      <div role="tablist" className="flex gap-1 border-b border-slate-200 dark:border-slate-700">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setParams({ tab: t.id }, { replace: true })}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'plans' ? <PlansTab /> : <SubscriptionsTab />}
    </div>
  );
}

function PlansTab() {
  const plans = useApi<Plans>('/platform/billing/plans');
  const { hasPermission } = useAuth();
  const canManage = hasPermission('plans:manage');
  return (
    <DataView {...plans}>
      {(d) => (
        <div className="space-y-6">
          {d.providers.length === 0 && (
            <Card>
              <EmptyState icon={CreditCard} title="No payment provider is set up"
                message="Limits still apply. To take payments, set the Razorpay keys (INR) or Stripe keys (other currencies); see docs/BILLING.md." />
            </Card>
          )}
          {d.plans.map((p) => <PlanCard key={p.code} plan={p} providers={d.providers} canManage={canManage} onSaved={plans.reload} />)}
          <p className="text-xs text-slate-500">
            An organization whose payments fail keeps working for {d.graceDays} days (BILLING_GRACE_DAYS), then it's read-only until it pays.
            Limits apply when something is added; nothing is removed when a plan gets smaller.
          </p>
        </div>
      )}
    </DataView>
  );
}

const limitValue = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.floor(Number(v))));

function PlanCard({ plan, providers, canManage, onSaved }: { plan: Plan; providers: string[]; canManage: boolean; onSaved: () => void }) {
  const toForm = (p: Plan) => ({
    name: p.name, description: p.description ?? '', public: p.public,
    maxUsers: p.maxUsers?.toString() ?? '', maxOrganizations: p.maxOrganizations?.toString() ?? '', maxGroups: p.maxGroups?.toString() ?? '',
    allowSso: p.allowSso, allowCustomDomain: p.allowCustomDomain,
  });
  const [form, setForm] = useState(toForm(plan));
  useEffect(() => setForm(toForm(plan)), [plan]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [price, setPrice] = useState({ currency: providers.includes('RAZORPAY') ? 'INR' : 'USD', interval: 'MONTH', amount: '' });
  const [adding, setAdding] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(plan));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPut(`/platform/billing/plans/${plan.code}`, {
        name: form.name, description: form.description || null, public: form.public, sortOrder: plan.sortOrder,
        maxUsers: limitValue(form.maxUsers), maxOrganizations: limitValue(form.maxOrganizations), maxGroups: limitValue(form.maxGroups),
        allowSso: form.allowSso, allowCustomDomain: form.allowCustomDomain,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const addPrice = async () => {
    const amount = Number(price.amount);
    if (!(amount > 0)) return setError('Enter the price per user');
    if (!confirm(`Charge ${formatMoney(toMinorUnits(amount, price.currency), price.currency)} per user per ${intervalLabel(price.interval)} for ${plan.name}? New subscriptions use it; existing ones keep their price.`)) return;
    setAdding(true);
    setError(null);
    try {
      await apiPost(`/platform/billing/plans/${plan.code}/prices`, { currency: price.currency, interval: price.interval, unitAmount: toMinorUnits(amount, price.currency) });
      setPrice({ ...price, amount: '' });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the price');
    } finally {
      setAdding(false);
    }
  };

  const retire = async (p: Price) => {
    if (!confirm(`Stop offering ${formatMoney(p.unitAmount, p.currency)} per ${intervalLabel(p.interval)}? Subscriptions already on it continue.`)) return;
    try {
      await apiDelete(`/platform/billing/plans/${plan.code}/prices/${p.id}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the price');
    }
  };

  const number = (key: 'maxUsers' | 'maxOrganizations' | 'maxGroups', label: string) => (
    <label className="block text-sm">
      <span className="text-slate-600 dark:text-slate-300">{label}</span>
      <input type="number" min={0} inputMode="numeric" placeholder="No limit" disabled={!canManage} value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })} className={`${inputClass} mt-1`} />
    </label>
  );
  const check = (key: 'allowSso' | 'allowCustomDomain' | 'public', label: string) => (
    <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
      <input type="checkbox" disabled={!canManage} checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} className="rounded border-slate-300" />
      {label}
    </label>
  );
  const active = plan.prices.filter((p) => p.active);
  const retired = plan.prices.filter((p) => !p.active);

  return (
    <Card title={`${plan.name}`} description={`${plan.organizations} organization${plan.organizations === 1 ? '' : 's'} on this plan, ${plan.subscriptions} paying`}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="text-slate-600 dark:text-slate-300">Name</span>
              <input disabled={!canManage} value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600 dark:text-slate-300">Description</span>
              <input disabled={!canManage} value={form.description} maxLength={300} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`${inputClass} mt-1`} />
            </label>
          </div>
          <div className="grid grid-cols-3 gap-4">
            {number('maxUsers', 'Users')}
            {number('maxOrganizations', 'Organizations')}
            {number('maxGroups', 'Groups')}
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {check('allowSso', 'Single sign-on')}
            {check('allowCustomDomain', 'Custom domain')}
            {check('public', 'Offered on the Billing page')}
          </div>
          {canManage && (
            <div className="flex justify-end gap-2">
              <button className={secondaryButtonClass} disabled={!dirty || saving} onClick={() => setForm(toForm(plan))}>Reset</button>
              <button className={primaryButtonClass} disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200">Prices per user</h3>
          {plan.code === 'FREE' ? (
            <p className="text-sm text-slate-500">The Free plan has no price.</p>
          ) : (
            <>
              {active.length === 0 ? <p className="text-sm text-slate-500">No prices yet: organizations can't subscribe to this plan.</p> : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-700/60 text-sm">
                  {active.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="tabular-nums">{formatMoney(p.unitAmount, p.currency)} / {intervalLabel(p.interval)}</span>
                      <span className="text-xs text-slate-500">{p.provider === 'RAZORPAY' ? 'Razorpay' : 'Stripe'} · {p.providerPriceId}</span>
                      {canManage && <button className="text-xs text-red-600 hover:underline" onClick={() => retire(p)}>Stop offering</button>}
                    </li>
                  ))}
                </ul>
              )}
              {retired.length > 0 && <p className="text-xs text-slate-500">{retired.length} earlier price{retired.length === 1 ? '' : 's'}, kept for subscriptions still on {retired.length === 1 ? 'it' : 'them'}.</p>}
              {canManage && providers.length > 0 && (
                <div className="flex flex-wrap items-end gap-2 pt-2">
                  <label className="text-sm">
                    <span className="block text-slate-600 dark:text-slate-300">Currency</span>
                    <input value={price.currency} maxLength={3} onChange={(e) => setPrice({ ...price, currency: e.target.value.toUpperCase() })} className={`${inputClass} mt-1 w-20 uppercase`} aria-describedby={`provider-${plan.code}`} />
                  </label>
                  <label className="text-sm">
                    <span className="block text-slate-600 dark:text-slate-300">Every</span>
                    <select value={price.interval} onChange={(e) => setPrice({ ...price, interval: e.target.value })} className={`${selectClass} mt-1`}>
                      <option value="MONTH">month</option>
                      <option value="YEAR">year</option>
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="block text-slate-600 dark:text-slate-300">Per user</span>
                    <input type="number" min={1} step="0.01" value={price.amount} onChange={(e) => setPrice({ ...price, amount: e.target.value })} className={`${inputClass} mt-1 w-32`} placeholder="499" />
                  </label>
                  <button className={primaryButtonClass} disabled={adding} onClick={addPrice}>{adding ? 'Setting…' : 'Set price'}</button>
                  <p id={`provider-${plan.code}`} className="w-full text-xs text-slate-500">
                    {price.currency === 'INR' ? 'Charged through Razorpay.' : 'Charged through Stripe.'} {!providers.includes(price.currency === 'INR' ? 'RAZORPAY' : 'STRIPE') && 'That provider is not set up.'}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {error && <p className="text-sm text-red-600 mt-3" role="alert">{error}</p>}
    </Card>
  );
}

function SubscriptionsTab() {
  const subs = useApi<{ subscriptions: Sub[] }>('/platform/billing/subscriptions');
  return (
    <DataView {...subs}>
      {(d) => d.subscriptions.length === 0 ? (
        <Card><EmptyState icon={CreditCard} title="No subscriptions yet" message="Organizations subscribe from their Billing page." /></Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-700">
                  <th className="py-2 pr-4 font-medium">Organization</th>
                  <th className="py-2 pr-4 font-medium">Plan</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium text-right">Users</th>
                  <th className="py-2 pr-4 font-medium text-right">Amount</th>
                  <th className="py-2 pr-4 font-medium">Renews</th>
                  <th className="py-2 font-medium">Through</th>
                </tr>
              </thead>
              <tbody>
                {d.subscriptions.map((s) => (
                  <tr key={s.tenantId} className="border-b border-slate-100 dark:border-slate-700/60 last:border-0 align-top">
                    <td className="py-2 pr-4">
                      <div className="font-medium text-slate-800 dark:text-white">{s.tenant}</div>
                      {s.slug && <div className="text-xs text-slate-500">{s.slug}</div>}
                    </td>
                    <td className="py-2 pr-4">{s.plan.charAt(0) + s.plan.slice(1).toLowerCase()} · {s.interval === 'YEAR' ? 'yearly' : 'monthly'}</td>
                    <td className="py-2 pr-4 space-y-1">
                      <Badge value={s.status} />
                      {s.readOnly && <div className="text-xs text-red-600">Read-only until paid</div>}
                      {s.cancelAtPeriodEnd && <div className="text-xs text-slate-500">Cancels at period end</div>}
                      {s.seatSyncError && <div className="text-xs text-amber-700 dark:text-amber-400" title={s.seatSyncError}>Seats not updated</div>}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{s.seats}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{formatMoney(s.amount, s.currency)}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{s.currentPeriodEnd ? formatDate(s.currentPeriodEnd) : '—'}</td>
                    <td className="py-2">{s.provider === 'RAZORPAY' ? 'Razorpay' : 'Stripe'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </DataView>
  );
}
