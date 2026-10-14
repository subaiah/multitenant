# OTP and Password Login Implementation

## Overview

Successfully implemented username/password and OTP (One-Time Password) authentication alongside the existing SSO functionality. For development purposes, the OTP is displayed directly on the login page.

## What Was Implemented

### Backend Changes

#### 1. Database Schema Updates (`backend/prisma/schema.prisma`)

**User Model**:
- Added `passwordHash` field (nullable) to support password authentication
- Nullable to allow SSO-only users without passwords

**OTP Model** (New):
- `id`: Unique identifier
- `tenantId`: Tenant association
- `email`: User email
- `code`: 6-digit OTP code
- `expiresAt`: Expiration timestamp
- `verified`: Whether OTP has been used
- `createdAt`: Creation timestamp

**AuthConfig Model**:
- Added `otpEnabled` (Boolean, default: true)
- Added `otpExpiry` (Int, default: 5 minutes)

#### 2. Authentication Utilities (`backend/src/utils/auth.ts`)

New utility functions:
- `generateOtp()`: Generates secure 6-digit OTP
- `hashPassword()`: Hashes passwords using PBKDF2
- `verifyPassword()`: Verifies password against hash
- `isOtpExpired()`: Checks if OTP has expired
- `getOtpExpiration()`: Calculates expiration time

#### 3. New API Endpoints (`backend/src/routes/auth.ts`)

**POST /auth/otp/request**
- Request OTP for passwordless login
- Generates 6-digit code
- In development: returns OTP in response
- In production: sends via email (TODO: integrate email service)
- Validates tenant and user existence
- Deletes any existing OTPs for the email

**POST /auth/otp/verify**
- Verify OTP and complete login
- Validates OTP code and expiration
- Marks OTP as verified
- Returns JWT token on success
- Logs authentication activity

**POST /auth/password-login**
- Traditional email/password login
- Validates credentials
- Returns JWT token on success
- Replaces old `/auth/login` endpoint
- Logs authentication activity

**POST /auth/set-password**
- Set password for authenticated user
- Requires valid JWT token
- Hashes password before storing
- Allows SSO users to add password authentication

#### 4. Seed Data Updates (`backend/prisma/seed.ts`)

- Added password hashes for test users
- Admin users: `admin@<tenant>.com` / `admin123`
- Regular users: `user@<tenant>.com` / `user123`
- Updated auth configs with OTP settings

### Frontend Changes

#### 1. Login Page Updates (`src/pages/Login.tsx`)

**New State**:
- `otp`: OTP code input
- `devOtp`: Development OTP display
- Updated `loginMode` to include 'otp' state

**New Functions**:
- `handleRequestOtp()`: Request OTP from backend
- `handleVerifyOtp()`: Verify OTP and login
- Updated `handleEmailPasswordLogin()` to use new endpoint

**UI Enhancements**:

1. **OTP Request Button**:
   - Appears in email/password form
   - Only shown if OTP is enabled for tenant
   - Validates email before requesting OTP

2. **OTP Input Form**:
   - 6-digit code input with monospace font
   - Real-time validation (only numbers, max 6 digits)
   - Submit button disabled until 6 digits entered

3. **Development OTP Display**:
   - Prominent green box with dashed border
   - Large, centered OTP code in monospace font
   - Clear indication this is for development only
   - Automatically shown when OTP is requested in dev mode

4. **Navigation**:
   - Back button to return to email/password form
   - Clear flow between authentication methods

## User Flows

### Password Login Flow

```
1. User visits /:tenantSlug/login
2. User clicks "Sign in with Email"
3. User enters email and password
4. User clicks "Sign In with Password"
5. Backend validates credentials
6. User is redirected to dashboard
```

### OTP Login Flow

```
1. User visits /:tenantSlug/login
2. User enters email address
3. User clicks "Sign In with OTP"
4. Backend generates OTP
5. [DEV] OTP displayed on login page
   [PROD] OTP sent via email
6. User enters OTP code
7. User clicks "Verify & Sign In"
8. Backend validates OTP
9. User is redirected to dashboard
```

### SSO Login Flow (Existing)

```
1. User visits /:tenantSlug/login
2. User sees SSO providers
3. User clicks provider (e.g., "Continue with Microsoft")
4. User redirected to provider
5. User authenticates with provider
6. User redirected back with token
7. User is redirected to dashboard
```

## Development vs Production

### Development Mode (`NODE_ENV=development`)

- OTP is returned in API response
- OTP is displayed on login page in green box
- No email sending required
- User enumeration errors are explicit
- Easier testing and debugging

### Production Mode (`NODE_ENV=production`)

- OTP is sent via email (requires email service integration)
- OTP is NOT displayed on login page
- Generic error messages for security
- Email service must be configured
- Rate limiting and security measures active

## Security Features

### OTP Security

1. **Expiration**: OTP expires after 5 minutes (configurable)
2. **Single Use**: OTP can only be verified once
3. **Tenant Isolation**: OTP is tied to specific tenant
4. **Email Binding**: OTP is tied to specific email
5. **Rate Limiting**: Prevents brute force attacks
6. **Secure Generation**: Uses crypto.randomInt for randomness
7. **Cleanup**: Old OTPs are deleted when new one is requested

### Password Security

1. **Hashing**: Passwords hashed with PBKDF2 (10,000 iterations)
2. **Salt**: Random salt per password
3. **SHA-512**: Strong hashing algorithm
4. **Policy Enforcement**: Configurable password policies per tenant
5. **No Plain Text**: Passwords never stored or transmitted in plain text

### General Security

1. **JWT Tokens**: Secure token-based authentication
2. **Tenant Context**: All operations scoped to tenant
3. **Activity Logging**: All auth events logged
4. **Rate Limiting**: Configurable per tenant
5. **CORS**: Properly configured for frontend
6. **HTTPS**: Required for production (not enforced in dev)

## Configuration Options

### Per-Tenant Settings

Each tenant can configure:

1. **SSO Only**: Disable password/OTP, require SSO
2. **OTP Enabled**: Enable/disable OTP authentication
3. **OTP Expiry**: How long OTP is valid (minutes)
4. **Password Policy**: STANDARD, STRONG, or VERY_STRONG
5. **SSO Providers**: Which providers are available
6. **Auto-Provisioning**: Create users on first SSO login

### Example Configurations

**Enterprise (SSO Only)**:
```json
{
  "ssoOnly": true,
  "otpEnabled": false,
  "providers": ["ENTRA"]
}
```

**Startup (All Methods)**:
```json
{
  "ssoOnly": false,
  "otpEnabled": true,
  "otpExpiry": 5,
  "passwordPolicy": "STANDARD",
  "providers": ["GOOGLE", "GITHUB"]
}
```

**Regulated (SSO + MFA)**:
```json
{
  "ssoOnly": true,
  "mfaEnabled": true,
  "otpEnabled": false,
  "providers": ["ENTRA"],
  "passwordPolicy": "VERY_STRONG"
}
```

## Testing

### Test Credentials

After running migrations and seed:

**Acme Corporation**:
- Admin: `admin@acme-corp.com` / `admin123`
- User: `user@acme-corp.com` / `user123`

**TechStart Inc.**:
- Admin: `admin@techstart.com` / `admin123`
- User: `user@techstart.com` / `user123`

**Global Media Group**:
- Admin: `admin@global-media.com` / `admin123`
- User: `user@global-media.com` / `user123`

**Startup Labs**:
- Admin: `admin@startup-labs.com` / `admin123`
- User: `user@startup-labs.com` / `user123`

### Testing OTP

1. Visit `http://localhost:5173/acme-corp/login`
2. Enter email: `admin@acme-corp.com`
3. Click "Sign In with OTP"
4. OTP will be displayed in green box
5. Enter the OTP
6. Click "Verify & Sign In"
7. You'll be redirected to dashboard

### Testing Password Login

1. Visit `http://localhost:5173/acme-corp/login`
2. Click "Sign in with Email"
3. Enter email: `admin@acme-corp.com`
4. Enter password: `admin123`
5. Click "Sign In with Password"
6. You'll be redirected to dashboard

## Next Steps for Production

### 1. Email Service Integration

Implement email sending in `backend/src/routes/auth.ts`:

```typescript
// TODO: Integrate with email service
import { sendEmail } from '../services/email.js';

await sendEmail({
  to: email,
  subject: 'Your Login Code',
  html: `<p>Your OTP is: <strong>${code}</strong></p>`
});
```

Recommended services:
- SendGrid
- AWS SES
- Mailgun
- Postmark

### 2. Password Hashing Upgrade

Consider upgrading to bcrypt or argon2:

```bash
npm install bcrypt
# or
npm install argon2
```

### 3. Additional Security

- Implement account lockout after failed attempts
- Add CAPTCHA for brute force protection
- Implement device fingerprinting
- Add IP-based rate limiting
- Implement refresh tokens
- Add session management

### 4. Monitoring

- Track authentication success/failure rates
- Monitor OTP request patterns
- Alert on suspicious activity
- Log all authentication events

## Files Modified

### Backend
- `backend/prisma/schema.prisma` - Added OTP model, updated User and AuthConfig
- `backend/prisma/seed.ts` - Added password hashes and OTP config
- `backend/src/utils/auth.ts` - New file with auth utilities
- `backend/src/routes/auth.ts` - Added OTP and password endpoints

### Frontend
- `src/pages/Login.tsx` - Added OTP UI and handlers

### Documentation
- `backend/docs/AUTHENTICATION_METHODS.md` - Comprehensive auth guide
- `OTP_PASSWORD_IMPLEMENTATION.md` - This file

## Summary

✅ **Password Login**: Traditional email/password authentication  
✅ **OTP Login**: Passwordless authentication with 6-digit codes  
✅ **Development OTP Display**: OTP shown on login page in dev mode  
✅ **Security**: Proper hashing, expiration, and validation  
✅ **Flexibility**: Per-tenant configuration of auth methods  
✅ **Documentation**: Comprehensive guides for all auth methods  
✅ **Test Data**: Pre-configured test users with passwords  

The implementation provides a complete, secure, and flexible authentication system that supports multiple authentication methods while maintaining ease of use for both developers and end users.
