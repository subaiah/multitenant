export type DatabaseStrategy = 'database-per-tenant' | 'schema-per-tenant' | 'shared-tables';
export type AuthProvider = 'entra' | 'google' | 'github' | 'okta' | 'auth0' | 'custom-oidc';

export interface DatabaseConfig {
  tenantId: string;
  strategy: DatabaseStrategy;
  provider: 'postgresql' | 'mysql' | 'mongodb' | 'sqlserver';
  region: string;
  backupEnabled: boolean;
  encryptionAtRest: boolean;
  maxConnections: number;
  storageLimit: string;
  connectionString?: string;
  schemaName?: string;
  tenantColumn?: string;
}

export interface AuthConfig {
  tenantId: string;
  providers: AuthProviderConfig[];
  mfaEnabled: boolean;
  sessionTimeout: number;
  passwordPolicy: 'standard' | 'strong' | 'very-strong';
  ssoOnly: boolean;
}

export interface AuthProviderConfig {
  id: AuthProvider;
  name: string;
  enabled: boolean;
  clientId?: string;
  tenantId?: string;
  domain?: string;
  scopes?: string[];
  autoProvision: boolean;
}

export interface ApiConfig {
  tenantId: string;
  bffEnabled: boolean;
  bffUrl?: string;
  apiGateway: 'kong' | 'apigee' | 'aws-apigateway' | 'azure-apim' | 'custom';
  rateLimit: number;
  corsEnabled: boolean;
  allowedOrigins: string[];
  authType: 'jwt' | 'oauth2' | 'api-key';
  versioning: 'url' | 'header' | 'query';
}

export const databaseConfigs: DatabaseConfig[] = [
  {
    tenantId: '1',
    strategy: 'database-per-tenant',
    provider: 'postgresql',
    region: 'US East (Virginia)',
    backupEnabled: true,
    encryptionAtRest: true,
    maxConnections: 100,
    storageLimit: '50 GB',
    connectionString: 'postgresql://acme_user:***@db-acme.postgres.azure.com:5432/acme_prod',
  },
  {
    tenantId: '2',
    strategy: 'schema-per-tenant',
    provider: 'postgresql',
    region: 'US West (Oregon)',
    backupEnabled: true,
    encryptionAtRest: true,
    maxConnections: 50,
    storageLimit: '25 GB',
    schemaName: 'tenant_techstart',
  },
  {
    tenantId: '3',
    strategy: 'shared-tables',
    provider: 'postgresql',
    region: 'EU West (Ireland)',
    backupEnabled: true,
    encryptionAtRest: false,
    maxConnections: 200,
    storageLimit: '100 GB',
    tenantColumn: 'tenant_id',
  },
  {
    tenantId: '4',
    strategy: 'schema-per-tenant',
    provider: 'mysql',
    region: 'US East (Virginia)',
    backupEnabled: false,
    encryptionAtRest: false,
    maxConnections: 20,
    storageLimit: '10 GB',
    schemaName: 'tenant_startuplabs',
  },
  {
    tenantId: '5',
    strategy: 'database-per-tenant',
    provider: 'postgresql',
    region: 'US East (Virginia)',
    backupEnabled: true,
    encryptionAtRest: true,
    maxConnections: 150,
    storageLimit: '75 GB',
    connectionString: 'postgresql://dataflow_user:***@db-dataflow.postgres.azure.com:5432/dataflow_prod',
  },
  {
    tenantId: '6',
    strategy: 'shared-tables',
    provider: 'mongodb',
    region: 'US West (Oregon)',
    backupEnabled: false,
    encryptionAtRest: false,
    maxConnections: 30,
    storageLimit: '5 GB',
    tenantColumn: 'tenantId',
  },
  {
    tenantId: '7',
    strategy: 'schema-per-tenant',
    provider: 'postgresql',
    region: 'EU West (Ireland)',
    backupEnabled: true,
    encryptionAtRest: true,
    maxConnections: 40,
    storageLimit: '20 GB',
    schemaName: 'tenant_nexus',
  },
  {
    tenantId: '8',
    strategy: 'database-per-tenant',
    provider: 'postgresql',
    region: 'US East (Virginia)',
    backupEnabled: true,
    encryptionAtRest: true,
    maxConnections: 120,
    storageLimit: '60 GB',
    connectionString: 'postgresql://quantum_user:***@db-quantum.postgres.azure.com:5432/quantum_prod',
  },
];

export const authConfigs: AuthConfig[] = [
  {
    tenantId: '1',
    providers: [
      { id: 'entra', name: 'Microsoft Entra ID', enabled: true, clientId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', tenantId: 'contoso.onmicrosoft.com', scopes: ['openid', 'profile', 'email'], autoProvision: true },
      { id: 'google', name: 'Google', enabled: true, clientId: '123456789-abcdef.apps.googleusercontent.com', scopes: ['openid', 'profile', 'email'], autoProvision: false },
    ],
    mfaEnabled: true,
    sessionTimeout: 60,
    passwordPolicy: 'strong',
    ssoOnly: false,
  },
  {
    tenantId: '2',
    providers: [
      { id: 'google', name: 'Google', enabled: true, clientId: '987654321-xyzabc.apps.googleusercontent.com', scopes: ['openid', 'profile', 'email'], autoProvision: true },
      { id: 'github', name: 'GitHub', enabled: true, clientId: 'Iv1.abc123def456', scopes: ['read:user', 'user:email'], autoProvision: true },
    ],
    mfaEnabled: false,
    sessionTimeout: 30,
    passwordPolicy: 'standard',
    ssoOnly: false,
  },
  {
    tenantId: '3',
    providers: [
      { id: 'entra', name: 'Microsoft Entra ID', enabled: true, clientId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', tenantId: 'globalmedia.onmicrosoft.com', scopes: ['openid', 'profile', 'email'], autoProvision: true },
    ],
    mfaEnabled: true,
    sessionTimeout: 120,
    passwordPolicy: 'very-strong',
    ssoOnly: true,
  },
  {
    tenantId: '4',
    providers: [
      { id: 'google', name: 'Google', enabled: true, clientId: '555666777-ghijkl.apps.googleusercontent.com', scopes: ['openid', 'profile', 'email'], autoProvision: false },
    ],
    mfaEnabled: false,
    sessionTimeout: 15,
    passwordPolicy: 'standard',
    ssoOnly: false,
  },
  {
    tenantId: '5',
    providers: [
      { id: 'entra', name: 'Microsoft Entra ID', enabled: true, clientId: 'c3d4e5f6-a7b8-9012-cdef-123456789012', tenantId: 'dataflow.onmicrosoft.com', scopes: ['openid', 'profile', 'email'], autoProvision: true },
      { id: 'okta', name: 'Okta', enabled: true, domain: 'dataflow.okta.com', clientId: '0oa1abc2def3ghi4j5', scopes: ['openid', 'profile', 'email'], autoProvision: true },
    ],
    mfaEnabled: true,
    sessionTimeout: 90,
    passwordPolicy: 'strong',
    ssoOnly: true,
  },
  {
    tenantId: '6',
    providers: [
      { id: 'google', name: 'Google', enabled: false, autoProvision: false },
    ],
    mfaEnabled: false,
    sessionTimeout: 30,
    passwordPolicy: 'standard',
    ssoOnly: false,
  },
  {
    tenantId: '7',
    providers: [
      { id: 'auth0', name: 'Auth0', enabled: true, domain: 'nexus.auth0.com', clientId: 'abc123DEF456ghi789', scopes: ['openid', 'profile', 'email'], autoProvision: false },
    ],
    mfaEnabled: true,
    sessionTimeout: 60,
    passwordPolicy: 'strong',
    ssoOnly: false,
  },
  {
    tenantId: '8',
    providers: [
      { id: 'entra', name: 'Microsoft Entra ID', enabled: true, clientId: 'd4e5f6a7-b8c9-0123-defa-234567890123', tenantId: 'quantum.onmicrosoft.com', scopes: ['openid', 'profile', 'email'], autoProvision: true },
      { id: 'custom-oidc', name: 'Custom OIDC', enabled: true, domain: 'auth.quantumanalytics.io', clientId: 'quantum-client-id', scopes: ['openid', 'profile', 'email', 'roles'], autoProvision: true },
    ],
    mfaEnabled: true,
    sessionTimeout: 45,
    passwordPolicy: 'very-strong',
    ssoOnly: true,
  },
];

export const apiConfigs: ApiConfig[] = [
  {
    tenantId: '1',
    bffEnabled: true,
    bffUrl: 'https://bff.acme-corp.app',
    apiGateway: 'azure-apim',
    rateLimit: 10000,
    corsEnabled: true,
    allowedOrigins: ['https://portal.acme-corp.app', 'https://admin.acme-corp.app'],
    authType: 'oauth2',
    versioning: 'url',
  },
  {
    tenantId: '2',
    bffEnabled: true,
    bffUrl: 'https://bff.techstart.io',
    apiGateway: 'aws-apigateway',
    rateLimit: 5000,
    corsEnabled: true,
    allowedOrigins: ['https://shop.techstart.io'],
    authType: 'jwt',
    versioning: 'header',
  },
  {
    tenantId: '3',
    bffEnabled: false,
    apiGateway: 'kong',
    rateLimit: 8000,
    corsEnabled: true,
    allowedOrigins: ['https://cms.globalmedia.com', 'https://stream.globalmedia.com'],
    authType: 'oauth2',
    versioning: 'url',
  },
  {
    tenantId: '4',
    bffEnabled: false,
    apiGateway: 'custom',
    rateLimit: 1000,
    corsEnabled: false,
    allowedOrigins: [],
    authType: 'api-key',
    versioning: 'query',
  },
  {
    tenantId: '5',
    bffEnabled: true,
    bffUrl: 'https://bff.dataflow.io',
    apiGateway: 'azure-apim',
    rateLimit: 15000,
    corsEnabled: true,
    allowedOrigins: ['https://pipeline.dataflow.io', 'https://ml.dataflow.io'],
    authType: 'oauth2',
    versioning: 'url',
  },
  {
    tenantId: '6',
    bffEnabled: false,
    apiGateway: 'custom',
    rateLimit: 500,
    corsEnabled: false,
    allowedOrigins: [],
    authType: 'api-key',
    versioning: 'query',
  },
  {
    tenantId: '7',
    bffEnabled: true,
    bffUrl: 'https://bff.nexusdigital.com',
    apiGateway: 'apigee',
    rateLimit: 3000,
    corsEnabled: true,
    allowedOrigins: ['https://nexusdigital.com'],
    authType: 'jwt',
    versioning: 'header',
  },
  {
    tenantId: '8',
    bffEnabled: true,
    bffUrl: 'https://bff.quantumanalytics.io',
    apiGateway: 'azure-apim',
    rateLimit: 12000,
    corsEnabled: true,
    allowedOrigins: ['https://dash.quantumanalytics.io'],
    authType: 'oauth2',
    versioning: 'url',
  },
];

export const ssoProviders = [
  {
    id: 'entra' as AuthProvider,
    name: 'Microsoft Entra ID',
    shortName: 'Entra',
    description: 'Azure Active Directory / Microsoft 365 SSO',
    icon: 'microsoft',
    color: 'bg-blue-600',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/active-directory/',
    features: ['SAML 2.0', 'OIDC', 'SCIM Provisioning', 'Conditional Access'],
  },
  {
    id: 'google' as AuthProvider,
    name: 'Google Workspace',
    shortName: 'Google',
    description: 'Google Workspace / Gmail SSO',
    icon: 'google',
    color: 'bg-red-500',
    docsUrl: 'https://developers.google.com/identity',
    features: ['OAuth 2.0', 'OIDC', 'Google Groups Sync'],
  },
  {
    id: 'github' as AuthProvider,
    name: 'GitHub',
    shortName: 'GitHub',
    description: 'GitHub Organizations SSO',
    icon: 'github',
    color: 'bg-gray-900',
    docsUrl: 'https://docs.github.com/en/apps',
    features: ['OAuth 2.0', 'Team Sync', 'Organization SSO'],
  },
  {
    id: 'okta' as AuthProvider,
    name: 'Okta',
    shortName: 'Okta',
    description: 'Okta Universal Directory SSO',
    icon: 'okta',
    color: 'bg-blue-500',
    docsUrl: 'https://developer.okta.com/docs/',
    features: ['SAML 2.0', 'OIDC', 'SCIM', 'Lifecycle Management'],
  },
  {
    id: 'auth0' as AuthProvider,
    name: 'Auth0',
    shortName: 'Auth0',
    description: 'Auth0 Identity Platform',
    icon: 'auth0',
    color: 'bg-orange-500',
    docsUrl: 'https://auth0.com/docs',
    features: ['SAML', 'OIDC', 'Social Connections', 'MFA'],
  },
  {
    id: 'custom-oidc' as AuthProvider,
    name: 'Custom OIDC',
    shortName: 'OIDC',
    description: 'Custom OpenID Connect provider',
    icon: 'custom',
    color: 'bg-purple-500',
    docsUrl: 'https://openid.net/connect/',
    features: ['OIDC', 'Custom Claims', 'Flexible Scopes'],
  },
];

export const databaseStrategies = [
  {
    id: 'database-per-tenant' as DatabaseStrategy,
    name: 'Database per Tenant',
    description: 'Complete data isolation with dedicated database instances per tenant. Best for enterprise customers with strict compliance requirements.',
    pros: ['Maximum isolation', 'Independent scaling', 'Custom backups', 'No noisy neighbor'],
    cons: ['Higher cost', 'Complex migrations', 'More infrastructure to manage'],
    bestFor: 'Enterprise, Regulated Industries',
    icon: 'database',
  },
  {
    id: 'schema-per-tenant' as DatabaseStrategy,
    name: 'Schema per Tenant',
    description: 'Shared database with isolated schemas per tenant. Good balance between isolation and resource efficiency.',
    pros: ['Good isolation', 'Lower cost than dedicated DBs', 'Easier cross-tenant queries', 'Shared infrastructure'],
    cons: ['Schema migrations complexity', 'Connection pooling limits', 'Backup coordination'],
    bestFor: 'Mid-market, SaaS Platforms',
    icon: 'layers',
  },
  {
    id: 'shared-tables' as DatabaseStrategy,
    name: 'Shared Tables (Row-Level)',
    description: 'All tenants share the same tables with a tenant_id column and row-level security policies. Most cost-effective option.',
    pros: ['Lowest cost', 'Simplest operations', 'Easy migrations', 'Efficient resource use'],
    cons: ['Weakest isolation', 'Noisy neighbor risk', 'Complex RLS policies', 'Data leakage risk'],
    bestFor: 'Startups, Free Tiers, High-volume low-value',
    icon: 'table',
  },
];
