import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
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
import { databaseRoutes } from './routes/database.js';
import { authConfigRoutes } from './routes/auth-config.js';
import { apiConfigRoutes } from './routes/api-config.js';
import { healthRoutes } from './routes/health.js';
import { roleRoutes } from './routes/roles.js';
import { errorHandler } from './middleware/error-handler.js';
import { tenantContext } from './middleware/tenant-context.js';

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
  });

  // Security headers
  await fastify.register(helmet, {
    contentSecurityPolicy: false, // Disable for API
  });

  // JWT authentication
  await fastify.register(jwt, {
    secret: config.jwtSecret,
    sign: {
      expiresIn: config.jwtExpiresIn,
    },
  });

  // Rate limiting
  await fastify.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitTimeWindow,
    keyGenerator: (request) => {
      // Rate limit by tenant + IP for multi-tenant
      const tenantId = request.headers[config.tenantHeader] as string;
      return tenantId ? `${tenantId}:${request.ip}` : request.ip;
    },
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

  // Tenant context middleware (extracts tenant from header)
  fastify.addHook('onRequest', tenantContext);
}

// Register routes
async function registerRoutes() {
  // Health check (no auth required)
  await fastify.register(healthRoutes, { prefix: '/health' });

  // Authentication routes (no auth required)
  await fastify.register(authRoutes, { prefix: '/auth' });

  // Protected routes (require authentication)
  await fastify.register(async (protectedRoutes) => {
    // Add authentication hook
    protectedRoutes.addHook('onRequest', async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch (err) {
        reply.status(401).send({ error: 'Unauthorized' });
      }
    });

    // Tenant management
    await protectedRoutes.register(tenantRoutes, { prefix: '/tenants' });

    // User management
    await protectedRoutes.register(userRoutes, { prefix: '/users' });

    // Application management
    await protectedRoutes.register(applicationRoutes, { prefix: '/applications' });

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
