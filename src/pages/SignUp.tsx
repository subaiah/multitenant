/**
 * Self-service sign-up: create a new organization. Nothing exists until the
 * email address is confirmed (the link opens SignupVerify).
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api-client';
import { APP_NAME } from '../lib/brand';
import type { PasswordPolicy } from '../lib/password-policy';
import { AuthCard, NewPasswordField, authButtonClass, authInputClass, meetsPolicy } from '../components/AuthCard';
import { LoadingState } from '../components/ui';

export interface SiteInfo {
  tenant: { slug: string; name: string } | null;
  signup: { passwordPolicy: PasswordPolicy } | null;
}

/** "Acme Corp." -> "acme-corp" */
export const suggestSlug = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}

export default function SignUp() {
  const navigate = useNavigate();
  const [site, setSite] = useState<SiteInfo | null>(null);
  const [organization, setOrganization] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    apiGet<SiteInfo>('/bff/site', { skipAuth: true })
      .then((s) => {
        // An organization's own address: its sign-in page instead
        if (s.tenant) navigate(`/${s.tenant.slug}/login`, { replace: true });
        else setSite(s);
      })
      .catch(() => setSite({ tenant: null, signup: null }));
  }, [navigate]);

  const effectiveSlug = slugEdited ? slug : suggestSlug(organization);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiPost<{ email: string }>('/bff/signup', { organization, slug: effectiveSlug, name, email, password }, { skipAuth: true });
      setSentTo(res.email);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign up');
    } finally {
      setSubmitting(false);
    }
  };

  if (!site) return <LoadingState />;
  if (!site.signup) {
    return (
      <AuthCard title="Signing up isn't open" subtitle={`New organizations are set up by the ${APP_NAME} team. Ask them for an invitation.`}>
        <Link to="/login" className="text-sm font-medium text-blue-600 hover:text-blue-700">Go to sign in</Link>
      </AuthCard>
    );
  }
  if (sentTo) {
    return (
      <AuthCard title="Check your email" subtitle={<>We sent a link to <strong>{sentTo}</strong>. Open it to create {organization}. It works for 24 hours.</>}>
        <div className="flex items-start gap-3 p-4 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-300">
          <MailCheck size={20} className="text-blue-600 shrink-0" aria-hidden />
          <p>Nothing arrived? Check the spam folder, or <button type="button" className="font-medium text-blue-700 hover:text-blue-600 dark:text-blue-300" onClick={() => setSentTo(null)}>go back</button> and check the address.</p>
        </div>
      </AuthCard>
    );
  }

  const slugOk = SLUG.test(effectiveSlug);
  const ready = organization.trim().length >= 2 && slugOk && name.trim().length >= 2 && email.includes('@') && meetsPolicy(password, site.signup.passwordPolicy);

  return (
    <AuthCard title={`Create an organization on ${APP_NAME}`} subtitle="You'll be its administrator, and can invite your team once it's ready.">
      <form onSubmit={submit} className="space-y-4">
        <Field id="organization" label="Organization name">
          <input id="organization" className={authInputClass} autoComplete="organization" required value={organization}
            onChange={(e) => setOrganization(e.target.value)} maxLength={100} />
        </Field>
        <Field id="slug" label="Sign-in address" hint={slugOk || !effectiveSlug ? 'Your team signs in at this address. Lowercase letters, digits and hyphens.' : 'Use 2-50 lowercase letters, digits and hyphens.'}>
          <span className="flex items-center h-10 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/25">
            <span className="pl-3 text-slate-500 font-mono text-sm" aria-hidden>/</span>
            <input id="slug" className="flex-1 min-w-0 h-full px-1 bg-transparent font-mono text-sm text-slate-800 dark:text-slate-100 focus:outline-none"
              required value={effectiveSlug} maxLength={50} aria-invalid={!!effectiveSlug && !slugOk}
              onChange={(e) => { setSlugEdited(true); setSlug(e.target.value.toLowerCase()); }} />
            <span className="pr-3 text-slate-500 font-mono text-sm" aria-hidden>/login</span>
          </span>
        </Field>
        <Field id="name" label="Your name">
          <input id="name" className={authInputClass} autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </Field>
        <Field id="email" label="Work email">
          <input id="email" type="email" className={authInputClass} autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} />
        </Field>
        <NewPasswordField label="Password" value={password} onChange={setPassword} policy={site.signup.passwordPolicy} />
        {error && <p className="p-3 rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 text-sm text-red-800 dark:text-red-300" role="alert">{error}</p>}
        <button type="submit" disabled={submitting || !ready} className={authButtonClass}>
          {submitting ? 'Sending…' : 'Create organization'}
        </button>
      </form>
      <p className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-700 text-sm text-slate-600 dark:text-slate-400">
        Already have one? <Link to="/login" className="font-medium text-blue-700 hover:text-blue-600 dark:text-blue-300">Sign in</Link>
      </p>
    </AuthCard>
  );
}
