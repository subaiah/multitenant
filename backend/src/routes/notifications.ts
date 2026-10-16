/**
 * Notifications (lib/notifications.ts).
 *
 *   /notifications          your own inbox and preferences (tenant and platform users)
 *   /notification-settings  the organization's rules and email delivery (notifications:manage)
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SessionOwner } from '../lib/auth-planes.js';
import { AppError } from '../middleware/error-handler.js';
import { AUTHENTICATED } from '../middleware/authorize.js';
import { audit, diff } from '../lib/audit.js';
import {
  listInbox, markRead, notificationCatalog, preferencesFor, processChain, savePreferences, unreadCount,
} from '../lib/notifications.js';

function ownerOf(request: FastifyRequest): SessionOwner {
  const { tenantId } = request.user;
  return tenantId && request.tenant ? { tenantId, tenantSlug: request.tenant.slug } : 'platform';
}

const channels = z.object({ inApp: z.boolean(), email: z.boolean() });

export const notificationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: AUTHENTICATED },
    schema: { tags: ['notifications'], summary: 'Your notifications, newest first (?unread=true, ?before=<createdAt>)' },
  }, async (request) => {
    const q = z.object({
      unread: z.enum(['true', 'false']).optional(),
      before: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }).parse(request.query);
    const owner = ownerOf(request);
    const data = await listInbox(owner, request.user.userId, { unread: q.unread === 'true', before: q.before, limit: q.limit + 1 });
    const page = data.slice(0, q.limit);
    return {
      data: page,
      nextBefore: data.length > q.limit ? page.at(-1)!.createdAt : null,
      unread: await unreadCount(owner, request.user.userId),
    };
  });

  fastify.get('/unread-count', {
    config: { permission: AUTHENTICATED },
    schema: { tags: ['notifications'], summary: 'How many unread (polled by the bell; send x-background-request: 1)' },
  }, async (request) => ({ count: await unreadCount(ownerOf(request), request.user.userId) }));

  fastify.post('/read', {
    config: { permission: AUTHENTICATED },
    schema: { tags: ['notifications'], summary: 'Mark notifications read ({ ids } or all)' },
  }, async (request) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(200).optional() }).parse(request.body ?? {});
    return { updated: await markRead(ownerOf(request), request.user.userId, ids) };
  });

  fastify.get('/preferences', {
    config: { permission: AUTHENTICATED },
    schema: { tags: ['notifications'], summary: 'What you can be notified about, and how' },
  }, async (request) => preferencesFor(ownerOf(request), request.user.userId));

  fastify.put('/preferences', {
    config: { permission: AUTHENTICATED },
    schema: { tags: ['notifications'], summary: 'Choose channels per notification type' },
  }, async (request) => {
    const { preferences } = z.object({ preferences: z.record(z.string(), channels) }).parse(request.body);
    try {
      await savePreferences(ownerOf(request), request.user.userId, preferences);
    } catch (err) {
      throw new AppError((err as Error).message, (err as { statusCode?: number }).statusCode ?? 500);
    }
    return preferencesFor(ownerOf(request), request.user.userId);
  });
};

const settingSchema = z.object({ enabled: z.boolean(), inApp: z.boolean(), email: z.boolean(), mandatory: z.boolean() });

export const notificationSettingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: 'notifications:manage' },
    schema: { tags: ['notifications'], summary: "The organization's notification rules" },
  }, async (request) => {
    const tenantId = request.tenant.id;
    const [settings, failed, pending] = await Promise.all([
      request.db.notificationSetting.findMany({ where: { tenantId } }),
      request.db.notificationOutbox.count({ where: { tenantId, kind: 'EMAIL', status: 'FAILED' } }),
      request.db.notificationOutbox.count({ where: { tenantId, status: { in: ['PENDING', 'PROCESSING'] } } }),
    ]);
    const types = Object.entries(notificationCatalog())
      .filter(([, t]) => t.scope === 'tenant')
      .map(([key, t]) => {
        const s = settings.find((x) => x.type === key);
        return {
          type: key,
          label: t.label,
          description: t.description,
          category: t.category,
          /** Built in as mandatory: can't be switched off */
          required: Boolean(t.mandatory),
          defaults: t.defaults,
          setting: s
            ? { enabled: s.enabled, inApp: s.inApp, email: s.email, mandatory: s.mandatory }
            : { enabled: true, inApp: true, email: true, mandatory: false },
        };
      });
    return { types, delivery: { failedEmails: failed, pending } };
  });

  fastify.put('/', {
    config: { permission: 'notifications:manage' },
    schema: { tags: ['notifications'], summary: 'Change notification rules' },
  }, async (request) => {
    const { settings } = z.object({ settings: z.record(z.string(), settingSchema) }).parse(request.body);
    const tenantId = request.tenant.id;
    const catalog = notificationCatalog();
    for (const [type, s] of Object.entries(settings)) {
      const def = catalog[type];
      if (def?.scope !== 'tenant') throw new AppError(`Unknown notification type "${type}"`, 400);
      if (def.mandatory && !s.enabled) throw new AppError(`"${def.label}" is a security notice and can't be turned off`, 400);
      const before = await request.db.notificationSetting.findUnique({ where: { tenantId_type: { tenantId, type } } });
      await request.db.notificationSetting.upsert({ where: { tenantId_type: { tenantId, type } }, create: { tenantId, type, ...s }, update: s });
      const changes = diff(before ?? { enabled: true, inApp: true, email: true, mandatory: false }, s);
      if (Object.keys(changes).length) {
        await audit(request, 'notification_settings.updated', { resource: { type: 'notification_type', id: type, label: def.label }, changes });
      }
    }
    return { saved: Object.keys(settings).length };
  });

  fastify.get('/failed-emails', {
    config: { permission: 'notifications:manage' },
    schema: { tags: ['notifications'], summary: 'Emails that could not be sent' },
  }, async (request) => {
    const rows = await request.db.notificationOutbox.findMany({
      where: { tenantId: request.tenant.id, kind: 'EMAIL', status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => {
      const p = r.payload as { to?: string; subject?: string };
      return { id: r.id, to: p.to, subject: p.subject, attempts: r.attempts, lastError: r.lastError, createdAt: r.createdAt };
    });
  });

  fastify.post('/failed-emails/retry', {
    config: { permission: 'notifications:manage' },
    schema: { tags: ['notifications'], summary: 'Try failed emails again' },
  }, async (request) => {
    const { count } = await request.db.notificationOutbox.updateMany({
      where: { tenantId: request.tenant.id, kind: 'EMAIL', status: 'FAILED' },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });
    void processChain(request.tenant.id);
    return { retried: count };
  });
};
