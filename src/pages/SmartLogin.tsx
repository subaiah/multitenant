import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { APP_NAME } from '../lib/brand';
import { apiGet } from '../lib/api-client';
import { useAuth } from '../contexts/AuthContext';
import { portalHome } from '../lib/permissions';

export default function SmartLogin() {
  const [orgSlug, setOrgSlug] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  // Keep a notice (e.g. why the session ended) for the organization's sign-in page
  const { search } = useLocation();
  const { user, loading: authLoading } = useAuth();

  // Already signed in: skip the org picker
  useEffect(() => {
    if (!authLoading && user) {
      navigate(portalHome(user.portal), { replace: true });
    }
  }, [authLoading, user, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!orgSlug.trim()) {
      setError('Please enter your organization slug');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Verify the organization exists
      const response = await apiGet<{ exists: boolean; portal: 'PLATFORM' | 'TENANT' }>(
        `/auth/verify-organization/${encodeURIComponent(orgSlug.trim())}`,
        { skipAuth: true },
      );

      if (!response.exists) {
        setError('Organization not found. Please check the slug and try again.');
        setLoading(false);
        return;
      }

      // Redirect to the appropriate login page
      navigate(`/${orgSlug.trim()}/login${search}`, { replace: true });
    } catch (err) {
      console.error('Error verifying organization:', err);
      setError('Failed to verify organization. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 px-4 pt-16 sm:pt-24 pb-10">
      <div className="max-w-sm mx-auto flex flex-col gap-7">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-800 dark:text-white">Sign in to {APP_NAME}</h1>
          <p className="text-slate-600 dark:text-slate-400">Enter your organization's sign-in address to continue.</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label htmlFor="orgSlug" className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Organization address</span>
            <span className="flex items-center h-10 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/25">
              <span className="pl-3 text-slate-500 font-mono text-sm" aria-hidden>/</span>
              <input
                id="orgSlug"
                type="text"
                autoComplete="organization"
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                placeholder="acme-corp"
                className="flex-1 min-w-0 h-full px-1 bg-transparent font-mono text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none"
                disabled={loading}
              />
            </span>
            <span className="text-sm text-slate-600 dark:text-slate-400">It's in the invitation email, after the site's address.</span>
          </label>

          {error && (
            <p role="alert" className="p-3 rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 text-sm text-red-800 dark:text-red-300">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="h-11 w-full flex items-center justify-center gap-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-60"
          >
            {loading && <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden />}
            {loading ? 'Finding your organization…' : 'Continue'}
          </button>
        </form>

        <p className="pt-5 border-t border-slate-200 dark:border-slate-700 text-sm text-slate-600 dark:text-slate-400">
          No account yet? Ask your organization's administrator to invite you. Platform staff sign in at <a className="font-medium text-blue-700 hover:text-blue-600 dark:text-blue-300" href="/platform/login">/platform/login</a>.
        </p>
      </div>
    </div>
  );
}
