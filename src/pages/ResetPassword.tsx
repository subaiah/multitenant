import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api-client';
import type { PasswordPolicy } from '../lib/password-policy';
import { AuthCard, NewPasswordField, authButtonClass, meetsPolicy } from '../components/AuthCard';
import { LoadingState } from '../components/ui';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const [info, setInfo] = useState<{ email: string; tenantSlug: string; passwordPolicy: PasswordPolicy } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoadError('This reset link is incomplete.');
      return;
    }
    apiGet<{ email: string; tenantSlug: string; passwordPolicy: PasswordPolicy }>(`/bff/account/password/reset/${encodeURIComponent(token)}`, { skipAuth: true })
      .then(setInfo)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'This reset link is invalid.'));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiPost<{ tenantSlug: string; email: string }>('/bff/account/password/reset', { token, password }, { skipAuth: true });
      navigate(`/${res.tenantSlug}/login?notice=password-reset&email=${encodeURIComponent(res.email)}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the password');
      setSubmitting(false);
    }
  };

  if (loadError) {
    return (
      <AuthCard title="Link unavailable" subtitle={loadError}>
        <Link to="/login" className="text-sm font-medium text-blue-600 hover:text-blue-700">Go to sign in</Link>
      </AuthCard>
    );
  }
  if (!info) return <LoadingState />;

  return (
    <AuthCard title="Choose a new password" subtitle={<>For <strong>{info.email}</strong>. You'll be signed out on other devices.</>}>
      <form onSubmit={submit} className="space-y-4">
        <NewPasswordField value={password} onChange={setPassword} policy={info.passwordPolicy} />
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        <button type="submit" disabled={submitting || !meetsPolicy(password, info.passwordPolicy)} className={authButtonClass}>
          {submitting ? 'Saving…' : 'Set new password'}
        </button>
      </form>
    </AuthCard>
  );
}
