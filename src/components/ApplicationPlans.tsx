/**
 * An application's limits by plan, and the usage it reported this month
 * (platform staff, Applications page). The application declares its limits
 * and meters in its manifest; staff set each plan's value here, and the
 * organizations on that plan are told. backend/src/routes/application-limits.ts.
 */
import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiPut } from '../lib/api-client';
import { invalidateApi } from '../lib/query';
import { Card, inputClass, secondaryButtonClass } from './ui';

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
      <th scope="row" className="py-2 pr-3 text-left font-normal">
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

export default function ApplicationPlans({ applicationId, applicationName }: { applicationId: string; applicationName: string }) {
  const limits = useApi<LimitsInfo>(`/applications/${applicationId}/limits`);
  const usage = useApi<UsageInfo>(`/applications/${applicationId}/usage`);
  const ls = limits.data?.limits ?? [];
  const meters = usage.data?.meters ?? [];
  if (!ls.length && !meters.length) return null;
  const plans = limits.data?.plans ?? [];

  return (
    <Card className="mt-6" title="Plans and usage"
      description={`What each plan allows in ${applicationName} (from its manifest), and what organizations used this month. Organizations are told when their limits change.`}>
      {ls.length > 0 && (
        <div className="overflow-x-auto -mx-1 px-1">
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
