/**
 * The organization's billing: its plan and what it allows, the subscription
 * (paid per user, through Razorpay in rupees or Stripe in other currencies),
 * plans to move to, and invoices. backend/src/routes/billing.ts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, CreditCard, ExternalLink, Info, Minus } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { apiPost } from '../lib/api-client';
import { formatMoney, intervalLabel } from '../lib/money';
import { Badge, Card, DataView, EmptyState, PageHeader, formatDate, primaryButtonClass, secondaryButtonClass } from '../components/ui';

type Interval = 'MONTH' | 'YEAR';
interface Price { currency: string; interval: Interval; unitAmount: number; provider: 'RAZORPAY' | 'STRIPE' }
interface Plan {
  code: string; name: string; description: string | null; public: boolean;
  maxUsers: number | null; maxOrganizations: number | null; maxGroups: number | null; allowSso: boolean; allowCustomDomain: boolean;
  prices: Price[];
}
interface Overview {
  billingEnabled: boolean;
  graceDays: number;
  plan: Omit<Plan, 'prices' | 'description' | 'public'>;
  usage: { users: number; organizations: number; groups: number };
  status: string;
  trialEndsAt: string | null;
  paymentRequiredSince: string | null;
  subscription: null | {
    provider: 'RAZORPAY' | 'STRIPE'; plan: string; interval: Interval; currency: string; seats: number; status: string;
    currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; pastDueSince: string | null; graceEndsAt: string | null;
    checkoutUrl: string | null; seatSyncError: string | null; unitAmount: number | null; canResume: boolean; hasPortal: boolean;
  };
  plans: Plan[];
  invoices: { id: string; number: string | null; amount: number; currency: string; status: string; url: string | null; periodStart: string | null; periodEnd: string | null; paidAt: string | null; createdAt: string }[];
}

const LIVE = ['ACTIVE', 'PAST_DUE', 'UNPAID'];
const providerName = (p: string) => (p === 'RAZORPAY' ? 'Razorpay' : 'Stripe');
const limitText = (n: number | null, noun: string) => (n === null ? `Unlimited ${noun}` : `Up to ${n.toLocaleString()} ${n === 1 ? noun.replace(/s$/, '') : noun}`);

function Notice({ tone, title, children }: { tone: 'red' | 'amber' | 'blue' | 'green'; title: string; children?: React.ReactNode }) {
  const styles = {
    red: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
    amber: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
    blue: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200',
    green: 'border-green-200 bg-green-50 text-green-900 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-200',
  }[tone];
  const Icon = tone === 'blue' ? Info : tone === 'green' ? Check : AlertTriangle;
  return (
    <div className={`flex gap-3 rounded-lg border p-4 text-sm ${styles}`} role={tone === 'red' ? 'alert' : 'status'}>
      <Icon size={18} className="mt-0.5 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {children && <div className="opacity-90">{children}</div>}
      </div>
    </div>
  );
}

function UsageRow({ label, used, max }: { label: string; used: number; max: number | null }) {
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const full = max !== null && used >= max;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-600 dark:text-slate-300">{label}</span>
        <span className="tabular-nums text-slate-800 dark:text-white">{used.toLocaleString()}{max !== null ? ` of ${max.toLocaleString()}` : ''}</span>
      </div>
      {max !== null && (
        <div className="mt-1.5 h-1.5 rounded-full bg-slate-100 dark:bg-slate-700" aria-hidden>
          <div className={`h-1.5 rounded-full ${full ? 'bg-amber-500' : 'bg-blue-600'}`} style={{ width: `${Math.max(pct, 2)}%` }} />
        </div>
      )}
    </div>
  );
}

export default function BillingPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('billing:manage');
  const [params, setParams] = useSearchParams();
  const overview = useApi<Overview>('/billing');
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [interval, setInterval] = useState<Interval>('MONTH');
  const [currency, setCurrency] = useState<string | null>(null);
  const handledReturn = useRef(false);

  useEffect(() => {
    if (overview.data) setData(overview.data);
  }, [overview.data]);
  // Start the plans on the subscription's billing interval
  const sawInterval = useRef(false);
  useEffect(() => {
    if (!sawInterval.current && data?.subscription && LIVE.includes(data.subscription.status)) {
      sawInterval.current = true;
      setInterval(data.subscription.interval);
    }
  }, [data]);

  // Back from the payment page: look the subscription up now
  useEffect(() => {
    const checkout = params.get('checkout');
    if (!checkout || handledReturn.current) return;
    handledReturn.current = true;
    const session = params.get('session');
    setParams({}, { replace: true });
    if (checkout === 'cancelled') {
      setNotice('Checkout was cancelled. Nothing was charged.');
      return;
    }
    setNotice('Thanks! Confirming your payment…');
    apiPost<Overview>('/billing/refresh', session && session.startsWith('cs_') ? { session } : {})
      .then((o) => {
        setData(o);
        setNotice(o.subscription && LIVE.includes(o.subscription.status)
          ? `You're on the ${o.plan.name} plan.`
          : 'Your payment is being confirmed. This page will show it in a minute or two.');
      })
      .catch((err) => setNotice(err instanceof Error ? err.message : 'Could not confirm the payment yet'));
  }, [params, setParams]);

  const run = async (key: string, action: () => Promise<Overview | { url: string } | void>) => {
    setBusy(key);
    setError(null);
    try {
      const result = await action();
      if (result && 'url' in result) {
        window.location.assign(result.url);
        return;
      }
      if (result) setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Billing" description="Your plan, what it includes, and payments. Plans are priced per user: everyone active or invited counts." />
      <DataView data={data} error={overview.error} loading={overview.loading} reload={overview.reload}>
        {(o) => (
          <Content
            o={o} canManage={canManage} busy={busy} error={error} notice={notice}
            interval={interval} setInterval={setInterval} currency={currency} setCurrency={setCurrency} run={run}
          />
        )}
      </DataView>
    </div>
  );
}

function Content({ o, canManage, busy, error, notice, interval, setInterval, currency, setCurrency, run }: {
  o: Overview; canManage: boolean; busy: string | null; error: string | null; notice: string | null;
  interval: Interval; setInterval: (i: Interval) => void; currency: string | null; setCurrency: (c: string) => void;
  run: (key: string, action: () => Promise<Overview | { url: string } | void>) => void;
}) {
  const sub = o.subscription;
  const live = !!sub && LIVE.includes(sub.status);
  const currencies = useMemo(() => [...new Set(o.plans.flatMap((p) => p.prices.map((x) => x.currency)))].sort((a, b) => (a === 'INR' ? -1 : b === 'INR' ? 1 : a.localeCompare(b))), [o.plans]);
  // A subscription's currency can't change; otherwise the first on offer
  const shown = live ? sub.currency : currency && currencies.includes(currency) ? currency : currencies[0] ?? null;
  const priceOf = (p: Plan) => p.prices.find((x) => x.currency === shown && x.interval === interval) ?? null;
  const trialEnded = o.status === 'TRIAL' && o.trialEndsAt && new Date(o.trialEndsAt) <= new Date();

  const subscribe = (plan: Plan) => run(`plan-${plan.code}`, () => apiPost('/billing/checkout', { plan: plan.code, interval, currency: shown }));
  const change = (plan: Plan) => {
    if (!confirm(`Move to the ${plan.name} plan, billed ${interval === 'YEAR' ? 'yearly' : 'monthly'}?${sub?.provider === 'STRIPE' ? ' The difference for the rest of this period is charged or credited now.' : ' Upgrades start now; a smaller plan starts at the next billing date.'}`)) return;
    run(`plan-${plan.code}`, () => apiPost('/billing/change', { plan: plan.code, interval }));
  };

  return (
    <div className="space-y-6">
      {notice && <Notice tone="blue" title={notice} />}
      {error && <Notice tone="red" title={error} />}
      {o.paymentRequiredSince && (
        <Notice tone="red" title="Read-only: payments are overdue">
          Payments have failed for more than {o.graceDays} days, so changes are paused. Update the payment method and everything works again straight away.
        </Notice>
      )}
      {!o.paymentRequiredSince && sub && (sub.status === 'PAST_DUE' || sub.status === 'UNPAID') && (
        <Notice tone="amber" title="A payment didn't go through">
          {providerName(sub.provider)} will try again. Check the card or payment method{sub.graceEndsAt ? ` before ${formatDate(sub.graceEndsAt)}; after that the organization becomes read-only until it's paid` : ''}.
        </Notice>
      )}
      {o.status === 'TRIAL' && o.trialEndsAt && !live && (
        <Notice tone={trialEnded ? 'red' : 'blue'} title={trialEnded ? 'Your trial has ended' : `Your trial ends on ${formatDate(o.trialEndsAt)}`}>
          {trialEnded ? 'The organization is read-only. Subscribe to a plan below to carry on.' : 'Subscribe any time; your trial ends as soon as you do.'}
        </Notice>
      )}
      {sub?.status === 'INCOMPLETE' && sub.checkoutUrl && (
        <Notice tone="amber" title="Your subscription is waiting for the first payment">
          <a className="inline-flex items-center gap-1 font-medium underline" href={sub.checkoutUrl}>Finish paying at {providerName(sub.provider)} <ExternalLink size={13} aria-hidden /></a>
        </Notice>
      )}
      {sub?.seatSyncError && live && (
        <Notice tone="amber" title="Seats couldn't be updated automatically">
          {sub.seatSyncError}. You're billed for {sub.seats} {sub.seats === 1 ? 'user' : 'users'} and have {o.usage.users}.
          {sub.provider === 'RAZORPAY' && ' Subscriptions paid by UPI or e-mandate can\'t be changed; to pay for the right number, cancel and subscribe again by card.'}
        </Notice>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card title="Your plan" className="lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-2xl font-semibold tracking-tight text-slate-800 dark:text-white">{o.plan.name}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                {live ? <Badge value={sub.status} /> : <Badge value={o.status === 'TRIAL' ? (trialEnded ? 'TRIAL_ENDED' : 'TRIAL') : 'ACTIVE'} />}
                {live && sub.unitAmount !== null && (
                  <span className="tabular-nums">
                    {formatMoney(sub.unitAmount, sub.currency)} × {sub.seats} {sub.seats === 1 ? 'user' : 'users'} = <strong className="text-slate-800 dark:text-white">{formatMoney(sub.unitAmount * sub.seats, sub.currency)}</strong> a {intervalLabel(sub.interval)}
                  </span>
                )}
                {!live && o.plan.code === 'FREE' && <span>No charge</span>}
              </div>
              {live && sub.currentPeriodEnd && (
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
                  {sub.cancelAtPeriodEnd ? `Cancelled: ends on ${formatDate(sub.currentPeriodEnd)}, then the Free plan.` : `Renews on ${formatDate(sub.currentPeriodEnd)} through ${providerName(sub.provider)}.`}
                </p>
              )}
            </div>
            {canManage && live && (
              <div className="flex flex-wrap gap-2">
                {sub.hasPortal && (
                  <button className={secondaryButtonClass} disabled={!!busy} onClick={() => run('portal', () => apiPost('/billing/portal'))}>
                    <CreditCard size={15} aria-hidden /> {busy === 'portal' ? 'Opening…' : 'Payment method and invoices'}
                  </button>
                )}
                {sub.cancelAtPeriodEnd
                  ? sub.canResume && <button className={secondaryButtonClass} disabled={!!busy} onClick={() => run('resume', () => apiPost('/billing/resume'))}>{busy === 'resume' ? 'Keeping…' : 'Keep subscription'}</button>
                  : (
                    <button className={secondaryButtonClass} disabled={!!busy} onClick={() => {
                      if (!confirm(`Cancel the subscription? It stays on the ${o.plan.name} plan until ${sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : 'the end of the period'}, then moves to the Free plan.${sub.provider === 'RAZORPAY' ? ' Razorpay subscriptions can\'t be un-cancelled.' : ''}`)) return;
                      run('cancel', () => apiPost('/billing/cancel'));
                    }}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel subscription'}</button>
                  )}
              </div>
            )}
          </div>
          <ul className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-slate-700 dark:text-slate-300">
            <li>{limitText(o.plan.maxUsers, 'users')}</li>
            <li>{limitText(o.plan.maxOrganizations, 'organizations')}</li>
            <li>{limitText(o.plan.maxGroups, 'groups')}</li>
            <li>{o.plan.allowSso ? 'Single sign-on' : 'No single sign-on'}</li>
            <li>{o.plan.allowCustomDomain ? 'Your own domain' : 'No custom domain'}</li>
          </ul>
        </Card>

        <Card title="Usage">
          <div className="space-y-4">
            <UsageRow label="Users (active and invited)" used={o.usage.users} max={o.plan.maxUsers} />
            <UsageRow label="Organizations" used={o.usage.organizations} max={o.plan.maxOrganizations} />
            <UsageRow label="Groups" used={o.usage.groups} max={o.plan.maxGroups} />
          </div>
        </Card>
      </div>

      <section aria-labelledby="plans-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="plans-heading" className="text-lg font-semibold text-slate-800 dark:text-white">{live ? 'Change plan' : 'Plans'}</h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">Prices are per user.</p>
          </div>
          {o.billingEnabled && currencies.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-md border border-slate-300 dark:border-slate-600 p-0.5" role="group" aria-label="Billing interval">
                {(['MONTH', 'YEAR'] as const).map((i) => (
                  <button key={i} aria-pressed={interval === i} onClick={() => setInterval(i)}
                    className={`px-3 py-1 text-sm rounded ${interval === i ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900' : 'text-slate-600 dark:text-slate-300'}`}>
                    {i === 'MONTH' ? 'Monthly' : 'Yearly'}
                  </button>
                ))}
              </div>
              {!live && currencies.length > 1 && (
                <label className="text-sm text-slate-600 dark:text-slate-300">
                  <span className="sr-only">Currency</span>
                  <select value={shown ?? ''} onChange={(e) => setCurrency(e.target.value)} className="px-2 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900">
                    {currencies.map((c) => <option key={c} value={c}>{c === 'INR' ? 'INR: UPI, cards, netbanking' : `${c}: card`}</option>)}
                  </select>
                </label>
              )}
            </div>
          )}
        </div>

        {!o.billingEnabled ? (
          <Card><EmptyState icon={CreditCard} title="Online payments aren't set up" message="To change plans, contact the platform team." /></Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {o.plans.map((p) => {
              const price = priceOf(p);
              // On a trial, its plan is still to be paid for; a plan given by the platform team (no subscription) is simply current
              const onTrial = !live && o.status === 'TRIAL' && o.plan.code === p.code;
              const current = live ? sub.plan === p.code && sub.interval === interval : o.plan.code === p.code && !onTrial;
              const total = price ? price.unitAmount * Math.max(1, o.usage.users) : null;
              let action: React.ReactNode = null;
              if (current) action = <span className="text-sm font-medium text-green-700 dark:text-green-400 inline-flex items-center gap-1"><Check size={15} aria-hidden /> Current plan</span>;
              else if (p.code === 'FREE') action = live ? <span className="text-xs text-slate-500">Cancel your subscription to move here</span> : null;
              else if (!price) action = <span className="text-xs text-slate-500">{p.public ? `Not offered ${interval === 'YEAR' ? 'yearly' : 'monthly'} in ${shown}` : 'Contact us'}</span>;
              else if (canManage) {
                action = (
                  <button className={`${primaryButtonClass} w-full`} disabled={!!busy || (live && !!sub.cancelAtPeriodEnd)} onClick={() => (live ? change(p) : subscribe(p))}>
                    {busy === `plan-${p.code}` ? 'One moment…' : live ? `Switch to ${p.name}` : `Subscribe`}
                  </button>
                );
              }
              return (
                <div key={p.code} className={`flex flex-col rounded-lg border p-5 bg-white dark:bg-slate-800 ${current || onTrial ? 'border-blue-500 ring-1 ring-blue-500' : 'border-slate-200 dark:border-slate-700'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-slate-800 dark:text-white">{p.name}</h3>
                    {onTrial && <span className="text-xs font-medium text-blue-700 dark:text-blue-300">Your trial</span>}
                  </div>
                  {p.description && <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">{p.description}</p>}
                  <div className="mt-4 min-h-[3.5rem]">
                    {p.code === 'FREE' ? (
                      <p className="text-2xl font-semibold text-slate-800 dark:text-white">Free</p>
                    ) : price ? (
                      <>
                        <p className="text-2xl font-semibold tabular-nums text-slate-800 dark:text-white">{formatMoney(price.unitAmount, price.currency)}<span className="text-sm font-normal text-slate-500"> / user / {intervalLabel(price.interval)}</span></p>
                        {total !== null && <p className="text-xs text-slate-500 tabular-nums">{formatMoney(total, price.currency)} a {intervalLabel(price.interval)} for your {Math.max(1, o.usage.users)} {o.usage.users === 1 ? 'user' : 'users'}</p>}
                      </>
                    ) : <p className="text-sm text-slate-500">{p.public ? 'No price yet' : 'Arranged with our team'}</p>}
                  </div>
                  <ul className="mt-4 space-y-1.5 text-sm text-slate-700 dark:text-slate-300 flex-1">
                    <li>{limitText(p.maxUsers, 'users')}</li>
                    <li>{limitText(p.maxOrganizations, 'organizations')}</li>
                    <li>{limitText(p.maxGroups, 'groups')}</li>
                    <li className="flex items-center gap-1.5">{p.allowSso ? <Check size={14} className="text-green-600" aria-hidden /> : <Minus size={14} className="text-slate-400" aria-hidden />} Single sign-on</li>
                    <li className="flex items-center gap-1.5">{p.allowCustomDomain ? <Check size={14} className="text-green-600" aria-hidden /> : <Minus size={14} className="text-slate-400" aria-hidden />} Your own domain</li>
                  </ul>
                  <div className="mt-5">{action}</div>
                </div>
              );
            })}
          </div>
        )}
        {!canManage && <p className="text-xs text-slate-500">Only people who manage billing can change the plan.</p>}
        {!live && o.billingEnabled && shown && (
          <p className="text-xs text-slate-500">
            You'll pay at {providerName(shown === 'INR' ? 'RAZORPAY' : 'STRIPE')}'s secure page. The number of users on your subscription follows your organization: people you add or remove change the next bill.
          </p>
        )}
      </section>

      <Card title="Invoices" className="min-w-0">
        {o.invoices.length === 0 ? (
          <p className="text-sm text-slate-500">No invoices yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-700">
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium hidden sm:table-cell">Period</th>
                  <th className="py-2 pr-4 font-medium text-right">Amount</th>
                  <th className="py-2 pr-4 font-medium hidden sm:table-cell">Status</th>
                  <th className="py-2 font-medium"><span className="sr-only">Invoice</span></th>
                </tr>
              </thead>
              <tbody>
                {o.invoices.map((i) => (
                  <tr key={i.id} className="border-b border-slate-100 dark:border-slate-700/60 last:border-0">
                    <td className="py-2 pr-4 whitespace-nowrap">{formatDate(i.createdAt)}</td>
                    <td className="py-2 pr-4 whitespace-nowrap text-slate-600 dark:text-slate-400 hidden sm:table-cell">{i.periodStart && i.periodEnd ? `${formatDate(i.periodStart)} – ${formatDate(i.periodEnd)}` : '—'}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{formatMoney(i.amount, i.currency)}</td>
                    <td className="py-2 pr-4 hidden sm:table-cell"><Badge value={i.status.toUpperCase()} /></td>
                    <td className="py-2 text-right">
                      {i.url && <a className="inline-flex items-center gap-1 text-blue-600 hover:underline" href={i.url} target="_blank" rel="noreferrer">{i.number ?? 'View'} <ExternalLink size={13} aria-hidden /></a>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
