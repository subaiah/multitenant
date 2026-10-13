import { prisma, pool } from '../src/lib/prisma.js';
import { hashPassword } from '../src/utils/auth.js';

async function main() {
  console.log('🌱 Starting database seed...');

  // Create tenants
  const tenants = await Promise.all([
    prisma.tenant.create({
      data: {
        name: 'Acme Corporation',
        slug: 'acme-corp',
        plan: 'ENTERPRISE',
        status: 'ACTIVE',
        primaryColor: '#3b82f6',
        loginTitle: 'Welcome to Acme Corporation',
        loginSubtitle: 'Sign in with your corporate account',
      },
    }),
    prisma.tenant.create({
      data: {
        name: 'TechStart Inc.',
        slug: 'techstart',
        plan: 'PROFESSIONAL',
        status: 'ACTIVE',
        primaryColor: '#10b981',
        loginTitle: 'TechStart Portal',
        loginSubtitle: 'Access your workspace',
      },
    }),
    prisma.tenant.create({
      data: {
        name: 'Global Media Group',
        slug: 'global-media',
        plan: 'PROFESSIONAL',
        status: 'ACTIVE',
        primaryColor: '#8b5cf6',
        loginTitle: 'Global Media Login',
        loginSubtitle: 'Continue with your organization credentials',
      },
    }),
    prisma.tenant.create({
      data: {
        name: 'Startup Labs',
        slug: 'startup-labs',
        plan: 'STARTER',
        status: 'TRIAL',
        primaryColor: '#f59e0b',
        loginTitle: 'Startup Labs',
        loginSubtitle: 'Sign in to your trial account',
      },
    }),
  ]);

  console.log(`✅ Created ${tenants.length} tenants`);

  // Create users for each tenant
  const users = [];
  for (const tenant of tenants) {
    // Hash passwords for test users
    const adminPasswordHash = await hashPassword('admin123');
    const userPasswordHash = await hashPassword('user123');

    const tenantUsers = await Promise.all([
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `admin@${tenant.slug}.com`,
          name: 'Admin User',
          passwordHash: adminPasswordHash,
          userType: 'TENANT_ADMIN',
          status: 'ACTIVE',
        },
      }),
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `user@${tenant.slug}.com`,
          name: 'Regular User',
          passwordHash: userPasswordHash,
          userType: 'TENANT_USER',
          status: 'ACTIVE',
        },
      }),
    ]);
    users.push(...tenantUsers);
  }

  console.log(`✅ Created ${users.length} users`);

  // Create applications for each tenant
  const applications = [];
  for (const tenant of tenants) {
    const tenantApps = await Promise.all([
      prisma.application.create({
        data: {
          tenantId: tenant.id,
          name: 'Customer Portal',
          description: 'Main customer-facing portal',
          status: 'RUNNING',
          version: '2.1.0',
          environment: 'PRODUCTION',
          url: `https://portal.${tenant.slug}.com`,
          cpu: 45,
          memory: 62,
          requests: 12500,
        },
      }),
      prisma.application.create({
        data: {
          tenantId: tenant.id,
          name: 'Admin Dashboard',
          description: 'Internal administration panel',
          status: 'RUNNING',
          version: '1.5.2',
          environment: 'PRODUCTION',
          url: `https://admin.${tenant.slug}.com`,
          cpu: 28,
          memory: 45,
          requests: 3200,
        },
      }),
    ]);
    applications.push(...tenantApps);
  }

  console.log(`✅ Created ${applications.length} applications`);

  // Create database configurations
  const dbConfigs = await Promise.all(
    tenants.map((tenant, index) => {
      const strategies = ['DATABASE_PER_TENANT', 'SCHEMA_PER_TENANT', 'SHARED_TABLES', 'SCHEMA_PER_TENANT'];
      return prisma.databaseConfig.create({
        data: {
          tenantId: tenant.id,
          strategy: strategies[index % strategies.length] as any,
          provider: 'POSTGRESQL',
          region: 'US East',
          backupEnabled: true,
          encryptionAtRest: true,
          maxConnections: 100,
          storageLimit: '50 GB',
          schemaName: strategies[index % strategies.length] === 'SCHEMA_PER_TENANT' ? `tenant_${tenant.slug}` : undefined,
          tenantColumn: strategies[index % strategies.length] === 'SHARED_TABLES' ? 'tenant_id' : undefined,
        },
      });
    })
  );

  console.log(`✅ Created ${dbConfigs.length} database configurations`);

  // Create auth configurations
  const authConfigs = await Promise.all(
    tenants.map((tenant) =>
      prisma.authConfig.create({
        data: {
          tenantId: tenant.id,
          mfaEnabled: true,
          sessionTimeout: 60,
          passwordPolicy: 'STRONG',
          ssoOnly: false,
          otpEnabled: true,
          otpExpiry: 5, // 5 minutes
        },
      })
    )
  );

  console.log(`✅ Created ${authConfigs.length} auth configurations`);

  // Create auth providers - multiple providers per tenant
  const authProviders = await Promise.all([
    // Acme Corporation - Entra ID + Google (multiple providers)
    prisma.authProvider.create({
      data: {
        authConfigId: authConfigs[0].id,
        provider: 'ENTRA',
        enabled: true,
        clientId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        tenantId: 'acme.onmicrosoft.com',
        scopes: ['openid', 'profile', 'email'],
        autoProvision: true,
        authorizeUrl: 'https://login.microsoftonline.com/acme.onmicrosoft.com/oauth2/v2.0/authorize',
        tokenUrl: 'https://login.microsoftonline.com/acme.onmicrosoft.com/oauth2/v2.0/token',
        userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
      },
    }),
    prisma.authProvider.create({
      data: {
        authConfigId: authConfigs[0].id,
        provider: 'GOOGLE',
        enabled: true,
        clientId: '123456789-acme.apps.googleusercontent.com',
        scopes: ['openid', 'profile', 'email'],
        autoProvision: false,
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
      },
    }),
    // TechStart - Google only
    prisma.authProvider.create({
      data: {
        authConfigId: authConfigs[1].id,
        provider: 'GOOGLE',
        enabled: true,
        clientId: '987654321-techstart.apps.googleusercontent.com',
        scopes: ['openid', 'profile', 'email'],
        autoProvision: true,
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
      },
    }),
    // Global Media - Entra ID + GitHub (multiple providers)
    prisma.authProvider.create({
      data: {
        authConfigId: authConfigs[2].id,
        provider: 'ENTRA',
        enabled: true,
        clientId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
        tenantId: 'globalmedia.onmicrosoft.com',
        scopes: ['openid', 'profile', 'email'],
        autoProvision: true,
        authorizeUrl: 'https://login.microsoftonline.com/globalmedia.onmicrosoft.com/oauth2/v2.0/authorize',
        tokenUrl: 'https://login.microsoftonline.com/globalmedia.onmicrosoft.com/oauth2/v2.0/token',
        userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
      },
    }),
    prisma.authProvider.create({
      data: {
        authConfigId: authConfigs[2].id,
        provider: 'GITHUB',
        enabled: true,
        clientId: 'Iv1.abc123def456',
        scopes: ['read:user', 'user:email'],
        autoProvision: false,
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        userInfoUrl: 'https://api.github.com/user',
      },
    }),
    // Startup Labs - Google only (simple setup)
    prisma.authProvider.create({
      data: {
        authConfigId: authConfigs[3].id,
        provider: 'GOOGLE',
        enabled: true,
        clientId: '555666777-startuplabs.apps.googleusercontent.com',
        scopes: ['openid', 'profile', 'email'],
        autoProvision: false,
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
      },
    }),
  ]);

  console.log(`✅ Created ${authProviders.length} auth providers`);

  // Create API configurations
  const apiConfigs = await Promise.all(
    tenants.map((tenant, index) => {
      const gateways = ['AZURE_APIM', 'AWS_APIGATEWAY', 'KONG', 'CUSTOM'];
      return prisma.apiConfig.create({
        data: {
          tenantId: tenant.id,
          bffEnabled: index % 2 === 0,
          bffUrl: index % 2 === 0 ? `https://bff.${tenant.slug}.com` : undefined,
          apiGateway: gateways[index % gateways.length] as any,
          rateLimit: 5000,
          corsEnabled: true,
          allowedOrigins: [`https://${tenant.slug}.com`],
          authType: 'OAUTH2',
          versioning: 'URL',
        },
      });
    })
  );

  console.log(`✅ Created ${apiConfigs.length} API configurations`);

  // Create activities
  const activities = await Promise.all([
    prisma.activity.create({
      data: {
        tenantId: tenants[0].id,
        userId: users[0].id,
        action: 'deployed',
        target: 'Customer Portal v2.1.0',
        type: 'DEPLOY',
      },
    }),
    prisma.activity.create({
      data: {
        tenantId: tenants[0].id,
        userId: users[0].id,
        action: 'updated configuration',
        target: 'database',
        type: 'CONFIG',
      },
    }),
    prisma.activity.create({
      data: {
        tenantId: tenants[1].id,
        userId: users[2].id,
        action: 'created user',
        target: 'user@techstart.com',
        type: 'USER',
      },
    }),
    prisma.activity.create({
      data: {
        tenantId: tenants[2].id,
        userId: users[4].id,
        action: 'enabled MFA',
        target: 'authentication',
        type: 'AUTH',
      },
    }),
  ]);

  console.log(`✅ Created ${activities.length} activities`);

  console.log('🎉 Database seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
