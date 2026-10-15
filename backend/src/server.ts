import Fastify, { FastifyPluginAsync } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config/env.js';
import { prisma, pool } from './lib/prisma.js';
import { tenantRoutes } from './routes/tenants.js';
import { applicationRoutes } from './routes/applications.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { activityRoutes } from './routes/activities.js';
import { bffRoutes } from './routes/bff.js';
import { bffAuthRoutes } from './routes/bff-auth.js';
import { accountRoutes } from './routes/account.js';
import { databaseRoutes } from './routes/database.js';
import { authConfigRoutes } from './routes/auth-config.js';
import { apiConfigRoutes } from './routes/api-config.js';
import { healthRoutes } from './routes/health.js';
import { roleRoutes } from './routes/roles.js';
import { groupRoutes } from './routes/groups.js';
import { organizationRoutes } from './routes/organizations.js';
import { orgUnitRoutes } from './routes/org-units.js';
import { tenantApplicationRoutes } from './routes/tenant-applications.js';
import { delegationRoutes } from './routes/delegations.js';
import { policyRoutes } from './routes/policies.js';
import { supportSessionRoutes } from './routes/support-sessions.js';
import { accessRequestRoutes } from './routes/access-requests.js';
import { certificationRoutes } from './routes/certifications.js';
import { menuItemRoutes } from './routes/menu-items.js';
import { permissionRoutes } from './routes/permissions.js';
import { platformRoutes } from './routes/platform.js';
import { deploymentRoutes } from './routes/deployments.js';
import { errorHandler } from './middleware/error-handler.js';
import { authenticate } from './middleware/authenticate.js';
import { authorize } from './middleware/authorize.js';
import { emailDeliveryWarning } from './lib/mailer.js';

// Create Fastify instance
const fastify = Fastify({
  logger: {
    level: config.logLevel,
    transport: config.nodeEnv === 'development' 
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss Z' } }
      : undefined,
  },
});

// Register plugins
async function registerPlugins() {
  // CORS
  await fastify.register(cors, {
    origin: config.corsOrigin.split(','),
    credentials: true,
    // @fastify/cors only allows GET, HEAD and POST by default, which blocked
    // every PATCH/PUT/DELETE the frontend makes.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  // Security headers
  await fastify.register(helmet, {
    contentSecurityPolicy: false, // Disable for API
  });

  // JWT authentication
  await fastify.register(jwt, {
    secret: config.jwtSecret,
    // Browsers authenticate with the httpOnly cookie set by /bff/auth/login;
    // API clients can still send `Authorization: Bearer` (checked first).
    cookie: { cookieName: 'access_token', signed: false },
    sign: {
      expiresIn: config.jwtExpiresIn,
    },
  });

  // Cookie support for BFF
  await fastify.register(cookie, {
    secret: config.cookieSecret,
    parseOptions: {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
    },
  });

  // Rate limiting
  await fastify.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitTimeWindow,
    // Key on IP only: the tenant header is client-controlled, so including it
    // let clients get a fresh budget per header value.
    keyGenerator: (request) => request.ip,
  });

  // Swagger documentation
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Multi-Tenant BFF & API',
        description: 'Backend for Frontend and API services for multi-tenant application management',
        version: '1.0.0',
      },
      servers: [
        {
          url: `http://localhost:${config.port}`,
          description: 'Development server',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
  });
}

// Register middleware
async function registerMiddleware() {
  // Global error handler
  fastify.setErrorHandler(errorHandler);
}

// Marks every route in a plugin as usable without a tenant (see authenticate.ts)
function platformScoped(plugin: FastifyPluginAsync): FastifyPluginAsync {
  return async (instance) => {
    instance.addHook('onRoute', (route) => {
      route.config = { ...(route.config ?? {}), platformScoped: true };
    });
    await instance.register(plugin);
  };
}

// Register routes
async function registerRoutes() {
  // Health check (no auth required)
  await fastify.register(healthRoutes, { prefix: '/health' });

  // Authentication routes (no auth required)
  await fastify.register(authRoutes, { prefix: '/auth' });

  // BFF Authentication routes (handles cookies, no JWT auth required)
  await fastify.register(bffAuthRoutes, { prefix: '/bff/auth' });

  // Account flows from emailed links (invitations, password reset); no session
  await fastify.register(accountRoutes, { prefix: '/bff/account' });

  // Protected routes (require authentication)
  await fastify.register(async (protectedRoutes) => {
    // Add authentication hook
    // Verify JWT and bind request.tenant to the token's tenant
    protectedRoutes.addHook('onRequest', authenticate);
    // Enforce each route's declared permission (see authorize.ts). Runs before
    // body validation so unauthorized callers get 403, not schema details.
    protectedRoutes.addHook('preValidation', authorize);

    // Tenant management
    await protectedRoutes.register(platformScoped(tenantRoutes), { prefix: '/tenants' });

    // User management
    await protectedRoutes.register(userRoutes, { prefix: '/users' });

    // Application management
    await protectedRoutes.register(platformScoped(applicationRoutes), { prefix: '/applications' });

    // Activity logs
    await protectedRoutes.register(activityRoutes, { prefix: '/activities' });

    // Database configuration
    await protectedRoutes.register(databaseRoutes, { prefix: '/database' });

    // Auth configuration
    await protectedRoutes.register(authConfigRoutes, { prefix: '/auth-config' });

    // API configuration
    await protectedRoutes.register(apiConfigRoutes, { prefix: '/api-config' });

    // Role management
    await protectedRoutes.register(roleRoutes, { prefix: '/roles' });

    // Group management
    await protectedRoutes.register(groupRoutes, { prefix: '/groups' });

    // Organization management (Phase 2)
    await protectedRoutes.register(organizationRoutes, { prefix: '/organizations' });

    // Org unit management (Phase 2)
    await protectedRoutes.register(orgUnitRoutes, { prefix: '/org-units' });

    // Tenant application entitlements (Phase 2)
    await protectedRoutes.register(tenantApplicationRoutes, { prefix: '/tenant-applications' });

    // Phase 3: Advanced Governance routes
    await protectedRoutes.register(delegationRoutes, { prefix: '/delegations' });
    await protectedRoutes.register(policyRoutes, { prefix: '/policies' });
    await protectedRoutes.register(supportSessionRoutes, { prefix: '/support-sessions' });
    await protectedRoutes.register(accessRequestRoutes, { prefix: '/access-requests' });
    await protectedRoutes.register(certificationRoutes, { prefix: '/certifications' });

    // Menu items routes
    await protectedRoutes.register(platformScoped(menuItemRoutes), { prefix: '/menu-items' });

    // Permission routes
    await protectedRoutes.register(platformScoped(permissionRoutes), { prefix: '/permissions' });

    // Platform portal data (platform users only)
    await protectedRoutes.register(platformScoped(platformRoutes), { prefix: '/platform' });

    // Current tenant's deployed applications
    await protectedRoutes.register(deploymentRoutes, { prefix: '/deployments' });

    // BFF routes (Backend for Frontend)
    await protectedRoutes.register(bffRoutes, { prefix: '/bff' });
  });
}

// Start server
async function start() {
  try {
    // Register all plugins and routes
    await registerPlugins();
    await registerMiddleware();
    await registerRoutes();

    const emailWarning = emailDeliveryWarning();
    if (emailWarning) fastify.log.warn(emailWarning);

    // Test database connection
    await prisma.$connect();
    fastify.log.info('Database connected successfully');

    // Start server
    await fastify.listen({ 
      port: config.port, 
      host: config.host 
    });

    fastify.log.info(`Server started on http://${config.host}:${config.port}`);
    fastify.log.info(`API documentation available at http://localhost:${config.port}/docs`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
const shutdown = async () => {
  fastify.log.info('Shutting down gracefully...');
  await prisma.$disconnect();
  await pool.end();
  await fastify.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the server
start();
