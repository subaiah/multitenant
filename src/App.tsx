import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LayoutProvider } from './context/LayoutContext';
import { AuthProvider } from './contexts/AuthContext';
import Layout from './components/Layout';
import PlatformLayout from './layouts/PlatformLayout';
import TenantLayout from './layouts/TenantLayout';
import SmartLogin from './pages/SmartLogin';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Tenants from './pages/Tenants';
import Applications from './pages/Applications';
import ActivityLog from './pages/ActivityLog';
import SettingsPage from './pages/Settings';
import Infrastructure from './pages/Infrastructure';
import DataIsolation from './pages/DataIsolation';
import Authentication from './pages/Authentication';
import ApiManagement from './pages/ApiManagement';
import Profile from './pages/Profile';
import Groups from './pages/Groups';
import RoleAssignments from './pages/RoleAssignments';
import Organizations from './pages/Organizations';
import ApplicationsManagement from './pages/ApplicationsManagement';
import TenantEntitlements from './pages/TenantEntitlements';

function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800 dark:text-white">{title}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{description}</p>
      </div>
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-12">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="w-16 h-16 bg-blue-100 dark:bg-blue-500/20 rounded-2xl flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-slate-800 dark:text-white mb-2">Coming Soon</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md">
            This section is under development. Check back soon for updates on {title.toLowerCase()} management features.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <LayoutProvider>
        <BrowserRouter>
          <Routes>
            {/* Public routes */}
            <Route path="/" element={<SmartLogin />} />
            <Route path="/login" element={<SmartLogin />} />
            <Route path="/:tenantSlug/login" element={<Login />} />
            
            {/* Platform Portal */}
            <Route element={<PlatformLayout />}>
              <Route path="/platform/dashboard" element={<PlaceholderPage title="Platform Dashboard" description="Overview of all tenants and platform metrics" />} />
              <Route path="/platform/tenants" element={<Tenants />} />
              <Route path="/platform/applications" element={<ApplicationsManagement />} />
              <Route path="/platform/users" element={<PlaceholderPage title="Platform Users" description="Manage platform-level users" />} />
              <Route path="/platform/policies" element={<PlaceholderPage title="Global Policies" description="Manage platform-wide access policies" />} />
              <Route path="/platform/settings" element={<PlaceholderPage title="Platform Settings" description="Configure platform-wide settings" />} />
            </Route>
            
            {/* Tenant Portal */}
            <Route element={<TenantLayout />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/applications" element={<Applications />} />
              <Route path="/activity" element={<ActivityLog />} />
              <Route path="/infrastructure" element={<Infrastructure />} />
              <Route path="/data-isolation" element={<DataIsolation />} />
              <Route path="/authentication" element={<Authentication />} />
              <Route path="/api" element={<ApiManagement />} />
              <Route path="/groups" element={<Groups />} />
              <Route path="/role-assignments" element={<RoleAssignments />} />
              <Route path="/organizations" element={<Organizations />} />
              <Route path="/tenant-entitlements" element={<TenantEntitlements />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            
            {/* Catch-all redirect */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </LayoutProvider>
    </AuthProvider>
  );
}
