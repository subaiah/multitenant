import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiPut } from '../lib/api-client';
import { useAuth } from '../contexts/AuthContext';
import { Card, DataView, PageHeader, inputClass, primaryButtonClass, secondaryButtonClass } from '../components/ui';

/** The platform's security baseline (backend lib/security-baseline.ts) */
interface Baseline {
  minPasswordPolicy: 'STANDARD' | 'STRONG' | 'VERY_STRONG';
  mfaRequiredFor: 'NONE' | 'ADMINS' | 'EVERYONE';
  maxIdleMinutes: number | null;
  maxSessionHours: number | null;
  emailedCodesAllowed: boolean;
  staffIpAllowlist: string[];
  updatedAt: string | null;
  yourAddress: string;
}

export default function GlobalPolicies() {
  const baseline = useApi<Baseline>('/platform/security-baseline');
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Global policies" description="Rules every organization on the platform follows" />
      <DataView {...baseline}>{(b) => <SecurityBaseline baseline={b} onSaved={baseline.reload} />}</DataView>
    </div>
  );
}

const toForm = (b: Baseline) => ({
  minPasswordPolicy: b.minPasswordPolicy,
  mfaRequiredFor: b.mfaRequiredFor,
  maxIdleMinutes: b.maxIdleMinutes === null ? '' : String(b.maxIdleMinutes),
  maxSessionHours: b.maxSessionHours === null ? '' : String(b.maxSessionHours),
  emailedCodesAllowed: b.emailedCodesAllowed,
  staffIpAllowlist: b.staffIpAllowlist.join('\n'),
});

function SecurityBaseline({ baseline: b, onSaved }: { baseline: Baseline; onSaved: () => Promise<unknown> | void }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('policies:manage');
  const [form, setForm] = useState(() => toForm(b));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(b));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPut('/platform/security-baseline', {
        minPasswordPolicy: form.minPasswordPolicy,
        mfaRequiredFor: form.mfaRequiredFor,
        maxIdleMinutes: form.maxIdleMinutes === '' ? null : Number(form.maxIdleMinutes),
        maxSessionHours: form.maxSessionHours === '' ? null : Number(form.maxSessionHours),
        emailedCodesAllowed: form.emailedCodesAllowed,
        staffIpAllowlist: form.staffIpAllowlist.split(/[\s,]+/).filter(Boolean),
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const field = 'block p-3 rounded-lg bg-slate-50 dark:bg-slate-900 text-sm';
  const label = 'font-medium text-slate-700 dark:text-slate-200';
  const hint = 'block text-xs text-slate-500 mt-1';

  return (
    <Card title="Security baseline" actions={<ShieldCheck size={18} className="text-slate-400" />}
      description="Minimums every organization meets. Each can set stricter sign-in rules of its own, never looser; raising a minimum applies to organizations whose settings are looser at once.">
      <fieldset disabled={!canManage} className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className={field}>
          <span className={label}>Weakest password policy allowed</span>
          <select value={form.minPasswordPolicy} onChange={(e) => setForm({ ...form, minPasswordPolicy: e.target.value as Baseline['minPasswordPolicy'] })} className={`${inputClass} mt-1`}>
            <option value="STANDARD">Standard</option>
            <option value="STRONG">Strong</option>
            <option value="VERY_STRONG">Very strong</option>
          </select>
          <span className={hint}>Applies to platform staff too.</span>
        </label>
        <label className={field}>
          <span className={label}>Two-factor sign-in required for</span>
          <select value={form.mfaRequiredFor} onChange={(e) => setForm({ ...form, mfaRequiredFor: e.target.value as Baseline['mfaRequiredFor'] })} className={`${inputClass} mt-1`}>
            <option value="NONE">Nobody (each organization decides)</option>
            <option value="ADMINS">Administrators: organization admins and platform staff</option>
            <option value="EVERYONE">Everyone</option>
          </select>
          <span className={hint}>People it newly applies to set it up the next time they sign in.</span>
        </label>
        <label className={field}>
          <span className={label}>Longest idle time before sign-out (minutes)</span>
          <input type="number" min={5} max={1440} placeholder="No limit" value={form.maxIdleMinutes}
            onChange={(e) => setForm({ ...form, maxIdleMinutes: e.target.value })} className={`${inputClass} mt-1`} />
        </label>
        <label className={field}>
          <span className={label}>Longest session (hours)</span>
          <input type="number" min={1} max={720} placeholder="No limit" value={form.maxSessionHours}
            onChange={(e) => setForm({ ...form, maxSessionHours: e.target.value })} className={`${inputClass} mt-1`} />
        </label>
        <label className="flex items-start justify-between gap-4 p-3 rounded-lg bg-slate-50 dark:bg-slate-900 md:col-span-2">
          <span>
            <span className={`block text-sm ${label}`}>Emailed sign-in codes</span>
            <span className="block text-xs text-slate-500 mt-0.5">Off: nobody can sign in with an emailed code, whatever their organization's setting.</span>
          </span>
          <input type="checkbox" className="mt-1 h-4 w-4" checked={form.emailedCodesAllowed} onChange={(e) => setForm({ ...form, emailedCodesAllowed: e.target.checked })} />
        </label>
        <label className={`${field} md:col-span-2`}>
          <span className={label}>Where platform staff may work from</span>
          <textarea rows={3} value={form.staffIpAllowlist} placeholder="Anywhere"
            onChange={(e) => setForm({ ...form, staffIpAllowlist: e.target.value })} className={`${inputClass} mt-1 font-mono`} />
          <span className={hint}>Addresses or CIDR ranges, one per line (e.g. 203.0.113.0/24). Empty: anywhere. Your address now is <code>{b.yourAddress}</code>, and it must be in the list.</span>
        </label>
      </fieldset>
      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      {canManage && (
        <div className="flex justify-end gap-2 mt-4">
          <button className={secondaryButtonClass} disabled={!dirty || saving} onClick={() => setForm(toForm(b))}>Reset</button>
          <button className={primaryButtonClass} disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      )}
      {b.updatedAt && <p className="text-xs text-slate-500 mt-2">Last changed {new Date(b.updatedAt).toLocaleString()}.</p>}
    </Card>
  );
}
