/**
 * Sidebar menus for both portals (added to the database by lib/menus.ts).
 * Every `permission` must be in src/utils/permissions.ts and every `path`
 * must be a route in src/App.tsx; test/permissions.test.ts checks both.
 *
 * A top-level entry whose path starts with "#" is a section: a heading over
 * the entries in it, shown only when someone may open at least one of them.
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
    {
      label: 'Customers', path: '#customers', icon: 'Building2',
      children: [
        { label: 'Tenants', path: '/platform/tenants', icon: 'Building2', permission: 'tenants:read' },
        { label: 'Applications', path: '/platform/applications', icon: 'Package', permission: 'applications:read' },
        { label: 'Plans and billing', path: '/platform/billing', icon: 'CreditCard', permission: 'plans:read' },
      ],
    },
    {
      label: 'People', path: '#people', icon: 'Users',
      children: [
        { label: 'Platform users', path: '/platform/users', icon: 'Users', permission: 'platform-users:read' },
        { label: 'Support', path: '/platform/support', icon: 'LifeBuoy', permission: 'support:request' },
      ],
    },
    {
      label: 'Security', path: '#security', icon: 'ShieldCheck',
      children: [
        { label: 'Audit log', path: '/platform/audit', icon: 'ScrollText', permission: 'platform-audit:read' },
        { label: 'Global policies', path: '/platform/policies', icon: 'Shield', permission: 'policies:read' },
      ],
    },
    { label: 'Settings', path: '/platform/settings', icon: 'Settings', permission: 'platform-settings:manage' },
  ],
  TENANT: [
    { label: 'Dashboard', path: '/dashboard', icon: 'LayoutDashboard', permission: 'dashboard:view' },
    // The product's own screens (src/product), right after the dashboard
    ...product.tenantMenu,
    {
      label: 'People', path: '#people', icon: 'Users',
      children: [
        { label: 'Users', path: '/users', icon: 'Users', permission: 'users:read' },
        { label: 'Groups', path: '/groups', icon: 'UsersRound', permission: 'groups:read' },
        { label: 'Role assignments', path: '/role-assignments', icon: 'KeySquare', permission: 'roles:read' },
        { label: 'Access review', path: '/access-review', icon: 'ClipboardCheck', permission: 'roles:read' },
        { label: 'Organizations', path: '/organizations', icon: 'Network', permission: 'organizations:read' },
      ],
    },
    {
      label: 'Security', path: '#security', icon: 'ShieldCheck',
      children: [
        { label: 'Sign-in methods', path: '/authentication', icon: 'KeyRound', permission: 'auth:manage' },
        { label: 'Audit log', path: '/audit-log', icon: 'ScrollText', permission: 'audit:read' },
        { label: 'Activity', path: '/activity', icon: 'Activity', permission: 'activity:read' },
      ],
    },
    {
      // Sample data until real deployments report in (lib/preview.ts)
      label: 'Workspace', path: '#workspace', icon: 'Package',
      children: [
        { label: 'Applications', path: '/applications', icon: 'Package', permission: 'applications:read' },
        { label: 'Infrastructure', path: '/infrastructure', icon: 'Server', permission: 'infrastructure:read' },
        { label: 'API', path: '/api', icon: 'Code', permission: 'api:manage' },
      ],
    },
    {
      label: 'Organization', path: '#organization', icon: 'Building2',
      children: [
        { label: 'Entitlements', path: '/tenant-entitlements', icon: 'Boxes', permission: 'applications:manage' },
        { label: 'Data isolation', path: '/data-isolation', icon: 'Database', permission: 'database:manage' },
        { label: 'Billing', path: '/billing', icon: 'CreditCard', permission: 'billing:read' },
        { label: 'Settings', path: '/settings', icon: 'Settings', permission: 'settings:read' },
      ],
    },
  ],
};
