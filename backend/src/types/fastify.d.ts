// Single source of truth for Fastify / @fastify/jwt type augmentations.
import '@fastify/jwt';
import type { UserType } from '../utils/authorization.js';

/** Claims carried by every user access token. */
export interface AuthUser {
  userId: string;
  tenantId?: string;
  userType: UserType;
  /** Session id (the refresh-token family) on browser sessions */
  sid?: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    // What we sign. Extra claims are optional so every sign() call site type-checks.
    payload: Partial<AuthUser> & {
      provider?: string;
      type?: 'access';
      /** Session id: the refresh-token family, for idle tracking (lib/sign-in.ts) */
      sid?: string;
      service?: string;
      scope?: string;
    };
    // What request.user is after jwtVerify().
    user: AuthUser;
  }
}

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
