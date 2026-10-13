# Tenant-Specific Login Implementation Guide

## 🎯 Overview

This implementation provides a superior approach to multi-tenant authentication with:

1. **Tenant-Specific Login Pages** - Branded login at `/:tenantSlug/login`
2. **Provider Selection** - Users can choose from multiple SSO providers
3. **OAuth 2.0 Flow** - Secure authentication with industry-standard protocols
4. **Flexible Configuration** - Each tenant can have different providers and settings

## 📋 Why This Approach is Better

### ❌ Single Login Page (Old Approach)
```
/login → Enter tenant ID → Enter credentials
```
**Problems:**
- Poor user experience
- No branding per tenant
- Confusing for users with multiple accounts
- No SSO provider selection

### ✅ Tenant-Specific Login (New Approach)
```
/acme-corp/login → See branded page → Choose provider → OAuth flow
```
**Benefits:**
- ✅ Branded experience per tenant
- ✅ Clear tenant context
- ✅ Provider selection (Entra, Google, GitHub, etc.)
- ✅ Industry-standard OAuth 2.0
- ✅ Better security with CSRF protection
- ✅ Supports SSO-only tenants
- ✅ Fallback to email/password when needed

## 🏗️ Architecture

### URL Structure

```
# Tenant-specific login (recommended)
https://yourapp.com/acme-corp/login
https://yourapp.com/techstart/login
https://yourapp.com/global-media/login

# Generic login (fallback)
https://yourapp.com/login
```

### Authentication Flow

#### 1. User visits tenant login page
```
GET /acme-corp/login
```

#### 2. Frontend fetches tenant info
```
GET /auth/tenant/acme-corp
```
Returns:
```json
{
  "id": "uuid",
  "name": "Acme Corporation",
  "slug": "acme-corp",
  "logoUrl": "https://...",
  "primaryColor": "#3b82f6",
  "loginTitle": "Welcome to Acme Corporation",
  "loginSubtitle": "Sign in with your corporate account",
  "authConfig": {
    "ssoOnly": false,
    "providers": [
      { "id": "uuid", "provider": "ENTRA" },
      { "id": "uuid", "provider": "GOOGLE" }
    ]
  }
}
```

#### 3. User selects provider (e.g., Microsoft)
```
POST /auth/oauth/initiate
{
  "tenantSlug": "acme-corp",
  "provider": "ENTRA",
  "redirectUri": "https://yourapp.com/acme-corp/login"
}
```

#### 4. Backend returns authorization URL
```json
{
  "authorizationUrl": "https://login.microsoftonline.com/...",
  "state": "csrf-token-123"
}
```

#### 5. Frontend redirects to provider
```
→ https://login.microsoftonline.com/acme.onmicrosoft.com/oauth2/v2.0/authorize?...
```

#### 6. User authenticates with provider
```
User enters credentials at Microsoft login page
```

#### 7. Provider redirects back to backend
```
GET /auth/oauth/callback?code=abc123&state=csrf-token-123
```

#### 8. Backend exchanges code for token
```
Backend → Microsoft: Exchange code for access token
Backend → Microsoft: Get user info
Backend → Database: Find or create user
Backend → Frontend: Redirect with JWT token
```

#### 9. Frontend receives token and redirects
```
GET /acme-corp/login?token=jwt-token&tenantId=uuid
→ Redirect to /dashboard
```

## 🔐 Security Features

### 1. CSRF Protection
- Random state parameter generated for each OAuth flow
- State stored in database with expiration (10 minutes)
- State validated on callback

### 2. Tenant Isolation
- Each OAuth session tied to specific tenant
- Users can only authenticate within their tenant
- Tenant status checked (active/suspended)

### 3. Provider Validation
- Only enabled providers shown to users
- Provider configuration validated before use
- SSO-only enforcement when configured

### 4. Token Security
- JWT tokens with expiration
- Tokens include tenant context
- Secure token storage in localStorage

## 🎨 Branding Features

### Per-Tenant Customization

```typescript
{
  logoUrl: "https://acme.com/logo.png",
  primaryColor: "#3b82f6",
  loginTitle: "Welcome to Acme Corporation",
  loginSubtitle: "Sign in with your corporate account"
}
```

### Dynamic Styling
- Logo displayed at top
- Primary color used for buttons
- Custom title and subtitle
- Tenant name shown for context

## 🔄 Provider Selection UX

### Multiple Providers Available
```
┌─────────────────────────────────────┐
│  Choose your sign-in method         │
├─────────────────────────────────────┤
│  [🔵 Continue with Microsoft]       │
│  [🔴 Continue with Google]          │
│  [⚫ Continue with GitHub]           │
├─────────────────────────────────────┤
│  ─── or continue with email ───     │
│  [📧 Sign in with Email]            │
└─────────────────────────────────────┘
```

### Single Provider
```
┌─────────────────────────────────────┐
│  [🔵 Continue with Microsoft]       │
├─────────────────────────────────────┤
│  ─── or continue with email ───     │
│  [📧 Sign in with Email]            │
└─────────────────────────────────────┘
```

### SSO-Only (No Email/Password)
```
┌─────────────────────────────────────┐
│  Choose your sign-in method         │
├─────────────────────────────────────┤
│  [🔵 Continue with Microsoft]       │
│  [🔴 Continue with Google]          │
└─────────────────────────────────────┘
```

## 📊 Supported Providers

### 1. Microsoft Entra ID (Azure AD)
- **Best for**: Enterprise customers
- **Features**: SAML 2.0, OIDC, SCIM
- **Setup**: Requires Azure AD app registration

### 2. Google Workspace
- **Best for**: Google-based organizations
- **Features**: OAuth 2.0, OIDC
- **Setup**: Google Cloud Console

### 3. GitHub
- **Best for**: Developer-focused companies
- **Features**: OAuth 2.0, Team sync
- **Setup**: GitHub OAuth App

### 4. Okta
- **Best for**: Enterprise identity management
- **Features**: SAML, OIDC, SCIM, MFA
- **Setup**: Okta Admin Console

### 5. Auth0
- **Best for**: Flexible identity platform
- **Features**: SAML, OIDC, Social connections
- **Setup**: Auth0 Dashboard

### 6. Custom OIDC
- **Best for**: Custom identity providers
- **Features**: Full OIDC compliance
- **Setup**: Provide endpoints manually

## 🚀 Implementation Details

### Backend Endpoints

#### 1. Get Tenant Info
```typescript
GET /auth/tenant/:slug
```
Returns tenant branding and available providers.

#### 2. Get Providers
```typescript
GET /auth/tenant/:slug/providers
```
Returns enabled providers for login page.

#### 3. Initiate OAuth
```typescript
POST /auth/oauth/initiate
{
  "tenantSlug": "acme-corp",
  "provider": "ENTRA",
  "redirectUri": "https://..."
}
```
Returns authorization URL and CSRF state.

#### 4. OAuth Callback
```typescript
GET /auth/oauth/callback?code=...&state=...
```
Handles OAuth callback, exchanges code, creates user, returns JWT.

#### 5. Email/Password Login
```typescript
POST /auth/login
{
  "email": "user@acme.com",
  "tenantId": "uuid",
  "password": "..."
}
```
Fallback when SSO is not required.

### Frontend Components

#### Login Page (`/src/pages/Login.tsx`)
- Fetches tenant info on mount
- Displays branded login page
- Shows available providers
- Handles OAuth initiation
- Processes OAuth callback
- Stores JWT token

#### Provider Buttons
- Dynamic based on tenant configuration
- Branded colors per provider
- Loading states during OAuth flow
- Error handling

## 🔧 Configuration

### Tenant Setup

```typescript
// Create tenant with branding
await prisma.tenant.create({
  data: {
    name: 'Acme Corporation',
    slug: 'acme-corp',
    primaryColor: '#3b82f6',
    loginTitle: 'Welcome to Acme Corporation',
    loginSubtitle: 'Sign in with your corporate account',
    logoUrl: 'https://acme.com/logo.png',
  }
});

// Configure auth
await prisma.authConfig.create({
  data: {
    tenantId: tenant.id,
    ssoOnly: false, // Allow email/password fallback
    mfaEnabled: true,
  }
});

// Add providers
await prisma.authProvider.create({
  data: {
    authConfigId: authConfig.id,
    provider: 'ENTRA',
    enabled: true,
    clientId: 'your-client-id',
    tenantId: 'your-tenant.onmicrosoft.com',
    scopes: ['openid', 'profile', 'email'],
    autoProvision: true,
    authorizeUrl: 'https://login.microsoftonline.com/...',
    tokenUrl: 'https://login.microsoftonline.com/...',
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
  }
});
```

### Environment Variables

```env
# OAuth callback URL
APP_URL=http://localhost:5173

# JWT secret
JWT_SECRET=your-secret-key

# Database
DATABASE_URL=postgresql://...
```

## 🎯 Best Practices

### 1. Use Subdomains in Production
```
acme-corp.yourapp.com/login
techstart.yourapp.com/login
```
Better for:
- Cookie isolation
- Custom SSL certificates
- CDN configuration
- Clear tenant separation

### 2. Implement Custom Domains
```
login.acme.com → yourapp.com/acme-corp/login
```
Best for enterprise customers with their own domains.

### 3. Cache Tenant Info
```typescript
// Cache tenant branding for 5 minutes
const tenant = await cache.get(`tenant:${slug}`, async () => {
  return await prisma.tenant.findUnique({ where: { slug } });
}, 300);
```

### 4. Rate Limit OAuth Initiation
```typescript
// Prevent abuse of OAuth flow
await fastify.register(rateLimit, {
  max: 10,
  timeWindow: '1 minute',
  keyGenerator: (request) => `${request.ip}:oauth-init`,
});
```

### 5. Log All Authentication Events
```typescript
await prisma.activity.create({
  data: {
    tenantId: tenant.id,
    userId: user.id,
    action: 'logged in via OAuth',
    target: provider,
    type: 'AUTH',
  }
});
```

## 🧪 Testing

### Test Tenant-Specific Login
```bash
# Visit tenant login page
curl http://localhost:5173/acme-corp/login

# Get tenant info
curl http://localhost:3000/auth/tenant/acme-corp

# Initiate OAuth
curl -X POST http://localhost:3000/auth/oauth/initiate \
  -H "Content-Type: application/json" \
  -d '{
    "tenantSlug": "acme-corp",
    "provider": "GOOGLE",
    "redirectUri": "http://localhost:5173/acme-corp/login"
  }'
```

### Test Email/Password Login
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@acme-corp.com",
    "tenantId": "tenant-uuid",
    "password": "password"
  }'
```

## 📈 Future Enhancements

### 1. Remember Provider Choice
```typescript
localStorage.setItem(`preferredProvider:${tenantId}`, 'GOOGLE');
```

### 2. Account Linking
Allow users to link multiple providers to same account.

### 3. Just-in-Time Provisioning
Automatically create user accounts on first login.

### 4. Multi-Factor Authentication
Add MFA step after OAuth authentication.

### 5. Session Management
Implement refresh tokens and session revocation.

### 6. Audit Logging
Track all authentication attempts and failures.

## 🎉 Summary

This tenant-specific login implementation provides:

✅ **Better UX** - Branded, contextual login pages  
✅ **Provider Choice** - Users select their preferred SSO provider  
✅ **Security** - OAuth 2.0 with CSRF protection  
✅ **Flexibility** - Each tenant can have different providers  
✅ **Scalability** - Supports custom domains and subdomains  
✅ **Standards** - Industry-standard OAuth 2.0 flow  

This is a production-ready authentication system that scales from startups to enterprise customers.
