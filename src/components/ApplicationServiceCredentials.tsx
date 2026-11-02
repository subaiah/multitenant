/**
 * An external product's service credentials (platform staff): for calling
 * API v1 as itself, with OAuth client credentials. The secret is shown once.
 * backend/src/routes/application-service-credentials.ts; docs/PRODUCT_INTEGRATION.md.
 */
import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiDelete, apiPost } from '../lib/api-client';
import { invalidateApi } from '../lib/query';
import { CopyBox } from './CopyBox';
import { Field } from './Dialog';
import { Badge, Card, DataView, formatDateTime, formatRelative, inputClass, primaryButtonClass } from './ui';

interface Credential { id: string; name: string; clientId: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
interface Info {
  tokenUrl: string;
  audience: string;
  tokenLifetimeSeconds: number;
  scopes: { name: string; description: string }[];
  credentials: Credential[];
}

export default function ApplicationServiceCredentials({ applicationId, applicationName }: { applicationId: string; applicationName: string }) {
  const path = `/applications/${applicationId}/service-credentials`;
  const info = useApi<Info>(path);
  const [made, setMade] = useState<(Credential & { clientSecret: string }) | null>(null);
  useEffect(() => setMade(null), [applicationId]);

  return (
    <Card title="Service credentials" description={`For ${applicationName}'s server to call the platform's API as itself (OAuth client credentials), for the organizations that have it on. Separate from its sign-in client.`}>
      <DataView {...info}>
        {(data) => (
          <div className="space-y-5">
            {made && (
              <div className="space-y-2 p-4 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">Copy the secret for “{made.name}” now: it isn't shown again. Keep it on the application's server.</p>
                <p className="text-xs text-amber-900/80 dark:text-amber-200/80">Client ID</p>
                <CopyBox value={made.clientId} label="Service client ID" />
                <p className="text-xs text-amber-900/80 dark:text-amber-200/80">Client secret</p>
                <CopyBox value={made.clientSecret} label="Service client secret" />
              </div>
            )}
            <dl className="grid gap-2 text-sm">
              <div className="space-y-1">
                <dt className="text-slate-500 dark:text-slate-400">Token endpoint (grant_type=client_credentials, HTTP Basic)</dt>
                <dd><CopyBox value={data.tokenUrl} label="Token endpoint" /></dd>
              </div>
              <p className="text-xs text-slate-500">Tokens are for <span className="font-mono">{data.audience}</span> and last {Math.round(data.tokenLifetimeSeconds / 60)} minutes. Revoking a credential stops it at once, tokens included.</p>
            </dl>

            {data.credentials.length > 0 && (
              <ul className="divide-y divide-slate-100 dark:divide-slate-700 text-sm">
                {data.credentials.map((c) => (
                  <li key={c.id} className="py-3 flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-800 dark:text-slate-100">{c.name} {c.revokedAt && <Badge value="REVOKED" />}</p>
                      <p className="font-mono text-xs text-slate-500 break-all">{c.clientId}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {c.scopes.join(', ')} · made {formatDateTime(c.createdAt)} · {c.revokedAt ? `revoked ${formatRelative(c.revokedAt)}` : c.lastUsedAt ? `last used ${formatRelative(c.lastUsedAt)}` : 'not used yet'}
                      </p>
                    </div>
                    {!c.revokedAt && (
                      <button type="button" className="text-xs text-red-600 hover:text-red-700"
                        onClick={() => confirm(`Revoke “${c.name}”? Anything using it stops working at once.`) && void apiDelete(`${path}/${c.id}`).then(() => invalidateApi(path))}>
                        Revoke
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <NewCredential path={path} scopes={data.scopes} onMade={(c) => { setMade(c); void invalidateApi(path); }} />
          </div>
        )}
      </DataView>
    </Card>
  );
}

function NewCredential({ path, scopes, onMade }: { path: string; scopes: Info['scopes']; onMade: (c: Credential & { clientSecret: string }) => void }) {
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onMade(await apiPost<Credential & { clientSecret: string }>(path, { name: name.trim(), scopes: chosen }));
      setName('');
      setChosen([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Making the credential failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3 pt-2 border-t border-slate-100 dark:border-slate-700">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">New credential</h3>
      <Field label="Name" hint="Where it's used, e.g. “Production server”.">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} maxLength={60} />
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm text-slate-600 dark:text-slate-300 mb-1">What it may do</legend>
        {scopes.map((s) => (
          <label key={s.name} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={chosen.includes(s.name)} onChange={(e) => setChosen(e.target.checked ? [...chosen, s.name] : chosen.filter((x) => x !== s.name))} />
            <span><span className="font-mono text-xs text-slate-800 dark:text-slate-100">{s.name}</span><span className="block text-xs text-slate-500">{s.description}</span></span>
          </label>
        ))}
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex justify-end">
        <button type="submit" className={primaryButtonClass} disabled={busy || !name.trim() || chosen.length === 0}><KeyRound size={15} aria-hidden /> Make credential</button>
      </div>
    </form>
  );
}
