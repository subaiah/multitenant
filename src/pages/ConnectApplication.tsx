/**
 * Connecting an application in one step (backend lib/application-connect.ts,
 * docs/hub/CONNECT.md).
 *
 * An application sends a platform administrator here with its address, where
 * to come back to and a PKCE challenge:
 *
 *   /platform/applications/connect?app_url=https://hearth.example.com
 *     &redirect_uri=https://hearth.example.com/hub/connected
 *     &code_challenge=<S256>&state=<anything>&scope=members.read%20notifications.send
 *
 * The platform reads the application's manifest from that address and shows
 * what connecting it would do. Approving registers it and sends the browser
 * back with a one-time code; the application's own server then collects its
 * credentials. Nobody copies a secret.
 */
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Link2, ShieldCheck, XCircle } from 'lucide-react';
import { ApiError, apiPost } from '../lib/api-client';
import { invalidateApi } from '../lib/query';
import { rememberConnect } from '../lib/continue-after-sign-in';
import { useAuth } from '../contexts/AuthContext';
import { permissionMatches } from '../lib/permissions';
import { LoadingState, primaryButtonClass, secondaryButtonClass } from '../components/ui';

interface Check {
  application: { productId: string; name: string; description: string | null; version: string; baseUrl: string; kind: string | null };
  reconnect: boolean;
  addressChanged: boolean;
  clientTypeChange: boolean;
  signIn: { redirectUris: string[]; clientType: string };
  callbackUrl: string | null;
  permissions: { name: string; description: string }[];
  scopes: { name: string; description: string }[];
  returnsTo: string;
  manifestHash: string;
}

/** The request as the application sent it */
export function connectRequestOf(params: URLSearchParams) {
  const scope = params.get('scope')?.trim();
  return {
    appUrl: params.get('app_url') ?? '',
    redirectUri: params.get('redirect_uri') ?? '',
    codeChallenge: params.get('code_challenge') ?? '',
    ...(params.get('state') && { state: params.get('state')! }),
    scopes: scope ? scope.split(/\s+/) : [],
  };
}

/** Send the browser back to the application, saying it was not connected */
function declineUrl(redirectUri: string, state: string | undefined, appUrl: string): string | null {
  try {
    const back = new URL(redirectUri);
    // Only to the application's own address, as when approving
    if (back.origin !== new URL(appUrl).origin) return null;
    back.searchParams.set('error', 'access_denied');
    if (state) back.searchParams.set('state', state);
    return back.toString();
  } catch {
    return null;
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-white">{title}</h2>
      {children}
    </section>
  );
}

export default function ConnectApplication() {
  const { user, loading, permissions } = useAuth();
  const location = useLocation();
  const [params] = useSearchParams();
  const connect = useMemo(() => connectRequestOf(params), [params]);
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allowed = permissionMatches(permissions, 'app-registry:manage');

  useEffect(() => {
    if (!user || !allowed) return;
    let cancelled = false;
    apiPost<Check>('/applications/connect/check', connect)
      .then((c) => !cancelled && setCheck(c))
      .catch((e: unknown) => !cancelled && setError(e instanceof ApiError || e instanceof Error ? e.message : 'Could not read the request'));
    return () => {
      cancelled = true;
    };
  }, [user, allowed, connect]);

  if (loading) return <LoadingState />;
  if (!user) {
    // Back here, with the request, once signed in
    rememberConnect(`${location.pathname}${location.search}`);
    return <Navigate to="/login" replace />;
  }
  if (user.portal !== 'PLATFORM') return <Navigate to="/unauthorized" replace />;

  const decline = declineUrl(connect.redirectUri, connect.state, connect.appUrl);

  async function approve() {
    if (!check) return;
    setBusy(true);
    setError(null);
    try {
      const { redirectTo } = await apiPost<{ redirectTo: string }>('/applications/connect/approve', {
        ...connect,
        manifestHash: check.manifestHash,
        ...(check.clientTypeChange && { confirmClientTypeChange: true }),
      });
      invalidateApi('/applications');
      window.location.assign(redirectTo);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect the application');
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 space-y-6">
      <header className="flex items-start gap-3">
        <div className="mt-1 rounded-lg bg-blue-50 dark:bg-blue-900/30 p-2 text-blue-700 dark:text-blue-300">
          <Link2 size={20} aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">
            {check ? `Connect ${check.application.name}` : 'Connect an application'}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {check
              ? `${check.application.baseUrl} asks to join the platform. Approving registers it and hands its credentials to its own server; nobody needs to copy a secret.`
              : 'Reading the request…'}
          </p>
        </div>
      </header>

      {!allowed && (
        <p role="alert" className="flex gap-2 rounded-md bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-800 dark:text-red-200">
          <XCircle size={18} aria-hidden className="shrink-0" /> Connecting applications needs the app-registry:manage permission.
        </p>
      )}

      {error && (
        <p role="alert" className="flex gap-2 rounded-md bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-800 dark:text-red-200">
          <XCircle size={18} aria-hidden className="shrink-0" /> {error}
        </p>
      )}

      {allowed && !check && !error && <LoadingState label="Reading the application's manifest…" />}

      {check && (
        <div className="space-y-6 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5">
          {check.application.description && <p className="text-sm text-slate-700 dark:text-slate-200">{check.application.description}</p>}

          {(check.reconnect || check.addressChanged || check.clientTypeChange) && (
            <div className="space-y-2">
              {check.reconnect && (
                <p className="flex gap-2 rounded-md bg-amber-50 dark:bg-amber-900/30 p-3 text-sm text-amber-900 dark:text-amber-100">
                  <AlertTriangle size={18} aria-hidden className="shrink-0" />
                  {check.application.name} is already registered. Connecting again replaces its secrets; the copies it has now stop working.
                </p>
              )}
              {check.addressChanged && (
                <p className="flex gap-2 rounded-md bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-800 dark:text-red-200">
                  <AlertTriangle size={18} aria-hidden className="shrink-0" />
                  It was registered at a different address before. Approve only if you moved it to {check.application.baseUrl}.
                </p>
              )}
              {check.clientTypeChange && (
                <p className="flex gap-2 rounded-md bg-amber-50 dark:bg-amber-900/30 p-3 text-sm text-amber-900 dark:text-amber-100">
                  <AlertTriangle size={18} aria-hidden className="shrink-0" /> Its sign-in changes to a {check.signIn.clientType.toLowerCase()} client.
                </p>
              )}
            </div>
          )}

          <Section title="Sign-in">
            <p className="text-sm text-slate-600 dark:text-slate-300">People sign in to it with their organization account, and come back to:</p>
            <ul className="text-xs font-mono text-slate-700 dark:text-slate-200 space-y-1">
              {check.signIn.redirectUris.map((u) => <li key={u} className="break-all">{u}</li>)}
            </ul>
          </Section>

          {check.callbackUrl && (
            <Section title="Events">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                The platform tells it when organizations turn it on or off and when people change, at <span className="font-mono text-xs break-all">{check.callbackUrl}</span>.
              </p>
            </Section>
          )}

          {check.permissions.length > 0 && (
            <Section title={`Permissions organizations can grant (${check.permissions.length})`}>
              <ul className="text-sm space-y-1">
                {check.permissions.map((p) => (
                  <li key={p.name}><span className="font-mono text-xs">{p.name}</span> <span className="text-slate-600 dark:text-slate-300">— {p.description}</span></li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="What its server may call the platform for">
            {check.scopes.length ? (
              <ul className="text-sm space-y-1">
                {check.scopes.map((s) => (
                  <li key={s.name} className="flex gap-2"><ShieldCheck size={16} aria-hidden className="shrink-0 mt-0.5 text-emerald-600" /><span><span className="font-mono text-xs">{s.name}</span> <span className="text-slate-600 dark:text-slate-300">— {s.description}</span></span></li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-600 dark:text-slate-300">Nothing: it only signs people in.</p>
            )}
          </Section>

          <p className="text-xs text-slate-500 dark:text-slate-400">
            Organizations still choose whether to turn it on. Approving sends you back to <span className="font-mono">{check.returnsTo}</span>.
          </p>

          <div className="flex flex-wrap gap-3 justify-end">
            {decline && <a href={decline} className={secondaryButtonClass}>Don&apos;t connect</a>}
            <button type="button" onClick={approve} disabled={busy} className={primaryButtonClass}>
              <CheckCircle2 size={16} aria-hidden /> {busy ? 'Connecting…' : `Approve and connect`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
