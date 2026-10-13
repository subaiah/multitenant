import { Bell, Search, Menu, User } from 'lucide-react';
import { useState } from 'react';
import { useLayout } from '../context/LayoutContext';
import LayoutSelector from './LayoutSelector';

interface HeaderProps {
  pageTitle: string;
}

export default function Header({ pageTitle }: HeaderProps) {
  const [searchFocused, setSearchFocused] = useState(false);
  const { toggleSidebar, settings } = useLayout();
  const { sidebarCollapsed, layoutMode } = settings;

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

        {/* User avatar */}
        <div className="flex items-center gap-3 ml-2 pl-3 border-l border-slate-200 dark:border-slate-700">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center">
            <User size={16} className="text-white" />
          </div>
          <div className="hidden lg:block">
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Admin User</p>
            <p className="text-xs text-slate-400">Super Admin</p>
          </div>
        </div>
      </div>
    </header>
  );
}
