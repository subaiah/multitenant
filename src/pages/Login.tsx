import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api-client';
import { useAuth } from '../contexts/AuthContext';
import { portalHome } from '../lib/permissions';
import { Building2, Mail, Lock, ArrowRight, AlertCircle, CheckCircle2 } from 'lucide-react';

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
  
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loginMode, setLoginMode] = useState<'provider-selection' | 'email-password' | 'otp'>(
    // Arriving with an email (after accepting an invitation or resetting a password): go straight to the password form
    searchParams.get('email') ? 'email-password' : 'provider-selection',
  );
  const [email, setEmail] = useState(searchParams.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in: go straight to the right portal
  useEffect(() => {
    if (!authLoading && user) {
      navigate(portalHome(user.portal), { replace: true });
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

  const handleProviderLogin = async (providerId: string) => {
    if (!tenant) return;

    setSubmitting(true);
    setError(null);

    try {
      const data = await apiPost<{ authorizationUrl: string }>(
        '/auth/oauth/initiate',
        {
          tenantSlug: tenant.slug,
          provider: providerId,
          redirectUri: window.location.origin + (tenantSlug ? `/${tenantSlug}/login` : '/login'),
        },
        { skipAuth: true },
      );

      // Redirect to provider's authorization URL
      window.location.href = data.authorizationUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initiate login');
      setSubmitting(false);
    }
  };

  const handleEmailPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenant) return;

    setSubmitting(true);
    setError(null);

    try {
      // Sets httpOnly session cookies and loads the user + permissions
      const portal = await login(email, password, tenant.slug);
      navigate(portalHome(portal), { replace: true });
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
      await apiPost('/bff/auth/otp/verify', { email, tenantSlug: tenant.slug, code: otp }, { skipAuth: true });
      const portal = await reload();
      navigate(portal ? portalHome(portal) : '/login', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OTP verification failed');
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error && !tenant) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
        <div className="max-w-md w-full bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8 text-center">
          <AlertCircle size={48} className="mx-auto text-red-500 mb-4" />
          <h2 className="text-xl font-bold text-slate-800 dark:text-white mb-2">
            Tenant Not Found
          </h2>
          <p className="text-slate-600 dark:text-slate-400 mb-6">{error}</p>
          <Link
            to="/login"
            className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            Go to Login
            <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    );
  }

  const primaryColor = tenant?.primaryColor || '#3b82f6';
  const noticeText = notice === 'invite-accepted'
    ? 'Your account is ready. Sign in with your new password.'
    : notice === 'password-reset'
      ? 'Your password has been changed. Sign in with your new password.'
      : notice === 'signed-out'
        ? 'You were signed out. Sign in again to continue.'
        : null;
  const hasProviders = tenant?.authConfig?.providers && tenant.authConfig.providers.length > 0;
  const ssoOnly = tenant?.authConfig?.ssoOnly || false;

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
      <div className="max-w-md w-full">
        {noticeText && (
          <div role="status" className="mb-6 flex items-center gap-2 p-3 rounded-lg border border-green-200 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10 text-sm text-green-700 dark:text-green-300">
            <CheckCircle2 size={18} /> {noticeText}
          </div>
        )}

        {/* Logo and Branding */}
        <div className="text-center mb-8">
          {tenant?.logoUrl ? (
            <img
              src={tenant.logoUrl}
              alt={tenant.name}
              className="h-16 mx-auto mb-4"
            />
          ) : (
            <div
              className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center text-white font-bold text-2xl"
              style={{ backgroundColor: primaryColor }}
            >
              {tenant?.name.charAt(0) || 'M'}
            </div>
          )}
          <h1 className="text-2xl font-bold text-slate-800 dark:text-white mb-2">
            {tenant?.loginTitle || 'Welcome'}
          </h1>
          <p className="text-slate-600 dark:text-slate-400">
            {tenant?.loginSubtitle || 'Sign in to your account'}
          </p>
          {tenant && (
            <p className="text-sm text-slate-500 dark:text-slate-500 mt-2">
              {tenant.name}
            </p>
          )}
        </div>

        {/* Login Card */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8">
          {error && (
            <div className="mb-6 p-4 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg">
              <div className="flex items-start gap-3">
                <AlertCircle size={20} className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
              </div>
            </div>
          )}

          {/* Provider Selection */}
          {loginMode === 'provider-selection' && hasProviders && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600 dark:text-slate-400 text-center mb-6">
                Choose your sign-in method
              </p>

              {tenant.authConfig?.providers.map((provider) => {
                const providerInfo = providerDetails[provider.provider];
                if (!providerInfo) return null;

                return (
                  <button
                    key={provider.id}
                    onClick={() => handleProviderLogin(provider.provider)}
                    disabled={submitting}
                    className={`w-full flex items-center justify-center gap-3 px-6 py-3 ${providerInfo.color} text-white font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow-md`}
                  >
                    <span className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center text-sm font-bold">
                      {providerInfo.icon}
                    </span>
                    <span>Continue with {providerInfo.name}</span>
                  </button>
                );
              })}

              {!ssoOnly && (
                <>
                  <div className="relative my-6">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-slate-200 dark:border-slate-700"></div>
                    </div>
                    <div className="relative flex justify-center text-sm">
                      <span className="px-4 bg-white dark:bg-slate-800 text-slate-500">
                        or continue with email
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={() => setLoginMode('email-password')}
                    className="w-full flex items-center justify-center gap-3 px-6 py-3 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-medium rounded-lg transition-colors"
                  >
                    <Mail size={20} />
                    <span>Sign in with Email</span>
                  </button>
                </>
              )}
            </div>
          )}

          {/* Email/Password Login */}
          {(loginMode === 'email-password' || !hasProviders) && (
            <form onSubmit={handleEmailPasswordLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">
                  Email Address
                </label>
                <div className="relative">
                  <Mail size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full pl-10 pr-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 dark:text-slate-200"
                    placeholder="you@example.com"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
                    Password
                  </label>
                  <Link to={`/${tenant?.slug ?? tenantSlug}/forgot-password`} className="text-xs font-medium text-blue-600 hover:text-blue-700">
                    Forgot password?
                  </Link>
                </div>
                <div className="relative">
                  <Lock size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full pl-10 pr-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 dark:text-slate-200"
                    placeholder="••••••••"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full flex items-center justify-center gap-2 px-6 py-3 text-white font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow-md"
                style={{ backgroundColor: primaryColor }}
              >
                {submitting ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    <span>Signing in...</span>
                  </>
                ) : (
                  <>
                    <span>Sign In with Password</span>
                    <ArrowRight size={16} />
                  </>
                )}
              </button>

              {/* OTP Option */}
              {tenant?.authConfig?.otpEnabled && (
                <div className="relative my-4">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-slate-200 dark:border-slate-700"></div>
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-4 bg-white dark:bg-slate-800 text-slate-500">or</span>
                  </div>
                </div>
              )}

              {tenant?.authConfig?.otpEnabled && (
                <button
                  type="button"
                  onClick={handleRequestOtp}
                  disabled={submitting || !email}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? (
                    <>
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-slate-600"></div>
                      <span>Requesting OTP...</span>
                    </>
                  ) : (
                    <>
                      <span>Sign In with OTP</span>
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              )}

              {hasProviders && loginMode === 'email-password' && (
                <button
                  type="button"
                  onClick={() => setLoginMode('provider-selection')}
                  className="w-full text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
                >
                  ← Back to sign-in options
                </button>
              )}
            </form>
          )}

          {/* OTP Login */}
          {loginMode === 'otp' && (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              {/* Development OTP Display */}
              {devOtp && (
                <div className="p-4 bg-green-50 dark:bg-green-500/10 border-2 border-green-300 dark:border-green-500/50 rounded-lg">
                  <div className="flex items-start gap-3">
                    <CheckCircle2 size={20} className="text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-green-800 dark:text-green-300 mb-2">
                        Development Mode - Your OTP:
                      </p>
                      <div className="bg-white dark:bg-slate-900 px-4 py-3 rounded-lg border-2 border-dashed border-green-400 dark:border-green-500">
                        <p className="text-3xl font-mono font-bold text-center text-green-700 dark:text-green-400 tracking-widest">
                          {devOtp}
                        </p>
                      </div>
                      <p className="text-xs text-green-700 dark:text-green-400 mt-2">
                        This OTP is shown for development purposes only
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">
                  Enter OTP Code
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    required
                    maxLength={6}
                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 dark:text-slate-200 text-center text-2xl font-mono tracking-widest"
                    placeholder="000000"
                  />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                  Enter the 6-digit code sent to {email}
                </p>
              </div>

              <button
                type="submit"
                disabled={submitting || otp.length !== 6}
                className="w-full flex items-center justify-center gap-2 px-6 py-3 text-white font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow-md"
                style={{ backgroundColor: primaryColor }}
              >
                {submitting ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    <span>Verifying...</span>
                  </>
                ) : (
                  <>
                    <span>Verify & Sign In</span>
                    <ArrowRight size={16} />
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setLoginMode('email-password');
                  setOtp('');
                  setDevOtp(null);
                }}
                className="w-full text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
              >
                ← Back to email/password
              </button>
            </form>
          )}

          {/* No providers configured */}
          {!hasProviders && !ssoOnly && (
            <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-lg">
              <div className="flex items-start gap-3">
                <CheckCircle2 size={20} className="text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-blue-800 dark:text-blue-300">
                    No SSO providers configured
                  </p>
                  <p className="text-xs text-blue-700 dark:text-blue-400 mt-1">
                    Use email and password to sign in
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-center mt-8">
          {!tenantSlug && (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Don't have an account?{' '}
              <Link to="/register" className="text-blue-600 dark:text-blue-400 hover:underline font-medium">
                Create one
              </Link>
            </p>
          )}
          {tenantSlug && (
            <p className="text-xs text-slate-500 dark:text-slate-500">
              Protected by multi-tenant authentication
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
