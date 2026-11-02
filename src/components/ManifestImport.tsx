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
  permissions: { added: string[]; updated: string[]; notInManifest: string[] };
  menuItems: number;
}

export function ManifestImport({ onClose, onImported }: { onClose: () => void; onImported: (applicationId: string) => void }) {
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const readFile = async (file: File | undefined) => {
    if (file) setText(await file.text());
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
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
      const r = await apiPost<ImportResult>('/applications/manifest', manifest);
      setResult(r);
      await invalidateApi('/applications', '/tenant-applications');
      onImported(r.application.id);
    } catch (err) {
      const message = err instanceof ApiError || err instanceof Error ? err.message : 'Importing failed';
      setProblems(message.split('\n').filter(Boolean));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const { permissions: p } = result;
    return (
      <Dialog title={result.created ? `${result.application.name} added` : `${result.application.name} updated`} onClose={onClose} wide>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Version {result.application.version}. {p.added.length} permission{p.added.length === 1 ? '' : 's'} added, {p.updated.length} updated; {result.menuItems} menu entr{result.menuItems === 1 ? 'y' : 'ies'}.
        </p>
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
        <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
          className={`${inputClass} font-mono text-xs`} placeholder={'{\n  "manifestVersion": 1,\n  "productId": "appforge",\n  …\n}'} />
      </Field>
      {problems && (
        <div role="alert" className="text-sm text-red-700 dark:text-red-300 p-3 rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10">
          <ul className="space-y-0.5">{problems.map((m, i) => <li key={i} className="break-words">{m}</li>)}</ul>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={secondaryButtonClass} onClick={onClose}>Cancel</button>
        <button type="submit" className={primaryButtonClass} disabled={busy || !text.trim()}><FileJson size={15} aria-hidden /> Import</button>
      </div>
    </Dialog>
  );
}
