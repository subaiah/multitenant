/**
 * Register or update an external product from its manifest (platform staff).
 * backend/src/lib/product-manifest.ts; docs/PRODUCT_INTEGRATION.md.
 */
import { useState } from 'react';
import { FileJson } from 'lucide-react';
import { ApiError, apiPost } from '../lib/api-client';
import { invalidateApi } from '../lib/query';
import { CopyBox } from './CopyBox';
import { Dialog, Field } from './Dialog';
import { inputClass, primaryButtonClass, secondaryButtonClass } from './ui';

interface ImportResult {
  application: { id: string; key: string; name: string; version: string };
  created: boolean;
  clientId: string;
  clientSecret?: string;
  callbackSigningSecret?: string;
  organizationsTold?: number;
  permissions: { added: string[]; updated: string[]; notInManifest: string[] };
  /** Declared notification and audit event types (manifest v2) */
  platformServices?: { added: string[]; updated: string[]; retired: string[] } | { leftAlone: true };
  /** Scopes exposed to and consumed from other applications (manifest v2) */
  api?: { added: string[]; updated: string[]; retired: string[]; consumes: number; notExposedYet: string[] } | { leftAlone: true };
  /** Applications it requires or works with (manifest v2) */
  dependencies?: { requires: number; integratesWith: number; notRegisteredYet: string[] } | { leftAlone: true };
  embeds?: { tags: string[] } | { leftAlone: true };
  menuItems: number;
  changes: Record<string, [unknown, unknown]>;
  dryRun?: true;
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Name', version: 'Version', baseUrl: 'Address', callbackUrl: 'Lifecycle callback', deletesDataOnDeprovision: 'Deletes data when an organization leaves', userEvents: 'Told when people change',
  clientType: 'Client type', redirectUris: 'Redirect URIs', postLogoutRedirectUris: 'After sign-out', openUrl: 'Open address', signInEnabled: 'Sign-in on', backchannelLogoutUri: 'Back-channel logout', accessTokenLifetime: 'Access token lifetime (s)',
};
const show = (v: unknown) => (v === null || v === undefined || (Array.isArray(v) && !v.length) ? '—' : Array.isArray(v) ? v.join(', ') : String(v));

/** What an import would do (a dry run) */
function Plan({ plan }: { plan: ImportResult }) {
  const p = plan.permissions;
  const fields = Object.entries(plan.changes);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-700 dark:text-slate-200">
        {plan.created ? `Adds ${plan.application.name} to the catalogue, with sign-in on.` : `Updates ${plan.application.name}.`} Nothing has been saved yet.
      </p>
      {fields.length > 0 && (
        <dl className="divide-y divide-slate-100 dark:divide-slate-700 rounded-md border border-slate-200 dark:border-slate-600">
          {fields.map(([k, [from, to]]) => (
            <div key={k} className="px-3 py-2">
              <dt className="text-xs text-slate-500">{FIELD_LABELS[k] ?? k}</dt>
              <dd className="font-mono text-xs break-all text-slate-800 dark:text-slate-100">{plan.created ? show(to) : <>{show(from)} → {show(to)}</>}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-slate-600 dark:text-slate-300">
        Permissions: {p.added.length} added, {p.updated.length} updated{p.notInManifest.length ? `, ${p.notInManifest.length} no longer listed (kept)` : ''}. Menu entries: {plan.menuItems}.
      </p>
      <ServicesLine services={plan.platformServices} />
      <ApiLine api={plan.api} />
      <DependenciesLine dependencies={plan.dependencies} />
      <EmbedsLine embeds={plan.embeds} />
    </div>
  );
}

export function ManifestImport({ onClose, onImported }: { onClose: () => void; onImported: (applicationId: string) => void }) {
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [plan, setPlan] = useState<ImportResult | null>(null);
  // The import would switch client type: asked to confirm
  const [typeChange, setTypeChange] = useState<string | null>(null);

  // A different manifest: the last check or confirmation no longer applies
  const change = (value: string) => {
    setText(value);
    setPlan(null);
    setTypeChange(null);
  };
  const readFile = async (file: File | undefined) => {
    if (file) change(await file.text());
  };

  const send = async ({ dryRun = false, confirm = false } = {}) => {
    setProblems(null);
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      setProblems(["This isn't valid JSON."]);
      return;
    }
    setBusy(true);
    try {
      const query = new URLSearchParams({ ...(dryRun && { dryRun: 'true' }), ...(confirm && { confirmClientTypeChange: 'true' }) });
      const r = await apiPost<ImportResult>(`/applications/manifest${query.size ? `?${query}` : ''}`, manifest);
      if (r.dryRun) {
        setPlan(r);
        return;
      }
      setResult(r);
      await invalidateApi('/applications', '/tenant-applications');
      onImported(r.application.id);
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { code?: string } | undefined) : undefined;
      const message = err instanceof Error ? err.message : 'Importing failed';
      if (body?.code === 'CLIENT_TYPE_CHANGE') setTypeChange(message);
      else setProblems(message.split('\n').filter(Boolean));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void send({ confirm: !!typeChange });
  };

  if (result) {
    const { permissions: p } = result;
    return (
      <Dialog title={result.created ? `${result.application.name} added` : `${result.application.name} updated`} onClose={onClose} wide>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Version {result.application.version}. {p.added.length} permission{p.added.length === 1 ? '' : 's'} added, {p.updated.length} updated; {result.menuItems} menu entr{result.menuItems === 1 ? 'y' : 'ies'}.
        </p>
        <ServicesLine services={result.platformServices} />
        <ApiLine api={result.api} />
        <DependenciesLine dependencies={result.dependencies} />
        <EmbedsLine embeds={result.embeds} />
        <div className="space-y-1">
          <p className="text-sm text-slate-600 dark:text-slate-300">Client ID</p>
          <CopyBox value={result.clientId} label="Client ID" />
        </div>
        {result.clientSecret && (
          <div className="space-y-2 p-4 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">Copy the client secret now: it isn't shown again. Store it on the application's server.</p>
            <CopyBox value={result.clientSecret} label="Client secret" />
          </div>
        )}
        {result.callbackSigningSecret && (
          <div className="space-y-2 p-4 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">Copy the lifecycle events' signing secret now: it isn't shown again.</p>
            <CopyBox value={result.callbackSigningSecret} label="Signing secret" />
          </div>
        )}
        {!!result.organizationsTold && (
          <p className="text-sm text-slate-600 dark:text-slate-300">{result.organizationsTold} organization{result.organizationsTold === 1 ? '' : 's'} that already had it on {result.organizationsTold === 1 ? 'is' : 'are'} being told now.</p>
        )}
        {p.notInManifest.length > 0 && (
          <div className="text-sm p-3 rounded-md border border-slate-200 dark:border-slate-600">
            <p className="text-slate-700 dark:text-slate-200">No longer in the manifest, so not removed (roles may still use them):</p>
            <ul className="mt-1 font-mono text-xs text-slate-600 dark:text-slate-300 list-disc pl-5">{p.notInManifest.map((n) => <li key={n}>{n}</li>)}</ul>
            <p className="mt-1 text-xs text-slate-500">Remove them from the application's permissions once no role uses them.</p>
          </div>
        )}
        <div className="flex justify-end"><button type="button" className={primaryButtonClass} onClick={onClose}>Done</button></div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Import a manifest" onClose={onClose} onSubmit={submit} wide>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Adds an external product, or updates it if its <span className="font-mono">productId</span> is already in the catalogue. The format is in docs/PRODUCT_INTEGRATION.md.
      </p>
      <Field label="Manifest file">
        <input type="file" accept="application/json,.json" onChange={(e) => void readFile(e.target.files?.[0])} className="block w-full text-sm text-slate-600 dark:text-slate-300" />
      </Field>
      <Field label="Or paste it">
        <textarea rows={10} value={text} onChange={(e) => change(e.target.value)} spellCheck={false}
          className={`${inputClass} font-mono text-xs`} placeholder={'{\n  "manifestVersion": 1,\n  "productId": "appforge",\n  …\n}'} />
      </Field>
      {plan && <Plan plan={plan} />}
      {typeChange && (
        <div role="alert" className="text-sm p-3 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-amber-900 dark:text-amber-200">
          {typeChange.replace(' Import again with confirmClientTypeChange to go ahead.', '')} Import to go ahead.
        </div>
      )}
      {problems && (
        <div role="alert" className="text-sm text-red-700 dark:text-red-300 p-3 rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10">
          <ul className="space-y-0.5">{problems.map((m, i) => <li key={i} className="break-words">{m}</li>)}</ul>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={secondaryButtonClass} onClick={onClose}>Cancel</button>
        <button type="button" className={secondaryButtonClass} disabled={busy || !text.trim()} onClick={() => void send({ dryRun: true })}>Check</button>
        <button type="submit" className={primaryButtonClass} disabled={busy || !text.trim()}>
          <FileJson size={15} aria-hidden /> {typeChange ? 'Switch client type and import' : 'Import'}
        </button>
      </div>
    </Dialog>
  );
}

/** Declared notification and audit event types: what the import did with them */
function ServicesLine({ services }: { services?: ImportResult['platformServices'] }) {
  if (!services) return null;
  if ('leftAlone' in services) return null;
  const { added, updated, retired } = services;
  if (!added.length && !updated.length && !retired.length) return null;
  return (
    <p className="text-sm text-slate-600 dark:text-slate-300">
      Notification and audit event types: {added.length} added, {updated.length} updated{retired.length ? `, ${retired.length} no longer listed (kept, can't be used)` : ''}.
    </p>
  );
}

/** Scopes exposed to other applications, and consumed from them */
function ApiLine({ api }: { api?: ImportResult['api'] }) {
  if (!api || 'leftAlone' in api) return null;
  const { added, updated, retired, consumes, notExposedYet } = api;
  if (!added.length && !updated.length && !retired.length && !consumes) return null;
  return (
    <div className="text-sm text-slate-600 dark:text-slate-300">
      <p>
        Exposed scopes: {added.length} added, {updated.length} updated{retired.length ? `, ${retired.length} no longer listed (kept, can't be used)` : ''}. Consumes {consumes} from other applications.
      </p>
      {notExposedYet.length > 0 && (
        <p className="mt-1 text-amber-700 dark:text-amber-400">No registered application exposes these yet: <span className="font-mono text-xs">{notExposedYet.join(', ')}</span></p>
      )}
    </div>
  );
}

/** Applications it requires or works with */
function DependenciesLine({ dependencies }: { dependencies?: ImportResult['dependencies'] }) {
  if (!dependencies || 'leftAlone' in dependencies) return null;
  const { requires, integratesWith, notRegisteredYet } = dependencies;
  if (!requires && !integratesWith) return null;
  return (
    <div className="text-sm text-slate-600 dark:text-slate-300">
      <p>Requires {requires} application{requires === 1 ? '' : 's'}; works with {integratesWith}.</p>
      {notRegisteredYet.length > 0 && <p className="mt-1 text-amber-700 dark:text-amber-400">Not registered yet: <span className="font-mono text-xs">{notRegisteredYet.join(', ')}</span></p>}
    </div>
  );
}

/** Web Components it offers other applications */
function EmbedsLine({ embeds }: { embeds?: ImportResult['embeds'] }) {
  if (!embeds || 'leftAlone' in embeds || !embeds.tags.length) return null;
  return (
    <p className="text-sm text-slate-600 dark:text-slate-300">
      Offers {embeds.tags.length} component{embeds.tags.length === 1 ? '' : 's'} for other applications' pages: <span className="font-mono text-xs break-all">{embeds.tags.map((t) => `<${t}>`).join(', ')}</span>
    </p>
  );
}
