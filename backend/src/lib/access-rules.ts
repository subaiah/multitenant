/**
 * Access rules: conditions on top of roles (attribute-based access control).
 *
 * Roles decide what someone may do at all; access rules can refuse it in
 * some circumstances (outside working hours, from outside the office
 * network, without two-factor, for contractors), and make exceptions to
 * such refusals. A rule never grants what someone's roles don't.
 *
 * A rule: effect (ALLOW or DENY), priority, and a body:
 *   actions   permissions it covers, wildcards allowed ("billing:*", "*")
 *   subjects  who it's about (user types, role names, group ids, user ids;
 *             any listed kind must match; none listed: everyone)
 *   when      conditions on attributes, all of which must hold
 *   timezone  for the time attributes (default UTC)
 *
 * Deciding a request, after its roles allowed it:
 *   1. The platform's rules (Global policies), highest priority first. The
 *      first that matches decides: DENY refuses; ALLOW lets the request past
 *      the platform's lower-priority rules.
 *   2. Then the organization's own rules, the same way.
 *   No matching rule: allowed. So ALLOW rules are exceptions to DENY rules
 *   below them at the same level, and an organization can't make an
 *   exception to the platform's refusals.
 *
 * An organization's rule with bindings applies only to them: the whole
 * organization (TENANT), people in an organization or unit (ORGANIZATION,
 * ORG_UNIT), or one resource (RESOURCE: the request's :id). No bindings:
 * the whole organization.
 */
import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { controlDb } from './prisma.js';
import type { TenantDb } from './tenant-db.js';
import { permissionMatches } from '../utils/permissions.js';

// ---------------------------------------------------------------------------
// The rule language
// ---------------------------------------------------------------------------

export const ATTRIBUTES = {
  'user.id': 'The person (or API key)',
  'user.type': 'User type, e.g. TENANT_ADMIN; API_KEY for API keys',
  'user.email': 'Email address',
  'user.emailDomain': 'Email domain, e.g. example.com',
  'user.groups': 'Ids of the groups they belong to (a list)',
  'user.roles': 'Names of the roles they hold (a list)',
  'user.units': 'Ids of the organizations and units they belong to (a list)',
  'context.ip': 'Address the request came from',
  'context.method': 'GET, POST, PATCH, PUT or DELETE',
  'context.path': 'The address asked for, e.g. /users/123',
  'context.apiKey': 'true for API key requests',
  'context.hour': 'Hour of the day, 0–23, in the rule\'s time zone',
  'context.weekday': 'MON … SUN, in the rule\'s time zone',
  'context.date': 'YYYY-MM-DD, in the rule\'s time zone',
  'resource.type': 'What kind of thing: the permission\'s first part, e.g. users',
  'resource.id': 'The id in the address, when there is one',
} as const;
export type Attribute = keyof typeof ATTRIBUTES;

export const OPERATORS = ['eq', 'neq', 'in', 'notIn', 'contains', 'notContains', 'gte', 'lte', 'between', 'inCidr', 'notInCidr', 'startsWith', 'endsWith', 'exists', 'notExists'] as const;
export type Operator = (typeof OPERATORS)[number];

const conditionSchema = z.object({
  attribute: z.enum(Object.keys(ATTRIBUTES) as [Attribute, ...Attribute[]]),
  op: z.enum(OPERATORS),
  value: z.unknown().optional(),
}).superRefine((c, ctx) => {
  const v = c.value;
  const bad = (message: string) => ctx.addIssue({ code: 'custom', path: ['value'], message: `${c.attribute} ${c.op}: ${message}` });
  if (c.op === 'exists' || c.op === 'notExists') return;
  if (v === undefined) return bad('needs a value');
  if ((c.op === 'in' || c.op === 'notIn') && !Array.isArray(v)) return bad('needs a list');
  if (c.op === 'between' && !(Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number'))) return bad('needs two numbers');
  if ((c.op === 'gte' || c.op === 'lte') && typeof v !== 'number') return bad('needs a number');
  if (c.op === 'inCidr' || c.op === 'notInCidr') {
    const list = Array.isArray(v) ? v : [v];
    try {
      cidrList(list as string[]);
    } catch (err) {
      return bad((err as Error).message);
    }
  }
});
export type Condition = z.infer<typeof conditionSchema>;

const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const ruleBodySchema = z.object({
  actions: z.array(z.string().trim().min(1).max(100)).min(1, 'A rule covers at least one permission').max(50),
  subjects: z.object({
    userTypes: z.array(z.string()).max(20).optional(),
    roles: z.array(z.string()).max(50).optional(),
    groups: z.array(z.string().uuid()).max(50).optional(),
    users: z.array(z.string()).max(100).optional(),
  }).optional(),
  when: z.array(conditionSchema).max(20).optional(),
  timezone: z.string().refine(validTimeZone, 'Not a time zone, e.g. Asia/Kolkata').optional(),
});
export type RuleBody = z.infer<typeof ruleBodySchema>;

export interface Rule {
  id: string;
  name: string;
  effect: 'ALLOW' | 'DENY';
  priority: number;
  level: 'platform' | 'organization';
  body: RuleBody | null;
  bindings?: { scopeType: string; scopeId: string }[];
}

/** A stored rule's body; null if it isn't one (rules saved before rules were enforced): such a rule never matches */
export function bodyOf(conditions: unknown): RuleBody | null {
  const parsed = ruleBodySchema.safeParse(conditions);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Evaluating
// ---------------------------------------------------------------------------

/** What a rule can ask about a request; the costly parts are looked up only if a rule asks */
export interface Subject {
  permissions: string[];
  user: { id: string; type: string };
  email: () => Promise<string | null>;
  apiKey: boolean;
  ip: string;
  method: string;
  path: string;
  resourceId: string | null;
  now: Date;
  groups: () => Promise<string[]>;
  roles: () => Promise<string[]>;
  units: () => Promise<string[]>;
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function timeIn(now: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { hour: Number(parts.hour), weekday: WEEKDAYS[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)], date: `${parts.year}-${parts.month}-${parts.day}` };
}

async function attributeOf(s: Subject, attribute: Attribute, timeZone: string): Promise<unknown> {
  switch (attribute) {
    case 'user.id': return s.user.id;
    case 'user.type': return s.user.type;
    case 'user.email': return s.email();
    case 'user.emailDomain': return (await s.email())?.split('@')[1]?.toLowerCase() ?? null;
    case 'user.groups': return s.groups();
    case 'user.roles': return s.roles();
    case 'user.units': return s.units();
    case 'context.ip': return s.ip;
    case 'context.method': return s.method;
    case 'context.path': return s.path;
    case 'context.apiKey': return s.apiKey;
    case 'context.hour': return timeIn(s.now, timeZone).hour;
    case 'context.weekday': return timeIn(s.now, timeZone).weekday;
    case 'context.date': return timeIn(s.now, timeZone).date;
    case 'resource.type': return s.permissions[0]?.split(':')[0] ?? null;
    case 'resource.id': return s.resourceId;
  }
}

function cidrList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const raw of entries) {
    const [address, bits] = String(raw).trim().split('/');
    const family = isIP(address);
    if (!family) throw new Error(`"${raw}" is not an address or CIDR range`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(bits), type);
  }
  return list;
}

function inCidr(ip: unknown, value: unknown): boolean {
  if (typeof ip !== 'string' || !ip) return false;
  const list = cidrList((Array.isArray(value) ? value : [value]) as string[]);
  const v4 = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : null;
  return v4 ? list.check(v4, 'ipv4') : list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

const same = (a: unknown, b: unknown) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b);

export function holds(op: Operator, actual: unknown, value: unknown): boolean {
  switch (op) {
    case 'exists': return actual !== null && actual !== undefined && !(Array.isArray(actual) && actual.length === 0);
    case 'notExists': return !holds('exists', actual, value);
    case 'eq': return same(actual, value);
    case 'neq': return !same(actual, value);
    case 'in': return Array.isArray(value) && value.some((v) => same(actual, v));
    case 'notIn': return Array.isArray(value) && !value.some((v) => same(actual, v));
    case 'contains': return Array.isArray(actual) ? actual.some((a) => same(a, value)) : typeof actual === 'string' && typeof value === 'string' && actual.toLowerCase().includes(value.toLowerCase());
    case 'notContains': return !holds('contains', actual, value);
    case 'gte': return typeof actual === 'number' && actual >= (value as number);
    case 'lte': return typeof actual === 'number' && actual <= (value as number);
    case 'between': {
      const [lo, hi] = value as [number, number];
      if (typeof actual !== 'number') return false;
      // A range across midnight (22 to 6) for hours
      return lo <= hi ? actual >= lo && actual <= hi : actual >= lo || actual <= hi;
    }
    case 'inCidr': return inCidr(actual, value);
    case 'notInCidr': return typeof actual === 'string' && !inCidr(actual, value);
    case 'startsWith': return typeof actual === 'string' && typeof value === 'string' && actual.toLowerCase().startsWith(value.toLowerCase());
    case 'endsWith': return typeof actual === 'string' && typeof value === 'string' && actual.toLowerCase().endsWith(value.toLowerCase());
  }
}

export interface Step {
  ruleId: string;
  name: string;
  level: Rule['level'];
  effect: Rule['effect'];
  /** Why it did or didn't match */
  matched: boolean;
  reason: string;
}

async function matches(rule: Rule, s: Subject): Promise<{ matched: boolean; reason: string }> {
  const body = rule.body;
  if (!body) return { matched: false, reason: 'Not a rule the platform can read (saved in an older form): never applies' };
  if (!s.permissions.some((p) => permissionMatches(body.actions, p))) return { matched: false, reason: `Not about ${s.permissions.join(' or ')}` };
  if (rule.bindings?.length) {
    const units = rule.bindings.some((b) => b.scopeType === 'ORGANIZATION' || b.scopeType === 'ORG_UNIT') ? await s.units() : [];
    const bound = rule.bindings.some((b) =>
      b.scopeType === 'TENANT' || ((b.scopeType === 'ORGANIZATION' || b.scopeType === 'ORG_UNIT') && units.includes(b.scopeId)) || (b.scopeType === 'RESOURCE' && b.scopeId === s.resourceId));
    if (!bound) return { matched: false, reason: 'Outside where it applies (its bindings)' };
  }
  const who = body.subjects;
  if (who) {
    if (who.userTypes?.length && !who.userTypes.includes(s.user.type)) return { matched: false, reason: `Not for ${s.user.type}` };
    if (who.users?.length && !who.users.includes(s.user.id)) return { matched: false, reason: 'Not about this person' };
    if (who.roles?.length) {
      const roles = (await s.roles()).map((r) => r.toLowerCase());
      if (!who.roles.some((r) => roles.includes(r.toLowerCase()))) return { matched: false, reason: 'They hold none of its roles' };
    }
    if (who.groups?.length) {
      const groups = await s.groups();
      if (!who.groups.some((g) => groups.includes(g))) return { matched: false, reason: "They're in none of its groups" };
    }
  }
  const tz = body.timezone ?? 'UTC';
  for (const c of body.when ?? []) {
    const actual = await attributeOf(s, c.attribute, tz);
    if (!holds(c.op, actual, c.value)) return { matched: false, reason: `${c.attribute} ${c.op} ${JSON.stringify(c.value ?? '')} doesn't hold (it's ${JSON.stringify(actual)})` };
  }
  return { matched: true, reason: 'Every condition holds' };
}

export interface Decision {
  allowed: boolean;
  /** The rule that refused, when one did */
  deniedBy: Pick<Rule, 'id' | 'name' | 'level'> | null;
  steps: Step[];
}

/** Decide a request its roles allowed: the platform's rules, then the organization's (see the top of this file) */
export async function decide(platform: Rule[], organization: Rule[], s: Subject): Promise<Decision> {
  const steps: Step[] = [];
  for (const level of [platform, organization]) {
    const ordered = [...level].sort((a, b) => b.priority - a.priority);
    for (const rule of ordered) {
      const m = await matches(rule, s);
      steps.push({ ruleId: rule.id, name: rule.name, level: rule.level, effect: rule.effect, ...m });
      if (!m.matched) continue;
      if (rule.effect === 'DENY') return { allowed: false, deniedBy: { id: rule.id, name: rule.name, level: rule.level }, steps };
      break; // ALLOW: past this level's lower-priority rules
    }
  }
  return { allowed: true, deniedBy: null, steps };
}

// ---------------------------------------------------------------------------
// Loading (kept half a minute; a change applies at once on its server)
// ---------------------------------------------------------------------------

const CACHE_MS = 30_000;
let platformCache: { at: number; rules: Rule[] } | null = null;
const tenantCache = new Map<string, { at: number; rules: Rule[] }>();

export async function platformRules(): Promise<Rule[]> {
  if (platformCache && Date.now() - platformCache.at < CACHE_MS) return platformCache.rules;
  const rows = await controlDb.platformAccessRule.findMany({ where: { enabled: true } });
  const rules = rows.map((r): Rule => ({ id: r.id, name: r.name, effect: r.effect as Rule['effect'], priority: r.priority, level: 'platform', body: bodyOf(r.conditions) }));
  platformCache = { at: Date.now(), rules };
  return rules;
}

export async function organizationRules(tenantId: string, db: TenantDb): Promise<Rule[]> {
  const hit = tenantCache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rules;
  const rows = await db.accessPolicy.findMany({ where: { tenantId, enabled: true }, include: { bindings: { select: { scopeType: true, scopeId: true } } } });
  const rules = rows.map((r): Rule => ({
    id: r.id, name: r.name, effect: r.effect as Rule['effect'], priority: r.priority, level: 'organization', body: bodyOf(r.conditions), bindings: r.bindings,
  }));
  tenantCache.set(tenantId, { at: Date.now(), rules });
  return rules;
}

export function forgetPlatformRules() {
  platformCache = null;
}
export function forgetOrganizationRules(tenantId: string) {
  tenantCache.delete(tenantId);
}

/** The attributes of someone in an organization, the costly ones looked up once, when a rule asks */
export function subjectFor(
  db: TenantDb,
  tenantId: string,
  who: { userId: string; userType: string; email?: string | null },
  request: { ip: string; method: string; path: string; apiKey: boolean; resourceId: string | null },
  permissions: string[],
  now = new Date(),
): Subject {
  const once = <T>(load: () => Promise<T>) => {
    let p: Promise<T> | null = null;
    return () => (p ??= load());
  };
  const memberships = once<{ groupId: string }[]>(() => db.groupMembership.findMany({
    where: { tenantId, userId: who.userId, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    select: { groupId: true },
  }));
  const subject: Subject = {
    permissions,
    user: { id: who.userId, type: who.userType },
    email: once<string | null>(async () => who.email ?? (await db.user.findFirst({ where: { id: who.userId, tenantId }, select: { email: true } }))?.email ?? null),
    apiKey: request.apiKey,
    ip: request.ip,
    method: request.method,
    path: request.path,
    resourceId: request.resourceId,
    now,
    groups: async () => (await memberships()).map((m) => m.groupId),
    roles: once<string[]>(async () => {
      const groupIds = (await memberships()).map((m) => m.groupId);
      const rows: { role: { name: string } }[] = await db.roleAssignment.findMany({
        where: { tenantId, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }], AND: [{ OR: [{ userId: who.userId }, { groupId: { in: groupIds } }] }] },
        select: { role: { select: { name: true } } },
      });
      return [...new Set(rows.map((r: { role: { name: string } }) => r.role.name))];
    }),
    units: once<string[]>(async () => {
      const rows = await db.orgMembership.findMany({ where: { tenantId, userId: who.userId }, select: { organizationId: true, orgUnitId: true } });
      return rows.flatMap((r: { organizationId: string | null; orgUnitId: string | null }) => [r.organizationId, r.orgUnitId]).filter((x): x is string => !!x);
    }),
  };
  return subject;
}

/**
 * For the permission check (middleware/authorize.ts): may this request,
 * which the caller's roles allow, go ahead under the access rules? Only
 * people and API keys of organizations; platform staff aren't subject to them.
 */
export async function accessRulesDecide(request: FastifyRequest, permissions: string[]): Promise<Decision | null> {
  const tenantId = (request as { tenant?: { id?: string } }).tenant?.id;
  const user = request.user as { userId?: string; userType?: string } | undefined;
  if (!tenantId || !user?.userId || !user.userType || user.userType.startsWith('PLATFORM_')) return null;
  const db = (request as { db?: TenantDb }).db;
  if (!db) return null;
  const [platform, organization] = await Promise.all([platformRules(), organizationRules(tenantId, db)]);
  if (!platform.length && !organization.length) return null;
  const params = (request.params ?? {}) as Record<string, unknown>;
  const subject = subjectFor(db, tenantId, { userId: user.userId, userType: request.apiKey ? 'API_KEY' : user.userType }, {
    ip: request.ip,
    method: request.method,
    path: request.url.split('?')[0],
    apiKey: Boolean(request.apiKey),
    resourceId: typeof params.id === 'string' ? params.id : null,
  }, permissions);
  return decide(platform, organization, subject);
}
