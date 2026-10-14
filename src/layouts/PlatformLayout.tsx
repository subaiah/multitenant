import { Outlet } from 'react-router-dom';
import DynamicMenu from '../components/DynamicMenu';
import { useAuth } from '../contexts/AuthContext';
import { LogOut, User } from 'lucide-react';

export default function PlatformLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-slate-900">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-800 text-white flex flex-col">
        <div className="p-4 border-b border-slate-700">
          <h1 className="text-xl font-bold">Platform Admin</h1>
          <p className="text-sm text-slate-400">Multi-Tenant Management</p>
        </div>
        
        {/* Dynamic Menu */}
        <div className="flex-1 overflow-y-auto">
          <DynamicMenu portal="PLATFORM" />
        </div>

        {/* User Info */}
        <div className="p-4 border-t border-slate-700">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center">
              <User size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{user?.name || user?.email}</p>
              <p className="text-xs text-slate-400 truncate">{user?.userType}</p>
            </div>
          </div>
          <button
            onClick={logout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 rounded-lg transition-colors"
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
