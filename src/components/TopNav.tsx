import { useLocation, Link } from 'react-router-dom';
import { useState } from 'react';
import {
  LayoutDashboard,
  Building2,
  AppWindow,
  Activity,
  Settings,
  Users,
  Shield,
  CreditCard,
  BarChart3,
  Server,
  ChevronDown,
  Menu,
  X,
  Database,
  Key,
  Code,
} from 'lucide-react';

interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
  path: string;
  children?: { id: string; label: string; path: string }[];
}

const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, path: '/' },
  {
    id: 'tenants',
    label: 'Tenants',
    icon: Building2,
    path: '/tenants',
    children: [
      { id: 'tenants-list', label: 'All Tenants', path: '/tenants' },
      { id: 'tenants-active', label: 'Active', path: '/tenants?status=active' },
      { id: 'tenants-suspended', label: 'Suspended', path: '/tenants?status=suspended' },
    ],
  },
  {
    id: 'applications',
    label: 'Applications',
    icon: AppWindow,
    path: '/applications',
    children: [
      { id: 'apps-all', label: 'All Apps', path: '/applications' },
      { id: 'apps-running', label: 'Running', path: '/applications?status=running' },
      { id: 'apps-stopped', label: 'Stopped', path: '/applications?status=stopped' },
    ],
  },
  { id: 'activity', label: 'Activity', icon: Activity, path: '/activity' },
  { id: 'infrastructure', label: 'Infrastructure', icon: Server, path: '/infrastructure' },
  { id: 'data-isolation', label: 'Data Isolation', icon: Database, path: '/data-isolation' },
  { id: 'authentication', label: 'Authentication', icon: Key, path: '/authentication' },
  { id: 'api', label: 'API & BFF', icon: Code, path: '/api' },
  {
    id: 'users',
    label: 'Users',
    icon: Users,
    path: '/users',
    children: [
      { id: 'users-all', label: 'All Users', path: '/users' },
      { id: 'users-groups', label: 'Groups', path: '/groups' },
      { id: 'users-roles', label: 'Role Assignments', path: '/role-assignments' },
    ],
  },
  { id: 'security', label: 'Security', icon: Shield, path: '/security' },
  { id: 'billing', label: 'Billing', icon: CreditCard, path: '/billing' },
  { id: 'analytics', label: 'Analytics', icon: BarChart3, path: '/analytics' },
  { id: 'settings', label: 'Settings', icon: Settings, path: '/settings' },
];

export default function TopNav() {
  const location = useLocation();
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isActive = (path: string) => {
    const [pathname] = path.split('?');
    if (pathname === '/') return location.pathname === '/';
    return location.pathname.startsWith(pathname);
  };

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 h-16 bg-[#1e293b] text-white z-50 flex items-center px-4 lg:px-6 shadow-lg">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-3 mr-6 flex-shrink-0">
          <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center font-bold text-sm">
            MT
          </div>
          <span className="font-semibold text-lg hidden sm:block">MultiTenant</span>
        </Link>

        {/* Mobile menu button */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="lg:hidden p-2 rounded-lg hover:bg-white/10 mr-2"
        >
          {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>

        {/* Desktop Navigation */}
        <div className="hidden lg:flex items-center gap-1 flex-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.path);

            if (item.children) {
              return (
                <div
                  key={item.id}
                  className="relative"
                  onMouseEnter={() => setOpenDropdown(item.id)}
                  onMouseLeave={() => setOpenDropdown(null)}
                >
                  <button
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      active
                        ? 'bg-blue-500/20 text-blue-400'
                        : 'text-slate-300 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <Icon size={16} />
                    {item.label}
                    <ChevronDown size={14} />
                  </button>

                  {openDropdown === item.id && (
                    <div className="absolute top-full left-0 mt-1 w-48 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 py-2 z-50">
                      {item.children.map((child) => (
                        <Link
                          key={child.id}
                          to={child.path}
                          className="block px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                        >
                          {child.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            }

            return (
              <Link
                key={item.id}
                to={item.path}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'text-slate-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          })}
        </div>

        {/* Right side */}
        <div className="flex items-center gap-2 ml-auto">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-white/10 rounded-lg">
            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
            <span className="text-xs text-slate-300">System Online</span>
          </div>
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-sm font-medium">
            A
          </div>
        </div>
      </nav>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="fixed top-16 left-0 right-0 bottom-0 bg-[#1e293b] z-40 lg:hidden overflow-y-auto">
          <div className="p-4 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);

              if (item.children) {
                return (
                  <div key={item.id}>
                    <button
                      onClick={() =>
                        setOpenDropdown(openDropdown === item.id ? null : item.id)
                      }
                      className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                        active
                          ? 'bg-blue-500/20 text-blue-400'
                          : 'text-slate-300 hover:bg-white/5'
                      }`}
                    >
                      <Icon size={18} />
                      <span className="flex-1 text-left">{item.label}</span>
                      <ChevronDown
                        size={14}
                        className={`transition-transform ${
                          openDropdown === item.id ? 'rotate-180' : ''
                        }`}
                      />
                    </button>
                    {openDropdown === item.id && (
                      <div className="ml-10 mt-1 space-y-1 border-l border-white/10 pl-3">
                        {item.children.map((child) => (
                          <Link
                            key={child.id}
                            to={child.path}
                            onClick={() => setMobileMenuOpen(false)}
                            className="block px-3 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-white/5"
                          >
                            {child.label}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <Link
                  key={item.id}
                  to={item.path}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? 'bg-blue-500/20 text-blue-400'
                      : 'text-slate-300 hover:bg-white/5'
                  }`}
                >
                  <Icon size={18} />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
