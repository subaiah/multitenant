/**
 * Demo data: four tenants, one in each isolation mode (two on shared tables),
 * each provisioned for real (database role, schema or database, row-level
 * security), plus two platform users.
 *
 *   npm run prisma:seed
 *
 * Needs an empty control plane and the roles from prisma/tenant/setup-roles.sql.
 * Tenant data is written as each tenant's own database role.
 */
import { controlDb, disconnectDatabases } from '../src/lib/prisma.js';
import { provisionTenant } from '../src/lib/provisioning.js';
import { dbForTenant } from '../src/lib/tenant-db.js';
import { refreshTenantUsage } from '../src/lib/tenant-usage.js';
import { hashPassword } from '../src/utils/auth.js';

type Strategy = 'SHARED_TABLES' | 'SCHEMA_PER_TENANT' | 'DATABASE_PER_TENANT';

const TENANTS: {
  name: string; slug: string; plan: 'FREE' | 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE'; status: 'ACTIVE' | 'TRIAL';
  color: string; loginTitle: string; loginSubtitle: string; strategy: Strategy;
  gateway: 'AZURE_APIM' | 'AWS_APIGATEWAY' | 'KONG' | 'CUSTOM';
  providers: { provider: 'ENTRA' | 'GOOGLE' | 'GITHUB'; clientId: string; idpTenantId?: string; autoProvision: boolean }[];
}[] = [
  {
    name: 'Acme Corporation', slug: 'acme-corp', plan: 'ENTERPRISE', status: 'ACTIVE', color: '#3b82f6',
    loginTitle: 'Welcome to Acme Corporation', loginSubtitle: 'Sign in with your corporate account', strategy: 'SHARED_TABLES', gateway: 'AZURE_APIM',
    providers: [
      { provider: 'ENTRA', clientId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', idpTenantId: 'acme.onmicrosoft.com', autoProvision: true },
      { provider: 'GOOGLE', clientId: '123456789-acme.apps.googleusercontent.com', autoProvision: false },
    ],
  },
  {
    name: 'TechStart Inc.', slug: 'techstart', plan: 'PROFESSIONAL', status: 'ACTIVE', color: '#10b981',
    loginTitle: 'TechStart Portal', loginSubtitle: 'Access your workspace', strategy: 'SCHEMA_PER_TENANT', gateway: 'AWS_APIGATEWAY',
    providers: [{ provider: 'GOOGLE', clientId: '987654321-techstart.apps.googleusercontent.com', autoProvision: true }],
  },
  {
    name: 'Global Media Group', slug: 'global-media', plan: 'PROFESSIONAL', status: 'ACTIVE', color: '#8b5cf6',
    loginTitle: 'Global Media Login', loginSubtitle: 'Continue with your organization credentials', strategy: 'DATABASE_PER_TENANT', gateway: 'KONG',
    providers: [
      { provider: 'ENTRA', clientId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', idpTenantId: 'globalmedia.onmicrosoft.com', autoProvision: true },
      { provider: 'GITHUB', clientId: 'Iv1.abc123def456', autoProvision: false },
    ],
  },
  {
    name: 'Startup Labs', slug: 'startup-labs', plan: 'STARTER', status: 'TRIAL', color: '#f59e0b',
    loginTitle: 'Startup Labs', loginSubtitle: 'Sign in to your trial account', strategy: 'SHARED_TABLES', gateway: 'CUSTOM',
    providers: [{ provider: 'GOOGLE', clientId: '555666777-startuplabs.apps.googleusercontent.com', autoProvision: false }],
  },
];

const PROVIDER_URLS = {
  ENTRA: (t?: string) => ({
    authorizeUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
    scopes: ['openid', 'profile', 'email'],
  }),
  GOOGLE: () => ({
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scopes: ['openid', 'profile', 'email'],
  }),
  GITHUB: () => ({
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    scopes: ['read:user', 'user:email'],
  }),
};

async function main() {
  console.log('🌱 Seeding...');
  const adminHash = await hashPassword('admin123');
  const userHash = await hashPassword('user123');

  // Platform users live in the control plane; they sign in at /platform/login
  await controlDb.platformUser.createMany({
    data: [
      { email: 'admin@platform.local', name: 'Platform Admin', passwordHash: adminHash, userType: 'PLATFORM_ADMIN', status: 'ACTIVE' },
      { email: 'support@platform.local', name: 'Platform Support', passwordHash: userHash, userType: 'PLATFORM_USER', status: 'ACTIVE' },
    ],
  });
  console.log('✅ 2 platform users (admin@platform.local / admin123, support@platform.local / user123)');

  for (const t of TENANTS) {
    const tenant = await controlDb.tenant.create({
      data: {
        name: t.name, slug: t.slug, plan: t.plan, status: t.status, primaryColor: t.color,
        loginTitle: t.loginTitle, loginSubtitle: t.loginSubtitle,
        databaseConfig: {
          create: { strategy: t.strategy, provider: 'POSTGRESQL', region: 'US East', backupEnabled: true, encryptionAtRest: true, storageLimit: '50 GB' },
        },
      },
    });

    // Role, schema or database, tables, row-level security, default roles
    await provisionTenant(tenant.id);
    const state = await controlDb.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    if (state.provisioningStatus !== 'READY') throw new Error(`Provisioning ${t.slug} failed: ${state.provisioningError}`);

    // Everything else as the tenant's own role
    const db = await dbForTenant(tenant.id);
    const tenantId = tenant.id;
    const admin = await db.user.create({
      data: { tenantId, email: `admin@${t.slug}.com`, name: 'Admin User', passwordHash: adminHash, userType: 'TENANT_ADMIN', status: 'ACTIVE' },
    });
    await db.user.create({
      data: { tenantId, email: `user@${t.slug}.com`, name: 'Regular User', passwordHash: userHash, userType: 'TENANT_USER', status: 'ACTIVE' },
    });
    await db.application.createMany({
      data: [
        { tenantId, name: 'Customer Portal', description: 'Main customer-facing portal', status: 'RUNNING', version: '2.1.0', environment: 'PRODUCTION', url: `https://portal.${t.slug}.com`, cpu: 45, memory: 62, requests: 12500 },
        { tenantId, name: 'Admin Dashboard', description: 'Internal administration panel', status: 'RUNNING', version: '1.5.2', environment: 'PRODUCTION', url: `https://admin.${t.slug}.com`, cpu: 28, memory: 45, requests: 3200 },
      ],
    });
    const authConfig = await db.authConfig.update({
      where: { tenantId },
      data: { mfaEnabled: true, passwordPolicy: 'STRONG', otpEnabled: true, otpExpiry: 5 },
    });
    for (const p of t.providers) {
      await db.authProvider.create({
        data: { tenantId, authConfigId: authConfig.id, provider: p.provider, enabled: true, clientId: p.clientId, idpTenantId: p.idpTenantId, autoProvision: p.autoProvision, ...PROVIDER_URLS[p.provider](p.idpTenantId) },
      });
    }
    await db.apiConfig.update({
      where: { tenantId },
      data: { apiGateway: t.gateway, rateLimit: 5000, allowedOrigins: [`https://${t.slug}.com`], authType: 'OAUTH2' },
    });
    await db.activity.createMany({
      data: [
        { tenantId, userId: admin.id, action: 'deployed', target: 'Customer Portal v2.1.0', type: 'DEPLOY' },
        { tenantId, userId: admin.id, action: 'enabled MFA', target: 'authentication', type: 'AUTH' },
      ],
    });
    console.log(`✅ ${t.name} (${t.slug}): ${t.strategy.toLowerCase().replaceAll('_', ' ')}; admin@${t.slug}.com / admin123, user@${t.slug}.com / user123`);
  }

  await refreshTenantUsage();
  console.log('🎉 Done');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exitCode = 1;
  })
  .finally(disconnectDatabases);
