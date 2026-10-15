/** Your own two-factor sign-in: set it up, make new recovery codes, turn it off. */
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, ShieldCheck, ShieldAlert } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api-client';
import { CodeField, EnrollInstructions, RecoveryCodes, type Enrollment } from './TwoFactor';

interface Status {
  enabled: boolean;
  required: boolean;
  recoveryCodesLeft: number;
}

type Mode = 'idle' | 'enroll' | 'disable' | 'regenerate';

const messageOf = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');
const btn = 'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export function TwoFactorSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => apiGet<Status>('/bff/two-factor').then(setStatus).catch((err) => setError(messageOf(err))), []);
  useEffect(() => {
    void load();
  }, [load]);

  const reset = () => {
    setMode('idle');
    setEnrollment(null);
    setCode('');
    setError(null);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(messageOf(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const startEnroll = () =>
    run(async () => {
      setCodes(null);
      setEnrollment(await apiPost<Enrollment>('/bff/two-factor/enroll/start'));
      setMode('enroll');
    });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (mode === 'enroll' && enrollment) {
        const res = await apiPost<{ recoveryCodes: string[] }>('/bff/two-factor/enroll/confirm', { enrollToken: enrollment.enrollToken, code });
        setCodes(res.recoveryCodes);
      } else if (mode === 'regenerate') {
        const res = await apiPost<{ recoveryCodes: string[] }>('/bff/two-factor/recovery-codes', { code });
        setCodes(res.recoveryCodes);
      } else if (mode === 'disable') {
        await apiPost('/bff/two-factor/disable', { code });
        setCodes(null);
      }
      reset();
      await load();
    });
  };

  if (!status) {
    return error ? <p className="text-sm text-red-600">{error}</p> : <Loader2 size={18} className="animate-spin text-slate-400" />;
  }

  return (
    <div className="space-y-4" data-testid="two-factor-settings">
      <div className="flex items-start gap-3">
        {status.enabled ? <ShieldCheck size={20} className="text-green-600 mt-0.5" /> : <ShieldAlert size={20} className="text-amber-500 mt-0.5" />}
        <div className="flex-1">
          <p className="text-sm font-medium text-slate-800 dark:text-white">
            {status.enabled ? 'On: you enter a code from your authenticator app when you sign in' : 'Off: a password is enough to sign in'}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {status.required && 'Required by your organization. '}
            {status.enabled && `${status.recoveryCodesLeft} recovery code${status.recoveryCodesLeft === 1 ? '' : 's'} left.`}
          </p>
        </div>
      </div>

      {codes && <RecoveryCodes codes={codes} />}

      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {mode === 'idle' && (
        <div className="flex flex-wrap gap-2">
          {!status.enabled && (
            <button type="button" onClick={startEnroll} disabled={busy} className={`${btn} bg-blue-600 hover:bg-blue-700 text-white`}>
              <KeyRound size={16} /> Set up two-factor
            </button>
          )}
          {status.enabled && (
            <button type="button" onClick={() => { setCodes(null); setMode('regenerate'); }} className={`${btn} bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200`}>
              New recovery codes
            </button>
          )}
          {status.enabled && !status.required && (
            <button type="button" onClick={() => { setCodes(null); setMode('disable'); }} className={`${btn} text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10`}>
              Turn off
            </button>
          )}
        </div>
      )}

      {mode !== 'idle' && (
        <form onSubmit={submit} className="space-y-3 max-w-sm">
          {mode === 'enroll' && enrollment && <EnrollInstructions enrollment={enrollment} />}
          {mode !== 'enroll' && (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {mode === 'disable' ? 'To turn off two-factor, enter' : 'To make new recovery codes (the old ones stop working), enter'} a code from your authenticator app or a recovery code.
            </p>
          )}
          <CodeField value={code} onChange={setCode} allowRecovery={mode !== 'enroll'} autoFocus />
          <div className="flex gap-2">
            <button type="submit" disabled={busy || code.trim().length < 6} className={`${btn} ${mode === 'disable' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'} text-white`}>
              {busy && <Loader2 size={14} className="animate-spin" />}
              {mode === 'enroll' ? 'Confirm' : mode === 'disable' ? 'Turn off two-factor' : 'Make new codes'}
            </button>
            <button type="button" onClick={reset} className={`${btn} text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700`}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
