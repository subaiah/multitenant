import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Building2, ArrowRight } from 'lucide-react';
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-slate-900 dark:to-slate-800 p-4">
      <div className="max-w-md w-full">
        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl p-8">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-full mb-4">
              <Building2 className="w-8 h-8 text-blue-600 dark:text-blue-400" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
              Welcome Back
            </h1>
            <p className="text-slate-600 dark:text-slate-400">
              Enter your organization slug to continue
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="orgSlug" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                Organization Slug
              </label>
              <input
                id="orgSlug"
                type="text"
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                placeholder="e.g., acme-corp"
                className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={loading}
              />
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                This is the unique identifier for your organization
              </p>
            </div>

            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  <span>Verifying...</span>
                </>
              ) : (
                <>
                  <span>Continue</span>
                  <ArrowRight size={20} />
                </>
              )}
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-slate-200 dark:border-slate-700">
            <p className="text-center text-sm text-slate-600 dark:text-slate-400">
              Don't have an account? Ask your organization's administrator for an invitation.
            </p>
          </div>
        </div>

        <div className="mt-6 text-center">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Protected by multi-tenant authentication
          </p>
        </div>
      </div>
    </div>
  );
}
