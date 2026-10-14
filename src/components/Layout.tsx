import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopNav from './TopNav';
import Header from './Header';
import { useLayout } from '../context/LayoutContext';

const pageTitles: Record<string, string> = {
  '/': 'Dashboard',
  '/tenants': 'Tenants',
  '/applications': 'Applications',
  '/activity': 'Activity Log',
  '/infrastructure': 'Infrastructure',
  '/data-isolation': 'Data Isolation',
  '/authentication': 'Authentication & SSO',
  '/api': 'API & BFF Management',
  '/users': 'Users',
  '/security': 'Security',
  '/billing': 'Billing',
  '/analytics': 'Analytics',
  '/settings': 'Settings',
};

function getPageTitle(pathname: string, search: string): string {
  if (search) {
    const params = new URLSearchParams(search);
    const status = params.get('status');
    const tab = params.get('tab');

    if (pathname === '/tenants' && status === 'active') return 'Active Tenants';
    if (pathname === '/tenants' && status === 'suspended') return 'Suspended Tenants';
    if (pathname === '/tenants' && status === 'trial') return 'Trial Tenants';
    if (pathname === '/applications' && status === 'running') return 'Running Applications';
    if (pathname === '/applications' && status === 'stopped') return 'Stopped Applications';
    if (pathname === '/applications' && status === 'error') return 'Error Applications';
    if (pathname === '/users' && tab === 'roles') return 'Roles & Permissions';
  }

  return pageTitles[pathname] || 'Dashboard';
}

export default function Layout() {
  const { settings } = useLayout();
  const location = useLocation();
  const pageTitle = getPageTitle(location.pathname, location.search);
  const { layoutMode, sidebarCollapsed } = settings;

  if (layoutMode === 'top-nav') {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
        <TopNav />
        <main className="pt-16">
          {/* Sub-header for top-nav mode */}
          <div className="bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 px-6 py-4">
            <h1 className="text-lg font-semibold text-slate-800 dark:text-white">{pageTitle}</h1>
          </div>
          <div className="p-6">
            <Outlet />
          </div>
        </main>
      </div>
    );
  }

  // Sidebar layouts (left or right)
  const sidebarWidth = sidebarCollapsed ? 70 : 260;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <Sidebar />
      <div
        className="transition-all duration-300"
        style={
          layoutMode === 'sidebar-right'
            ? { marginRight: `${sidebarWidth}px` }
            : { marginLeft: `${sidebarWidth}px` }
        }
      >
        <Header pageTitle={pageTitle} />
        <main className="pt-16 min-h-screen">
          <div className="p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
