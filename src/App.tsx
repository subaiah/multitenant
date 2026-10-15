import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LayoutProvider } from './context/LayoutContext';
import { AuthProvider } from './contexts/AuthContext';
import { PermissionGuard } from './components/PermissionGuard';
import { RequireAuth } from './components/RequireAuth';
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
import Unauthorized from './pages/Unauthorized';

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
    <BrowserRouter>
      <AuthProvider>
        <LayoutProvider>
          <Routes>
            {/* Public routes */}
            <Route path="/" element={<SmartLogin />} />
            <Route path="/login" element={<SmartLogin />} />
            <Route path="/:tenantSlug/login" element={<Login />} />
            <Route path="/unauthorized" element={<Unauthorized />} />
            
            {/* Platform Portal - Protected by PLATFORM_* user types */}
            <Route element={<RequireAuth portal="PLATFORM"><PlatformLayout /></RequireAuth>}>
              <Route path="/platform/dashboard" element={
                <PermissionGuard permission="platform:read" redirectTo="/unauthorized">
                  <PlaceholderPage title="Platform Dashboard" description="Overview of all tenants and platform metrics" />
                </PermissionGuard>
              } />
              <Route path="/platform/tenants" element={
                <PermissionGuard permission="tenants:read" redirectTo="/unauthorized">
                  <Tenants />
                </PermissionGuard>
              } />
              <Route path="/platform/applications" element={
                <PermissionGuard permission="applications:read" redirectTo="/unauthorized">
                  <ApplicationsManagement />
                </PermissionGuard>
              } />
              <Route path="/platform/users" element={
                <PermissionGuard permission="platform-users:read" redirectTo="/unauthorized">
                  <PlaceholderPage title="Platform Users" description="Manage platform-level users" />
                </PermissionGuard>
              } />
              <Route path="/platform/policies" element={
                <PermissionGuard permission="policies:read" redirectTo="/unauthorized">
                  <PlaceholderPage title="Global Policies" description="Manage platform-wide access policies" />
                </PermissionGuard>
              } />
              <Route path="/platform/settings" element={
                <PermissionGuard permission="platform-settings:manage" redirectTo="/unauthorized">
                  <PlaceholderPage title="Platform Settings" description="Configure platform-wide settings" />
                </PermissionGuard>
              } />
            </Route>
            
            {/* Tenant Portal - Protected by TENANT_* user types */}
            <Route element={<RequireAuth portal="TENANT"><TenantLayout /></RequireAuth>}>
              <Route path="/dashboard" element={
                <PermissionGuard permission="dashboard:view" redirectTo="/unauthorized">
                  <Dashboard />
                </PermissionGuard>
              } />
              {/* Every signed-in user can see their own profile */}
              <Route path="/profile" element={<Profile />} />
              <Route path="/applications" element={
                <PermissionGuard permission="applications:read" redirectTo="/unauthorized">
                  <Applications />
                </PermissionGuard>
              } />
              <Route path="/activity" element={
                <PermissionGuard permission="activity:read" redirectTo="/unauthorized">
                  <ActivityLog />
                </PermissionGuard>
              } />
              <Route path="/infrastructure" element={
                <PermissionGuard permission="infrastructure:read" redirectTo="/unauthorized">
                  <Infrastructure />
                </PermissionGuard>
              } />
              <Route path="/data-isolation" element={
                <PermissionGuard permission="database:manage" redirectTo="/unauthorized">
                  <DataIsolation />
                </PermissionGuard>
              } />
              <Route path="/authentication" element={
                <PermissionGuard permission="auth:manage" redirectTo="/unauthorized">
                  <Authentication />
                </PermissionGuard>
              } />
              <Route path="/api" element={
                <PermissionGuard permission="api:manage" redirectTo="/unauthorized">
                  <ApiManagement />
                </PermissionGuard>
              } />
              <Route path="/groups" element={
                <PermissionGuard permission="groups:read" redirectTo="/unauthorized">
                  <Groups />
                </PermissionGuard>
              } />
              <Route path="/role-assignments" element={
                <PermissionGuard permission="roles:read" redirectTo="/unauthorized">
                  <RoleAssignments />
                </PermissionGuard>
              } />
              <Route path="/organizations" element={
                <PermissionGuard permission="organizations:read" redirectTo="/unauthorized">
                  <Organizations />
                </PermissionGuard>
              } />
              <Route path="/tenant-entitlements" element={
                <PermissionGuard permission="applications:manage" redirectTo="/unauthorized">
                  <TenantEntitlements />
                </PermissionGuard>
              } />
              <Route path="/settings" element={
                <PermissionGuard permission="settings:read" redirectTo="/unauthorized">
                  <SettingsPage />
                </PermissionGuard>
              } />
            </Route>
            
            {/* Catch-all redirect */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </LayoutProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
