/**
 * Bundles an organization can turn on in one step (Application
 * Entitlements): each bundle's applications and which are on already.
 * backend/src/routes/tenant-applications.ts (bundles); defined by platform
 * staff (backend/src/routes/application-bundles.ts).
 */
import { useState } from 'react';
import { Boxes, CheckCircle2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiPost } from '../lib/api-client';
import { invalidateApi } from '../lib/query';

interface Bundle {
  id: string;
  key: string;
  name: string;
  description: string | null;
  applications: { id: string; key: string; name: string; on: boolean }[];
}

export default function Bundles({ canManage, onChanged }: { canManage: boolean; onChanged: () => void }) {
  const path = '/tenant-applications/bundles';
  const info = useApi<{ bundles: Bundle[] }>(path);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ bundle: string; text: string; error: boolean } | null>(null);
  const bundles = info.data?.bundles ?? [];
  if (!bundles.length) return null;

  const turnOn = async (b: Bundle) => {
    const missing = b.applications.filter((a) => !a.on).map((a) => a.name);
    if (!confirm(`Turn on ${missing.join(', ')}?`)) return;
    setBusy(b.id);
    try {
      const r = await apiPost<{ turnedOn: string[] }>(`${path}/${b.id}`);
      setMessage({ bundle: b.id, text: `Turned on ${r.turnedOn.join(', ')}.`, error: false });
      await invalidateApi(path);
      onChanged();
    } catch (err) {
      setMessage({ bundle: b.id, text: err instanceof Error ? err.message : 'Turning the bundle on failed', error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-6 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700" aria-labelledby="bundles-title">
      <div className="p-4 border-b border-slate-200 dark:border-slate-700">
        <h2 id="bundles-title" className="text-lg font-semibold text-slate-900 dark:text-white">Bundles</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Applications that work together, turned on in one step.</p>
      </div>
      <ul className="divide-y divide-slate-200 dark:divide-slate-700">
        {bundles.map((b) => {
          const allOn = b.applications.every((a) => a.on);
          return (
            <li key={b.id} className="p-4 flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium text-slate-900 dark:text-white"><Boxes size={18} className="text-slate-400" aria-hidden /> {b.name}</p>
                {b.description && <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">{b.description}</p>}
                <ul className="mt-2 flex flex-wrap gap-2">
                  {b.applications.map((a) => (
                    <li key={a.id} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs ${a.on ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200'}`}>
                      {a.on && <CheckCircle2 size={12} aria-label="on" />} {a.name}
                    </li>
                  ))}
                </ul>
                {message?.bundle === b.id && (
                  <p role={message.error ? 'alert' : 'status'} className={`mt-2 text-sm ${message.error ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}`}>{message.text}</p>
                )}
              </div>
              {canManage && !allOn && (
                <button type="button" disabled={busy === b.id} onClick={() => void turnOn(b)}
                  className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                  Turn on
                </button>
              )}
              {allOn && <span className="text-sm text-emerald-700 dark:text-emerald-400">All on</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
