/**
 * "Sign in with" settings for an application in the catalogue (platform
 * staff): turn it on, where it may return people to, and its client
 * credentials. backend/src/routes/application-sign-in.ts; docs/SIGN_IN_WITH.md.
 */
import { useEffect, useState } from 'react';
import { LogIn } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiPost, apiPut } from '../lib/api-client';
import { CopyBox } from './CopyBox';
import { Field } from './Dialog';
import { Card, DataView, formatDateTime, inputClass, primaryButtonClass, secondaryButtonClass } from './ui';

interface Settings {
  enabled: boolean;
  clientId: string;
  clientType: 'CONFIDENTIAL' | 'PUBLIC';
  hasSecret: boolean;
  secretCreatedAt: string | null;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  initiateLoginUri: string | null;
}
interface SignInInfo {
  issuer: string;
  discoveryUrl: string;
  settings: Settings | null;
  clientSecret?: string;
}

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

export default function ApplicationSignIn({ applicationId, applicationName }: { applicationId: string; applicationName: string }) {
  const info = useApi<SignInInfo>(`/applications/${applicationId}/sign-in`);
  const [secret, setSecret] = useState<string | null>(null);
  // A secret belongs to the application it was made for
  useEffect(() => setSecret(null), [applicationId]);

  return (
    <Card
      title="Sign in with your organization account"
      description={`Lets people sign in to ${applicationName} with their account here (OpenID Connect), if their organization has it turned on.`}
    >
      <DataView {...info}>
        {(data) => (
          <div className="space-y-5">
            {secret && (
              <div className="space-y-2 p-4 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">Copy the client secret now: it isn't shown again.</p>
                <CopyBox value={secret} label="Client secret" />
              </div>
            )}
            <SettingsForm
              key={`${applicationId}-${data.settings?.clientType ?? 'new'}`}
              applicationId={applicationId}
              info={data}
              onSaved={(next) => {
                if (next.clientSecret) setSecret(next.clientSecret);
                info.reload();
              }}
            />
          </div>
        )}
      </DataView>
    </Card>
  );
}

function SettingsForm({ applicationId, info, onSaved }: { applicationId: string; info: SignInInfo; onSaved: (next: SignInInfo) => void }) {
  const s = info.settings;
  const [enabled, setEnabled] = useState(s?.enabled ?? true);
  const [clientType, setClientType] = useState<Settings['clientType']>(s?.clientType ?? 'CONFIDENTIAL');
  const [redirects, setRedirects] = useState((s?.redirectUris ?? []).join('\n'));
  const [logoutRedirects, setLogoutRedirects] = useState((s?.postLogoutRedirectUris ?? []).join('\n'));
  const [loginUri, setLoginUri] = useState(s?.initiateLoginUri ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await apiPut<SignInInfo>(`/applications/${applicationId}/sign-in`, {
        enabled, clientType, redirectUris: lines(redirects), postLogoutRedirectUris: lines(logoutRedirects), initiateLoginUri: loginUri.trim() || null,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Saving failed');
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    if (!confirm('Replace the client secret? The current one stops working at once.')) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await apiPost<SignInInfo>(`/applications/${applicationId}/sign-in/secret`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Replacing the secret failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-5">
      {s && (
        <dl className="grid gap-3 text-sm">
          <div className="space-y-1">
            <dt className="text-slate-500 dark:text-slate-400">Client ID</dt>
            <dd><CopyBox value={s.clientId} label="Client ID" /></dd>
          </div>
          <div className="space-y-1">
            <dt className="text-slate-500 dark:text-slate-400">Issuer (the application finds everything else from it)</dt>
            <dd><CopyBox value={info.issuer} label="Issuer" /></dd>
          </div>
          {s.clientType === 'CONFIDENTIAL' && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Client secret</dt>
                <dd className="text-slate-700 dark:text-slate-200">{s.hasSecret ? `Made ${formatDateTime(s.secretCreatedAt)}` : 'None yet'}</dd>
              </div>
              <button type="button" className={secondaryButtonClass} disabled={busy} onClick={rotate}>New secret</button>
            </div>
          )}
        </dl>
      )}

      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="rounded border-slate-300" />
        People can sign in to this application
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm text-slate-600 dark:text-slate-300 mb-1">Kind of application</legend>
        {([
          ['CONFIDENTIAL', 'A server-side web application', 'It keeps a client secret and exchanges codes for tokens on its server.'],
          ['PUBLIC', 'A browser or mobile app', 'It can\'t keep a secret: it uses PKCE alone.'],
        ] as const).map(([value, label, hint]) => (
          <label key={value} className="flex items-start gap-2 text-sm">
            <input type="radio" name="clientType" value={value} checked={clientType === value} onChange={() => setClientType(value)} className="mt-1" />
            <span><span className="text-slate-800 dark:text-slate-100">{label}</span><span className="block text-xs text-slate-500">{hint}</span></span>
          </label>
        ))}
      </fieldset>

      <Field label="Redirect URIs" hint="Where the application receives the sign-in result, one per line. https://, or http://localhost while developing.">
        <textarea rows={3} value={redirects} onChange={(e) => setRedirects(e.target.value)} className={`${inputClass} font-mono text-xs`} placeholder="https://crm.example.com/auth/callback" />
      </Field>
      <Field label="After sign-out (optional)" hint="Where people may go after signing out of the application, one per line.">
        <textarea rows={2} value={logoutRedirects} onChange={(e) => setLogoutRedirects(e.target.value)} className={`${inputClass} font-mono text-xs`} placeholder="https://crm.example.com/" />
      </Field>
      <Field label="Open address (optional)" hint="Where the organization's Applications page sends people to open it: the application's page that starts signing in.">
        <input value={loginUri} onChange={(e) => setLoginUri(e.target.value)} className={`${inputClass} font-mono text-xs`} placeholder="https://crm.example.com/login" />
      </Field>

      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex justify-end">
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          <LogIn size={15} aria-hidden /> {s ? 'Save sign-in settings' : 'Set up sign-in'}
        </button>
      </div>
    </form>
  );
}
