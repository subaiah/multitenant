# Authentication Methods Guide

This guide covers all authentication methods supported by the multi-tenant platform.

## Overview

The platform supports three authentication methods:

1. **SSO (Single Sign-On)** - Enterprise identity providers
2. **Password Login** - Traditional email/password authentication
3. **OTP (One-Time Password)** - Passwordless authentication via email

## 1. SSO Authentication

### Supported Providers

- **Microsoft Entra ID** (Azure AD)
- **Google Workspace**
- **GitHub**
- **Okta**
- **Auth0**
- **Custom OIDC**

### Configuration

Each tenant can configure multiple SSO providers in the Authentication settings page.

### User Flow

1. User visits tenant login page (e.g., `/acme-corp/login`)
2. User sees available SSO providers
3. User clicks on a provider (e.g., "Continue with Microsoft")
4. User is redirected to provider's login page
5. After authentication, user is redirected back to the application
6. If user doesn't exist and auto-provisioning is enabled, account is created automatically

### Tenant Settings

- **SSO Only**: When enabled, users can only authenticate via SSO (no password/OTP)
- **Auto-Provisioning**: Automatically create user accounts on first SSO login

## 2. Password Login

### Overview

Traditional email and password authentication for users who have set a password.

### User Flow

1. User visits tenant login page
2. User clicks "Sign in with Email" or "Sign In with Password"
3. User enters email and password
4. System validates credentials
5. User is logged in and redirected to dashboard

### Setting a Password

Users can set a password via the API:

```bash
POST /auth/set-password
Authorization: Bearer <token>
Content-Type: application/json

{
  "password": "your-secure-password"
}
```

### Password Requirements

Password policies are configurable per tenant:

- **STANDARD**: Minimum 8 characters
- **STRONG**: Minimum 12 characters, mixed case, numbers
- **VERY_STRONG**: Minimum 16 characters, special characters

### Test Credentials

For development, test users are seeded with passwords:

- **Admin**: `admin@<tenant-slug>.com` / `admin123`
- **User**: `user@<tenant-slug>.com` / `user123`

Example:
- Email: `admin@acme-corp.com`
- Password: `admin123`

## 3. OTP (One-Time Password) Login

### Overview

Passwordless authentication using a 6-digit code sent to the user's email.

### User Flow

1. User visits tenant login page
2. User enters email address
3. User clicks "Sign In with OTP"
4. System generates a 6-digit OTP and sends it via email
5. **In Development**: OTP is displayed on the login page
6. **In Production**: OTP is sent to user's email
7. User enters the OTP code
8. System validates the OTP
9. User is logged in and redirected to dashboard

### Configuration

OTP settings are configurable per tenant:

- **OTP Enabled**: Enable/disable OTP authentication
- **OTP Expiry**: How long the OTP is valid (default: 5 minutes)

### Development Mode

In development mode (`NODE_ENV=development`), the OTP is displayed directly on the login page in a prominent green box:

```
┌─────────────────────────────────────┐
│  Development Mode - Your OTP:       │
│  ┌───────────────────────────────┐ │
│  │         123456                │ │
│  └───────────────────────────────┘ │
│  This OTP is shown for development │
│  purposes only                     │
└─────────────────────────────────────┘
```

### Production Mode

In production, the OTP is sent via email. You need to integrate with an email service:

- SendGrid
- AWS SES
- Mailgun
- Postmark

Example integration (to be implemented in `backend/src/routes/auth.ts`):

```typescript
// In production, send OTP via email
await sendOtpEmail(email, code);
```

### Security Features

- OTP expires after configured time (default: 5 minutes)
- OTP can only be used once
- OTP is tied to specific tenant and email
- Rate limiting prevents brute force attacks
- Failed attempts are logged

## API Endpoints

### Request OTP

```bash
POST /auth/otp/request
Content-Type: application/json

{
  "email": "user@example.com",
  "tenantSlug": "acme-corp"
}
```

**Response (Development)**:
```json
{
  "message": "OTP generated successfully",
  "otp": "123456",
  "expiresAt": "2024-01-15T10:30:00.000Z"
}
```

**Response (Production)**:
```json
{
  "message": "OTP sent successfully",
  "expiresAt": "2024-01-15T10:30:00.000Z"
}
```

### Verify OTP

```bash
POST /auth/otp/verify
Content-Type: application/json

{
  "email": "user@example.com",
  "tenantSlug": "acme-corp",
  "code": "123456"
}
```

**Response**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "USER"
  },
  "tenant": {
    "id": "uuid",
    "name": "Acme Corporation"
  }
}
```

### Password Login

```bash
POST /auth/password-login
Content-Type: application/json

{
  "email": "user@example.com",
  "tenantSlug": "acme-corp",
  "password": "your-password"
}
```

**Response**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "USER"
  },
  "tenant": {
    "id": "uuid",
    "name": "Acme Corporation"
  }
}
```

### Set Password

```bash
POST /auth/set-password
Authorization: Bearer <token>
Content-Type: application/json

{
  "password": "your-secure-password"
}
```

**Response**:
```json
{
  "message": "Password set successfully"
}
```

## Tenant Configuration

### Authentication Settings

Each tenant can configure authentication methods in the Authentication page:

1. **SSO Providers**: Add/remove SSO providers
2. **SSO Only**: Restrict to SSO only (no password/OTP)
3. **OTP Enabled**: Enable/disable OTP authentication
4. **OTP Expiry**: Set OTP validity duration
5. **Password Policy**: Set password requirements
6. **Session Timeout**: Configure session duration

### Example Configurations

#### Enterprise Tenant (SSO Only)
```json
{
  "ssoOnly": true,
  "otpEnabled": false,
  "providers": ["ENTRA", "OKTA"]
}
```

#### Startup Tenant (All Methods)
```json
{
  "ssoOnly": false,
  "otpEnabled": true,
  "otpExpiry": 5,
  "passwordPolicy": "STANDARD",
  "providers": ["GOOGLE", "GITHUB"]
}
```

#### Regulated Tenant (SSO + MFA)
```json
{
  "ssoOnly": true,
  "mfaEnabled": true,
  "otpEnabled": false,
  "providers": ["ENTRA"],
  "passwordPolicy": "VERY_STRONG"
}
```

## Security Best Practices

### For Production

1. **Use HTTPS**: All authentication endpoints must use HTTPS
2. **Rate Limiting**: Implement rate limiting on auth endpoints
3. **Account Lockout**: Lock accounts after multiple failed attempts
4. **Audit Logging**: Log all authentication events
5. **Email Verification**: Verify email addresses before allowing OTP
6. **Password Hashing**: Use bcrypt or argon2 (currently using PBKDF2)
7. **Session Management**: Implement proper session timeout and refresh
8. **CSRF Protection**: Use CSRF tokens for state-changing operations

### For Development

1. **Never expose OTP in production**: Only show OTP in development mode
2. **Use strong test passwords**: Don't use weak passwords even in dev
3. **Rotate secrets**: Regularly rotate JWT secrets and API keys
4. **Monitor logs**: Watch for suspicious authentication patterns

## Troubleshooting

### OTP Not Received (Production)

1. Check email service configuration
2. Verify email address is correct
3. Check spam/junk folder
4. Verify email service quotas and limits
5. Check backend logs for email sending errors

### Password Login Fails

1. Verify email and password are correct
2. Check if user account is active
3. Verify tenant is not suspended
4. Check if SSO-only mode is enabled
5. Verify password meets policy requirements

### SSO Login Fails

1. Verify SSO provider configuration
2. Check client ID and secret are correct
3. Verify redirect URIs are configured correctly
4. Check provider's admin console for errors
5. Verify user has access to the application in provider

## Migration Guide

### Adding OTP to Existing Tenant

1. Go to Authentication settings
2. Enable "OTP Authentication"
3. Set OTP expiry duration
4. Save changes
5. Users can now use OTP login

### Enabling Password Login

1. User logs in via SSO or OTP
2. User navigates to profile settings
3. User sets a password
4. Password login is now available

### Switching to SSO Only

1. Configure SSO providers
2. Test SSO login works
3. Enable "SSO Only" mode
4. Password and OTP login will be disabled
5. Users must use SSO to login

## Database Schema

### User Model

```prisma
model User {
  id              String     @id @default(uuid())
  tenantId        String     @map("tenant_id")
  email           String
  name            String?
  passwordHash    String?    @map("password_hash")  // Nullable for SSO-only users
  role            UserRole   @default(USER)
  status          UserStatus @default(ACTIVE)
  lastLoginAt     DateTime?  @map("last_login_at")
  createdAt       DateTime   @default(now()) @map("created_at")
  updatedAt       DateTime   @updatedAt @map("updated_at")
}
```

### OTP Model

```prisma
model OtpCode {
  id          String    @id @default(uuid())
  tenantId    String    @map("tenant_id")
  email       String
  code        String
  expiresAt   DateTime  @map("expires_at")
  verified    Boolean   @default(false)
  createdAt   DateTime  @default(now()) @map("created_at")
}
```

### Auth Config Model

```prisma
model AuthConfig {
  id              String         @id @default(uuid())
  tenantId        String         @unique @map("tenant_id")
  mfaEnabled      Boolean        @default(false) @map("mfa_enabled")
  sessionTimeout  Int            @default(60) @map("session_timeout")
  passwordPolicy  PasswordPolicy @default(STANDARD) @map("password_policy")
  ssoOnly         Boolean        @default(false) @map("sso_only")
  otpEnabled      Boolean        @default(true) @map("otp_enabled")
  otpExpiry       Int            @default(5) @map("otp_expiry")
}
```

## Summary

The multi-tenant platform provides flexible authentication options:

- **SSO**: Best for enterprise customers with existing identity providers
- **Password**: Traditional authentication for users who prefer it
- **OTP**: Modern passwordless authentication with email verification

All methods can be enabled/disabled per tenant, providing maximum flexibility for different use cases and security requirements.
