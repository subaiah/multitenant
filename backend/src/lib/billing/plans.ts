/**
 * Plans: what each allows (limits and features) and costs (per-seat prices).
 * Rows in billing_plans, one per TenantPlan, edited by platform staff.
 *
 * Limits are checked when something is added: inviting or creating a user,
 * an organization, a group; turning on single sign-on or a custom domain.
 * Nothing that already exists is removed when a plan gets smaller.
 */
import type { FastifyRequest } from 'fastify';
import { controlDb } from '../prisma.js';
import { dbForTenant } from '../tenant-db.js';
import { AppError } from '../../middleware/error-handler.js';

export type PlanCode = 'FREE' | 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE';
export const PLAN_CODES: PlanCode[] = ['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE'];

export interface PlanRules {
  code: PlanCode;
  name: string;
  maxUsers: number | null;
  maxOrganizations: number | null;
  maxGroups: number | null;
  allowSso: boolean;
  allowCustomDomain: boolean;
}

// Plans change rarely and are read on every limited action: a short cache
const CACHE_MS = 30_000;
let cache: { at: number; plans: Map<PlanCode, PlanRules> } | null = null;

export function forgetPlans() {
  cache = null;
}

export async function allPlanRules(): Promise<Map<PlanCode, PlanRules>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.plans;
  const rows = await controlDb.billingPlan.findMany();
  const plans = new Map<PlanCode, PlanRules>(rows.map((r) => [r.code as PlanCode, {
    code: r.code as PlanCode, name: r.name, maxUsers: r.maxUsers, maxOrganizations: r.maxOrganizations, maxGroups: r.maxGroups,
    allowSso: r.allowSso, allowCustomDomain: r.allowCustomDomain,
  }]));
  cache = { at: Date.now(), plans };
  return plans;
}

/** The rules for a plan. A plan without a row (shouldn't happen) has no limits. */
export async function planRules(code: string): Promise<PlanRules> {
  return (await allPlanRules()).get(code as PlanCode)
    ?? { code: code as PlanCode, name: code, maxUsers: null, maxOrganizations: null, maxGroups: null, allowSso: true, allowCustomDomain: true };
}

export async function tenantPlanRules(tenantId: string): Promise<PlanRules> {
  const t = await controlDb.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  return planRules(t?.plan ?? 'FREE');
}

/** People who count as users (and seats): everyone not deactivated, invitations included */
export const SEAT_STATUSES = ['ACTIVE', 'PENDING'] as const;

export async function usageOf(tenantId: string) {
  const db = await dbForTenant(tenantId);
  const [users, organizations, groups] = await Promise.all([
    db.user.count({ where: { tenantId, status: { in: [...SEAT_STATUSES] } } }),
    db.organization.count({ where: { tenantId } }),
    db.group.count({ where: { tenantId } }),
  ]);
  return { users, organizations, groups };
}

export type Limited = 'users' | 'organizations' | 'groups';
const LIMIT_FIELD = { users: 'maxUsers', organizations: 'maxOrganizations', groups: 'maxGroups' } as const;
const NOUN = { users: 'users', organizations: 'organizations', groups: 'groups' } as const;

export function planLimitError(plan: PlanRules, message: string) {
  return new AppError(`${message} Upgrade on the Billing page to go further.`, 403, true, 'PLAN_LIMIT');
}

/**
 * Refuse to add `adding` more of something when the tenant's plan doesn't
 * allow it. Platform staff (support sessions) are held to the same limits:
 * changing a plan is the way past them.
 */
export async function assertWithinLimit(tenantId: string, what: Limited, adding = 1) {
  const plan = await tenantPlanRules(tenantId);
  const max = plan[LIMIT_FIELD[what]];
  if (max === null) return;
  const current = (await usageOf(tenantId))[what];
  if (current + adding > max) {
    throw planLimitError(plan, `The ${plan.name} plan allows ${max} ${NOUN[what]} and you have ${current}.`);
  }
}

export async function assertFeature(tenantId: string, feature: 'allowSso' | 'allowCustomDomain') {
  const plan = await tenantPlanRules(tenantId);
  if (plan[feature]) return;
  const what = feature === 'allowSso' ? 'Single sign-on' : 'A custom domain';
  throw planLimitError(plan, `${what} isn't part of the ${plan.name} plan.`);
}

/** For route handlers: the request's tenant */
export const assertWithinLimitFor = (request: FastifyRequest, what: Limited, adding = 1) => assertWithinLimit(request.tenant.id, what, adding);
