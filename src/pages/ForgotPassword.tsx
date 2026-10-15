import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { apiPost } from '../lib/api-client';
import { AuthCard, authButtonClass, authInputClass } from '../components/AuthCard';

export default function ForgotPassword() {
  const { tenantSlug = '' } = useParams<{ tenantSlug: string }>();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiPost('/bff/account/password/forgot', { email: email.trim(), tenantSlug }, { skipAuth: true });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const back = (
    <Link to={`/${tenantSlug}/login`} className="inline-block mt-6 text-sm font-medium text-blue-600 hover:text-blue-700">
      Back to sign in
    </Link>
  );

  if (sent) {
    return (
      <AuthCard title="Check your email">
        <div className="flex gap-3 text-sm text-slate-600 dark:text-slate-300">
          <MailCheck className="text-green-600 shrink-0" size={20} />
          <p>If an account exists for <strong>{email}</strong>, we've sent a link to reset the password. It expires in an hour.</p>
        </div>
        {back}
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset your password" subtitle="Enter your email and we'll send you a link to choose a new password.">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={authInputClass} />
        </div>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        <button type="submit" disabled={submitting} className={authButtonClass}>{submitting ? 'Sending…' : 'Send reset link'}</button>
      </form>
      {back}
    </AuthCard>
  );
}
