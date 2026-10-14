import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { apiGet, apiPost } from '../lib/api-client';
import { useNavigate, useLocation } from 'react-router-dom';

interface User {
  id: string;
  email: string;
  name: string | null;
  userType: string;
  portal: 'PLATFORM' | 'TENANT';
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
}

interface AuthContextType {
  user: User | null;
  tenant: Tenant | null;
  loading: boolean;
  login: (email: string, password: string, tenantSlug: string) => Promise<void>;
  logout: () => Promise<void>;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Check if user is authenticated on mount
    const checkAuth = async () => {
      try {
        const response = await apiGet<{ user: User; tenant: Tenant | null }>('/bff/auth/me');
        setUser(response.user);
        setTenant(response.tenant);
      } catch (error) {
        // Not authenticated, redirect to login
        console.log('Not authenticated, redirecting to login');
        setUser(null);
        setTenant(null);
        
        // Only redirect if not already on login page
        if (!location.pathname.includes('/login')) {
          navigate('/login', { replace: true });
        }
      } finally {
        setLoading(false);
      }
    };

    checkAuth();
  }, [navigate, location.pathname]);

  const login = async (email: string, password: string, tenantSlug: string) => {
    const response = await apiPost<{ user: User; tenant: Tenant | null }>('/bff/auth/login', {
      email,
      password,
      tenantSlug,
    });

    setUser(response.user);
    setTenant(response.tenant);

    // Redirect to appropriate portal
    if (response.user.portal === 'PLATFORM') {
      navigate('/platform/dashboard', { replace: true });
    } else {
      navigate('/dashboard', { replace: true });
    }
  };

  const logout = async () => {
    try {
      await apiPost('/bff/auth/logout');
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setUser(null);
      setTenant(null);
      navigate('/login', { replace: true });
    }
  };

  const isAuthenticated = !!user;

  return (
    <AuthContext.Provider value={{ user, tenant, loading, login, logout, isAuthenticated }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
