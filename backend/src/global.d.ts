// Global type declarations for the application

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

// Extend @fastify/jwt types
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      userId: string;
      tenantId?: string;
      userType: string;
    };
    user: {
      userId: string;
      tenantId?: string;
      userType: string;
    };
  }
}

export {};
