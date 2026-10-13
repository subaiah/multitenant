# Multi-Tenant Application Management Platform

A comprehensive multi-tenant application management dashboard built with React, TypeScript, and Tailwind CSS, inspired by Tabler.io's admin template design.

## 🚀 Features

### Core Management
- **Dashboard**: Overview of tenant statistics, application health, revenue metrics, and recent activities
- **Tenant Management**: Complete tenant lifecycle management with filtering by status and plan
- **Application Management**: Monitor and manage applications across all tenants with real-time status
- **Activity Log**: Track all actions across tenants and applications with timeline view
- **Infrastructure**: Server health monitoring and resource utilization tracking

### Multi-Tenancy Architecture

#### 1. Data Isolation Strategies
Three database isolation patterns supported per tenant:

**Database per Tenant**
- Complete data isolation with dedicated database instances
- Best for: Enterprise customers, regulated industries
- Pros: Maximum isolation, independent scaling, custom backups
- Cons: Higher cost, complex migrations

**Schema per Tenant**
- Shared database with isolated schemas per tenant
- Best for: Mid-market SaaS platforms
- Pros: Good isolation, lower cost, easier cross-tenant queries
- Cons: Schema migration complexity, connection pooling limits

**Shared Tables (Row-Level Security)**
- All tenants share tables with tenant_id column and RLS policies
- Best for: Startups, free tiers, high-volume low-value data
- Pros: Lowest cost, simplest operations, efficient resource use
- Cons: Weakest isolation, noisy neighbor risk

#### 2. Authentication & SSO Configuration
Per-tenant authentication setup with multiple identity providers:

**Supported Providers:**
- **Microsoft Entra ID** (Azure AD): SAML 2.0, OIDC, SCIM Provisioning
- **Google Workspace**: OAuth 2.0, OIDC, Google Groups Sync
- **GitHub**: OAuth 2.0, Team Sync, Organization SSO
- **Okta**: SAML 2.0, OIDC, SCIM, Lifecycle Management
- **Auth0**: SAML, OIDC, Social Connections, MFA
- **Custom OIDC**: Flexible OpenID Connect provider integration

**Security Features:**
- Multi-Factor Authentication (MFA)
- Configurable password policies (Standard/Strong/Very Strong)
- Session timeout management
- Auto-provisioning of users on first login
- SSO-only mode option

#### 3. API & BFF (Backend for Frontend) Management
Per-tenant API configuration with BFF pattern support:

**BFF Pattern Benefits:**
- Token Management: Securely store and manage OAuth tokens server-side
- API Aggregation: Combine multiple backend calls into single frontend requests
- Tenant Isolation: Inject tenant context and enforce data isolation
- Security: Keep sensitive credentials server-side

**API Gateway Support:**
- Azure API Management
- AWS API Gateway
- Kong
- Apigee
- Custom gateways

**Configuration Options:**
- Authentication types: OAuth 2.0, JWT, API Key
- Rate limiting per tenant
- CORS configuration with allowed origins
- API versioning strategies (URL, Header, Query)

### Theme & Layout Customization
- **Layout Modes**: Left Sidebar, Right Sidebar, Top Navigation
- **Color Schemes**: Light, Dark, Auto (system preference)
- **Accent Colors**: Blue, Green, Purple, Amber, Red, Teal
- Settings persist via localStorage

### Routing & Navigation
- Full React Router v7 integration
- URL-based filtering and pagination
- Shareable links with query parameters
- Browser back/forward navigation support

## 📁 Project Structure

```
src/
├── components/
│   ├── Header.tsx              # Top header with search and user menu
│   ├── Layout.tsx              # Main layout wrapper
│   ├── LayoutSelector.tsx      # Theme and layout customization panel
│   ├── Sidebar.tsx             # Left/Right sidebar navigation
│   └── TopNav.tsx              # Top navigation bar
├── context/
│   └── LayoutContext.tsx       # Layout settings context provider
├── data/
│   ├── mockData.ts             # Mock data for tenants, applications, activities
│   └── tenantConfigs.ts        # Multi-tenancy configuration data
├── pages/
│   ├── ActivityLog.tsx         # Activity timeline with filters
│   ├── ApiManagement.tsx       # API & BFF configuration
│   ├── Applications.tsx        # Application management
│   ├── Authentication.tsx      # SSO provider configuration
│   ├── Dashboard.tsx           # Main dashboard overview
│   ├── DataIsolation.tsx       # Database strategy configuration
│   ├── Infrastructure.tsx      # Server monitoring
│   ├── Settings.tsx            # Platform settings
│   └── Tenants.tsx             # Tenant management
├── App.tsx                     # Main app with routing
├── main.tsx                    # Entry point
└── index.css                   # Global styles
```

## 🛠️ Technology Stack

- **React 18** - UI framework
- **TypeScript** - Type safety
- **React Router v7** - Client-side routing
- **Tailwind CSS v4** - Utility-first styling
- **Recharts** - Data visualization
- **Lucide React** - Icon library
- **Vite** - Build tool

## 🎯 Multi-Tenancy Best Practices Implemented

### Data Isolation
1. **Choose the right strategy** based on:
   - Compliance requirements
   - Budget constraints
   - Performance needs
   - Operational complexity tolerance

2. **Security considerations**:
   - Encryption at rest for sensitive tenants
   - Automated backups
   - Connection pooling limits
   - Row-level security policies

### Authentication
1. **Provider selection** based on:
   - Existing identity infrastructure
   - User base preferences
   - Compliance requirements
   - Integration complexity

2. **Security hardening**:
   - Enable MFA for all tenants
   - Use strong password policies
   - Implement session timeouts
   - Enable auto-provisioning for seamless UX

### API Architecture
1. **BFF Pattern** for:
   - Mobile and web frontends with different needs
   - Complex data aggregation
   - Security token management
   - Tenant-specific customizations

2. **Direct API** for:
   - Simple applications
   - Cost-sensitive scenarios
   - Low-latency requirements

## 🔐 Security Features

- Role-based access control (RBAC)
- Multi-factor authentication
- Session management
- API rate limiting
- CORS configuration
- Encryption at rest
- Audit logging
- SSO integration

## 📊 Monitoring & Observability

- Real-time application status
- Resource utilization tracking
- Server health monitoring
- Activity logging
- Error tracking
- Performance metrics

## 🚀 Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## 📝 Configuration

### Adding a New Tenant
1. Navigate to Tenants page
2. Click "Add Tenant"
3. Configure:
   - Basic information (name, slug)
   - Subscription plan
   - Data isolation strategy
   - Authentication providers
   - API/BFF settings

### Configuring Data Isolation
1. Go to Data Isolation page
2. Select tenant
3. Choose strategy:
   - Database per Tenant
   - Schema per Tenant
   - Shared Tables
4. Configure connection details
5. Set security options

### Setting Up SSO
1. Navigate to Authentication page
2. Select tenant
3. Click "Add Provider"
4. Choose identity provider
5. Configure credentials
6. Enable auto-provisioning (optional)

### Configuring API/BFF
1. Go to API & BFF Management
2. Select tenant
3. Enable BFF service (optional)
4. Configure API gateway
5. Set authentication type
6. Configure rate limits and CORS

## 🎨 Customization

### Theme Settings
Access via the monitor icon in the header:
- Layout mode (Left/Right sidebar, Top nav)
- Color scheme (Light/Dark/Auto)
- Accent color selection

### Adding Custom Pages
1. Create new page component in `src/pages/`
2. Add route in `src/App.tsx`
3. Add navigation item in `src/components/Sidebar.tsx` and `src/components/TopNav.tsx`
4. Update page titles in `src/components/Layout.tsx`

## 📈 Future Enhancements

- [ ] Real-time WebSocket updates
- [ ] Advanced analytics dashboard
- [ ] Automated tenant onboarding workflows
- [ ] Multi-region deployment support
- [ ] Custom branding per tenant
- [ ] Advanced RBAC with custom roles
- [ ] Audit log export and compliance reports
- [ ] Automated backup and disaster recovery
- [ ] Performance optimization recommendations
- [ ] Cost analysis and optimization tools

## 🤝 Contributing

This is a demonstration project showcasing multi-tenant architecture patterns. Feel free to extend and customize for your specific use case.

## 📄 License

MIT License - feel free to use this project for learning and commercial purposes.

## 🙏 Acknowledgments

- Design inspired by [Tabler.io](https://tabler.io/)
- Icons by [Lucide](https://lucide.dev/)
- Charts by [Recharts](https://recharts.org/)
