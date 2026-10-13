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
  ChevronDown,
  ChevronRight,
  Server,
  Bell,
  HelpCircle,
} from 'lucide-react';
import { useLayout } from '../context/LayoutContext';


interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
  path: string;
  badge?: string;
  children?: { id: string; label: string; path: string }[];
}

const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, path: '/' },
  {
    id: 'tenants',
    label: 'Tenants',
    icon: Building2,
    path: '/tenants',
    badge: '8',
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
    badge: '12',
    children: [
      { id: 'apps-all', label: 'All Apps', path: '/applications' },
      { id: 'apps-running', label: 'Running', path: '/applications?status=running' },
      { id: 'apps-stopped', label: 'Stopped', path: '/applications?status=stopped' },
    ],
  },
  { id: 'activity', label: 'Activity Log', icon: Activity, path: '/activity' },
  { id: 'infrastructure', label: 'Infrastructure', icon: Server, path: '/infrastructure' },
  {
    id: 'users',
    label: 'Users',
    icon: Users,
    path: '/users',
    children: [
      { id: 'users-all', label: 'All Users', path: '/users' },
      { id: 'users-roles', label: 'Roles & Permissions', path: '/users?tab=roles' },
    ],
  },
  { id: 'security', label: 'Security', icon: Shield, path: '/security' },
  { id: 'billing', label: 'Billing', icon: CreditCard, path: '/billing' },
  { id: 'analytics', label: 'Analytics', icon: BarChart3, path: '/analytics' },
  { id: 'settings', label: 'Settings', icon: Settings, path: '/settings' },
];

export default function Sidebar() {
  const location = useLocation();
  const { settings } = useLayout();
  const collapsed = settings.sidebarCollapsed;
  const [expandedItems, setExpandedItems] = useState<string[]>(['tenants', 'applications']);

  const toggleExpand = (id: string) => {
    setExpandedItems((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const isActive = (item: NavItem) => {
    if (item.path === '/') {
      return location.pathname === '/';
    }
    return location.pathname.startsWith(item.path);
  };

  const isChildActive = (path: string) => {
    const [pathname, search] = path.split('?');
    if (search) {
      const params = new URLSearchParams(search);
      const currentParams = new URLSearchParams(location.search);
      return location.pathname === pathname && params.get('status') === currentParams.get('status');
    }
    return location.pathname === pathname;
  };

  return (
    <aside
      className={`fixed top-0 h-full bg-[#1e293b] text-white transition-all duration-300 z-50 flex flex-col ${
        collapsed ? 'w-[70px]' : 'w-[260px]'
      } ${settings.layoutMode === 'sidebar-right' ? 'right-0' : 'left-0'}`}
    >
      {/* Logo */}
      <div className="flex items-center h-16 px-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center font-bold text-sm flex-shrink-0">
            MT
          </div>
          {!collapsed && (
            <span className="font-semibold text-lg whitespace-nowrap">MultiTenant</span>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-4 px-3">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const expanded = expandedItems.includes(item.id);
            const active = isActive(item);

            return (
              <li key={item.id}>
                {item.children ? (
                  <>
                    <button
                      onClick={() => toggleExpand(item.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-150 ${
                        active
                          ? 'bg-blue-500/20 text-blue-400'
                          : 'text-slate-300 hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      <Icon size={18} className="flex-shrink-0" />
                      {!collapsed && (
                        <>
                          <span className="flex-1 text-left whitespace-nowrap">{item.label}</span>
                          {item.badge && (
                            <span className="bg-blue-500/20 text-blue-400 text-xs px-2 py-0.5 rounded-full">
                              {item.badge}
                            </span>
                          )}
                          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </>
                      )}
                    </button>

                    {!collapsed && expanded && (
                      <ul className="ml-8 mt-1 space-y-1 border-l border-white/10 pl-3">
                        {item.children.map((child) => (
                          <li key={child.id}>
                            <Link
                              to={child.path}
                              className={`block px-3 py-2 rounded-lg text-sm transition-colors ${
                                isChildActive(child.path)
                                  ? 'text-blue-400 bg-blue-500/10'
                                  : 'text-slate-400 hover:text-white hover:bg-white/5'
                              }`}
                            >
                              {child.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <Link
                    to={item.path}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-150 ${
                      active
                        ? 'bg-blue-500/20 text-blue-400'
                        : 'text-slate-300 hover:bg-white/5 hover:text-white'
                    }`}
                  >
                    <Icon size={18} className="flex-shrink-0" />
                    {!collapsed && (
                      <>
                        <span className="flex-1 whitespace-nowrap">{item.label}</span>
                        {item.badge && (
                          <span className="bg-blue-500/20 text-blue-400 text-xs px-2 py-0.5 rounded-full">
                            {item.badge}
                          </span>
                        )}
                      </>
                    )}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Bottom section */}
      {!collapsed && (
        <div className="p-3 border-t border-white/10">
          <div className="flex items-center gap-3 px-3 py-2">
            <HelpCircle size={16} className="text-slate-400" />
            <span className="text-sm text-slate-400">Help & Support</span>
          </div>
          <div className="flex items-center gap-3 px-3 py-2">
            <Bell size={16} className="text-slate-400" />
            <span className="text-sm text-slate-400">Notifications</span>
            <span className="ml-auto bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">
              3
            </span>
          </div>
        </div>
      )}
    </aside>
  );
}
