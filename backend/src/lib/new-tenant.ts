/**
 * Creating a tenant's control-plane record, by platform staff (routes/tenants.ts)
 * or by someone signing up (routes/signup.ts). Provisioning (lib/provisioning.ts)
 * then builds its database side and brings in its first administrator.
 */
import { z } from 'zod';
import { config } from '../config/env.js';
import { controlDb } from './prisma.js';
import { RESERVED_ROLE_SLUGS, roleNameFor } from './tenant-targets.js';
import { isPlatformSlug } from './platform.js';
import { AppError } from '../middleware/error-handler.js';

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/, 'Use 2-50 lowercase letters, digits and hyphens');

/** Addresses the app itself uses at the top level (its own pages) */
const APP_PATHS = ['login', 'signup', 'platform', 'accept-invite', 'reset-password', 'unauthorized', 'api', 'assets', 'dashboard', 'settings', 'users', 'profile'];

/** Throws when the address can't be a new tenant's */
export async function assertSlugAvailable(slug: string) {
  if (isPlatformSlug(slug) || RESERVED_ROLE_SLUGS.includes(slug) || APP_PATHS.includes(slug)) {
    throw new AppError('That address is reserved', 409, true, 'SLUG_TAKEN');
  }
  // The tenant's database role (and its schema or database) is named from the slug
  if (
    (await controlDb.tenant.findUnique({ where: { slug }, select: { id: true } })) ||
    (await controlDb.databaseConfig.findUnique({ where: { dbRoleName: roleNameFor(slug) }, select: { id: true } }))
  ) {
    throw new AppError(`The address "${slug}" is already taken`, 409, true, 'SLUG_TAKEN');
  }
}

export interface NewTenant {
  name: string;
  slug: string;
  plan: 'FREE' | 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE';
  status: 'ACTIVE' | 'TRIAL';
  strategy?: 'SHARED_TABLES' | 'SCHEMA_PER_TENANT' | 'DATABASE_PER_TENANT';
  adminEmail: string;
  adminName: string;
  /** The platform user creating it (named in the invitation); none when someone signs up */
  createdById: string | null;
}

export async function createTenantRecord(data: NewTenant) {
  await assertSlugAvailable(data.slug);
  return controlDb.tenant.create({
    data: {
      name: data.name,
      slug: data.slug,
      plan: data.plan,
      status: data.status,
      loginTitle: `Welcome to ${data.name}`,
      loginSubtitle: 'Sign in to your account',
      provisioningStatus: 'PENDING',
      initialAdminEmail: data.adminEmail,
      initialAdminName: data.adminName,
      createdById: data.createdById,
      databaseConfig: {
        create: { strategy: data.strategy ?? config.defaultTenantStrategy, region: 'default', storageLimit: '5 GB', tenantColumn: 'tenant_id' },
      },
    },
  });
}
