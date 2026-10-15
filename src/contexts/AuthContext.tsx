import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { apiGet, apiPost, logout as apiLogout, getCurrentUser, type CurrentUser } from '../lib/api-client';
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
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

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
    () => ({ user, tenant, permissions, loading, isAuthenticated: !!user, login, reload, logout, hasPermission }),
    [user, tenant, permissions, loading, login, reload, logout, hasPermission],
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
