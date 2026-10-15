import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode, useRef } from 'react';
import { SESSION_ENDED_EVENT, apiGet, apiPost, logout as apiLogout, getCurrentUser, type CurrentUser } from '../lib/api-client';
import { permissionMatches, type Portal } from '../lib/permissions';

type User = CurrentUser['user'];
type Tenant = NonNullable<CurrentUser['tenant']>;

interface AuthContextType {
  user: User | null;
  tenant: Tenant | null;
  permissions: string[];
  /** True until the initial session check (and any reload) finishes. */
  loading: boolean;
  isAuthenticated: boolean;
  /** Password login; returns the user's portal so the caller can navigate. */
  login: (email: string, password: string, tenantSlug: string) => Promise<Portal>;
  /** Re-read the session after a login that happened elsewhere (e.g. OTP). */
  reload: () => Promise<Portal | null>;
  logout: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
  /** True after the server ended the session mid-use (see api-client) */
  sessionEnded: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);

  const clear = useCallback(() => {
    setUser(null);
    setTenant(null);
    setPermissions([]);
  }, []);

  const reload = useCallback(async (): Promise<Portal | null> => {
    setLoading(true);
    try {
      const me = await getCurrentUser();
      const { permissions } = await apiGet<{ permissions: string[] }>('/auth/permissions');
      setUser(me.user);
      setTenant(me.tenant);
      setPermissions(permissions);
      setSessionEnded(false);
      return me.user.portal;
    } catch {
      // Not logged in (or the session expired): route guards send the user to /login
      clear();
      return null;
    } finally {
      setLoading(false);
    }
  }, [clear]);

  // Check the session once on startup
  useEffect(() => {
    reload();
  }, [reload]);

  // A request found the session ended (deactivated, removed, signed out
  // everywhere): drop the user but keep the tenant, so RequireAuth sends them
  // to this tenant's sign-in page with an explanation.
  const signedIn = useRef(false);
  signedIn.current = !!user;
  useEffect(() => {
    const onEnded = () => {
      // Only a session that existed can "end" (not the startup check while signed out)
      if (!signedIn.current) return;
      setSessionEnded(true);
      setUser(null);
      setPermissions([]);
    };
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, []);

  const login = useCallback(
    async (email: string, password: string, tenantSlug: string): Promise<Portal> => {
      await apiPost('/bff/auth/login', { email, password, tenantSlug }, { skipAuth: true });
      const portal = await reload();
      if (!portal) throw new Error('Login succeeded but the session could not be loaded');
      return portal;
    },
    [reload],
  );

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      clear();
    }
  }, [clear]);

  const granted = useMemo(() => new Set(permissions), [permissions]);
  const hasPermission = useCallback((permission: string) => permissionMatches(granted, permission), [granted]);

  const value = useMemo(
    () => ({ user, tenant, permissions, loading, isAuthenticated: !!user, login, reload, logout, hasPermission, sessionEnded }),
    [user, tenant, permissions, loading, login, reload, logout, hasPermission, sessionEnded],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
