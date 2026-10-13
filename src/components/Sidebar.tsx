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

interface SidebarProps {
  currentPage: string;
  onNavigate: (page: string) => void;
  collapsed: boolean;
}

interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
  badge?: string;
  children?: { id: string; label: string }[];
}

const navItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  {
    id: 'tenants',
    label: 'Tenants',
    icon: Building2,
    badge: '8',
    children: [
      { id: 'tenants-list', label: 'All Tenants' },
      { id: 'tenants-active', label: 'Active' },
      { id: 'tenants-suspended', label: 'Suspended' },
    ],
  },
  {
    id: 'applications',
    label: 'Applications',
    icon: AppWindow,
    badge: '12',
    children: [
      { id: 'apps-all', label: 'All Apps' },
      { id: 'apps-running', label: 'Running' },
      { id: 'apps-stopped', label: 'Stopped' },
    ],
  },
  { id: 'activity', label: 'Activity Log', icon: Activity },
  { id: 'infrastructure', label: 'Infrastructure', icon: Server },
  {
    id: 'users',
    label: 'Users',
    icon: Users,
    children: [
      { id: 'users-all', label: 'All Users' },
      { id: 'users-roles', label: 'Roles & Permissions' },
    ],
  },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'billing', label: 'Billing', icon: CreditCard },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function Sidebar({ currentPage, onNavigate, collapsed }: SidebarProps) {
  const [expandedItems, setExpandedItems] = useState<string[]>(['tenants', 'applications']);

  const toggleExpand = (id: string) => {
    setExpandedItems((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const isActive = (item: NavItem) => {
    if (item.id === currentPage) return true;
    if (item.children) {
      return item.children.some((child) => child.id === currentPage);
    }
    return false;
  };

  return (
    <aside
      className={`fixed left-0 top-0 h-full bg-[#1e293b] text-white transition-all duration-300 z-50 flex flex-col ${
        collapsed ? 'w-[70px]' : 'w-[260px]'
      }`}
    >
      {/* Logo */}
      <div className="flex items-center h-16 px-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center font-bold text-sm">
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
                <button
                  onClick={() => {
                    if (item.children) {
                      toggleExpand(item.id);
                    } else {
                      onNavigate(item.id);
                    }
                  }}
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
                      {item.children &&
                        (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
                    </>
                  )}
                </button>

                {/* Sub-navigation */}
                {!collapsed && item.children && expanded && (
                  <ul className="ml-8 mt-1 space-y-1 border-l border-white/10 pl-3">
                    {item.children.map((child) => (
                      <li key={child.id}>
                        <button
                          onClick={() => onNavigate(child.id)}
                          className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                            currentPage === child.id
                              ? 'text-blue-400 bg-blue-500/10'
                              : 'text-slate-400 hover:text-white hover:bg-white/5'
                          }`}
                        >
                          {child.label}
                        </button>
                      </li>
                    ))}
                  </ul>
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
