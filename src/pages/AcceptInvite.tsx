import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api-client';
import type { PasswordPolicy } from '../lib/password-policy';
import { AuthCard, NewPasswordField, authButtonClass, authInputClass, meetsPolicy } from '../components/AuthCard';
import { LoadingState } from '../components/ui';

interface Invitation {
  email: string;
  name: string | null;
  tenant: { name: string; slug: string } | null;
  passwordPolicy: PasswordPolicy;
}

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const [invite, setInvite] = useState<Invitation | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoadError('This invitation link is incomplete.');
      return;
    }
    apiGet<Invitation>(`/bff/account/invitations/${encodeURIComponent(token)}`, { skipAuth: true })
      .then((i) => {
        setInvite(i);
        setName(i.name ?? '');
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'This invitation is invalid.'));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiPost<{ tenantSlug: string; email: string }>(
        '/bff/account/invitations/accept',
        { token, password, ...(name.trim() && { name: name.trim() }) },
        { skipAuth: true },
      );
      navigate(`/${res.tenantSlug}/login?notice=invite-accepted&email=${encodeURIComponent(res.email)}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not accept the invitation');
      setSubmitting(false);
    }
  };

  if (loadError) {
    return (
      <AuthCard title="Invitation unavailable" subtitle={loadError}>
        <Link to="/login" className="text-sm font-medium text-blue-600 hover:text-blue-700">Go to sign in</Link>
      </AuthCard>
    );
  }
  if (!invite) return <LoadingState />;

  return (
    <AuthCard title={`Join ${invite.tenant?.name ?? 'the platform'}`} subtitle={<>Set up your account for <strong>{invite.email}</strong></>}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Your name</label>
          <input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={authInputClass} />
        </div>
        <NewPasswordField value={password} onChange={setPassword} policy={invite.passwordPolicy} />
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        <button type="submit" disabled={submitting || !meetsPolicy(password, invite.passwordPolicy)} className={authButtonClass}>
          {submitting ? 'Setting up…' : 'Create account'}
        </button>
      </form>
    </AuthCard>
  );
}
