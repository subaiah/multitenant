/**
 * Support sessions (lib/support.ts).
 *
 *   platform /support-sessions   request, approve or reject, end, list
 *   tenant   /support-access     the organization's view: who had access, and ending it
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { controlDb } from '../lib/prisma.js';
import { config } from '../config/env.js';
import { AppError } from '../middleware/error-handler.js';
import { AUTHENTICATED, hasPermission } from '../middleware/authorize.js';
import { logActivity } from '../lib/activity.js';
import { audit, type AuditActor } from '../lib/audit.js';
import { PERMISSIONS, PERMISSION_INFO, isReadPermission, isTenantGrantable } from '../utils/permissions.js';
import { expireSupportSessions, supportMaxMinutes } from '../lib/support.js';

const requestSchema = z.object({
  tenantId: z.string().uuid(),
  reason: z.string().trim().min(10).max(1000),
  access: z.enum(['READ_ONLY', 'READ_WRITE']).default('READ_ONLY'),
  /** READ_WRITE: which tenant permissions (reading is always included) */
  permissions: z.array(z.string()).max(100).default([]),
  durationMinutes: z.number().int().min(5),
});

const include = {
  platformUser: { select: { id: true, email: true, name: true } },
  approver: { select: { id: true, email: true, name: true } },
  tenant: { select: { id: true, name: true, slug: true } },
} as const;

type SessionWithPeople = Awaited<ReturnType<typeof findSession>>;
const findSession = (id: string) => controlDb.supportSession.findUnique({ where: { id }, include });

const requesterActor = (s: NonNullable<SessionWithPeople>): AuditActor => ({ type: 'PLATFORM', id: s.platformUser.id, email: s.platformUser.email });

/** Starting: the tenant's log and its admins hear about it (as the support person's session). */
async function started(request: FastifyRequest, s: NonNullable<SessionWithPeople>) {
  const details = { access: s.access, permissions: s.permissions, reason: s.reason, validTo: s.validTo, approvedBy: s.approver?.email ?? null };
  await audit(request, 'support.session_started', { resource: { type: 'support_session', id: s.id }, details }, { actor: requesterActor(s), tenantId: s.tenantId });
  await logActivity({ tenantId: s.tenantId, userId: s.platformUserId, action: `started a ${s.access === 'READ_ONLY' ? 'read-only' : 'read-write'} support session`, target: s.platformUser.email, type: 'AUTH' });
}

async function end(request: FastifyRequest, s: NonNullable<SessionWithPeople>, by: 'platform' | 'tenant') {
  const wasActive = s.status === 'ACTIVE';
  await controlDb.supportSession.update({ where: { id: s.id }, data: { status: 'REVOKED', revokedAt: new Date() } });
  await audit(request, 'support_session.revoked', { tenantId: s.tenantId, resource: { type: 'support_session', id: s.id, label: s.tenant.name }, details: { requester: s.platformUser.email, endedBy: by } });
  if (wasActive) {
    await audit(request, 'support.session_ended', { resource: { type: 'support_session', id: s.id }, details: { staff: s.platformUser.email, endedBy: by } }, by === 'tenant' ? undefined : { tenantId: s.tenantId });
  }
}

export const supportSessionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: ['support:request', 'support:manage'] },
    schema: { tags: ['support-sessions'], summary: 'Support sessions (everyone’s with support:manage, otherwise your own)' },
  }, async (request) => {
    await expireSupportSessions();
    const q = z.object({
      status: z.enum(['PENDING', 'ACTIVE', 'REJECTED', 'REVOKED', 'EXPIRED']).optional(),
      tenantId: z.string().uuid().optional(),
    }).parse(request.query);
    const all = await hasPermission(request, 'support:manage');
    const sessions = await controlDb.supportSession.findMany({
      where: { ...(q.status && { status: q.status }), ...(q.tenantId && { tenantId: q.tenantId }), ...(!all && { platformUserId: request.user.userId }) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include,
    });
    return {
      sessions,
      canApprove: all,
      selfApproval: config.supportSelfApproval,
      maxMinutes: supportMaxMinutes(),
      /** What a read-write session can be approved for (reading is always included) */
      writePermissions: PERMISSIONS.filter((p) => isTenantGrantable(p) && !isReadPermission(p)).map((name) => ({ name, description: PERMISSION_INFO[name] ?? name })),
    };
  });

  fastify.post('/request', {
    config: { permission: ['support:request', 'support:manage'] },
    schema: { tags: ['support-sessions'], summary: 'Ask for access to a tenant' },
  }, async (request, reply) => {
    const data = requestSchema.parse(request.body);
    const me = request.user.userId;
    if (data.durationMinutes > supportMaxMinutes()) throw new AppError(`A support session can last at most ${config.supportMaxHours} hours`, 400);
    const tenant = await controlDb.tenant.findUnique({ where: { id: data.tenantId }, select: { id: true, name: true, provisioningStatus: true } });
    if (!tenant) throw new AppError('Tenant not found', 404);
    if (tenant.provisioningStatus !== 'READY') throw new AppError('This tenant is not ready yet', 409);
    if (data.access === 'READ_WRITE') {
      if (data.permissions.length === 0) throw new AppError('Say which permissions read-write access needs', 400);
      const bad = data.permissions.filter((p) => !isTenantGrantable(p));
      if (bad.length) throw new AppError(`Not tenant permissions: ${bad.join(', ')}`, 400);
    }
    const open = await controlDb.supportSession.findFirst({
      where: { platformUserId: me, tenantId: data.tenantId, OR: [{ status: 'PENDING' }, { status: 'ACTIVE', validTo: { gt: new Date() } }] },
    });
    if (open) throw new AppError(`You already have a ${open.status === 'PENDING' ? 'pending' : 'active'} support session for ${tenant.name}`, 409);

    const created = await controlDb.supportSession.create({
      data: {
        platformUserId: me,
        tenantId: data.tenantId,
        reason: data.reason,
        access: data.access,
        permissions: data.access === 'READ_WRITE' ? data.permissions : [],
        durationMinutes: data.durationMinutes,
        status: 'PENDING',
      },
    });
    await audit(request, 'support_session.requested', {
      tenantId: data.tenantId,
      resource: { type: 'support_session', id: created.id, label: tenant.name },
      details: { reason: data.reason, access: data.access, permissions: created.permissions, durationMinutes: data.durationMinutes },
    });

    // One-person teams: someone who may approve can start their own, if allowed
    if (config.supportSelfApproval && (await hasPermission(request, 'support:manage'))) {
      const now = new Date();
      await controlDb.supportSession.update({
        where: { id: created.id },
        data: { status: 'ACTIVE', approvedBy: me, approvedAt: now, validFrom: now, validTo: new Date(now.getTime() + data.durationMinutes * 60_000), decisionNote: 'Self-approved' },
      });
      const s = (await findSession(created.id))!;
      await audit(request, 'support_session.approved', { tenantId: s.tenantId, resource: { type: 'support_session', id: s.id, label: tenant.name }, details: { selfApproved: true, requesterId: me, validTo: s.validTo } });
      await started(request, s);
      return reply.status(201).send(s);
    }
    return reply.status(201).send(await findSession(created.id));
  });

  fastify.post('/:id/decide', {
    config: { permission: 'support:manage' },
    schema: { tags: ['support-sessions'], summary: 'Approve (which starts it) or reject a request' },
  }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { approved, note } = z.object({ approved: z.boolean(), note: z.string().max(1000).optional() }).parse(request.body);
    const s = await findSession(id);
    if (!s) throw new AppError('Support session not found', 404);
    if (s.status !== 'PENDING') throw new AppError('This request has already been decided', 409);
    if (s.platformUserId === request.user.userId && !config.supportSelfApproval) {
      throw new AppError('Someone else has to approve your own support session', 403);
    }
    const now = new Date();
    const claimed = await controlDb.supportSession.updateMany({
      where: { id, status: 'PENDING' },
      data: approved
        ? { status: 'ACTIVE', approvedBy: request.user.userId, approvedAt: now, validFrom: now, validTo: new Date(now.getTime() + s.durationMinutes * 60_000), decisionNote: note ?? null }
        : { status: 'REJECTED', approvedBy: request.user.userId, approvedAt: now, decisionNote: note ?? null },
    });
    if (claimed.count !== 1) throw new AppError('This request has already been decided', 409);
    const after = (await findSession(id))!;
    await audit(request, approved ? 'support_session.approved' : 'support_session.rejected', {
      tenantId: s.tenantId,
      resource: { type: 'support_session', id, label: s.tenant.name },
      details: { requesterId: s.platformUserId, requester: s.platformUser.email, note: note ?? null, validTo: after.validTo },
    });
    if (approved) await started(request, after);
    return after;
  });

  fastify.post('/:id/revoke', {
    config: { permission: ['support:request', 'support:manage'] },
    schema: { tags: ['support-sessions'], summary: 'End a session (or withdraw a request): your own, or anyone’s with support:manage' },
  }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const s = await findSession(id);
    if (!s) throw new AppError('Support session not found', 404);
    if (s.platformUserId !== request.user.userId && !(await hasPermission(request, 'support:manage'))) {
      throw new AppError('You can only end your own support sessions', 403);
    }
    if (s.status !== 'ACTIVE' && s.status !== 'PENDING') throw new AppError('This support session has already ended', 409);
    await end(request, s, 'platform');
    return findSession(id);
  });

  fastify.get('/mine', {
    config: { permission: AUTHENTICATED },
    schema: { tags: ['support-sessions'], summary: 'Your sessions that are pending or active' },
  }, async (request) => {
    await expireSupportSessions();
    return controlDb.supportSession.findMany({
      where: { platformUserId: request.user.userId, status: { in: ['PENDING', 'ACTIVE'] } },
      orderBy: { createdAt: 'desc' },
      include,
    });
  });
};

/** The tenant's side: which platform staff had access, and ending a session. */
export const tenantSupportAccessRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', {
    config: { permission: 'audit:read' },
    schema: { tags: ['support-sessions'], summary: 'Platform support sessions for this organization' },
  }, async (request) => {
    await expireSupportSessions();
    const sessions = await controlDb.supportSession.findMany({
      where: { tenantId: request.tenant.id, status: { in: ['ACTIVE', 'REVOKED', 'EXPIRED'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { platformUser: { select: { email: true, name: true } }, approver: { select: { email: true } } },
    });
    return sessions.map((s) => ({
      id: s.id,
      staff: s.platformUser.name || s.platformUser.email,
      staffEmail: s.platformUser.email,
      approvedBy: s.approver?.email ?? null,
      reason: s.reason,
      access: s.access,
      permissions: s.permissions,
      status: s.status,
      validFrom: s.validFrom,
      validTo: s.validTo,
      revokedAt: s.revokedAt,
    }));
  });

  fastify.post('/:id/end', {
    config: { permission: 'settings:manage' },
    schema: { tags: ['support-sessions'], summary: 'End a platform support session in this organization now' },
  }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const s = await findSession(id);
    if (!s || s.tenantId !== request.tenant.id) throw new AppError('Support session not found', 404);
    if (s.status !== 'ACTIVE') throw new AppError('This support session has already ended', 409);
    await end(request, s, 'tenant');
    return { ended: true };
  });
};
