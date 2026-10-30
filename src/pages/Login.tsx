import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { API_URL, apiGet, apiPost, isMfaStep, type MfaStep } from '../lib/api-client';
import { TwoFactorSignIn } from '../components/TwoFactor';
import { useAuth } from '../contexts/AuthContext';
import { continuing, goAfterSignIn, rememberContinue } from '../lib/continue-after-sign-in';
import { AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { APP_NAME } from '../lib/brand';

interface TenantInfo {
  id: string | null; // null for the platform portal
  name: string;
  slug: string;
  logoUrl?: string;
  primaryColor?: string;
  loginTitle?: string;
  loginSubtitle?: string;
  status: string;
  authConfig?: {
    ssoOnly: boolean;
    otpEnabled: boolean;
    providers: Array<{
      id: string;
      provider: string;
    }>;
  };
}

interface ProviderInfo {
  id: string;
  name: string;
  icon: string;
  color: string;
}

const providerDetails: Record<string, ProviderInfo> = {
  ENTRA: {
    id: 'ENTRA',
    name: 'Microsoft',
    icon: 'M',
    color: 'bg-blue-600 hover:bg-blue-700',
  },
  GOOGLE: {
    id: 'GOOGLE',
    name: 'Google',
    icon: 'G',
    color: 'bg-red-500 hover:bg-red-600',
  },
  GITHUB: {
    id: 'GITHUB',
    name: 'GitHub',
    icon: 'GH',
    color: 'bg-gray-900 hover:bg-gray-800',
  },
  OKTA: {
    id: 'OKTA',
    name: 'Okta',
    icon: 'O',
    color: 'bg-blue-500 hover:bg-blue-600',
  },
  AUTH0: {
    id: 'AUTH0',
    name: 'Auth0',
    icon: 'A0',
    color: 'bg-orange-500 hover:bg-orange-600',
  },
  CUSTOM_OIDC: {
    id: 'CUSTOM_OIDC',
    name: 'SSO',
    icon: 'SSO',
    color: 'bg-purple-500 hover:bg-purple-600',
  },
};

export default function Login() {
  const { tenantSlug } = useParams<{ tenantSlug?: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading, login, reload } = useAuth();
  // Arriving from an accepted invitation or a password reset
  const [searchParams] = useSearchParams();
  const notice = searchParams.get('notice');
  // Signing in to an application with this account: back to it afterwards
  const search = searchParams.toString();
  useEffect(() => rememberContinue(`?${search}`), [search]);
  const forApplication = continuing(`?${search}`);
  
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [loading, setLoading] = useState(true);
  // Back from single sign-on with a problem (see /bff/auth/sso/callback)
  const [error, setError] = useState<string | null>(searchParams.get('sso_error') ? searchParams.get('message') || 'Single sign-on failed' : null);
  // Password or emailed code accepted; two-factor comes next
  const [mfaStep, setMfaStep] = useState<MfaStep | null>(null);
  // Single sign-on buttons and the password form show together; a code sent by email replaces the form
  const [loginMode, setLoginMode] = useState<'email-password' | 'otp'>('email-password');
  const [email, setEmail] = useState(searchParams.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in: go straight to the right portal
  useEffect(() => {
    if (!authLoading && user) {
      goAfterSignIn(navigate, user.portal);
    }
  }, [authLoading, user, navigate]);

  // Fetch tenant branding / login options for this slug
  useEffect(() => {
    const fetchTenant = async () => {
      if (!tenantSlug) {
        setLoading(false);
        return;
      }

      try {
        setTenant(await apiGet<TenantInfo>(`/auth/tenant/${encodeURIComponent(tenantSlug)}`, { skipAuth: true }));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load tenant');
      } finally {
        setLoading(false);
      }
    };

    fetchTenant();
  }, [tenantSlug]);

  // Single sign-on is a full-page trip: our server, the identity provider,
  // back to our server (which starts the session), then this page
  const hasProviders = !!tenant?.authConfig?.providers?.length;

  const handleProviderLogin = (providerId: string) => {
    if (!tenant) return;
    setSubmitting(true);
    setError(null);
    const params = new URLSearchParams({ tenantSlug: tenant.slug, providerId });
    window.location.href = `${API_URL}/bff/auth/sso/start?${params}`;
  };

  const finishSignIn = async () => {
    const portal = await reload();
    if (portal) goAfterSignIn(navigate, portal);
    else navigate('/login', { replace: true });
  };

  const restart = () => {
    setMfaStep(null);
    setPassword('');
    setOtp('');
    setSubmitting(false);
    setLoginMode('email-password');
  };

  const handleEmailPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenant) return;

    setSubmitting(true);
    setError(null);

    try {
      // Sets httpOnly session cookies and loads the user + permissions
      const result = await login(email, password, tenant.slug);
      if (typeof result === 'object') {
        setMfaStep(result);
        setSubmitting(false);
        return;
      }
      goAfterSignIn(navigate, result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setSubmitting(false);
    }
  };

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenant) return;

    setSubmitting(true);
    setError(null);
    setDevOtp(null);

    try {
      const data = await apiPost<{ otp?: string }>(
        '/bff/auth/otp/request',
        { email, tenantSlug: tenant.slug },
        { skipAuth: true },
      );

      // Only present when the backend runs with NODE_ENV=development and DEV_EXPOSE_OTP=true
      if (data.otp) {
        setDevOtp(data.otp);
      }

      setLoginMode('otp');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request OTP');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenant) return;

    setSubmitting(true);
    setError(null);

    try {
      const body = await apiPost('/bff/auth/otp/verify', { email, tenantSlug: tenant.slug, code: otp }, { skipAuth: true });
      if (isMfaStep(body)) {
        setMfaStep(body);
        setSubmitting(false);
        return;
      }
      await finishSignIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OTP verification failed');
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900" role="status" aria-label="Loading">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-300 border-t-blue-600"></div>
      </div>
    );
  }

  if (error && !tenant) {
    // It exists but can't be signed in to (closed or suspended), or it doesn't exist
    const unavailable = /closed|suspended/i.test(error);
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 px-4 pt-24">
        <div className="max-w-sm mx-auto space-y-4">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-800 dark:text-white">
            {unavailable ? 'This organization isn’t available' : "We couldn't find that organization"}
          </h1>
          <p className="text-slate-600 dark:text-slate-400">{error}{unavailable && '. Contact the platform team if you think that’s a mistake.'}</p>
          {!unavailable && <p className="text-slate-600 dark:text-slate-400">Check the sign-in address you were given, or look up your organization by its name.</p>}
          <Link to="/login" className="inline-flex items-center gap-2 px-4 py-2.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">
            Find my organization
          </Link>
        </div>
      </div>
    );
  }

  const primaryColor = tenant?.primaryColor || 'var(--color-blue-600)';
  const noticeText = notice === 'invite-accepted'
    ? 'Your account is ready. Sign in with your new password.'
    : notice === 'password-reset'
      ? 'Your password has been changed. Sign in with your new password.'
      : notice === 'signed-out'
        ? 'You were signed out. Sign in again to continue.'
        : null;
  // The session timed out (the organization's session settings)
  const timeoutText = notice === 'session-idle'
    ? 'You were signed out after a period of inactivity.'
    : notice === 'session-max'
      ? 'Your session reached its maximum length. Please sign in again.'
      : null;
  const ssoOnly = tenant?.authConfig?.ssoOnly || false;
  const isPlatform = !tenant?.id;
  const fieldClass =
    'w-full h-10 px-3 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25';
  const quietLink = 'text-sm font-medium text-blue-700 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 px-4 pt-16 sm:pt-24 pb-10">
      <div className="max-w-sm mx-auto flex flex-col gap-7">
        <div className="flex flex-col gap-4">
          {tenant?.logoUrl ? (
            <img src={tenant.logoUrl} alt={tenant.name} className="h-11 w-auto self-start" />
          ) : (
            <div
              aria-hidden
              className="w-11 h-11 rounded-lg flex items-center justify-center text-white font-semibold text-xl"
              style={{ backgroundColor: primaryColor }}
            >
              {(isPlatform ? APP_NAME : tenant?.name ?? 'M').charAt(0)}
            </div>
          )}
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-800 dark:text-white">
              {isPlatform ? `Sign in to ${APP_NAME}` : tenant?.loginTitle || `Sign in to ${tenant?.name}`}
            </h1>
            <p className="text-slate-600 dark:text-slate-400">
              {isPlatform ? 'Platform administration' : tenant?.loginSubtitle || 'Use the account your organization gave you.'}
            </p>
          </div>
        </div>

        {forApplication && (
          <p role="status" className="text-sm p-3 rounded-md border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/10 text-blue-800 dark:text-blue-300">
            Sign in to continue to the application that sent you here.
          </p>
        )}

        {timeoutText && (
          <div role="status" className="flex items-start gap-2 p-3 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-sm text-amber-800 dark:text-amber-300">
            <Clock size={18} className="shrink-0 mt-px" /> {timeoutText}
          </div>
        )}
        {noticeText && (
          <div role="status" className="flex items-start gap-2 p-3 rounded-md border border-green-200 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10 text-sm text-green-800 dark:text-green-300">
            <CheckCircle2 size={18} className="shrink-0 mt-px" /> {noticeText}
          </div>
        )}
        {error && (
          <div role="alert" className="flex items-start gap-2 p-3 rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 text-sm text-red-800 dark:text-red-300">
            <AlertCircle size={18} className="shrink-0 mt-px" /> {error}
          </div>
        )}

        {mfaStep && (
          <TwoFactorSignIn step={mfaStep} primaryColor={primaryColor} onSignedIn={() => void finishSignIn()} onCancel={restart} />
        )}

        {!mfaStep && loginMode !== 'otp' && (
          <>
            {hasProviders && (
              <div className="flex flex-col gap-3">
                {tenant.authConfig?.providers.map((provider) => {
                  const info = providerDetails[provider.provider];
                  if (!info) return null;
                  return (
                    <button
                      key={provider.id}
                      onClick={() => handleProviderLogin(provider.id)}
                      disabled={submitting}
                      className="h-11 w-full flex items-center justify-center gap-3 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 font-medium disabled:opacity-50"
                    >
                      <span aria-hidden className="min-w-6 h-6 px-1 rounded bg-slate-100 dark:bg-slate-700 text-[11px] font-semibold flex items-center justify-center">{info.icon}</span>
                      Continue with {info.name}
                    </button>
                  );
                })}
              </div>
            )}

            {hasProviders && !ssoOnly && (
              <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
                <span className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />or with your email<span className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
              </div>
            )}

            {!ssoOnly && (
              <form onSubmit={handleEmailPasswordLogin} className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Email</span>
                  <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required className={fieldClass} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Password</span>
                    <Link to={`/${tenant?.slug ?? tenantSlug}/forgot-password`} className={quietLink}>Forgot password?</Link>
                  </span>
                  <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required className={fieldClass} />
                </label>
                <button
                  type="submit"
                  disabled={submitting}
                  className="h-11 w-full flex items-center justify-center gap-2 rounded-md text-white font-medium disabled:opacity-60"
                  style={{ backgroundColor: primaryColor }}
                >
                  {submitting && <span className="animate-spin rounded-full h-4 w-4 border-2 border-white/40 border-t-white" aria-hidden />}
                  {submitting ? 'Signing in…' : 'Sign in'}
                </button>
                {tenant?.authConfig?.otpEnabled && (
                  <button type="button" onClick={handleRequestOtp} disabled={submitting || !email} className={`${quietLink} self-center disabled:opacity-50`}>
                    Email me a sign-in code instead
                  </button>
                )}
              </form>
            )}
          </>
        )}

        {!mfaStep && loginMode === 'otp' && (
          <form onSubmit={handleVerifyOtp} className="flex flex-col gap-4">
            {devOtp && (
              <p className="p-3 rounded-md border border-dashed border-green-400 bg-green-50 dark:bg-green-500/10 text-sm text-green-800 dark:text-green-300">
                Development only, the code is <span className="font-mono text-base font-semibold tracking-widest">{devOtp}</span>
              </p>
            )}
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Sign-in code</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required
                maxLength={6}
                className={`${fieldClass} h-12 text-center text-2xl font-mono tracking-widest`}
                placeholder="000000"
              />
              <span className="text-sm text-slate-600 dark:text-slate-400">We sent a 6-digit code to {email}.</span>
            </label>
            <button
              type="submit"
              disabled={submitting || otp.length !== 6}
              className="h-11 w-full rounded-md text-white font-medium disabled:opacity-60"
              style={{ backgroundColor: primaryColor }}
            >
              {submitting ? 'Checking…' : 'Sign in'}
            </button>
            <button
              type="button"
              onClick={() => {
                setLoginMode('email-password');
                setOtp('');
                setDevOtp(null);
              }}
              className={`${quietLink} self-center`}
            >
              Use my password instead
            </button>
          </form>
        )}

        <p className="pt-5 border-t border-slate-200 dark:border-slate-700 text-sm text-slate-600 dark:text-slate-400">
          {isPlatform
            ? 'Platform accounts are created by an administrator.'
            : `No account yet? Ask an administrator at ${tenant?.name} to invite you.`}
        </p>
      </div>
    </div>
  );
}
