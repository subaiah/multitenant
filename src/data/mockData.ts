export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: 'free' | 'starter' | 'professional' | 'enterprise';
  status: 'active' | 'suspended' | 'trial';
  users: number;
  apps: number;
  storage: string;
  createdAt: string;
  lastActive: string;
  logo?: string;
}

export interface Application {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  status: 'running' | 'stopped' | 'deploying' | 'error';
  version: string;
  environment: 'production' | 'staging' | 'development';
  url: string;
  cpu: number;
  memory: number;
  requests: number;
  lastDeployed: string;
  createdAt: string;
}

export interface Activity {
  id: string;
  tenantId: string;
  user: string;
  action: string;
  target: string;
  timestamp: string;
  type: 'deploy' | 'config' | 'user' | 'billing' | 'alert';
}

export const tenants: Tenant[] = [
  {
    id: '1',
    name: 'Acme Corporation',
    slug: 'acme-corp',
    plan: 'enterprise',
    status: 'active',
    users: 245,
    apps: 12,
    storage: '45.2 GB',
    createdAt: '2024-01-15',
    lastActive: '2 minutes ago',
  },
  {
    id: '2',
    name: 'TechStart Inc.',
    slug: 'techstart',
    plan: 'professional',
    status: 'active',
    users: 89,
    apps: 7,
    storage: '22.8 GB',
    createdAt: '2024-03-22',
    lastActive: '15 minutes ago',
  },
  {
    id: '3',
    name: 'Global Media Group',
    slug: 'global-media',
    plan: 'professional',
    status: 'active',
    users: 156,
    apps: 9,
    storage: '38.1 GB',
    createdAt: '2024-02-10',
    lastActive: '1 hour ago',
  },
  {
    id: '4',
    name: 'Startup Labs',
    slug: 'startup-labs',
    plan: 'starter',
    status: 'trial',
    users: 12,
    apps: 3,
    storage: '5.4 GB',
    createdAt: '2024-06-01',
    lastActive: '3 hours ago',
  },
  {
    id: '5',
    name: 'DataFlow Systems',
    slug: 'dataflow',
    plan: 'enterprise',
    status: 'active',
    users: 312,
    apps: 18,
    storage: '67.9 GB',
    createdAt: '2023-11-05',
    lastActive: '5 minutes ago',
  },
  {
    id: '6',
    name: 'CloudNine Solutions',
    slug: 'cloudnine',
    plan: 'starter',
    status: 'suspended',
    users: 8,
    apps: 2,
    storage: '3.1 GB',
    createdAt: '2024-04-18',
    lastActive: '2 days ago',
  },
  {
    id: '7',
    name: 'Nexus Digital',
    slug: 'nexus-digital',
    plan: 'professional',
    status: 'active',
    users: 67,
    apps: 5,
    storage: '18.6 GB',
    createdAt: '2024-05-12',
    lastActive: '30 minutes ago',
  },
  {
    id: '8',
    name: 'Quantum Analytics',
    slug: 'quantum-analytics',
    plan: 'enterprise',
    status: 'active',
    users: 198,
    apps: 14,
    storage: '52.3 GB',
    createdAt: '2023-09-20',
    lastActive: '10 minutes ago',
  },
];

export const applications: Application[] = [
  {
    id: '1',
    tenantId: '1',
    name: 'Customer Portal',
    description: 'Main customer-facing portal with SSO integration',
    status: 'running',
    version: '3.2.1',
    environment: 'production',
    url: 'portal.acme-corp.app',
    cpu: 34,
    memory: 62,
    requests: 12450,
    lastDeployed: '2 hours ago',
    createdAt: '2024-01-20',
  },
  {
    id: '2',
    tenantId: '1',
    name: 'Admin Dashboard',
    description: 'Internal administration panel',
    status: 'running',
    version: '2.8.0',
    environment: 'production',
    url: 'admin.acme-corp.app',
    cpu: 18,
    memory: 45,
    requests: 3200,
    lastDeployed: '1 day ago',
    createdAt: '2024-01-25',
  },
  {
    id: '3',
    tenantId: '1',
    name: 'API Gateway',
    description: 'Central API gateway for all microservices',
    status: 'running',
    version: '1.15.3',
    environment: 'production',
    url: 'api.acme-corp.app',
    cpu: 56,
    memory: 78,
    requests: 89200,
    lastDeployed: '5 hours ago',
    createdAt: '2024-02-01',
  },
  {
    id: '4',
    tenantId: '2',
    name: 'E-commerce Platform',
    description: 'Online store with payment processing',
    status: 'running',
    version: '4.1.0',
    environment: 'production',
    url: 'shop.techstart.io',
    cpu: 42,
    memory: 55,
    requests: 8900,
    lastDeployed: '3 hours ago',
    createdAt: '2024-03-25',
  },
  {
    id: '5',
    tenantId: '2',
    name: 'Analytics Engine',
    description: 'Real-time analytics processing pipeline',
    status: 'deploying',
    version: '2.0.0-beta',
    environment: 'staging',
    url: 'analytics-staging.techstart.io',
    cpu: 72,
    memory: 85,
    requests: 4500,
    lastDeployed: '10 minutes ago',
    createdAt: '2024-04-10',
  },
  {
    id: '6',
    tenantId: '3',
    name: 'CMS Platform',
    description: 'Content management system for media assets',
    status: 'running',
    version: '5.3.2',
    environment: 'production',
    url: 'cms.globalmedia.com',
    cpu: 28,
    memory: 41,
    requests: 6700,
    lastDeployed: '1 day ago',
    createdAt: '2024-02-15',
  },
  {
    id: '7',
    tenantId: '3',
    name: 'Video Streaming Service',
    description: 'Live and on-demand video streaming',
    status: 'error',
    version: '3.0.1',
    environment: 'production',
    url: 'stream.globalmedia.com',
    cpu: 95,
    memory: 92,
    requests: 23400,
    lastDeployed: '3 days ago',
    createdAt: '2024-03-01',
  },
  {
    id: '8',
    tenantId: '5',
    name: 'Data Pipeline',
    description: 'ETL pipeline for data processing',
    status: 'running',
    version: '2.4.0',
    environment: 'production',
    url: 'pipeline.dataflow.io',
    cpu: 67,
    memory: 73,
    requests: 45600,
    lastDeployed: '6 hours ago',
    createdAt: '2023-11-10',
  },
  {
    id: '9',
    tenantId: '5',
    name: 'ML Model Server',
    description: 'Machine learning model inference server',
    status: 'running',
    version: '1.8.5',
    environment: 'production',
    url: 'ml.dataflow.io',
    cpu: 88,
    memory: 91,
    requests: 12300,
    lastDeployed: '12 hours ago',
    createdAt: '2024-01-05',
  },
  {
    id: '10',
    tenantId: '7',
    name: 'Marketing Site',
    description: 'Company marketing website',
    status: 'stopped',
    version: '1.2.0',
    environment: 'staging',
    url: 'staging.nexusdigital.com',
    cpu: 0,
    memory: 0,
    requests: 0,
    lastDeployed: '5 days ago',
    createdAt: '2024-05-15',
  },
  {
    id: '11',
    tenantId: '8',
    name: 'Quantum Dashboard',
    description: 'Analytics dashboard for quantum computing research',
    status: 'running',
    version: '3.1.0',
    environment: 'production',
    url: 'dash.quantumanalytics.io',
    cpu: 31,
    memory: 48,
    requests: 5600,
    lastDeployed: '4 hours ago',
    createdAt: '2023-10-01',
  },
  {
    id: '12',
    tenantId: '4',
    name: 'MVP Platform',
    description: 'Minimum viable product for testing',
    status: 'running',
    version: '0.9.1',
    environment: 'development',
    url: 'dev.startuplabs.co',
    cpu: 15,
    memory: 22,
    requests: 890,
    lastDeployed: '1 day ago',
    createdAt: '2024-06-05',
  },
];

export const activities: Activity[] = [
  { id: '1', tenantId: '1', user: 'John Smith', action: 'deployed', target: 'Customer Portal v3.2.1', timestamp: '2 minutes ago', type: 'deploy' },
  { id: '2', tenantId: '5', user: 'Sarah Chen', action: 'updated config for', target: 'Data Pipeline', timestamp: '15 minutes ago', type: 'config' },
  { id: '3', tenantId: '2', user: 'Mike Johnson', action: 'added user to', target: 'E-commerce Platform', timestamp: '1 hour ago', type: 'user' },
  { id: '4', tenantId: '3', user: 'System', action: 'alert triggered for', target: 'Video Streaming Service', timestamp: '2 hours ago', type: 'alert' },
  { id: '5', tenantId: '8', user: 'Lisa Wang', action: 'deployed', target: 'Quantum Dashboard v3.1.0', timestamp: '4 hours ago', type: 'deploy' },
  { id: '6', tenantId: '1', user: 'Admin', action: 'updated billing for', target: 'Acme Corporation', timestamp: '6 hours ago', type: 'billing' },
  { id: '7', tenantId: '5', user: 'Alex Kumar', action: 'deployed', target: 'ML Model Server v1.8.5', timestamp: '12 hours ago', type: 'deploy' },
  { id: '8', tenantId: '7', user: 'Tom Wilson', action: 'stopped', target: 'Marketing Site', timestamp: '1 day ago', type: 'config' },
  { id: '9', tenantId: '2', user: 'Sarah Chen', action: 'started deploying', target: 'Analytics Engine v2.0.0-beta', timestamp: '1 day ago', type: 'deploy' },
  { id: '10', tenantId: '4', user: 'Dev Team', action: 'deployed', target: 'MVP Platform v0.9.1', timestamp: '1 day ago', type: 'deploy' },
];

export const revenueData = [
  { month: 'Jan', revenue: 42000, tenants: 45 },
  { month: 'Feb', revenue: 48000, tenants: 52 },
  { month: 'Mar', revenue: 55000, tenants: 58 },
  { month: 'Apr', revenue: 51000, tenants: 61 },
  { month: 'May', revenue: 62000, tenants: 67 },
  { month: 'Jun', revenue: 71000, tenants: 72 },
  { month: 'Jul', revenue: 68000, tenants: 78 },
  { month: 'Aug', revenue: 75000, tenants: 83 },
  { month: 'Sep', revenue: 82000, tenants: 89 },
  { month: 'Oct', revenue: 79000, tenants: 92 },
  { month: 'Nov', revenue: 88000, tenants: 97 },
  { month: 'Dec', revenue: 95000, tenants: 104 },
];

export const usageData = [
  { name: 'Mon', cpu: 45, memory: 62, requests: 34 },
  { name: 'Tue', cpu: 52, memory: 68, requests: 42 },
  { name: 'Wed', cpu: 48, memory: 65, requests: 38 },
  { name: 'Thu', cpu: 61, memory: 72, requests: 55 },
  { name: 'Fri', cpu: 58, memory: 70, requests: 48 },
  { name: 'Sat', cpu: 35, memory: 45, requests: 22 },
  { name: 'Sun', cpu: 30, memory: 40, requests: 18 },
];
