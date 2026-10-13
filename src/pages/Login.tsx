import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Building2, Mail, Lock, ArrowRight, AlertCircle, CheckCircle2 } from 'lucide-react';

interface TenantInfo {
  id: string;
  name: string;
  slug: string;
  logoUrl?: string;
  primaryColor?: string;
  loginTitle?: string;
  loginSubtitle?: string;
  status: string;
  authConfig?: {
    ssoOnly: boolean;
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
  const [searchParams] = useSearchParams();
  
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loginMode, setLoginMode] = useState<'provider-selection' | 'email-password'>('provider-selection');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Handle OAuth callback
  useEffect(() => {
    const token = searchParams.get('token');
    const tenantId = searchParams.get('tenantId');
    
    if (token && tenantId) {
      localStorage.setItem('authToken', token);
      localStorage.setItem('tenantId', tenantId);
      navigate('/dashboard');
    }
  }, [searchParams, navigate]);

  // Fetch tenant info if slug is provided
  useEffect(() => {
    const fetchTenant = async () => {
      if (!tenantSlug) {
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`http://localhost:3000/auth/tenant/${tenantSlug}`);
        
        if (!response.ok) {
          throw new Error('Tenant not found');
        }

        const data = await response.json();
        setTenant(data);
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
      const response = await fetch('http://localhost:3000/auth/oauth/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantSlug: tenant.slug,
          provider: providerId,
          redirectUri: window.location.origin + (tenantSlug ? `/${tenantSlug}/login` : '/login'),
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to initiate OAuth');
      }

      const data = await response.json();
      
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
      const response = await fetch('http://localhost:3000/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          tenantId: tenant.id,
          password,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Login failed');
      }

      const data = await response.json();
      
      // Store token and redirect
      localStorage.setItem('authToken', data.token);
      localStorage.setItem('tenantId', data.tenant.id);
      
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
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
  const hasProviders = tenant?.authConfig?.providers && tenant.authConfig.providers.length > 0;
  const ssoOnly = tenant?.authConfig?.ssoOnly || false;

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
      <div className="max-w-md w-full">
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
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">
                  Password
                </label>
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
                    <span>Sign In</span>
                    <ArrowRight size={16} />
                  </>
                )}
              </button>

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
