import { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { classifyDatabaseError } from '../lib/db-errors.js';
import { controlDb } from '../lib/prisma.js';

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;
  /** Machine-readable reason for clients (e.g. SESSION_IDLE), sent as `code` */
  code?: string;

  constructor(message: string, statusCode: number = 500, isOperational: boolean = true, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = async (
  error: FastifyError | ZodError | AppError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) => {
  // Zod validation errors
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: 'Validation Error',
      message: 'Invalid request data',
      details: error.issues.map((err) => ({
        field: err.path.join('.'),
        message: err.message,
      })),
    });
  }

  // Custom application errors
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: error.name,
      message: error.message,
      ...(error.code && { code: error.code }),
    });
  }

  // Fastify validation errors
  if ('validation' in error && error.validation) {
    return reply.status(400).send({
      error: 'Validation Error',
      message: 'Invalid request data',
      details: error.validation,
    });
  }

  // Tenant database unreachable, or a privilege / row-level security refusal
  const dbKind = classifyDatabaseError(error);
  if (dbKind === 'unavailable') {
    // Name the organization, also when this happened before the tenant was resolved (session check)
    const tenantId = request.tenant?.id ?? (request.user as { tenantId?: string } | undefined)?.tenantId;
    const name =
      request.tenant?.name ??
      (tenantId ? (await controlDb.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }).catch(() => null))?.name : undefined);
    request.log.error({ err: error, tenantId }, 'Database unavailable');
    return reply.status(503).send({
      error: 'Service Unavailable',
      message: name ? `${name}'s data is temporarily unavailable. Try again shortly.` : 'The database is temporarily unavailable. Try again shortly.',
    });
  }
  if (dbKind === 'read-only') {
    request.log.warn({ securityEvent: 'support-read-only', tenantId: request.tenant?.id, userId: request.user?.userId, route: request.routeOptions?.url }, 'Write refused in a read-only support session');
    return reply.status(403).send({ error: 'Forbidden', code: 'SUPPORT_READ_ONLY', message: 'This support session is read-only, so changes are not allowed.' });
  }
  if (dbKind === 'denied') {
    request.log.warn(
      { securityEvent: 'tenant-isolation', tenantId: request.tenant?.id, userId: request.user?.userId, route: request.routeOptions?.url, method: request.method, err: error },
      'Database refused access outside the tenant',
    );
    return reply.status(403).send({ error: 'Forbidden', message: "This request touches data outside your organization, so it isn't allowed." });
  }

  // Prisma errors
  if (error.name === 'PrismaClientKnownRequestError') {
    const prismaError = error as any;
    
    // Unique constraint violation
    if (prismaError.code === 'P2002') {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Resource already exists',
        details: prismaError.meta,
      });
    }

    // Record not found
    if (prismaError.code === 'P2025') {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Resource not found',
      });
    }
  }

  // Other Fastify/plugin errors that carry a client-error status
  // (rate limiting 429, payload too large 413, bad content type 415, ...)
  const statusCode = (error as FastifyError).statusCode;
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    return reply.status(statusCode).send({
      error: error.name,
      message: error.message,
    });
  }

  // Default error
  request.log.error(error);

  return reply.status(500).send({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
  });
};
