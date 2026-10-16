import { Outlet } from 'react-router-dom';
import DynamicMenu from '../components/DynamicMenu';
import NotificationBell from '../components/NotificationBell';
import { useAuth } from '../contexts/AuthContext';
import { LogOut, User, Building2 } from 'lucide-react';

export default function TenantLayout() {
  const { user, tenant, logout } = useAuth();

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-slate-900">
      {/* Sidebar */}
      <aside className="w-64 bg-white dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700 flex flex-col">
        <div className="p-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2 mb-2">
            <Building2 size={24} className="text-blue-600" />
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">Tenant Portal</h1>
            <div className="ml-auto"><NotificationBell allPath="/notifications" /></div>
          </div>
          {tenant && (
            <p className="text-sm text-slate-500 dark:text-slate-400">{tenant.name}</p>
          )}
        </div>
        
        {/* Dynamic Menu */}
        <div className="flex-1 overflow-y-auto">
          <DynamicMenu portal="TENANT" />
        </div>

        {/* User Info */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white">
              <User size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-900 dark:text-white truncate">
                {user?.name || user?.email}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                {user?.userType}
              </p>
            </div>
          </div>
          <button
            onClick={logout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
          >
            <LogOut size={16} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
