import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { portalHome, type Portal } from '../lib/permissions';

/**
 * Gate for a portal's routes: waits for the session check, sends signed-out
 * users to /login, and sends users of the other portal to their own home.
 */
export function RequireAuth({ portal, children }: { portal: Portal; children: ReactNode }) {
  const { user, tenant, loading, sessionEnded } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (!user) {
    const base = tenant?.slug ? `/${tenant.slug}/login` : '/login';
    const loginPath = sessionEnded ? `${base}?notice=signed-out` : base;
    return <Navigate to={loginPath} replace state={{ from: location.pathname }} />;
  }

  if (user.portal !== portal) {
    return <Navigate to={portalHome(user.portal)} replace />;
  }

  return <>{children}</>;
}
