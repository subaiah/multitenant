/**
 * Closing the organization (Settings, administrators only). It is suspended
 * at once and deleted after a grace period, during which the platform team
 * can restore it.
 */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';
import { apiPost } from '../lib/api-client';
import { Dialog, Field } from './Dialog';
import { Card, inputClass, secondaryButtonClass } from './ui';

const dangerButtonClass =
  'inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:cursor-not-allowed';

export function CloseOrganizationCard({ name, slug }: { name: string; slug: string }) {
  const { hasPermission, logout } = useAuth();
  const info = useApi<{ canClose: boolean; graceDays: number; needsPassword: boolean }>(hasPermission('settings:manage') ? '/organization/closure' : null);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!info.data?.canClose) return null;
  const { graceDays, needsPassword } = info.data;

  const close = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost('/organization/close', { confirm, password: needsPassword ? password : undefined });
      // The session no longer works: end it, and start afresh on a page that says what happened
      await logout().catch(() => {});
      window.location.replace('/login?notice=organization-closed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Closing failed');
      setBusy(false);
    }
  };

  return (
    <Card title="Close organization" description="For when your team no longer needs it.">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600 dark:text-slate-300 max-w-prose">
          Everyone loses access at once. After {graceDays} days, {name} and all its data are deleted for good; until then the platform team can restore it.
        </p>
        <button className={`${secondaryButtonClass} !text-red-700 dark:!text-red-300`} onClick={() => setOpen(true)}>Close organization…</button>
      </div>
      {open && (
        <Dialog title={`Close ${name}`} onClose={() => setOpen(false)} onSubmit={close}>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Nobody, including you, can sign in once it's closed. It's deleted after {graceDays} days, and its data can't be recovered after that.
          </p>
          <Field label={`Type its address, ${slug}, to confirm`}>
            <input className={`${inputClass} font-mono`} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" aria-label="Organization address" />
          </Field>
          {needsPassword && (
            <Field label="Your password">
              <input type="password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" aria-label="Your password" />
            </Field>
          )}
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={secondaryButtonClass} onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className={dangerButtonClass} disabled={busy || confirm.trim() !== slug || (needsPassword && !password)}>
              {busy ? 'Closing…' : 'Close organization'}
            </button>
          </div>
        </Dialog>
      )}
    </Card>
  );
}
