/**
 * Developers: API keys for other systems to call the API as the organization,
 * and webhooks for the organization's events to reach them.
 * backend/src/routes/api-keys.ts, backend/src/routes/webhooks.ts; docs/API_ACCESS.md.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Copy, KeyRound, Webhook } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { API_URL, apiDelete, apiGet, apiPatch, apiPost } from '../lib/api-client';
import { Dialog, Field } from '../components/Dialog';
import { Badge, Card, DataView, EmptyState, PageHeader, formatDate, formatDateTime, formatRelative, inputClass, primaryButtonClass, secondaryButtonClass, selectClass } from '../components/ui';

const apiBase = () => `${new URL(API_URL, window.location.origin).toString().replace(/\/$/, '')}/v1`;

function CopyBox({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-2">
      <code aria-label={label} className="flex-1 min-w-0 break-all rounded-md border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-xs font-mono text-slate-800 dark:text-slate-100">{value}</code>
      <button type="button" className={secondaryButtonClass} onClick={() => navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {})}>
        {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />} {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function DevelopersPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'webhooks' ? 'webhooks' : 'keys';
  const tabs = [{ id: 'keys', label: 'API keys' }, { id: 'webhooks', label: 'Webhooks' }];
  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Developers" description="Connect your other systems: API keys to call this app's API, webhooks to hear about what happens here" />
      <div role="tablist" className="flex gap-1 border-b border-slate-200 dark:border-slate-700">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setParams({ tab: t.id }, { replace: true })}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'keys' ? <KeysTab /> : <WebhooksTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

interface ApiKey {
  id: string; name: string; hint: string; permissions: string[]; createdBy: string | null; expiresAt: string | null;
  lastUsedAt: string | null; lastUsedIp: string | null; revokedAt: string | null; createdAt: string; status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
}
interface PermissionGroup { resource: string; label: string; permissions: { name: string; description: string }[] }

function KeysTab() {
  const keys = useApi<{ keys: ApiKey[] }>('/api-keys');
  const { hasPermission } = useAuth();
  const canManage = hasPermission('api:manage');
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<{ name: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const revoke = async (k: ApiKey) => {
    if (!confirm(`Revoke "${k.name}"? Anything using it stops working at once.`)) return;
    setError(null);
    try {
      await apiDelete(`/api-keys/${k.id}`);
      await keys.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke the key');
    }
  };

  return (
    <div className="space-y-6">
      {made && (
        <Card title={`"${made.name}" is ready`} description="Copy the key now: it isn't shown again. Store it like a password.">
          <div className="space-y-3">
            <CopyBox value={made.key} label="The new API key" />
            <p className="text-sm text-slate-600 dark:text-slate-400">Send it with each request:</p>
            <CopyBox value={`curl -H "Authorization: Bearer ${made.key}" ${apiBase()}/users`} label="Example request" />
            <div className="flex justify-end"><button className={secondaryButtonClass} onClick={() => setMade(null)}>Done</button></div>
          </div>
        </Card>
      )}
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      <Card
        title="API keys"
        description="A key acts for the organization, with the permissions you give it. Its use is recorded in the audit log."
        actions={canManage ? <button className={primaryButtonClass} onClick={() => setCreating(true)}><KeyRound size={15} aria-hidden /> New key</button> : undefined}
      >
        <DataView {...keys}>
          {(d) => d.keys.length === 0 ? (
            <EmptyState icon={KeyRound} title="No API keys yet" message="Make one for each system that connects, so you can revoke them one at a time." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-700">
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Permissions</th>
                    <th className="py-2 pr-4 font-medium hidden md:table-cell">Last used</th>
                    <th className="py-2 pr-4 font-medium hidden md:table-cell">Expires</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {d.keys.map((k) => (
                    <tr key={k.id} className="border-b border-slate-100 dark:border-slate-700/60 last:border-0 align-top">
                      <td className="py-2 pr-4">
                        <div className="font-medium text-slate-800 dark:text-white">{k.name}</div>
                        <div className="text-xs text-slate-500 font-mono">mtk_…{k.hint}</div>
                        <div className="text-xs text-slate-500">{k.createdBy ? `by ${k.createdBy}, ` : ''}{formatDate(k.createdAt)}</div>
                      </td>
                      <td className="py-2 pr-4">
                        <details>
                          <summary className="cursor-pointer text-slate-700 dark:text-slate-300">{k.permissions.length} permission{k.permissions.length === 1 ? '' : 's'}</summary>
                          <ul className="mt-1 text-xs font-mono text-slate-600 dark:text-slate-400">{k.permissions.map((p) => <li key={p}>{p}</li>)}</ul>
                        </details>
                      </td>
                      <td className="py-2 pr-4 hidden md:table-cell text-slate-600 dark:text-slate-400">{k.lastUsedAt ? <span title={`${formatDateTime(k.lastUsedAt)}${k.lastUsedIp ? ` from ${k.lastUsedIp}` : ''}`}>{formatRelative(k.lastUsedAt)}</span> : 'Never'}</td>
                      <td className="py-2 pr-4 hidden md:table-cell text-slate-600 dark:text-slate-400">{k.expiresAt ? formatDate(k.expiresAt) : 'Never'}</td>
                      <td className="py-2 pr-4"><Badge value={k.status} /></td>
                      <td className="py-2 text-right">{canManage && k.status === 'ACTIVE' && <button className="text-sm text-red-600 hover:underline" onClick={() => revoke(k)}>Revoke</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataView>
      </Card>
      <p className="text-xs text-slate-500">
        Send <code className="font-mono">Authorization: Bearer mtk_…</code> (or <code className="font-mono">X-API-Key</code>) to {apiBase()}. Keys can call any route their permissions allow,
        except the ones for a signed-in person's own account. They can't make keys, change webhooks or pay.
        The routes promised to stay compatible, with every parameter and answer, are in <a className="text-blue-600 hover:underline" href={`${apiBase()}/openapi.json`} target="_blank" rel="noreferrer">the API v1 document</a>.
      </p>
      {creating && <NewKeyDialog onClose={() => setCreating(false)} onMade={async (m) => { setCreating(false); setMade(m); await keys.reload(); }} />}
    </div>
  );
}

function NewKeyDialog({ onClose, onMade }: { onClose: () => void; onMade: (m: { name: string; key: string }) => void }) {
  const offered = useApi<{ groups: PermissionGroup[] }>('/api-keys/permissions');
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('90');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = useMemo(() => offered.data?.groups.flatMap((g) => g.permissions.map((p) => p.name)) ?? [], [offered.data]);
  const toggle = (p: string) => setChosen((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chosen.size) return setError('Choose at least one permission');
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ key: string; name: string }>('/api-keys', { name, permissions: [...chosen], expiresInDays: expires === 'never' ? null : Number(expires) });
      onMade({ name: res.name, key: res.key });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not make the key');
      setBusy(false);
    }
  };

  return (
    <Dialog title="New API key" onClose={onClose} onSubmit={submit} wide>
      <Field label="Name" hint="What will use it, e.g. “CRM sync”">
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} autoFocus />
      </Field>
      <Field label="Expires">
        <select value={expires} onChange={(e) => setExpires(e.target.value)} className={selectClass}>
          <option value="30">In 30 days</option>
          <option value="90">In 90 days</option>
          <option value="365">In a year</option>
          <option value="never">Never</option>
        </select>
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm text-slate-600 dark:text-slate-300">Permissions <span className="text-xs text-slate-500">(only ones you have yourself)</span></legend>
        <div className="flex gap-3 text-xs">
          <button type="button" className="text-blue-600 hover:underline" onClick={() => setChosen(new Set(all.filter((p) => p.endsWith(':read'))))}>Read only</button>
          <button type="button" className="text-blue-600 hover:underline" onClick={() => setChosen(new Set())}>None</button>
        </div>
        <DataView {...offered}>
          {(d) => (
            <div className="max-h-64 overflow-y-auto rounded-md border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700/60">
              {d.groups.map((g) => (
                <div key={g.resource} className="p-2.5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{g.label}</p>
                  {g.permissions.map((p) => (
                    <label key={p.name} className="flex items-start gap-2 mt-1 text-sm text-slate-700 dark:text-slate-300">
                      <input type="checkbox" className="mt-0.5 rounded border-slate-300" checked={chosen.has(p.name)} onChange={() => toggle(p.name)} />
                      <span>{p.description} <span className="font-mono text-xs text-slate-500">{p.name}</span></span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
        </DataView>
      </fieldset>
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={secondaryButtonClass} onClick={onClose}>Cancel</button>
        <button type="submit" className={primaryButtonClass} disabled={busy || !name.trim()}>{busy ? 'Making…' : 'Make key'}</button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

interface Endpoint {
  id: string; url: string; description: string | null; events: string[]; enabled: boolean; lastSuccessAt: string | null; lastFailureAt: string | null;
  consecutiveFailures: number; disabledReason: string | null; createdAt: string; waiting: number; failedThisWeek: number;
}
interface EventType { type: string; label: string; category: string }
interface Delivery {
  id: string; eventId: string; type: string; status: string; attempts: number; nextAttemptAt: string | null; responseStatus: number | null;
  lastError: string | null; durationMs: number | null; deliveredAt: string | null; createdAt: string; payload: unknown;
}

function WebhooksTab() {
  const endpoints = useApi<{ endpoints: Endpoint[] }>('/webhooks');
  const events = useApi<{ events: EventType[] }>('/webhooks/events');
  const { hasPermission } = useAuth();
  const canManage = hasPermission('api:manage');
  const [editing, setEditing] = useState<Endpoint | 'new' | null>(null);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);

  return (
    <div className="space-y-6">
      {secret && (
        <Card title="Signing secret" description={`For ${secret.url}. Copy it now: it isn't shown again.`}>
          <div className="space-y-3">
            <CopyBox value={secret.secret} label="Signing secret" />
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Each delivery has <code className="font-mono">webhook-id</code>, <code className="font-mono">webhook-timestamp</code> and <code className="font-mono">webhook-signature</code> headers
              (the <a className="text-blue-600 hover:underline" href="https://www.standardwebhooks.com/" target="_blank" rel="noreferrer">Standard Webhooks</a> format; its libraries check them for you).
              Answer with a 2xx within 10 seconds; anything else is retried for about two days.
            </p>
            <div className="flex justify-end"><button className={secondaryButtonClass} onClick={() => setSecret(null)}>Done</button></div>
          </div>
        </Card>
      )}
      <DataView {...endpoints}>
        {(d) => (
          <Card
            title="Webhooks"
            description="We send each event you choose to your URL as it happens"
            actions={canManage ? <button className={primaryButtonClass} onClick={() => setEditing('new')}><Webhook size={15} aria-hidden /> Add webhook</button> : undefined}
          >
            {d.endpoints.length === 0 ? (
              <EmptyState icon={Webhook} title="No webhooks yet" message="Add a URL to receive events such as people being invited, roles changing or the subscription renewing." />
            ) : (
              <div className="space-y-4">
                {d.endpoints.map((e) => (
                  <EndpointRow key={e.id} e={e} canManage={canManage} onEdit={() => setEditing(e)} onChanged={endpoints.reload} onSecret={(s) => setSecret({ url: e.url, secret: s })} />
                ))}
              </div>
            )}
          </Card>
        )}
      </DataView>
      {editing && (
        <EndpointDialog
          endpoint={editing === 'new' ? null : editing}
          events={events.data?.events ?? []}
          onClose={() => setEditing(null)}
          onSaved={async (made) => {
            setEditing(null);
            if (made) setSecret(made);
            await endpoints.reload();
          }}
        />
      )}
    </div>
  );
}

function EndpointRow({ e, canManage, onEdit, onChanged, onSecret }: { e: Endpoint; canManage: boolean; onEdit: () => void; onChanged: () => Promise<void> | void; onSecret: (s: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Something went wrong' });
    } finally {
      setBusy(null);
    }
  };
  const loadDeliveries = () => act('deliveries', async () => setDeliveries((await apiGet<{ deliveries: Delivery[] }>(`/webhooks/${e.id}/deliveries`)).deliveries));

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm text-slate-800 dark:text-white break-all">{e.url}</p>
          {e.description && <p className="text-sm text-slate-600 dark:text-slate-400">{e.description}</p>}
          <p className="mt-1 text-xs text-slate-500">
            {e.events.includes('*') ? 'All events' : `${e.events.length} event${e.events.length === 1 ? '' : 's'}: ${e.events.slice(0, 4).join(', ')}${e.events.length > 4 ? '…' : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge value={e.enabled ? 'ACTIVE' : 'INACTIVE'} />
        </div>
      </div>
      {e.disabledReason && <p className="mt-2 text-sm text-red-600" role="alert">{e.disabledReason}</p>}
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
        <div><dt className="inline">Last delivered: </dt><dd className="inline">{e.lastSuccessAt ? formatRelative(e.lastSuccessAt) : 'never'}</dd></div>
        {e.lastFailureAt && <div><dt className="inline">Last failure: </dt><dd className="inline">{formatRelative(e.lastFailureAt)}</dd></div>}
        {e.waiting > 0 && <div>{e.waiting} waiting to retry</div>}
        {e.failedThisWeek > 0 && <div className="text-red-600">{e.failedThisWeek} given up on this week</div>}
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        {canManage && (
          <button className={secondaryButtonClass} disabled={!!busy} onClick={() => act('test', async () => {
            const r = await apiPost<{ ok: boolean; status: number | null; error: string | null; durationMs: number }>(`/webhooks/${e.id}/test`);
            setNote({ ok: r.ok, text: r.ok ? `Test event delivered: answered ${r.status} in ${r.durationMs} ms` : `Test event failed: ${r.error ?? 'no answer'}` });
            await onChanged();
          })}>{busy === 'test' ? 'Sending…' : 'Send test event'}</button>
        )}
        <button className={secondaryButtonClass} disabled={!!busy} onClick={deliveries ? () => setDeliveries(null) : loadDeliveries}>{deliveries ? 'Hide deliveries' : 'Deliveries'}</button>
        {canManage && (
          <>
            <button className={secondaryButtonClass} disabled={!!busy} onClick={onEdit}>Edit</button>
            <button className={secondaryButtonClass} disabled={!!busy} onClick={() => act('toggle', async () => { await apiPatch(`/webhooks/${e.id}`, { enabled: !e.enabled }); await onChanged(); })}>{e.enabled ? 'Turn off' : 'Turn on'}</button>
            <button className={secondaryButtonClass} disabled={!!busy} onClick={() => confirm('Replace the signing secret? The current one stops working at once.') && act('rotate', async () => onSecret((await apiPost<{ secret: string }>(`/webhooks/${e.id}/rotate-secret`)).secret))}>New secret</button>
            <button className="text-sm text-red-600 hover:underline px-2" disabled={!!busy} onClick={() => confirm(`Remove the webhook to ${e.url}?`) && act('delete', async () => { await apiDelete(`/webhooks/${e.id}`); await onChanged(); })}>Remove</button>
          </>
        )}
      </div>
      {note && <p className={`mt-2 text-sm ${note.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`} role="status">{note.text}</p>}
      {deliveries && (
        <div className="mt-3 overflow-x-auto">
          {deliveries.length === 0 ? <p className="text-sm text-slate-500">No deliveries yet.</p> : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-700">
                  <th className="py-1.5 pr-3 font-medium">Event</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 pr-3 font-medium hidden md:table-cell">Answer</th>
                  <th className="py-1.5 pr-3 font-medium hidden md:table-cell">When</th>
                  <th className="py-1.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-b border-slate-100 dark:border-slate-700/60 last:border-0 align-top">
                    <td className="py-1.5 pr-3">
                      <details>
                        <summary className="cursor-pointer font-mono text-xs text-slate-800 dark:text-slate-200">{d.type}</summary>
                        <pre className="mt-1 max-w-[36rem] overflow-x-auto rounded bg-slate-50 dark:bg-slate-900 p-2 text-xs">{JSON.stringify(d.payload, null, 2)}</pre>
                      </details>
                    </td>
                    <td className="py-1.5 pr-3">
                      <Badge value={d.status === 'PENDING' && d.attempts > 0 ? 'SCHEDULED' : d.status} />
                      {d.status === 'FAILED' && <div className="text-xs text-slate-500">Gave up after {d.attempts} {d.attempts === 1 ? 'try' : 'tries'}</div>}
                      {d.status === 'PENDING' && d.attempts > 0 && d.nextAttemptAt && <div className="text-xs text-slate-500">Next try {formatRelative(d.nextAttemptAt)}</div>}
                    </td>
                    <td className="py-1.5 pr-3 hidden md:table-cell text-xs text-slate-600 dark:text-slate-400">{d.responseStatus ?? '—'}{d.lastError && d.status !== 'DELIVERED' ? ` · ${d.lastError}` : ''}{d.durationMs !== null ? ` · ${d.durationMs} ms` : ''}</td>
                    <td className="py-1.5 pr-3 hidden md:table-cell text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">{formatDateTime(d.createdAt)}</td>
                    <td className="py-1.5 text-right">
                      {canManage && (d.status === 'FAILED' || (d.status === 'PENDING' && d.attempts > 0)) && e.enabled && (
                        <button className="text-xs text-blue-600 hover:underline" onClick={() => act('retry', async () => { await apiPost(`/webhooks/deliveries/${d.id}/retry`); setTimeout(loadDeliveries, 800); })}>Send again</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function EndpointDialog({ endpoint, events, onClose, onSaved }: {
  endpoint: Endpoint | null; events: EventType[]; onClose: () => void; onSaved: (made: { url: string; secret: string } | null) => void;
}) {
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [allEvents, setAllEvents] = useState(endpoint ? endpoint.events.includes('*') : false);
  const [chosen, setChosen] = useState<Set<string>>(new Set(endpoint?.events.filter((e) => e !== '*') ?? []));
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byCategory = useMemo(() => {
    const m = new Map<string, EventType[]>();
    for (const e of events.filter((x) => !filter || `${x.type} ${x.label}`.toLowerCase().includes(filter.toLowerCase()))) m.set(e.category, [...(m.get(e.category) ?? []), e]);
    return [...m.entries()];
  }, [events, filter]);
  const toggle = (t: string) => setChosen((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const list = allEvents ? ['*'] : [...chosen];
    if (!list.length) return setError('Choose at least one event');
    setBusy(true);
    setError(null);
    try {
      if (endpoint) {
        await apiPatch(`/webhooks/${endpoint.id}`, { url, description: description || null, events: list });
        onSaved(null);
      } else {
        const r = await apiPost<{ url: string; secret: string }>('/webhooks', { url, description: description || undefined, events: list });
        onSaved({ url: r.url, secret: r.secret });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the webhook');
      setBusy(false);
    }
  };

  return (
    <Dialog title={endpoint ? 'Edit webhook' : 'Add webhook'} onClose={onClose} onSubmit={submit} wide>
      <Field label="URL" hint="https, reachable from the internet">
        <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/multitenant" className={inputClass} autoFocus />
      </Field>
      <Field label="Description (optional)">
        <input maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm text-slate-600 dark:text-slate-300">Events</legend>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input type="checkbox" className="rounded border-slate-300" checked={allEvents} onChange={(e) => setAllEvents(e.target.checked)} />
          All events, including ones added later
        </label>
        {!allEvents && (
          <>
            <input aria-label="Find events" placeholder="Find events…" value={filter} onChange={(e) => setFilter(e.target.value)} className={inputClass} />
            <div className="max-h-64 overflow-y-auto rounded-md border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700/60">
              {byCategory.map(([category, list]) => (
                <div key={category} className="p-2.5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{category}</p>
                  {list.map((e) => (
                    <label key={e.type} className="flex items-start gap-2 mt-1 text-sm text-slate-700 dark:text-slate-300">
                      <input type="checkbox" className="mt-0.5 rounded border-slate-300" checked={chosen.has(e.type)} onChange={() => toggle(e.type)} />
                      <span>{e.label} <span className="font-mono text-xs text-slate-500">{e.type}</span></span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-500">{chosen.size} chosen</p>
          </>
        )}
      </fieldset>
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={secondaryButtonClass} onClick={onClose}>Cancel</button>
        <button type="submit" className={primaryButtonClass} disabled={busy}>{busy ? 'Saving…' : endpoint ? 'Save' : 'Add webhook'}</button>
      </div>
    </Dialog>
  );
}
