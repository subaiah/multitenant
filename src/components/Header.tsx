import { Bell, Search, Menu, User, LogOut, Settings, ChevronDown } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLayout } from '../context/LayoutContext';
import LayoutSelector from './LayoutSelector';
import { getCurrentUser, logout } from '../lib/api-client';

interface HeaderProps {
  pageTitle: string;
}

interface UserInfo {
  id: string;
  email: string;
  name: string | null;
  userType: string;
}

interface TenantInfo {
  id: string;
  name: string;
  slug: string;
}

export default function Header({ pageTitle }: HeaderProps) {
  const navigate = useNavigate();
  const [searchFocused, setSearchFocused] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { toggleSidebar, settings } = useLayout();
  const { sidebarCollapsed, layoutMode } = settings;

  // Fetch user data on mount
  useEffect(() => {
    const fetchUser = async () => {
      try {
        const data = await getCurrentUser();
        setUser(data.user);
        setTenant(data.tenant);
      } catch (error) {
        console.error('Failed to fetch user:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchUser();
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    try {
      await logout();
      navigate('/login');
    } catch (error) {
      console.error('Logout failed:', error);
      // Still redirect even if logout fails
      navigate('/login');
    }
  };

  const handleProfileClick = () => {
    setDropdownOpen(false);
    navigate('/profile');
  };

  // Calculate positioning based on layout mode
  const getHeaderStyle = (): React.CSSProperties => {
    const sidebarWidth = sidebarCollapsed ? 70 : 260;
    if (layoutMode === 'sidebar-left') {
      return { left: `${sidebarWidth}px`, right: '0' };
    } else if (layoutMode === 'sidebar-right') {
      return { left: '0', right: `${sidebarWidth}px` };
    }
    return { left: '0', right: '0' };
  };

  const getUserInitials = () => {
    if (user?.name) {
      return user.name
        .split(' ')
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
    }
    return user?.email?.[0].toUpperCase() || 'U';
  };

  const formatUserType = (userType: string) => {
    return userType
      .split('_')
      .map(word => word.charAt(0) + word.slice(1).toLowerCase())
      .join(' ');
  };

  return (
    <header
      className="fixed top-0 h-16 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 z-40 flex items-center px-6 transition-all duration-300"
      style={getHeaderStyle()}
    >
      <div className="flex items-center gap-4 flex-1">
        <button
          onClick={toggleSidebar}
          className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400"
        >
          <Menu size={20} />
        </button>
        <h1 className="text-lg font-semibold text-slate-800 dark:text-white">{pageTitle}</h1>
      </div>

      <div className="flex items-center gap-3">
        {/* Search */}
        <div
          className={`relative transition-all duration-200 hidden md:block ${
            searchFocused ? 'w-72' : 'w-56'
          }`}
        >
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            type="text"
            placeholder="Search..."
            className="w-full pl-9 pr-4 py-2 text-sm bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 dark:text-slate-200 placeholder-slate-400"
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
          />
        </div>

        {/* Layout Selector */}
        <LayoutSelector />

        {/* Notifications */}
        <button className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 relative">
          <Bell size={20} />
          <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
        </button>

        {/* User dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-3 ml-2 pl-3 border-l border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-lg px-2 py-1 transition-colors"
          >
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white font-semibold text-sm">
              {loading ? <User size={16} /> : getUserInitials()}
            </div>
            <div className="hidden lg:block text-left">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                {loading ? 'Loading...' : user?.name || user?.email || 'User'}
              </p>
              <p className="text-xs text-slate-400">
                {loading ? '' : tenant?.name || formatUserType(user?.userType || '')}
              </p>
            </div>
            <ChevronDown
              size={16}
              className={`text-slate-400 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {/* Dropdown menu */}
          {dropdownOpen && (
            <div className="absolute right-0 top-full mt-2 w-64 bg-white dark:bg-slate-800 rounded-xl shadow-lg border border-slate-200 dark:border-slate-700 py-2 z-50">
              {/* User info section */}
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">
                <p className="text-sm font-medium text-slate-800 dark:text-white truncate">
                  {user?.name || user?.email}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                  {user?.email}
                </p>
                {tenant && (
                  <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                    {tenant.name}
                  </p>
                )}
              </div>

              {/* Menu items */}
              <div className="py-1">
                <button
                  onClick={handleProfileClick}
                  className="w-full flex items-center gap-3 px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                >
                  <User size={16} className="text-slate-400" />
                  <span>Profile</span>
                </button>
                <button
                  onClick={() => {
                    setDropdownOpen(false);
                    navigate('/settings');
                  }}
                  className="w-full flex items-center gap-3 px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                >
                  <Settings size={16} className="text-slate-400" />
                  <span>Settings</span>
                </button>
              </div>

              {/* Logout section */}
              <div className="border-t border-slate-200 dark:border-slate-700 pt-1">
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-3 px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                >
                  <LogOut size={16} />
                  <span>Logout</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
