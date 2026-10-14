import { UserType } from '../utils/authorization.js';

// Extend Fastify types
declare module 'fastify' {
  interface FastifyRequest {
    user: {
      userId: string;
      tenantId?: string;
      userType: UserType;
    };
    tenant: {
      id: string;
      name: string;
      slug: string;
      plan: string;
      status: string;
    };
  }
}

export {};
