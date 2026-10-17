import { Suspense, lazy, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { LoadingState } from './components/ui';
import { PermissionGuard } from './components/PermissionGuard';
import { RequireAuth } from './components/RequireAuth';
import PlatformLayout from './layouts/PlatformLayout';
import TenantLayout from './layouts/TenantLayout';
import SmartLogin from './pages/SmartLogin';
import Login from './pages/Login';
const Dashboard = lazy(() => import('./pages/Dashboard'));
const PlatformDashboard = lazy(() => import('./pages/PlatformDashboard'));
const PlatformUsers = lazy(() => import('./pages/PlatformUsers'));
const Tenants = lazy(() => import('./pages/Tenants'));
const Applications = lazy(() => import('./pages/Applications'));
const ActivityLog = lazy(() => import('./pages/ActivityLog'));
const AuditLog = lazy(() => import('./pages/AuditLog'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Support = lazy(() => import('./pages/Support'));
const SupportWorkspace = lazy(() => import('./pages/SupportWorkspace'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const Infrastructure = lazy(() => import('./pages/Infrastructure'));
const DataIsolation = lazy(() => import('./pages/DataIsolation'));
const Authentication = lazy(() => import('./pages/Authentication'));
const ApiManagement = lazy(() => import('./pages/ApiManagement'));
const Profile = lazy(() => import('./pages/Profile'));
const Groups = lazy(() => import('./pages/Groups'));
const RoleAssignments = lazy(() => import('./pages/RoleAssignments'));
const RoleEditor = lazy(() => import('./pages/RoleEditor'));
const AccessReview = lazy(() => import('./pages/AccessReview'));
const Organizations = lazy(() => import('./pages/Organizations'));
const ApplicationsManagement = lazy(() => import('./pages/ApplicationsManagement'));
const TenantEntitlements = lazy(() => import('./pages/TenantEntitlements'));
const Unauthorized = lazy(() => import('./pages/Unauthorized'));
const Users = lazy(() => import('./pages/Users'));
const AcceptInvite = lazy(() => import('./pages/AcceptInvite'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const SignUp = lazy(() => import('./pages/SignUp'));
const SignupVerify = lazy(() => import('./pages/SignupVerify'));

function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-800 dark:text-white">{title}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{description}</p>
      </div>
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-12">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="w-16 h-16 bg-blue-100 dark:bg-blue-500/20 rounded-lg flex items-center justify-center mb-4">
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

/**
 * Pages that show sample data rather than real measurements: only when the
 * server has preview features on (backend/src/lib/preview.ts). Otherwise the
 * address leads to the dashboard.
 */
function Preview({ children, home }: { children: ReactNode; home: string }) {
  const { previewFeatures } = useAuth();
  return previewFeatures ? <>{children}</> : <Navigate to={home} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
      <AuthProvider>
        {/* Pages load on first visit; the layouts show this while one does */}
        <Suspense fallback={<LoadingState />}>
          <Routes>
            {/* Public routes */}
            <Route path="/" element={<SmartLogin />} />
            <Route path="/login" element={<SmartLogin />} />
            <Route path="/:tenantSlug/login" element={<Login />} />
            <Route path="/unauthorized" element={<Unauthorized />} />
            {/* Links from emails (no session needed) */}
            <Route path="/accept-invite" element={<AcceptInvite />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/signup" element={<SignUp />} />
            <Route path="/signup/verify" element={<SignupVerify />} />
            <Route path="/:tenantSlug/forgot-password" element={<ForgotPassword />} />
            
            {/* Platform Portal - Protected by PLATFORM_* user types */}
            <Route element={<RequireAuth portal="PLATFORM"><PlatformLayout /></RequireAuth>}>
              <Route path="/platform/dashboard" element={
                <PermissionGuard permission="platform:read" redirectTo="/unauthorized">
                  <PlatformDashboard />
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
                  <PlatformUsers />
                </PermissionGuard>
              } />
              <Route path="/platform/notifications" element={<Notifications scope="platform" />} />
              <Route path="/platform/support" element={
                <PermissionGuard permission="support:request" redirectTo="/unauthorized">
                  <Support />
                </PermissionGuard>
              } />
              <Route path="/platform/support/:id" element={
                <PermissionGuard permission="support:request" redirectTo="/unauthorized">
                  <SupportWorkspace />
                </PermissionGuard>
              } />
              <Route path="/platform/audit" element={
                <PermissionGuard permission="platform-audit:read" redirectTo="/unauthorized">
                  <AuditLog scope="platform" />
                </PermissionGuard>
              } />
              <Route path="/platform/policies" element={
                <Preview home="/platform/dashboard">
                  <PermissionGuard permission="policies:read" redirectTo="/unauthorized">
                    <PlaceholderPage title="Global Policies" description="Manage platform-wide access policies" />
                  </PermissionGuard>
                </Preview>
              } />
              <Route path="/platform/settings" element={
                <Preview home="/platform/dashboard">
                  <PermissionGuard permission="platform-settings:manage" redirectTo="/unauthorized">
                    <PlaceholderPage title="Platform Settings" description="Configure platform-wide settings" />
                  </PermissionGuard>
                </Preview>
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
              {/* Everyone has an inbox and preferences */}
              <Route path="/notifications" element={<Notifications scope="tenant" />} />
              <Route path="/applications" element={
                <Preview home="/dashboard">
                  <PermissionGuard permission="applications:read" redirectTo="/unauthorized">
                    <Applications />
                  </PermissionGuard>
                </Preview>
              } />
              <Route path="/activity" element={
                <PermissionGuard permission="activity:read" redirectTo="/unauthorized">
                  <ActivityLog />
                </PermissionGuard>
              } />
              <Route path="/audit-log" element={
                <PermissionGuard permission="audit:read" redirectTo="/unauthorized">
                  <AuditLog scope="tenant" />
                </PermissionGuard>
              } />
              <Route path="/infrastructure" element={
                <Preview home="/dashboard">
                  <PermissionGuard permission="infrastructure:read" redirectTo="/unauthorized">
                    <Infrastructure />
                  </PermissionGuard>
                </Preview>
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
                <Preview home="/dashboard">
                  <PermissionGuard permission="api:manage" redirectTo="/unauthorized">
                    <ApiManagement />
                  </PermissionGuard>
                </Preview>
              } />
              <Route path="/users" element={
                <PermissionGuard permission="users:read" redirectTo="/unauthorized">
                  <Users />
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
              {/* Your own access is always viewable; others need roles:read (checked in the page and by the API) */}
              <Route path="/access-review" element={<AccessReview />} />
              <Route path="/access-review/:userId" element={<AccessReview />} />
              <Route path="/roles/new" element={
                <PermissionGuard permission="roles:manage" redirectTo="/unauthorized">
                  <RoleEditor />
                </PermissionGuard>
              } />
              <Route path="/roles/:id" element={
                <PermissionGuard permission="roles:read" redirectTo="/unauthorized">
                  <RoleEditor />
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
        </Suspense>
      </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
