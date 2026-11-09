/**
 * Bundles (platform staff): named sets of applications organizations turn on
 * together. backend/src/routes/application-bundles.ts.
 */
import { useState } from 'react';
import { Boxes, Trash2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiDelete, apiPost, apiPut } from '../lib/api-client';
import { invalidateApi } from '../lib/query';
import { Field } from './Dialog';
import { Badge, Card, inputClass, primaryButtonClass } from './ui';

interface Bundle { id: string; key: string; name: string; description: string | null; active: boolean; applications: { id: string; key: string; name: string }[] }

export default function BundlesManager({ applications }: { applications: { id: string; name: string; status: string }[] }) {
  const path = '/applications/bundles';
  const info = useApi<{ bundles: Bundle[] }>(path);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bundles = info.data?.bundles ?? [];

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await invalidateApi(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Saving failed');
    }
  };
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await run(async () => {
      await apiPost(path, { key, name: name.trim(), description: description.trim() || null, applicationIds: chosen });
      setName('');
      setKey('');
      setDescription('');
      setChosen([]);
    });
    setBusy(false);
  };

  return (
    <div className="mt-6">
      <Card title="Bundles" description="Applications organizations turn on together, e.g. a suite. What each application requires is checked across the bundle.">
        {bundles.length > 0 && (
          <ul className="divide-y divide-slate-100 dark:divide-slate-700 mb-5">
            {bundles.map((b) => (
              <li key={b.id} className="py-3 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-slate-800 dark:text-slate-100 flex items-center gap-2">
                    <Boxes size={16} className="text-slate-400" aria-hidden /> {b.name} <span className="font-mono text-xs text-slate-500">{b.key}</span>
                    {!b.active && <Badge value="INACTIVE" />}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">{b.applications.map((a) => a.name).join(' · ')}</p>
                </div>
                <div className="flex gap-3 text-xs">
                  <button type="button" className="text-blue-600 hover:text-blue-700"
                    onClick={() => void run(() => apiPut(`${path}/${b.id}`, { key: b.key, name: b.name, description: b.description, active: !b.active, applicationIds: b.applications.map((a) => a.id) }))}>
                    {b.active ? 'Hide from organizations' : 'Offer again'}
                  </button>
                  <button type="button" className="text-red-600 hover:text-red-700 inline-flex items-center gap-1"
                    onClick={() => confirm(`Delete "${b.name}"? Organizations keep what they turned on.`) && void run(() => apiDelete(`${path}/${b.id}`))}>
                    <Trash2 size={12} aria-hidden /> Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={create} className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">New bundle</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} maxLength={100} placeholder="Sales suite" /></Field>
            <Field label="Key" hint="Lowercase letters, digits and -"><input value={key} onChange={(e) => setKey(e.target.value)} className={`${inputClass} font-mono text-xs`} maxLength={50} placeholder="sales-suite" /></Field>
          </div>
          <Field label="Description (optional)"><input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} maxLength={300} /></Field>
          <fieldset>
            <legend className="text-sm text-slate-600 dark:text-slate-300 mb-1">Applications (at least two)</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {applications.filter((a) => a.status === 'ACTIVE').map((a) => (
                <label key={a.id} className="inline-flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-200">
                  <input type="checkbox" checked={chosen.includes(a.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))} />
                  {a.name}
                </label>
              ))}
            </div>
          </fieldset>
          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex justify-end">
            <button type="submit" className={primaryButtonClass} disabled={busy || !name.trim() || !key || chosen.length < 2}>Make bundle</button>
          </div>
        </form>
      </Card>
    </div>
  );
}
