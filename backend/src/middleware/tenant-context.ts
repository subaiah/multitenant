import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { config } from '../config/env.js';
import { AppError } from './error-handler.js';

// Extend FastifyRequest to include tenant
declare module 'fastify' {
  interface FastifyRequest {
    tenant: {
      id: string;
      name: string;
      slug: string;
      plan: string;
      status: string;
    };
  }
}

export const tenantContext = async (request: FastifyRequest, reply: FastifyReply) => {
  // Skip tenant context for health check, auth routes, and BFF auth routes.
  // Match whole path segments: a bare startsWith('/auth') also matched
  // '/auth-config', which then ran with no tenant and crashed.
  const path = request.url.split('?')[0];
  const isUnder = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  if (isUnder('/health') || isUnder('/auth') || isUnder('/bff/auth') || path.startsWith('/docs')) {
    return;
  }

  // Extract tenant ID from header
  const tenantId = request.headers[config.tenantHeader] as string;

  if (!tenantId) {
    throw new AppError('Tenant ID is required in header', 400);
  }

  // Fetch tenant from database
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      slug: true,
      plan: true,
      status: true,
    },
  });

  if (!tenant) {
    throw new AppError('Tenant not found', 404);
  }

  if (tenant.status === 'SUSPENDED') {
    throw new AppError('Tenant is suspended', 403);
  }

  // Attach tenant to request
  request.tenant = tenant;
};
