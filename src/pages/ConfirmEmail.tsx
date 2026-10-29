/**
 * The link sent to a new email address. Confirming takes a click (mail
 * scanners that open links don't change anyone's address).
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api-client';
import { AuthCard, authButtonClass } from '../components/AuthCard';
import { LoadingState } from '../components/ui';

export default function ConfirmEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [info, setInfo] = useState<{ email: string; newEmail: string; organization: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ tenantSlug: string; email: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return setError('This link is incomplete. Copy the whole link from the email.');
    apiGet<NonNullable<typeof info>>(`/bff/account/email/confirm/${encodeURIComponent(token)}`, { skipAuth: true })
      .then(setInfo)
      .catch((err) => setError(err instanceof Error ? err.message : 'This link is invalid or has expired.'));
  }, [token]);

  const confirm = async () => {
    setBusy(true);
    try {
      setDone(await apiPost('/bff/account/email/confirm', { token }, { skipAuth: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm');
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <AuthCard title="Link unavailable" subtitle={error}>
        <Link to="/login" className="text-sm font-medium text-blue-600 hover:text-blue-700">Go to sign in</Link>
      </AuthCard>
    );
  }
  if (done) {
    return (
      <AuthCard title="Email address changed" subtitle={<>Sign in with <strong>{done.email}</strong> from now on. You were signed out everywhere.</>}>
        <Link to={`/${done.tenantSlug}/login?email=${encodeURIComponent(done.email)}`} className={`${authButtonClass} flex items-center justify-center`}>Sign in</Link>
      </AuthCard>
    );
  }
  if (!info) return <LoadingState />;
  return (
    <AuthCard title="Confirm your new email address" subtitle={<>For your account in <strong>{info.organization}</strong>.</>}>
      <div className="space-y-4">
        <dl className="text-sm space-y-1">
          <div className="flex gap-2"><dt className="w-14 text-slate-500">From</dt><dd className="text-slate-800 dark:text-slate-100">{info.email}</dd></div>
          <div className="flex gap-2"><dt className="w-14 text-slate-500">To</dt><dd className="font-medium text-slate-800 dark:text-white">{info.newEmail}</dd></div>
        </dl>
        <button onClick={confirm} disabled={busy} className={authButtonClass}>{busy ? 'Confirming…' : 'Use this address'}</button>
        <p className="text-xs text-slate-500">You'll be signed out everywhere and sign in again with the new address.</p>
      </div>
    </AuthCard>
  );
}
