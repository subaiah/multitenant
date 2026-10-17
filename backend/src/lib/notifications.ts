/**
 * Notifications: in-app (an inbox per user) and email.
 *
 * Raising. Most notifications come from audit events: when an entry whose
 * key is a notification type (kit/notification-types.ts, or the product's)
 * is recorded, an EVENT row goes into the outbox in the same transaction, so
 * it exists exactly when the entry does. notify() raises one directly.
 *
 * Fan-out. The EVENT is turned into notifications for its audience (users,
 * group members, or everyone with a permission), keeping only active users
 * and applying the organization's settings and each person's preferences
 * (decide()). In-app notifications are written straight away; each email
 * becomes an EMAIL row, sent separately and retried with backoff.
 *
 * Who does the work. The server that recorded the event processes it at once.
 * notification_work (control plane) lists the logs with work due, so the
 * periodic sweep (NOTIFICATION_POLL_MS) only visits those: retries, and work
 * a stopped server left behind. Rows are claimed before processing, so
 * several servers can run the sweep.
 */
import { config } from '../config/env.js';
import { appOriginForTenant } from './domains.js';
import { controlDb } from './prisma.js';
import { dbForTenant } from './tenant-db.js';
import { sendMail } from './mailer.js';
import { notificationEmail } from './email-templates.js';
import { PLATFORM_CHAIN, onAudit, onAuditInTransaction, type AuditActor, type AuditContent } from './audit.js';
import { KIT_NOTIFICATION_TYPES, type NotificationType, type NotifyEvent } from '../kit/notification-types.js';
import { product } from '../product/index.js';
import { getEnhancedUserPermissions } from '../utils/authorization.js';
import { permissionMatches } from '../utils/permissions.js';
import type { SessionOwner } from './auth-planes.js';

// ---------------------------------------------------------------------------
// Catalog and rules
// ---------------------------------------------------------------------------

export function notificationCatalog(): Record<string, NotificationType> {
  const own = product.notificationTypes ?? {};
  for (const key of Object.keys(own)) {
    if (key in KIT_NOTIFICATION_TYPES) throw new Error(`Product notification type "${key}" reuses a kit key`);
  }
  return { ...KIT_NOTIFICATION_TYPES, ...own };
}

export interface Channels {
  inApp: boolean;
  email: boolean;
}
export interface OrgSetting extends Channels {
  enabled: boolean;
  mandatory: boolean;
}

/**
 * Which channels a person gets a notification on. The organization decides
 * whether the type is on and which channels it may use; within that, the
 * person's preference (or the type's defaults). Mandatory types ignore the
 * preference.
 */
export function decide(type: NotificationType, setting: OrgSetting | null, preference: Channels | null): Channels {
  if (setting && !setting.enabled && !type.mandatory) return { inApp: false, email: false };
  const allowed = { inApp: setting?.inApp ?? true, email: setting?.email ?? true };
  const mandatory = Boolean(type.mandatory || setting?.mandatory);
  const wanted = mandatory ? type.defaults : (preference ?? type.defaults);
  return { inApp: allowed.inApp && wanted.inApp, email: allowed.email && wanted.email };
}

// ---------------------------------------------------------------------------
// Raising
// ---------------------------------------------------------------------------

interface EventPayload {
  type: string;
  event: NotifyEvent;
  /** notify(): extra recipients on top of the type's audience */
  recipients?: string[];
}

const eventOf = (entry: AuditContent): NotifyEvent => ({
  type: entry.event,
  occurredAt: entry.occurredAt,
  actor: { type: entry.actorType, id: entry.actorId, email: entry.actorEmail },
  resource: { type: entry.resourceType, id: entry.resourceId, label: entry.resourceLabel },
  changes: (entry.changes as NotifyEvent['changes']) ?? null,
  details: (entry.details as NotifyEvent['details']) ?? null,
  ip: entry.ip,
});

type Tx = {
  notificationOutbox: { create: (args: { data: { tenantId: string; kind: 'EVENT'; payload: object } }) => Promise<unknown> };
  platformNotificationOutbox: { create: (args: { data: { kind: 'EVENT'; payload: object } }) => Promise<unknown> };
};

function wanted(chain: string, key: string): boolean {
  const type = notificationCatalog()[key];
  return Boolean(type && (type.scope === 'platform') === (chain === PLATFORM_CHAIN));
}

// With the audit entry, in its transaction
onAuditInTransaction(async ({ tx, chain, entry }) => {
  if (!wanted(chain, entry.event)) return;
  const payload: EventPayload = { type: entry.event, event: eventOf(entry) };
  const t = tx as Tx;
  if (chain === PLATFORM_CHAIN) await t.platformNotificationOutbox.create({ data: { kind: 'EVENT', payload: payload as object } });
  else await t.notificationOutbox.create({ data: { tenantId: chain, kind: 'EVENT', payload: payload as object } });
});
// Once it's committed: get on with it
onAudit(({ chain, event }) => {
  if (wanted(chain, event)) scheduleWork(chain);
});

/**
 * Send a notification that isn't an audit event (or to extra people):
 * notify({ tenantId }, 'invoice.due', { resource, details, recipients: [userId] }).
 */
export async function notify(
  ctx: { tenantId?: string | null; actor?: AuditActor },
  type: string,
  input: { resource?: NotifyEvent['resource']; details?: Record<string, unknown>; recipients?: string[] } = {},
): Promise<void> {
  const def = notificationCatalog()[type];
  if (!def) throw new Error(`Unknown notification type "${type}"`);
  const chain = def.scope === 'platform' ? PLATFORM_CHAIN : ctx.tenantId;
  if (!chain) throw new Error(`Notification "${type}" is for a tenant's users, but there is no tenant`);
  const payload: EventPayload = {
    type,
    event: {
      type,
      occurredAt: new Date().toISOString(),
      actor: { type: ctx.actor?.type ?? 'SYSTEM', id: ctx.actor?.id ?? null, email: ctx.actor?.email ?? null },
      resource: input.resource ?? {},
      details: input.details ?? null,
    },
    recipients: input.recipients,
  };
  if (chain === PLATFORM_CHAIN) await controlDb.platformNotificationOutbox.create({ data: { kind: 'EVENT', payload: payload as object } });
  else await (await dbForTenant(chain)).notificationOutbox.create({ data: { tenantId: chain, kind: 'EVENT', payload: payload as object } });
  scheduleWork(chain);
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

let log: (msg: string, err?: unknown) => void = (msg, err) => console.error(msg, err);

/** Note the work in the control plane (for other servers and restarts), then do it here. */
function scheduleWork(chain: string) {
  void controlDb.notificationWork
    .upsert({ where: { chain }, create: { chain, dueAt: new Date() }, update: { dueAt: new Date() } })
    .catch((err) => log(`Notification work for ${chain} not recorded`, err))
    .finally(() => void processChain(chain));
}

const MAX_ATTEMPTS = 6;
/** 1 minute, 5 minutes, 30 minutes, 2 hours, 12 hours */
const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
const STALE_CLAIM_MS = 5 * 60_000;

interface OutboxRow {
  id: string;
  kind: 'EVENT' | 'EMAIL';
  payload: unknown;
  attempts: number;
}

/** The outbox of one log, as the operations the worker needs. */
function outboxOf(chain: string) {
  if (chain === PLATFORM_CHAIN) {
    const o = controlDb.platformNotificationOutbox;
    return {
      due: (now: Date) =>
        o.findMany({
          where: { OR: [{ status: 'PENDING', nextAttemptAt: { lte: now } }, { status: 'PROCESSING', claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }] },
          orderBy: { createdAt: 'asc' },
          take: 50,
        }),
      claim: (row: { id: string; attempts: number }, now: Date) =>
        o.updateMany({ where: { id: row.id, attempts: row.attempts }, data: { status: 'PROCESSING', claimedAt: now, attempts: { increment: 1 } } }),
      done: (id: string) => o.deleteMany({ where: { id } }),
      retry: (id: string, at: Date, error: string) => o.update({ where: { id }, data: { status: 'PENDING', nextAttemptAt: at, lastError: error, claimedAt: null } }),
      fail: (id: string, error: string) => o.update({ where: { id }, data: { status: 'FAILED', lastError: error, claimedAt: null } }),
      nextDue: () => o.findFirst({ where: { status: 'PENDING' }, orderBy: { nextAttemptAt: 'asc' }, select: { nextAttemptAt: true } }),
    };
  }
  const db = dbForTenant(chain);
  return {
    due: async (now: Date) =>
      (await db).notificationOutbox.findMany({
        where: { tenantId: chain, OR: [{ status: 'PENDING', nextAttemptAt: { lte: now } }, { status: 'PROCESSING', claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }] },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
    claim: async (row: { id: string; attempts: number }, now: Date) =>
      (await db).notificationOutbox.updateMany({ where: { id: row.id, tenantId: chain, attempts: row.attempts }, data: { status: 'PROCESSING', claimedAt: now, attempts: { increment: 1 } } }),
    done: async (id: string) => (await db).notificationOutbox.deleteMany({ where: { id, tenantId: chain } }),
    retry: async (id: string, at: Date, error: string) =>
      (await db).notificationOutbox.updateMany({ where: { id, tenantId: chain }, data: { status: 'PENDING', nextAttemptAt: at, lastError: error, claimedAt: null } }),
    fail: async (id: string, error: string) => (await db).notificationOutbox.updateMany({ where: { id, tenantId: chain }, data: { status: 'FAILED', lastError: error, claimedAt: null } }),
    nextDue: async () => (await db).notificationOutbox.findFirst({ where: { tenantId: chain, status: 'PENDING' }, orderBy: { nextAttemptAt: 'asc' }, select: { nextAttemptAt: true } }),
  };
}

const running = new Map<string, Promise<void>>();
const again = new Set<string>();

/** Do one log's due work. One run per log at a time in this server; a request during a run queues one more. */
export function processChain(chain: string): Promise<void> {
  const current = running.get(chain);
  if (current) {
    again.add(chain);
    return current;
  }
  const run = (async () => {
    try {
      do {
        again.delete(chain);
        await processOnce(chain);
      } while (again.has(chain));
    } catch (err) {
      // A tenant deleted since: nothing left to do for it
      const gone = chain !== PLATFORM_CHAIN && !(await controlDb.tenant.findUnique({ where: { id: chain }, select: { id: true } }).catch(() => ({ id: chain })));
      if (gone) await controlDb.notificationWork.deleteMany({ where: { chain } }).catch(() => {});
      else log(`Notifications for ${chain} failed`, err);
    } finally {
      running.delete(chain);
    }
  })();
  running.set(chain, run);
  return run;
}

async function processOnce(chain: string) {
  const startedAt = new Date();
  const outbox = outboxOf(chain);
  for (;;) {
    const rows = (await outbox.due(new Date())) as OutboxRow[];
    let claimed = 0;
    for (const row of rows) {
      if ((await outbox.claim(row, new Date())).count !== 1) continue; // another server has it
      claimed++;
      try {
        if (row.kind === 'EVENT') await fanOut(chain, row);
        else await sendMail(row.payload as Parameters<typeof sendMail>[0]);
        await outbox.done(row.id);
      } catch (err) {
        const message = (err as Error).message?.slice(0, 1000) ?? String(err);
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) await outbox.fail(row.id, message);
        else await outbox.retry(row.id, new Date(Date.now() + BACKOFF_MS[attempts - 1]), message);
      }
    }
    if (claimed === 0) break;
  }
  // When this log next has something to do (retries), or nothing
  const next = await outbox.nextDue();
  if (next) {
    await controlDb.notificationWork.upsert({ where: { chain }, create: { chain, dueAt: next.nextAttemptAt }, update: { dueAt: next.nextAttemptAt } });
  } else {
    // Only if nobody asked for more since this run started
    await controlDb.notificationWork.deleteMany({ where: { chain, dueAt: { lte: startedAt } } });
  }
}

interface Recipient {
  id: string;
  email: string;
}

/** The audience's active users, minus the actor if asked. */
async function recipients(chain: string, type: NotificationType, payload: EventPayload): Promise<Recipient[]> {
  const audience = type.audience(payload.event);
  const ids = new Set<string>([...(audience.userIds ?? []), ...(payload.recipients ?? [])].filter((x): x is string => typeof x === 'string' && x.length > 0));
  const groupIds = (audience.groupIds ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0);

  let users: { id: string; email: string; userType: string }[];
  if (chain === PLATFORM_CHAIN) {
    users = await controlDb.platformUser.findMany({
      where: { status: 'ACTIVE', ...(audience.permission ? {} : { id: { in: [...ids] } }) },
      select: { id: true, email: true, userType: true },
      take: 1000,
    });
  } else {
    const db = await dbForTenant(chain);
    if (groupIds.length) {
      for (const m of await db.groupMembership.findMany({ where: { tenantId: chain, groupId: { in: groupIds } }, select: { userId: true } })) ids.add(m.userId);
    }
    users = await db.user.findMany({
      where: { tenantId: chain, status: 'ACTIVE', ...(audience.permission ? {} : { id: { in: [...ids] } }) },
      select: { id: true, email: true, userType: true },
      take: 1000,
    });
  }

  let chosen = users.filter((u) => ids.has(u.id));
  if (audience.permission) {
    const holders: typeof users = [];
    for (const u of users) {
      if (ids.has(u.id)) continue;
      const { permissions } = await getEnhancedUserPermissions(u.id, chain === PLATFORM_CHAIN ? undefined : chain, u.userType);
      if (permissionMatches(new Set(permissions), audience.permission)) holders.push(u);
    }
    chosen = [...chosen, ...holders];
  }
  if (audience.excludeActor && payload.event.actor.id) chosen = chosen.filter((u) => u.id !== payload.event.actor.id);
  return chosen.map(({ id, email }) => ({ id, email }));
}

/** An EVENT row: notifications and emails for everyone it concerns, all or nothing. */
async function fanOut(chain: string, row: OutboxRow) {
  const payload = row.payload as EventPayload;
  const type = notificationCatalog()[payload.type];
  if (!type) return; // the type was removed since
  const tenant = chain === PLATFORM_CHAIN ? null : await controlDb.tenant.findUnique({ where: { id: chain }, select: { name: true } });
  payload.event.tenantName = tenant?.name;
  const people = await recipients(chain, type, payload);
  if (people.length === 0) return;

  const content = type.render(payload.event);
  const ids = people.map((p) => p.id);
  // Email links: the organization's own domain once verified (lib/domains.ts)
  const origin = await appOriginForTenant(chain === PLATFORM_CHAIN ? null : chain);
  const settingsLink = `${origin}${chain === PLATFORM_CHAIN ? '/platform/notifications' : '/notifications'}?tab=preferences`;
  const link = content.link ? `${origin}${content.link}` : null;

  if (chain === PLATFORM_CHAIN) {
    const prefs = await controlDb.platformNotificationPreference.findMany({ where: { userId: { in: ids }, type: payload.type } });
    const notes: { userId: string; type: string; title: string; body?: string; link?: string; data: object }[] = [];
    const mails: { kind: 'EMAIL'; payload: object }[] = [];
    for (const p of people) {
      const pref = prefs.find((x) => x.userId === p.id) ?? null;
      const ch = decide(type, null, pref);
      if (ch.inApp) notes.push({ userId: p.id, type: payload.type, title: content.title, body: content.body, link: content.link, data: { resource: payload.event.resource } });
      if (ch.email) mails.push({ kind: 'EMAIL', payload: { ...notificationEmail(p.email, { ...content, link, from: 'Platform', mandatory: Boolean(type.mandatory), settingsLink }) } });
    }
    await controlDb.$transaction([
      controlDb.platformNotification.createMany({ data: notes }),
      controlDb.platformNotificationOutbox.createMany({ data: mails }),
    ]);
  } else {
    const db = await dbForTenant(chain);
    const [setting, prefs] = await Promise.all([
      db.notificationSetting.findUnique({ where: { tenantId_type: { tenantId: chain, type: payload.type } } }),
      db.notificationPreference.findMany({ where: { tenantId: chain, userId: { in: ids }, type: payload.type } }),
    ]);
    const notes: { tenantId: string; userId: string; type: string; title: string; body?: string; link?: string; data: object }[] = [];
    const mails: { tenantId: string; kind: 'EMAIL'; payload: object }[] = [];
    for (const p of people) {
      const pref = prefs.find((x) => x.userId === p.id) ?? null;
      const ch = decide(type, setting, pref);
      if (ch.inApp) notes.push({ tenantId: chain, userId: p.id, type: payload.type, title: content.title, body: content.body, link: content.link, data: { resource: payload.event.resource } });
      if (ch.email) {
        mails.push({
          tenantId: chain,
          kind: 'EMAIL',
          payload: { ...notificationEmail(p.email, { ...content, link, from: tenant?.name ?? 'Your organization', mandatory: Boolean(type.mandatory || setting?.mandatory), settingsLink }) },
        });
      }
    }
    await db.$transaction([db.notification.createMany({ data: notes }), db.notificationOutbox.createMany({ data: mails })]);
  }
}

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------

/** Every log with work due now. */
export async function processDueWork(): Promise<void> {
  const due = await controlDb.notificationWork.findMany({ where: { dueAt: { lte: new Date() } }, orderBy: { dueAt: 'asc' }, take: 100 });
  for (const w of due) await processChain(w.chain);
}

/** Remove in-app notifications past the retention period. */
export async function pruneNotifications(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - config.notificationRetentionDays * 86_400_000);
  let removed = (await controlDb.platformNotification.deleteMany({ where: { createdAt: { lt: before } } })).count;
  const tenants = await controlDb.tenant.findMany({ where: { provisioningStatus: 'READY' }, select: { id: true } });
  for (const t of tenants) {
    try {
      removed += (await (await dbForTenant(t.id)).notification.deleteMany({ where: { tenantId: t.id, createdAt: { lt: before } } })).count;
    } catch (err) {
      log(`Pruning notifications of ${t.id} failed`, err);
    }
  }
  return removed;
}

const timers: NodeJS.Timeout[] = [];
export function startNotifications(logger: (msg: string, err?: unknown) => void) {
  log = logger;
  if (config.notificationPollMs) {
    const sweep = () => void processDueWork().catch((err) => log('Notification sweep failed', err));
    timers.push(setInterval(sweep, config.notificationPollMs));
    sweep();
  }
  if (config.notificationRetentionDays) {
    timers.push(setInterval(() => void pruneNotifications().catch((err) => log('Pruning notifications failed', err)), 86_400_000));
  }
  for (const t of timers) t.unref();
}
export function stopNotifications() {
  for (const t of timers.splice(0)) clearInterval(t);
}

// ---------------------------------------------------------------------------
// Inbox and preferences (for the API)
// ---------------------------------------------------------------------------

export interface InboxItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export async function listInbox(owner: SessionOwner, userId: string, opts: { unread?: boolean; before?: Date; limit: number }) {
  const where = { userId, ...(opts.unread && { readAt: null }), ...(opts.before && { createdAt: { lt: opts.before } }) };
  const select = { id: true, type: true, title: true, body: true, link: true, readAt: true, createdAt: true } as const;
  const take = Math.min(Math.max(opts.limit, 1), 100);
  const items: InboxItem[] =
    owner === 'platform'
      ? await controlDb.platformNotification.findMany({ where, orderBy: { createdAt: 'desc' }, take, select })
      : await (await dbForTenant(owner.tenantId)).notification.findMany({ where: { tenantId: owner.tenantId, ...where }, orderBy: { createdAt: 'desc' }, take, select });
  return items;
}

export async function unreadCount(owner: SessionOwner, userId: string): Promise<number> {
  return owner === 'platform'
    ? controlDb.platformNotification.count({ where: { userId, readAt: null } })
    : (await dbForTenant(owner.tenantId)).notification.count({ where: { tenantId: owner.tenantId, userId, readAt: null } });
}

/** Mark some (ids) or all of a user's notifications read. */
export async function markRead(owner: SessionOwner, userId: string, ids?: string[]): Promise<number> {
  const where = { userId, readAt: null, ...(ids && { id: { in: ids } }) };
  const data = { readAt: new Date() };
  return (owner === 'platform'
    ? await controlDb.platformNotification.updateMany({ where, data })
    : await (await dbForTenant(owner.tenantId)).notification.updateMany({ where: { tenantId: owner.tenantId, ...where }, data })).count;
}

export interface PreferenceView {
  type: string;
  label: string;
  description: string;
  category: string;
  mandatory: boolean;
  /** Channels the organization allows */
  allowed: Channels;
  /** What the person gets now */
  current: Channels;
  defaults: Channels;
}

/** The types a person can get, with what they get now. */
export async function preferencesFor(owner: SessionOwner, userId: string): Promise<PreferenceView[]> {
  const scope = owner === 'platform' ? 'platform' : 'tenant';
  // Types sent to "everyone with permission X" only matter to people who have it
  const user = owner === 'platform'
    ? await controlDb.platformUser.findUnique({ where: { id: userId }, select: { userType: true } })
    : await (await dbForTenant(owner.tenantId)).user.findFirst({ where: { id: userId, tenantId: owner.tenantId }, select: { userType: true } });
  const granted = new Set(user ? (await getEnhancedUserPermissions(userId, owner === 'platform' ? undefined : owner.tenantId, user.userType)).permissions : []);
  const probe: NotifyEvent = { type: '', occurredAt: new Date(0).toISOString(), actor: { type: 'SYSTEM' }, resource: {}, details: {} };
  const types = Object.entries(notificationCatalog()).filter(([, t]) => {
    if (t.scope !== scope) return false;
    const permission = t.audience(probe).permission;
    return !permission || permissionMatches(granted, permission);
  });
  const [settings, prefs] = owner === 'platform'
    ? [[], await controlDb.platformNotificationPreference.findMany({ where: { userId } })]
    : await (async () => {
        const db = await dbForTenant(owner.tenantId);
        return Promise.all([
          db.notificationSetting.findMany({ where: { tenantId: owner.tenantId } }),
          db.notificationPreference.findMany({ where: { tenantId: owner.tenantId, userId } }),
        ]);
      })();
  return types
    .map(([key, t]) => {
      const setting = (settings as OrgSetting[] & { type: string }[]).find((s) => (s as unknown as { type: string }).type === key) ?? null;
      const pref = prefs.find((p) => p.type === key) ?? null;
      return {
        type: key,
        label: t.label,
        description: t.description,
        category: t.category,
        mandatory: Boolean(t.mandatory || setting?.mandatory),
        allowed: { inApp: setting?.inApp ?? true, email: setting?.email ?? true },
        current: decide(t, setting, pref),
        defaults: t.defaults,
        enabled: setting ? setting.enabled || Boolean(t.mandatory) : true,
      };
    })
    .filter((v) => v.enabled)
    .map(({ enabled: _e, ...v }) => v);
}

export async function savePreferences(owner: SessionOwner, userId: string, changes: Record<string, Channels>): Promise<void> {
  const catalog = notificationCatalog();
  const scope = owner === 'platform' ? 'platform' : 'tenant';
  for (const [type, ch] of Object.entries(changes)) {
    if (catalog[type]?.scope !== scope) throw Object.assign(new Error(`Unknown notification type "${type}"`), { statusCode: 400 });
    const data = { inApp: Boolean(ch.inApp), email: Boolean(ch.email) };
    if (owner === 'platform') {
      await controlDb.platformNotificationPreference.upsert({ where: { userId_type: { userId, type } }, create: { userId, type, ...data }, update: data });
    } else {
      await (await dbForTenant(owner.tenantId)).notificationPreference.upsert({
        where: { tenantId_userId_type: { tenantId: owner.tenantId, userId, type } },
        create: { tenantId: owner.tenantId, userId, type, ...data },
        update: data,
      });
    }
  }
}

/** Wait for work already started in this process (before closing connections: scripts, tests). */
export async function notificationsSettled(): Promise<void> {
  // Scheduling records work first, so give just-scheduled runs a moment to start
  await new Promise((r) => setTimeout(r, 50));
  while (running.size) await Promise.allSettled([...running.values()]);
}
