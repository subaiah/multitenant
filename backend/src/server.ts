import Fastify, { FastifyPluginAsync } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config/env.js';
import { serializeRequest } from './lib/log-redaction.js';
import { controlDb, disconnectDatabases } from './lib/prisma.js';
import { checkTenantServer } from './lib/tenant-server-check.js';
import { latestMigration, tenantsBehind } from './lib/tenant-migrations.js';
import { product } from './product/index.js';
import { tenantRoutes } from './routes/tenants.js';
import { applicationRoutes } from './routes/applications.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { activityRoutes } from './routes/activities.js';
import { bffRoutes } from './routes/bff.js';
import { bffAuthRoutes } from './routes/bff-auth.js';
import { twoFactorRoutes } from './routes/two-factor.js';
import { myAccountRoutes } from './routes/my-account.js';
import { accountRoutes } from './routes/account.js';
import { signupRoutes, siteRoutes, tlsAskRoutes } from './routes/signup.js';
import { customDomainRoutes } from './routes/custom-domain.js';
import { closureRoutes } from './routes/organization-closure.js';
import { dataExportRoutes } from './routes/data-exports.js';
import { databaseRoutes } from './routes/database.js';
import { authConfigRoutes } from './routes/auth-config.js';
import { apiConfigRoutes } from './routes/api-config.js';
import { healthDetailRoutes, healthRoutes } from './routes/health.js';
import { originGuard, requestIdFor } from './lib/request-guard.js';
import { roleRoutes } from './routes/roles.js';
import { groupRoutes } from './routes/groups.js';
import { organizationRoutes } from './routes/organizations.js';
import { orgUnitRoutes } from './routes/org-units.js';
import { tenantApplicationRoutes } from './routes/tenant-applications.js';
import { delegationRoutes } from './routes/delegations.js';
import { policyRoutes } from './routes/policies.js';
import { supportSessionRoutes, tenantSupportAccessRoutes } from './routes/support-sessions.js';
import { platformRoleRoutes } from './routes/platform-roles.js';
import { ensurePlatformRoles } from './lib/platform-roles.js';
import { accessRequestRoutes } from './routes/access-requests.js';
import { certificationRoutes } from './routes/certifications.js';
import { menuItemRoutes } from './routes/menu-items.js';
import { permissionRoutes } from './routes/permissions.js';
import { platformRoutes } from './routes/platform.js';
import { deploymentRoutes } from './routes/deployments.js';
import { auditRoutes, platformAuditRoutes } from './routes/audit.js';
import { startJobs, stopJobs } from './lib/jobs.js';
import { flushErrorReports } from './lib/error-reporting.js';
import { clientErrorRoutes } from './routes/client-errors.js';
import { openApiRoutes } from './routes/openapi.js';
import { billingRoutes } from './routes/billing.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { webhookRoutes } from './routes/webhooks.js';
import { billingWebhookRoutes } from './routes/billing-webhooks.js';
import { platformBillingRoutes } from './routes/platform-billing.js';
import { notificationRoutes, notificationSettingRoutes } from './routes/notifications.js';
import { errorHandler } from './middleware/error-handler.js';
import { authenticate } from './middleware/authenticate.js';
import { authorize } from './middleware/authorize.js';
import { emailDeliveryWarning } from './lib/mailer.js';
import { RateLimitStore } from './lib/rate-limit-store.js';
import { pendingControlMigrations } from './lib/control-migrations.js';

// Create Fastify instance
const fastify = Fastify({
  // Behind a proxy, request.ip (rate limits, audit, sign-in history) comes
  // from X-Forwarded-For, believed only for the configured hops
  trustProxy: config.trustProxy,
  // Kept from the proxy's X-Request-ID when it sends one (lib/request-guard.ts)
  genReqId: requestIdFor,
  // API v1 (src/api/v1.ts): /v1/... is the same route as /...; the version is
  // for other systems, so they keep working as the app's own paths change
  rewriteUrl: (req) => {
    const url = req.url ?? '/';
    if (url === '/v1' || url.startsWith('/v1/') || url.startsWith('/v1?')) {
      (req as { apiVersion?: string }).apiVersion = '1';
      return url.slice(3) || '/';
    }
    return url;
  },
  logger: {
    level: config.logLevel,
    // Request lines without the secrets some URLs carry (lib/log-redaction.ts)
    serializers: { req: serializeRequest },
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
    exposedHeaders: ['X-Request-ID'],
  });

  // Every response says which request it answers (quoted in support requests),
  // and, called as /v1/..., which API version answered
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-ID', request.id);
    if ((request.raw as { apiVersion?: string }).apiVersion) reply.header('API-Version', '1');
  });
  // State-changing requests with cookies must come from this app's own pages
  fastify.addHook('onRequest', originGuard(config.corsOrigin.split(',')));
  // Bodies are JSON. Fastify also parses
  // text/plain by default, a type any web page can send to another site
  // without asking first; nothing here uses it.
  fastify.removeContentTypeParser('text/plain');

  // Security headers. The API only returns JSON, so its content policy allows
  // nothing to load or frame it; the API reference sets its own (below).
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
    },
  });

  // JWT authentication
  await fastify.register(jwt, {
    secret: config.jwtSecret,
    // Browsers authenticate with the httpOnly cookie set by /bff/auth/login;
    // API clients can still send `Authorization: Bearer` (checked first).
    cookie: { cookieName: 'access_token', signed: false },
    // The algorithm is fixed both ways: a token claiming any other is refused
    sign: {
      algorithm: 'HS256',
      expiresIn: config.jwtExpiresIn,
    },
    verify: { algorithms: ['HS256'] },
  });

  // Stamp user tokens with a millisecond issue time. The standard `iat` is in
  // whole seconds, which isn't precise enough to tell a token issued just
  // before "sign out everywhere" from one issued just after (lib/sessions.ts).
  const signJwt = fastify.jwt.sign.bind(fastify.jwt);
  fastify.jwt.sign = ((payload: unknown, options?: unknown) =>
    signJwt(
      payload && typeof payload === 'object' && 'userId' in payload ? { ...payload, iatMs: Date.now() } : (payload as object),
      options as never,
    )) as typeof fastify.jwt.sign;

  // Cookie support for BFF
  await fastify.register(cookie, {
    secret: config.cookieSecret,
    parseOptions: {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
    },
  });

  // Rate limiting: a per-IP flood limit counted in each server's memory, and
  // per-account limits on credentials (lib/rate-limits.ts) counted in the
  // database so they hold across servers (lib/rate-limit-store.ts)
  await fastify.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitTimeWindow,
    // Key on IP only: the tenant header is client-controlled, so including it
    // let clients get a fresh budget per header value.
    keyGenerator: (request) => request.ip,
    store: RateLimitStore,
  });

  // The interactive API reference: not in production unless API_DOCS=true
  if (!config.apiDocs) return;
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Multi-Tenant BFF & API',
        description: 'Backend for Frontend and API services for multi-tenant application management',
        version: '1.0.0',
      },
      servers: [{ url: config.bffUrl }],
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
    // Its own content policy, replacing the API's (which allows nothing)
    staticCSP: true,
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

  // Self-service sign-up, and what the public pages need about this address
  await fastify.register(signupRoutes, { prefix: '/bff/signup' });
  await fastify.register(siteRoutes, { prefix: '/bff' });
  // The API v1 contract, always published (the interactive reference is API_DOCS)
  await fastify.register(openApiRoutes);
  // Errors in people's browsers, for error tracking
  await fastify.register(clientErrorRoutes, { prefix: '/bff' });
  // Payment providers' webhooks (signed; lib/billing/)
  await fastify.register(billingWebhookRoutes, { prefix: '/bff/billing/webhooks' });
  // For the web server only (Caddy's on-demand certificates for custom domains)
  await fastify.register(tlsAskRoutes, { prefix: '/internal' });

  // Protected routes (require authentication)
  await fastify.register(async (protectedRoutes) => {
    // Add authentication hook
    // Verify JWT and bind request.tenant to the token's tenant
    protectedRoutes.addHook('onRequest', authenticate);
    // Enforce each route's declared permission (see authorize.ts). Runs before
    // body validation so unauthorized callers get 403, not schema details.
    protectedRoutes.addHook('preValidation', authorize);

    // Database latency, memory, uptime: platform staff only
    await protectedRoutes.register(platformScoped(healthDetailRoutes), { prefix: '/health' });

    // Tenant management
    await protectedRoutes.register(platformScoped(tenantRoutes), { prefix: '/tenants' });

    // User management
    await protectedRoutes.register(userRoutes, { prefix: '/users' });

    // Application management
    await protectedRoutes.register(platformScoped(applicationRoutes), { prefix: '/applications' });

    // Activity logs
    await protectedRoutes.register(activityRoutes, { prefix: '/activities' });

    // Audit logs: the tenant's, and the platform's (lib/audit.ts)
    await protectedRoutes.register(auditRoutes, { prefix: '/audit' });
    await protectedRoutes.register(platformScoped(platformAuditRoutes), { prefix: '/platform-audit' });

    // Notifications: your inbox and preferences (both portals), and the organization's rules
    await protectedRoutes.register(platformScoped(notificationRoutes), { prefix: '/notifications' });
    await protectedRoutes.register(notificationSettingRoutes, { prefix: '/notification-settings' });

    // Database configuration
    await protectedRoutes.register(databaseRoutes, { prefix: '/database' });

    // Auth configuration
    await protectedRoutes.register(authConfigRoutes, { prefix: '/auth-config' });

    // The organization's own web address (lib/domains.ts)
    await protectedRoutes.register(customDomainRoutes, { prefix: '/custom-domain' });
    await protectedRoutes.register(closureRoutes, { prefix: '/organization' });
    await protectedRoutes.register(dataExportRoutes, { prefix: '/data-exports' });
    // The organization's plan, subscription and invoices
    await protectedRoutes.register(billingRoutes, { prefix: '/billing' });
    // Other systems: API keys to call in, webhooks to be called
    await protectedRoutes.register(apiKeyRoutes, { prefix: '/api-keys' });
    await protectedRoutes.register(webhookRoutes, { prefix: '/webhooks' });

    // API gateway settings: stored but not enforced yet (PREVIEW_FEATURES)
    if (config.previewFeatures) await protectedRoutes.register(apiConfigRoutes, { prefix: '/api-config' });

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
    await protectedRoutes.register(platformScoped(supportSessionRoutes), { prefix: '/support-sessions' });
    // The tenant's view of platform support in its organization
    await protectedRoutes.register(tenantSupportAccessRoutes, { prefix: '/support-access' });
    await protectedRoutes.register(accessRequestRoutes, { prefix: '/access-requests' });
    await protectedRoutes.register(certificationRoutes, { prefix: '/certifications' });

    // Menu items routes
    await protectedRoutes.register(platformScoped(menuItemRoutes), { prefix: '/menu-items' });

    // Permission routes
    await protectedRoutes.register(platformScoped(permissionRoutes), { prefix: '/permissions' });

    // Platform portal data (platform users only)
    await protectedRoutes.register(platformScoped(platformRoutes), { prefix: '/platform' });
    await protectedRoutes.register(platformScoped(platformBillingRoutes), { prefix: '/platform/billing' });
    await protectedRoutes.register(platformScoped(platformRoleRoutes), { prefix: '/platform-roles' });

    // Current tenant's deployed applications: sample data until deployments
    // are reported by something real (PREVIEW_FEATURES)
    if (config.previewFeatures) await protectedRoutes.register(deploymentRoutes, { prefix: '/deployments' });

    // Managing your own two-factor sign-in
    await protectedRoutes.register(platformScoped(twoFactorRoutes), { prefix: '/bff/two-factor' });
    await protectedRoutes.register(platformScoped(myAccountRoutes), { prefix: '/bff/my-account' });

    // BFF routes (Backend for Frontend)
    await protectedRoutes.register(bffRoutes, { prefix: '/bff' });

    // The product's own API (src/product), tenant-bound like the routes above
    await protectedRoutes.register(product.routes);
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
    await controlDb.$connect();
    fastify.log.info('Database connected successfully');
    // New code on an old control-plane schema fails in odd ways: run the
    // release step (node dist/cli/migrate.js, or npm run migrate) first
    const pending = await pendingControlMigrations();
    if (pending.length) {
      const message = `The control-plane database is missing migrations: ${pending.join(', ')}. Run the migrate step (npm run migrate) before starting this version.`;
      if (config.nodeEnv === 'production') throw new Error(message);
      fastify.log.warn(message);
    }
    // Built-in platform roles exist and are current
    await ensurePlatformRoles();

    // The tenant database server must be set up the way isolation relies on
    const serverCheck = await checkTenantServer();
    for (const w of serverCheck.warnings) fastify.log.warn(`Tenant database server: ${w}`);
    for (const e of serverCheck.errors) fastify.log.error(`Tenant database server: ${e}`);
    if (serverCheck.errors.length && config.nodeEnv === 'production') {
      throw new Error('The tenant database server is not set up correctly (see the errors above and prisma/tenant/setup-roles.sql)');
    }
    const behind = await tenantsBehind().catch(() => 0);
    if (behind) {
      fastify.log.warn(`${behind} tenant(s) are on an older schema than ${latestMigration()}; run npm run tenant:migrate (or Run migrations on the Tenants page)`);
    }

    // Start server
    await fastify.listen({ 
      port: config.port, 
      host: config.host 
    });

    fastify.log.info(`Server started on http://${config.host}:${config.port}`);
    if (config.apiDocs) fastify.log.info(`API reference at http://localhost:${config.port}/docs`);

    // Background jobs, unless a separate worker runs them (RUN_JOBS=false)
    if (config.runJobs) {
      await startJobs({
        info: (msg) => fastify.log.info(msg),
        warn: (msg) => fastify.log.warn(msg),
        error: (err, msg) => fastify.log.error({ err }, msg),
      });
    } else {
      fastify.log.info('Background jobs are off on this server (RUN_JOBS=false): a worker runs them');
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
const shutdown = async () => {
  fastify.log.info('Shutting down gracefully...');
  await stopJobs();
  await flushErrorReports();
  await disconnectDatabases();
  await fastify.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the server
start();
