import { useState } from 'react';
import Sidebar from './Sidebar';
import Header from './Header';

interface LayoutProps {
  children: React.ReactNode;
  currentPage: string;
  onNavigate: (page: string) => void;
}

const pageTitles: Record<string, string> = {
  dashboard: 'Dashboard',
  tenants: 'Tenants',
  'tenants-list': 'All Tenants',
  'tenants-active': 'Active Tenants',
  'tenants-suspended': 'Suspended Tenants',
  applications: 'Applications',
  'apps-all': 'All Applications',
  'apps-running': 'Running Applications',
  'apps-stopped': 'Stopped Applications',
  activity: 'Activity Log',
  infrastructure: 'Infrastructure',
  users: 'Users',
  'users-all': 'All Users',
  'users-roles': 'Roles & Permissions',
  security: 'Security',
  billing: 'Billing',
  analytics: 'Analytics',
  settings: 'Settings',
};

export default function Layout({ children, currentPage, onNavigate }: LayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  const toggleSidebar = () => setCollapsed(!collapsed);
  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
    document.documentElement.classList.toggle('dark');
  };

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
        <Sidebar
          currentPage={currentPage}
          onNavigate={onNavigate}
          collapsed={collapsed}
        />
        <Header
          onToggleSidebar={toggleSidebar}
          collapsed={collapsed}
          darkMode={darkMode}
          onToggleDarkMode={toggleDarkMode}
          pageTitle={pageTitles[currentPage] || 'Dashboard'}
        />
        <main
          className={`pt-16 min-h-screen transition-all duration-300 ${
            collapsed ? 'ml-[70px]' : 'ml-[260px]'
          }`}
        >
          <div className="p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
