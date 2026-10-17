/**
 * Sidebar menus for both portals (added to the database by lib/menus.ts).
 * Every `permission` must be in src/utils/permissions.ts and every `path`
 * must be a route in src/App.tsx; test/permissions.test.ts checks both.
 */
import { product } from '../product/index.js';

export type Portal = 'PLATFORM' | 'TENANT';
export interface MenuSeed {
  label: string;
  path: string;
  icon: string;
  permission?: string;
  children?: MenuSeed[];
}

export const MENUS: Record<Portal, MenuSeed[]> = {
  PLATFORM: [
    { label: 'Dashboard', path: '/platform/dashboard', icon: 'LayoutDashboard', permission: 'platform:read' },
    { label: 'Tenants', path: '/platform/tenants', icon: 'Building2', permission: 'tenants:read' },
    { label: 'Applications', path: '/platform/applications', icon: 'Package', permission: 'applications:read' },
    { label: 'Platform Users', path: '/platform/users', icon: 'Users', permission: 'platform-users:read' },
    { label: 'Global Policies', path: '/platform/policies', icon: 'Shield', permission: 'policies:read' },
    { label: 'Support', path: '/platform/support', icon: 'LifeBuoy', permission: 'support:request' },
    { label: 'Audit Log', path: '/platform/audit', icon: 'ScrollText', permission: 'platform-audit:read' },
    { label: 'Settings', path: '/platform/settings', icon: 'Settings', permission: 'platform-settings:manage' },
  ],
  TENANT: [
    { label: 'Dashboard', path: '/dashboard', icon: 'LayoutDashboard', permission: 'dashboard:view' },
    { label: 'Applications', path: '/applications', icon: 'Package', permission: 'applications:read' },
    {
      label: 'Access',
      path: '/users',
      icon: 'Users',
      permission: 'users:read',
      children: [
        { label: 'Users', path: '/users', icon: 'Users', permission: 'users:read' },
        { label: 'Groups', path: '/groups', icon: 'Users', permission: 'groups:read' },
        { label: 'Role Assignments', path: '/role-assignments', icon: 'Shield', permission: 'roles:read' },
        { label: 'Access Review', path: '/access-review', icon: 'ShieldCheck', permission: 'roles:read' },
      ],
    },
    { label: 'Organizations', path: '/organizations', icon: 'Building2', permission: 'organizations:read' },
    { label: 'Entitlements', path: '/tenant-entitlements', icon: 'Boxes', permission: 'applications:manage' },
    { label: 'Activity Log', path: '/activity', icon: 'Activity', permission: 'activity:read' },
    { label: 'Audit Log', path: '/audit-log', icon: 'ScrollText', permission: 'audit:read' },
    { label: 'Infrastructure', path: '/infrastructure', icon: 'Server', permission: 'infrastructure:read' },
    { label: 'Data Isolation', path: '/data-isolation', icon: 'Database', permission: 'database:manage' },
    { label: 'Authentication', path: '/authentication', icon: 'KeyRound', permission: 'auth:manage' },
    { label: 'API', path: '/api', icon: 'Code', permission: 'api:manage' },
    // The product's own screens (src/product), before Settings
    ...product.tenantMenu,
    { label: 'Settings', path: '/settings', icon: 'Settings', permission: 'settings:read' },
  ],
};
