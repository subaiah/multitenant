import { Link, useLocation } from 'react-router-dom';
import { useMenuItems, MenuItem } from '../hooks/useMenuItems';
import { usePermissions } from '../hooks/usePermissions';
import {
  LayoutDashboard,
  Building2,
  Package,
  Users,
  Shield,
  ShieldCheck,
  Settings,
  Activity,
  Boxes,
  Server,
  Database,
  KeyRound,
  Code,
  ScrollText,
  ChevronDown,
  ChevronRight,
  LucideIcon,
} from 'lucide-react';
import { useState, useMemo } from 'react';

// Icon mapping
const iconMap: Record<string, LucideIcon> = {
  LayoutDashboard,
  Building2,
  Package,
  Users,
  Shield,
  ShieldCheck,
  Settings,
  Activity,
  Boxes,
  Server,
  Database,
  KeyRound,
  Code,
  ScrollText,
};

interface DynamicMenuProps {
  portal: 'PLATFORM' | 'TENANT';
}

export default function DynamicMenu({ portal }: DynamicMenuProps) {
  const { menuItems, loading: menuLoading, error: menuError } = useMenuItems(portal);
  const { hasPermission, loading: permLoading } = usePermissions();
  const location = useLocation();
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  // Filter menu items based on permissions
  const filteredMenuItems = useMemo(() => {
    if (permLoading || menuLoading) return [];

    const filterItem = (item: MenuItem): MenuItem | null => {
      // Check if user has permission for this item
      if (item.permission && !hasPermission(item.permission)) {
        return null;
      }

      // Filter children recursively
      if (item.children && item.children.length > 0) {
        const filteredChildren = item.children
          .map(filterItem)
          .filter((child): child is MenuItem => child !== null);

        // If no children are visible, hide the parent too
        if (filteredChildren.length === 0) {
          return null;
        }

        return { ...item, children: filteredChildren };
      }

      return item;
    };

    return menuItems
      .map(filterItem)
      .filter((item): item is MenuItem => item !== null);
  }, [menuItems, hasPermission, menuLoading, permLoading]);

  const toggleExpanded = (id: string) => {
    setExpandedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const isActive = (path: string) => {
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  const hasActiveChild = (item: MenuItem) => {
    if (!item.children || item.children.length === 0) return false;
    return item.children.some(child => isActive(child.path));
  };

  const renderIcon = (iconName: string | null) => {
    if (!iconName || !iconMap[iconName]) {
      return <LayoutDashboard size={20} />;
    }
    const Icon = iconMap[iconName];
    return <Icon size={20} />;
  };

  const renderMenuItem = (item: MenuItem, isChild = false) => {
    const hasChildren = item.children && item.children.length > 0;
    const isExpanded = expandedItems.has(item.id);
    const active = isActive(item.path);
    const hasActive = hasActiveChild(item);

    if (hasChildren) {
      return (
        <div key={item.id}>
          <button
            onClick={() => toggleExpanded(item.id)}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-lg mb-2 transition-colors ${
              active || hasActive
                ? portal === 'PLATFORM'
                  ? 'bg-blue-600 text-white'
                  : 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                : isChild
                ? 'pl-8'
                : ''
            } ${
              !active && !hasActive
                ? portal === 'PLATFORM'
                  ? 'text-slate-300 hover:bg-slate-700'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                : ''
            }`}
          >
            <div className="flex items-center gap-3">
              {renderIcon(item.icon)}
              <span>{item.label}</span>
            </div>
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          {isExpanded && (
            <div className="ml-4">
              {item.children!.map(child => renderMenuItem(child, true))}
            </div>
          )}
        </div>
      );
    }

    return (
      <Link
        key={item.id}
        to={item.path}
        className={`flex items-center gap-3 px-4 py-3 rounded-lg mb-2 transition-colors ${
          active
            ? portal === 'PLATFORM'
              ? 'bg-blue-600 text-white'
              : 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
            : isChild
            ? 'pl-8'
            : ''
        } ${
          !active
            ? portal === 'PLATFORM'
              ? 'text-slate-300 hover:bg-slate-700'
              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
            : ''
        }`}
      >
        {renderIcon(item.icon)}
        <span>{item.label}</span>
      </Link>
    );
  };

  const isLoading = menuLoading || permLoading;

  if (isLoading) {
    return (
      <div className="p-4">
        <div className="animate-pulse space-y-3">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-12 bg-slate-200 dark:bg-slate-700 rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  if (menuError) {
    return (
      <div className="p-4 text-red-500">
        <p>Failed to load menu</p>
        <p className="text-sm">{menuError}</p>
      </div>
    );
  }

  if (filteredMenuItems.length === 0) {
    return (
      <div className="p-4 text-slate-500 dark:text-slate-400">
        <p>No menu items available</p>
      </div>
    );
  }

  return (
    <nav className="p-4">
      {filteredMenuItems.map(item => renderMenuItem(item))}
    </nav>
  );
}
