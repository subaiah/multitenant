/**
 * The contract between the kit and the product built on it.
 *
 * The kit (tenants, identity, access, organizations, the two portals) is the
 * same in every product forked from the starter. A product adds its own
 * features through one module, src/product/index.ts, and its own tenant
 * tables in prisma/tenant/product/. Keeping product code behind this
 * interface is what lets kit updates merge into a fork cleanly.
 * See docs/extending.md.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { TenantDb } from '../lib/tenant-db.js';
import type { UserType } from '../utils/authorization.js';
import type { AuditEventDefinition } from './audit-events.js';
import type { NotificationType } from './notification-types.js';

export interface ProductPermission {
  /** `resource:action`. The resource must not be a kit or platform resource. */
  name: string;
  /** What it allows, in plain language (shown in the role editor) */
  description: string;
}

export interface ProductMenuItem {
  label: string;
  /** A frontend route */
  path: string;
  /** A lucide-react icon name */
  icon: string;
  permission?: string;
  children?: ProductMenuItem[];
}

export interface ProductModule {
  /** Shown in logs and the API docs */
  name: string;

  /** Permissions the product's routes and screens check. Tenant-grantable. */
  permissions: ProductPermission[];
  /** Plain-language names for the product's resources (role editor) */
  resources: Record<string, { label: string; description: string }>;
  /** Extra grants per user type, on top of the kit's (e.g. TENANT_ADMIN: ['invoices:*']) */
  userTypeGrants: Partial<Record<UserType, string[]>>;

  /**
   * The product's API, registered inside the authenticated, tenant-bound
   * scope: every route has `request.tenant`, `request.user` and `request.db`
   * (the tenant's database) and must declare `config: { permission }`.
   */
  routes: FastifyPluginAsync;

  /** Tenant-portal menu entries, added after the kit's */
  tenantMenu: ProductMenuItem[];

  /**
   * The product's audit events, recorded with audit(request, key, ...)
   * (lib/audit.ts). Prefix keys with the feature, e.g. 'invoice.approved';
   * they must not reuse a kit key.
   */
  auditEvents?: Record<string, AuditEventDefinition>;

  /**
   * The product's notifications (lib/notifications.ts). A key that is also
   * an audit event is sent when that entry is recorded; any key can also be
   * sent directly with notify(). Keys must not reuse a kit key.
   */
  notificationTypes?: Record<string, NotificationType>;

  /**
   * What an organization's data export leaves out of the product's tables
   * (lib/data-export.ts): whole tables (caches, queues) and columns holding
   * secrets, e.g. { tables: ['job_queue'], columns: { webhooks: ['signing_secret'] } }.
   * Every other tenant table is exported.
   */
  exportExclusions?: { tables?: string[]; columns?: Record<string, string[]> };

  /** Runs when a tenant is created, after the kit's defaults (seed product data here). */
  onTenantCreated?: (tenantId: string, db: TenantDb) => Promise<void>;
}
