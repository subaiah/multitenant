/**
 * Events between the organization's applications (Application Entitlements):
 * what each application publishes, which of the others receive it and why,
 * how many of the organization's webhook endpoints take it, and how often
 * it's been published. backend/src/lib/product-events.ts.
 */
import { Radio, Webhook } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { formatRelative } from './ui';

interface Flow {
  type: string;
  label: string;
  description: string | null;
  publisher: { id: string; key: string; name: string };
  receivers: { id: string; key: string; name: string; reason: string; waiting: string | null }[];
  webhooks: number;
  publishedLast30Days: number;
  lastPublishedAt: string | null;
}

export default function AppEvents() {
  const info = useApi<{ flows: Flow[] }>('/tenant-applications/events');
  const flows = info.data?.flows ?? [];
  if (!flows.length) return null;
  return (
    <section className="mt-6 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700" aria-labelledby="app-events-title">
      <div className="p-4 border-b border-slate-200 dark:border-slate-700">
        <h2 id="app-events-title" className="text-lg font-semibold text-slate-900 dark:text-white">Events between applications</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          What your applications announce, and who hears it: other applications you have on that asked for it, and your webhook endpoints (Developers page).
        </p>
      </div>
      <ul className="divide-y divide-slate-200 dark:divide-slate-700">
        {flows.map((f) => (
          <li key={f.type} className="p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="font-medium text-slate-900 dark:text-white min-w-0">
                <Radio size={15} className="inline mr-1.5 -mt-0.5 text-slate-400" aria-hidden />
                {f.publisher.name}: {f.label}
              </p>
              <p className="text-xs text-slate-500">
                {f.publishedLast30Days === 0 ? 'Not published in the last 30 days' : `${f.publishedLast30Days} in the last 30 days`}
                {f.lastPublishedAt && ` · last ${formatRelative(f.lastPublishedAt)}`}
              </p>
            </div>
            <p className="mt-0.5 font-mono text-xs text-slate-500 break-all">{f.type}</p>
            {f.description && <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{f.description}</p>}
            <div className="mt-2 text-sm">
              {f.receivers.length === 0 && f.webhooks === 0 && <p className="text-slate-500">Nobody receives it here yet.</p>}
              {f.receivers.length > 0 && (
                <ul className="space-y-1">
                  {f.receivers.map((r) => (
                    <li key={r.id} className="text-slate-700 dark:text-slate-200">
                      Sent to <span className="font-medium">{r.name}</span>
                      {r.waiting && <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">(not yet: {r.waiting})</span>}
                      <span className="block text-xs text-slate-500">Why: {r.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
              {f.webhooks > 0 && (
                <p className="mt-1 text-slate-700 dark:text-slate-200">
                  <Webhook size={14} className="inline mr-1 -mt-0.5 text-slate-400" aria-hidden />
                  And {f.webhooks} of your webhook endpoint{f.webhooks === 1 ? '' : 's'}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
