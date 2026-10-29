/**
 * Your sign-in email and password (Profile; Platform users > Your account).
 * A new email is confirmed from that address before it's used.
 */
import { useState } from 'react';
import { Mail, KeyRound } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { apiDelete, apiPost } from '../lib/api-client';
import type { PasswordPolicy } from '../lib/password-policy';
import { NewPasswordField, meetsPolicy } from './AuthCard';
import { formatDateTime, inputClass, primaryButtonClass, secondaryButtonClass } from './ui';

interface MyAccount {
  email: string;
  hasPassword: boolean;
  passwordPolicy: PasswordPolicy;
  pendingEmail: { newEmail: string; expiresAt: string } | null;
}

export function SignInDetails() {
  const account = useApi<MyAccount>('/bff/my-account');
  const [mode, setMode] = useState<'email' | 'password' | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const a = account.data;
  if (!a) return <p className="text-sm text-slate-500">{account.error ? 'Could not load your sign-in details.' : 'Loading…'}</p>;

  const close = () => { setMode(null); setPassword(''); setNewPassword(''); setNewEmail(''); setError(null); };
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setDone(message);
      close();
      await account.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      {done && <p role="status" className="text-green-700 dark:text-green-400">{done}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <Mail size={16} className="text-slate-400" aria-hidden />
        <span className="font-medium text-slate-800 dark:text-white">{a.email}</span>
        {a.hasPassword && mode !== 'email' && (
          <button className="text-blue-700 hover:text-blue-600 dark:text-blue-300 font-medium" onClick={() => { close(); setDone(null); setMode('email'); }}>Change email</button>
        )}
      </div>
      {a.pendingEmail && (
        <div className="flex flex-wrap items-center gap-3 p-3 rounded-md bg-amber-50 dark:bg-amber-500/10 text-amber-900 dark:text-amber-200">
          <span className="flex-1 min-w-0">Waiting for <strong>{a.pendingEmail.newEmail}</strong> to be confirmed: open the link we sent there (until {formatDateTime(a.pendingEmail.expiresAt)}).</span>
          <button className={secondaryButtonClass} disabled={busy} onClick={() => run(() => apiDelete('/bff/my-account/email'), 'The email change was cancelled.')}>Cancel change</button>
        </div>
      )}
      {mode === 'email' && (
        <form className="space-y-3 max-w-md" onSubmit={(e) => { e.preventDefault(); void run(() => apiPost('/bff/my-account/email', { newEmail, password }), `We sent a link to ${newEmail.trim()}. Your email changes when you open it, and you'll sign in again.`); }}>
          <label className="block">
            <span className="text-slate-600 dark:text-slate-300">New email address</span>
            <input type="email" required autoComplete="email" className={`${inputClass} mt-1`} value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-slate-600 dark:text-slate-300">Your current password</span>
            <input type="password" required autoComplete="current-password" className={`${inputClass} mt-1`} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <p className="text-xs text-slate-500">We'll email a link to the new address to confirm it, and tell your current address about the change.</p>
          {error && <p role="alert" className="text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={busy || !newEmail || !password}>{busy ? 'Sending…' : 'Send confirmation link'}</button>
            <button type="button" className={secondaryButtonClass} onClick={close}>Cancel</button>
          </div>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <KeyRound size={16} className="text-slate-400" aria-hidden />
        <span className="text-slate-700 dark:text-slate-200">{a.hasPassword ? 'Password' : 'You sign in without a password (single sign-on or email codes)'}</span>
        {a.hasPassword && mode !== 'password' && (
          <button className="text-blue-700 hover:text-blue-600 dark:text-blue-300 font-medium" onClick={() => { close(); setDone(null); setMode('password'); }}>Change password</button>
        )}
      </div>
      {mode === 'password' && (
        <form className="space-y-3 max-w-md" onSubmit={(e) => { e.preventDefault(); void run(() => apiPost('/bff/my-account/password', { currentPassword: password, newPassword }), 'Your password is changed. Your other sessions were signed out.'); }}>
          <label className="block">
            <span className="text-slate-600 dark:text-slate-300">Current password</span>
            <input type="password" required autoComplete="current-password" className={`${inputClass} mt-1`} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <NewPasswordField value={newPassword} onChange={setNewPassword} policy={a.passwordPolicy} />
          {error && <p role="alert" className="text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={busy || !password || !meetsPolicy(newPassword, a.passwordPolicy)}>{busy ? 'Saving…' : 'Change password'}</button>
            <button type="button" className={secondaryButtonClass} onClick={close}>Cancel</button>
          </div>
        </form>
      )}
      {!a.hasPassword && <p className="text-xs text-slate-500">To change your email, ask an administrator.</p>}
    </div>
  );
}
