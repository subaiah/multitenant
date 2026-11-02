/**
 * An external product's lifecycle events (platform staff): where they go, the
 * secret they're signed with, each organization's setup, and what was sent.
 * backend/src/routes/application-lifecycle.ts; docs/PRODUCT_INTEGRATION.md.
 */
import { useEffect, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiPost, apiPut } from '../lib/api-client';
import { invalidateApi } from '../lib/query';
import { CopyBox } from './CopyBox';
import { Field } from './Dialog';
import { Badge, Card, DataView, formatDateTime, formatRelative, humanize, inputClass, primaryButtonClass, secondaryButtonClass } from './ui';

interface Lifecycle {
  callbackUrl: string | null;
  hasSecret: boolean;
  deletesDataOnDeprovision: boolean;
  organizations: { tenant: { id: string; name: string; slug: string }; state: string; provisioningStatus: string; provisioningError: string | null; provisionedAt: string | null }[];
  events: {
    id: string; publicId: string; type: string; status: string; attempts: number; nextAttemptAt: string;
    lastStatus: number | null; lastError: string | null; deliveredAt: string | null; createdAt: string;
    tenant: { id: string; name: string | null; slug: string | null };
  }[];
}

export default function ApplicationLifecycle({ applicationId, applicationName }: { applicationId: string; applicationName: string }) {
  const path = `/applications/${applicationId}/lifecycle`;
  const info = useApi<Lifecycle>(path);
  const [secret, setSecret] = useState<string | null>(null);
  useEffect(() => setSecret(null), [applicationId]);
  const refresh = () => invalidateApi(path, '/tenant-applications');

  return (
    <Card title="Lifecycle events" description={`Tells ${applicationName} when an organization turns it on, changes or ends that, is suspended or resumed, or is deleted, so it can set the organization up or clean it up.`}>
      <DataView {...info}>
        {(data) => (
          <div className="space-y-5">
            {secret && (
              <div className="space-y-2 p-4 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">Copy the signing secret now: it isn't shown again. The application checks each event's signature with it.</p>
                <CopyBox value={secret} label="Signing secret" />
              </div>
            )}
            <SettingsForm key={`${applicationId}-${data.callbackUrl ?? ''}`} path={path} data={data} onSecret={setSecret} onSaved={refresh} />

            {data.organizations.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Organizations</h3>
                <ul className="divide-y divide-slate-100 dark:divide-slate-700 text-sm">
                  {data.organizations.map((o) => (
                    <li key={o.tenant.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="min-w-0 truncate text-slate-800 dark:text-slate-100">{o.tenant.name} <span className="text-xs text-slate-500 font-mono">{o.tenant.slug}</span></span>
                      <span className="flex items-center gap-2">
                        <Badge value={setupLabel(o.provisioningStatus)} />
                        {o.provisioningError && <span className="text-xs text-red-600 dark:text-red-400 max-w-xs truncate" title={o.provisioningError}>{o.provisioningError}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.events.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Recent events</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-slate-500">
                      <tr><th className="py-1 pr-3 font-medium">Event</th><th className="py-1 pr-3 font-medium">Organization</th><th className="py-1 pr-3 font-medium">Status</th><th className="py-1 font-medium" /></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                      {data.events.map((e) => (
                        <tr key={e.id} className="align-top">
                          <td className="py-2 pr-3">
                            <span className="font-mono text-xs text-slate-800 dark:text-slate-100">{e.type}</span>
                            <span className="block text-xs text-slate-500" title={formatDateTime(e.createdAt)}>{formatRelative(e.createdAt)}</span>
                          </td>
                          <td className="py-2 pr-3 text-slate-700 dark:text-slate-200">{e.tenant.name ?? <span className="text-slate-400">Deleted</span>}</td>
                          <td className="py-2 pr-3">
                            <Badge value={e.status} />
                            <span className="block text-xs text-slate-500">
                              {e.status === 'DELIVERED' ? `Answered ${e.lastStatus}` : e.lastError ? `${e.lastError}${e.status === 'PENDING' ? ` · next try ${formatRelative(e.nextAttemptAt)}` : ''}` : 'Sending'}
                              {e.attempts > 1 && ` · ${e.attempts} tries`}
                            </span>
                          </td>
                          <td className="py-2 text-right">
                            {e.status !== 'DELIVERED' && e.attempts > 0 && (
                              <button type="button" className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                                onClick={() => void apiPost(`/applications/${applicationId}/lifecycle/events/${e.id}/retry`).then(refresh)}>
                                <RotateCw size={12} aria-hidden /> Retry now
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </DataView>
    </Card>
  );
}

const setupLabel = (s: string) => (s === 'NOT_REQUIRED' ? 'No setup' : humanize(s));

function SettingsForm({ path, data, onSecret, onSaved }: { path: string; data: Lifecycle; onSecret: (s: string) => void; onSaved: () => void }) {
  const [url, setUrl] = useState(data.callbackUrl ?? '');
  const [deletes, setDeletes] = useState(data.deletesDataOnDeprovision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [told, setTold] = useState<number | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await apiPut<{ signingSecret?: string; organizationsTold: number }>(path, { callbackUrl: url.trim() || null, deletesDataOnDeprovision: deletes });
      if (r.signingSecret) onSecret(r.signingSecret);
      setTold(r.organizationsTold);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Saving failed');
    } finally {
      setBusy(false);
    }
  };
  const rotate = async () => {
    if (!confirm('Replace the signing secret? Events signed with the current one stop verifying at once.')) return;
    try {
      onSecret((await apiPost<{ signingSecret: string }>(`${path}/secret`)).signingSecret);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Replacing the secret failed');
    }
  };

  return (
    <form onSubmit={save} className="space-y-4">
      <Field label="Callback address" hint="Where the events are sent (POST, signed like webhooks). Leave empty if the application needs no setup per organization.">
        <input value={url} onChange={(e) => setUrl(e.target.value)} className={`${inputClass} font-mono text-xs`} placeholder="https://appforge.example.com/platform/events" />
      </Field>
      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
        <input type="checkbox" checked={deletes} onChange={(e) => setDeletes(e.target.checked)} className="rounded border-slate-300" />
        The application deletes an organization's data when it leaves
      </label>
      {told !== null && told > 0 && <p role="status" className="text-sm text-slate-600 dark:text-slate-300">{told} organization{told === 1 ? '' : 's'} that already had it on {told === 1 ? 'is' : 'are'} being told now.</p>}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {data.hasSecret && data.callbackUrl && <button type="button" className={secondaryButtonClass} onClick={() => void rotate()}>New signing secret</button>}
        <button type="submit" className={primaryButtonClass} disabled={busy}>Save</button>
      </div>
    </form>
  );
}
