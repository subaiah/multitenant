import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode, useRef } from 'react';
import {
  SESSION_ENDED_EVENT, apiGet, apiPost, isMfaStep, logout as apiLogout, getCurrentUser,
  type CurrentUser, type MfaStep, type SessionEndReason,
} from '../lib/api-client';
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
  /**
   * Password login. Returns the user's portal so the caller can navigate, or
   * the two-factor step that comes next (no session yet).
   */
  login: (email: string, password: string, tenantSlug: string) => Promise<Portal | MfaStep>;
  /** Re-read the session after a login that happened elsewhere (e.g. OTP). */
  reload: () => Promise<Portal | null>;
  logout: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
  /** The permission across the tenant, or in at least one organization or unit */
  hasPermissionAnywhere: (permission: string) => boolean;
  /** Why the server ended the session mid-use (see api-client), or false */
  sessionEnded: SessionEndReason | false;
  /**
   * Pages that show sample data rather than real measurements are on
   * (PREVIEW_FEATURES on the server; backend/src/lib/preview.ts)
   */
  previewFeatures: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  // From roles given for one organization, unit or resource only
  const [scopedPermissions, setScopedPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionEnded, setSessionEnded] = useState<SessionEndReason | false>(false);
  const [previewFeatures, setPreviewFeatures] = useState(false);

  const clear = useCallback(() => {
    setUser(null);
    setTenant(null);
    setPermissions([]);
    setScopedPermissions([]);
  }, []);

  const reload = useCallback(async (): Promise<Portal | null> => {
    setLoading(true);
    try {
      const me = await getCurrentUser();
      const { permissions, scoped = [] } = await apiGet<{ permissions: string[]; scoped?: { permission: string; scopeAware?: boolean }[] }>('/auth/permissions');
      setUser(me.user);
      setTenant(me.tenant);
      setPermissions(permissions);
      // Only where pages check scope: elsewhere a role for one organization grants nothing
      setScopedPermissions([...new Set(scoped.filter((g) => g.scopeAware).map((g) => g.permission))]);
      setPreviewFeatures(me.features?.preview ?? false);
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
    const onEnded = (event: Event) => {
      const reason = (event as CustomEvent<SessionEndReason>).detail ?? 'signed-out';
      // Only a session that existed can "end" (not the startup check while
      // signed out), unless the server said it timed out
      if (!signedIn.current && reason === 'signed-out') return;
      setSessionEnded(reason);
      setUser(null);
      setPermissions([]);
    };
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, []);

  const login = useCallback(
    async (email: string, password: string, tenantSlug: string): Promise<Portal | MfaStep> => {
      const body = await apiPost('/bff/auth/login', { email, password, tenantSlug }, { skipAuth: true });
      if (isMfaStep(body)) return body;
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
  // Somewhere: across the tenant, or in at least one organization or unit (for showing a page that lists only those)
  const anywhere = useMemo(() => new Set([...permissions, ...scopedPermissions]), [permissions, scopedPermissions]);
  const hasPermissionAnywhere = useCallback((permission: string) => permissionMatches(anywhere, permission), [anywhere]);

  const value = useMemo(
    () => ({ user, tenant, permissions, loading, isAuthenticated: !!user, login, reload, logout, hasPermission, hasPermissionAnywhere, sessionEnded, previewFeatures }),
    [user, tenant, permissions, loading, login, reload, logout, hasPermission, hasPermissionAnywhere, sessionEnded, previewFeatures],
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
