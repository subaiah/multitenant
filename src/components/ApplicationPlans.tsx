/**
 * An application's limits by plan, and the usage it reported this month
 * (platform staff, Applications page). The application declares its limits
 * and meters in its manifest; staff set each plan's value here, and the
 * organizations on that plan are told. backend/src/routes/application-limits.ts.
 */
import { useEffect, useState } from 'react';
import { Gauge, Plus, Trash2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiPut } from '../lib/api-client';
import { invalidateApi } from '../lib/query';
import { Card, inputClass, primaryButtonClass, secondaryButtonClass, selectClass } from './ui';
import { formatMoney, fromMinorUnits, toMinorUnits } from '../lib/money';

type Value = number | boolean | null;
interface Limit { key: string; label: string; type: 'integer' | 'boolean'; unlimited: boolean; unit: string | null; default: Value; values: Record<string, Value> }
interface LimitsInfo { plans: { code: string; name: string }[]; limits: Limit[] }
interface UsageInfo { month: string; meters: { key: string; label: string; unit: string; total: number }[]; organizations: { id: string; name: string; used: Record<string, number> }[] }

const amount = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
const show = (l: Limit, v: Value) => (l.type === 'boolean' ? (v ? 'On' : 'Off') : v === null ? 'No limit' : `${amount(v as number)}${l.unit ? ` ${l.unit}` : ''}`);

/** One cell's draft: '' means the default */
type Draft = Record<string, string>;
const toDraft = (l: Limit): Draft => Object.fromEntries(Object.entries(l.values).map(([plan, v]) => [plan, v === null ? 'none' : String(v)]));

function LimitRow({ l, plans, applicationId }: { l: Limit; plans: LimitsInfo['plans']; applicationId: string }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(l));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(toDraft(l)), [l]);
  const changed = JSON.stringify(draft) !== JSON.stringify(toDraft(l));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const values: Record<string, Value> = {};
      for (const [plan, raw] of Object.entries(draft)) {
        if (raw === '') continue;
        values[plan] = l.type === 'boolean' ? raw === 'true' : raw === 'none' ? null : Number(raw);
      }
      await apiPut(`/applications/${applicationId}/limits/${encodeURIComponent(l.key)}`, { values });
      await invalidateApi(`/applications/${applicationId}/limits`);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Saving failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="align-top">
      <th scope="row" className="py-2 pr-3 text-left font-normal min-w-[9.5rem]">
        <span className="font-medium text-slate-800 dark:text-slate-100">{l.label}</span>
        <span className="block font-mono text-xs text-slate-500 break-all">{l.key}</span>
        <span className="block text-xs text-slate-500">Default: {show(l, l.default)}</span>
        {error && <span role="alert" className="block text-xs text-red-600 dark:text-red-400 mt-1">{error}</span>}
      </th>
      {plans.map((p) => {
        const id = `${l.key}-${p.code}`;
        const raw = draft[p.code] ?? '';
        const set = (v: string) => setDraft((d) => ({ ...d, [p.code]: v }));
        return (
          <td key={p.code} className="py-2 px-1.5">
            <label htmlFor={id} className="sr-only">{l.label} on {p.name}</label>
            {l.type === 'boolean' ? (
              <select id={id} value={raw} onChange={(e) => set(e.target.value)} className={`${inputClass} min-w-[92px]`}>
                <option value="">Default</option>
                <option value="true">On</option>
                <option value="false">Off</option>
              </select>
            ) : (
              <div className="flex flex-col gap-1 min-w-[110px]">
                <input id={id} type="number" min={0} step={1} inputMode="numeric" placeholder="Default"
                  value={raw === 'none' ? '' : raw} disabled={raw === 'none'} onChange={(e) => set(e.target.value)} className={inputClass} />
                {l.unlimited && (
                  <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                    <input type="checkbox" checked={raw === 'none'} onChange={(e) => set(e.target.checked ? 'none' : '')} /> No limit
                  </label>
                )}
              </div>
            )}
          </td>
        );
      })}
      <td className="py-2 pl-2 whitespace-nowrap">
        <button type="button" className={secondaryButtonClass} disabled={busy || !changed} onClick={() => void save()}>
          {busy ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </button>
      </td>
    </tr>
  );
}

interface PricesInfo {
  currencies: string[];
  prices: { currency: string; interval: 'MONTH' | 'YEAR'; model: 'flat' | 'per_seat'; unitAmount: number }[];
  meters: { key: string; label: string; unit: string; prices: { currency: string; unitAmount: number; perQuantity: number; includedQuantity: number }[] }[];
}
/** The shared input style without its full width, for inputs in a row */
const narrow = inputClass.replace('w-full ', '');
type PriceRow = { currency: string; interval: 'MONTH' | 'YEAR'; model: 'flat' | 'per_seat'; amount: string };
type MeterRow = { key: string; currency: string; amount: string; perQuantity: string; included: string };

/** What organizations pay for it on their subscription, and for its meters (backend lib/billing/app-charges.ts) */
function Prices({ applicationId }: { applicationId: string }) {
  const path = `/applications/${applicationId}/prices`;
  const info = useApi<PricesInfo>(path);
  const [rows, setRows] = useState<PriceRow[] | null>(null);
  const [meterRows, setMeterRows] = useState<MeterRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!info.data) return;
    setRows(info.data.prices.map((p) => ({ currency: p.currency, interval: p.interval, model: p.model, amount: String(fromMinorUnits(p.unitAmount, p.currency)) })));
    setMeterRows(info.data.meters.flatMap((m) => m.prices.map((p) => ({ key: m.key, currency: p.currency, amount: String(fromMinorUnits(p.unitAmount, p.currency)), perQuantity: String(p.perQuantity), included: String(p.includedQuantity) }))));
  }, [info.data]);
  if (!info.data || !rows || !meterRows) return null;
  const currencies = info.data.currencies.length ? info.data.currencies : ['INR', 'USD'];
  const meters = info.data.meters;

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await apiPut(path, {
        prices: rows.map((r) => ({ currency: r.currency, interval: r.interval, model: r.model, unitAmount: toMinorUnits(Number(r.amount || 0), r.currency) })),
        meters: meterRows.map((r) => ({ key: r.key, currency: r.currency, unitAmount: toMinorUnits(Number(r.amount || 0), r.currency), perQuantity: Number(r.perQuantity || 1), includedQuantity: Number(r.included || 0) })),
      });
      await invalidateApi(path);
      setMessage({ ok: true, text: 'Saved. Organizations are charged from the end of their current period.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Saving failed' });
    } finally {
      setBusy(false);
    }
  };
  const setRow = (i: number, change: Partial<PriceRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const setMeter = (i: number, change: Partial<MeterRow>) => setMeterRows(meterRows.map((r, j) => (j === i ? { ...r, ...change } : r)));

  return (
    <div>
      <h3 className="text-sm font-medium text-slate-800 dark:text-slate-100">Prices</h3>
      <p className="text-xs text-slate-500 mt-0.5">Charged on organizations' subscriptions, for each period they had it on (not trials), on the next invoice.</p>
      <ul className="mt-2 space-y-2">
        {rows.map((r, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
            <select aria-label="Currency" value={r.currency} onChange={(e) => setRow(i, { currency: e.target.value })} className={selectClass}>
              {[...new Set([...currencies, r.currency])].map((c) => <option key={c}>{c}</option>)}
            </select>
            <input aria-label="Amount" type="number" min={0} step="0.01" value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} className={`${narrow} w-28`} />
            <select aria-label="How it's charged" value={r.model} onChange={(e) => setRow(i, { model: e.target.value as PriceRow['model'] })} className={selectClass}>
              <option value="flat">per organization</option>
              <option value="per_seat">per user</option>
            </select>
            <select aria-label="Period" value={r.interval} onChange={(e) => setRow(i, { interval: e.target.value as PriceRow['interval'] })} className={selectClass}>
              <option value="MONTH">a month</option>
              <option value="YEAR">a year</option>
            </select>
            <button type="button" aria-label="Remove price" className="p-2 text-slate-400 hover:text-red-600" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={15} /></button>
          </li>
        ))}
      </ul>
      <button type="button" className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400" onClick={() => setRows([...rows, { currency: currencies[0], interval: 'MONTH', model: 'flat', amount: '' }])}>
        <Plus size={14} aria-hidden /> Add a price
      </button>
      {meters.length > 0 && (
        <>
          <h4 className="mt-4 text-sm font-medium text-slate-800 dark:text-slate-100">Usage</h4>
          <ul className="mt-2 space-y-2">
            {meterRows.map((r, i) => {
              const m = meters.find((x) => x.key === r.key);
              return (
                <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <select aria-label="Meter" value={r.key} onChange={(e) => setMeter(i, { key: e.target.value })} className={selectClass}>
                    {meters.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                  <select aria-label="Currency" value={r.currency} onChange={(e) => setMeter(i, { currency: e.target.value })} className={selectClass}>
                    {[...new Set([...currencies, r.currency])].map((c) => <option key={c}>{c}</option>)}
                  </select>
                  <input aria-label="Amount" type="number" min={0} step="0.01" value={r.amount} onChange={(e) => setMeter(i, { amount: e.target.value })} className={`${narrow} w-24`} />
                  <span className="text-slate-500">per</span>
                  <input aria-label="Per how many" type="number" min={1} step={1} value={r.perQuantity} onChange={(e) => setMeter(i, { perQuantity: e.target.value })} className={`${narrow} w-24`} />
                  <span className="text-slate-500">{m?.unit}, first</span>
                  <input aria-label="Included each period" type="number" min={0} value={r.included} onChange={(e) => setMeter(i, { included: e.target.value })} className={`${narrow} w-24`} />
                  <span className="text-slate-500">free</span>
                  <button type="button" aria-label="Remove usage price" className="p-2 text-slate-400 hover:text-red-600" onClick={() => setMeterRows(meterRows.filter((_, j) => j !== i))}><Trash2 size={15} /></button>
                </li>
              );
            })}
          </ul>
          <button type="button" className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400" onClick={() => setMeterRows([...meterRows, { key: meters[0].key, currency: currencies[0], amount: '', perQuantity: '1', included: '0' }])}>
            <Plus size={14} aria-hidden /> Add a usage price
          </button>
        </>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className={primaryButtonClass} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save prices'}</button>
        {message && <p role={message.ok ? 'status' : 'alert'} className={`text-sm ${message.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{message.text}</p>}
      </div>
      {rows.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          {rows.filter((r) => r.amount).map((r) => `${formatMoney(toMinorUnits(Number(r.amount), r.currency), r.currency)} ${r.model === 'per_seat' ? 'per user ' : ''}a ${r.interval === 'YEAR' ? 'year' : 'month'}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

export default function ApplicationPlans({ applicationId, applicationName }: { applicationId: string; applicationName: string }) {
  const limits = useApi<LimitsInfo>(`/applications/${applicationId}/limits`);
  const usage = useApi<UsageInfo>(`/applications/${applicationId}/usage`);
  const ls = limits.data?.limits ?? [];
  const meters = usage.data?.meters ?? [];
  const plans = limits.data?.plans ?? [];

  return (
    <Card className="mt-6" title="Plans and usage"
      description={`What ${applicationName} costs, what each plan allows in it (from its manifest), and what organizations used this month.`}>
      <Prices applicationId={applicationId} />
      {ls.length > 0 && (
        <div className="relative overflow-x-auto -mx-1 px-1 mt-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th scope="col" className="py-1 pr-3 font-medium">Limit</th>
                {plans.map((p) => <th key={p.code} scope="col" className="py-1 px-1.5 font-medium">{p.name}</th>)}
                <th scope="col" className="py-1 pl-2"><span className="sr-only">Save</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
              {ls.map((l) => <LimitRow key={l.key} l={l} plans={plans} applicationId={applicationId} />)}
            </tbody>
          </table>
        </div>
      )}
      {meters.length > 0 && (
        <div className={ls.length ? 'mt-5' : ''}>
          <h3 className="text-sm font-medium text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
            <Gauge size={15} className="text-slate-400" aria-hidden /> Usage in {usage.data?.month}
          </h3>
          <ul className="mt-1 text-sm text-slate-700 dark:text-slate-200">
            {meters.map((m) => <li key={m.key}>{m.label}: <span className="font-medium">{amount(m.total)} {m.unit}</span></li>)}
          </ul>
          {(usage.data?.organizations.length ?? 0) > 0 && (
            <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-700 text-sm">
              {usage.data!.organizations.map((o) => (
                <li key={o.id} className="py-1.5 flex flex-wrap justify-between gap-x-4">
                  <span className="text-slate-700 dark:text-slate-200">{o.name}</span>
                  <span className="text-slate-500">{meters.map((m) => `${amount(o.used[m.key] ?? 0)} ${m.unit}`).join(' · ')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
