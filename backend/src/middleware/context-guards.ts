import { FastifyRequest } from 'fastify';
import { AppError } from './error-handler.js';

/**
 * Type guard to ensure tenant context is present
 * Use this in route handlers that require tenant context
 */
export function requireTenant(request: FastifyRequest): asserts request is FastifyRequest & { tenant: NonNullable<FastifyRequest['tenant']> } {
  if (!request.tenant) {
    throw new AppError('Tenant context is required', 400);
  }
}

/**
 * Type guard to ensure user context is present (from JWT)
 * Use this in route handlers that require authentication
 */
export function requireUser(request: FastifyRequest): asserts request is FastifyRequest & { user: NonNullable<FastifyRequest['user']> } {
  if (!request.user) {
    throw new AppError('Authentication required', 401);
  }
}
