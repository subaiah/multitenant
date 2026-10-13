import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
      },
    }),
    prisma.tenant.create({
      data: {
        name: 'TechStart Inc.',
        slug: 'techstart',
        plan: 'PROFESSIONAL',
        status: 'ACTIVE',
      },
    }),
    prisma.tenant.create({
      data: {
        name: 'Global Media Group',
        slug: 'global-media',
        plan: 'PROFESSIONAL',
        status: 'ACTIVE',
      },
    }),
    prisma.tenant.create({
      data: {
        name: 'Startup Labs',
        slug: 'startup-labs',
        plan: 'STARTER',
        status: 'TRIAL',
      },
    }),
  ]);

  console.log(`✅ Created ${tenants.length} tenants`);

  // Create users for each tenant
  const users = [];
  for (const tenant of tenants) {
    const tenantUsers = await Promise.all([
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `admin@${tenant.slug}.com`,
          name: 'Admin User',
          role: 'ADMIN',
          status: 'ACTIVE',
        },
      }),
      prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: `user@${tenant.slug}.com`,
          name: 'Regular User',
          role: 'USER',
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
        },
      })
    )
  );

  console.log(`✅ Created ${authConfigs.length} auth configurations`);

  // Create auth providers
  const authProviders = await Promise.all([
    prisma.authProvider.create({
      data: {
        authConfigId: authConfigs[0].id,
        provider: 'ENTRA',
        enabled: true,
        clientId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        tenantId: 'acme.onmicrosoft.com',
        scopes: ['openid', 'profile', 'email'],
        autoProvision: true,
      },
    }),
    prisma.authProvider.create({
      data: {
        authConfigId: authConfigs[1].id,
        provider: 'GOOGLE',
        enabled: true,
        clientId: '123456789-abcdef.apps.googleusercontent.com',
        scopes: ['openid', 'profile', 'email'],
        autoProvision: false,
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
  });
