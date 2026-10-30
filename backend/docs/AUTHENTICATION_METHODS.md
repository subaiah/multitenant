# Signing in

How people sign in, and the rules every session follows. Code: `src/routes/bff-auth.ts`
(the endpoints), `src/lib/sign-in.ts` (sessions and two-factor), `src/lib/sso.ts`
(single sign-on), `src/lib/mfa.ts` (authenticator codes).

All sign-in goes through `/bff/auth/*`. The session is two httpOnly cookies: a short
access token and a rotating refresh token. The old `/auth/login`, `/auth/otp/*` and
`/auth/oauth/*` routes are gone; they skipped two-factor and the session rules.

## Ways to sign in

| Way | Endpoint | Two-factor |
| --- | --- | --- |
| Email and password | `POST /bff/auth/login` | Yes, when set up or required |
| Emailed one-time code | `POST /bff/auth/otp/request`, `POST /bff/auth/otp/verify` | Yes, when set up or required |
| Single sign-on | `GET /bff/auth/sso/start` → identity provider → `GET /bff/auth/sso/callback` | No: the identity provider's own sign-in (and its MFA) applies |

Platform users sign in with a password on the `platform` slug; single sign-on is for tenants.

## Single sign-on

Each tenant adds identity providers on the Authentication page. Register the
**redirect URI** shown there (`BFF_URL` + `/bff/auth/sso/callback`) with the provider.
A tenant with a verified custom domain sees a second one on its own domain
(`https://<domain>/api/bff/auth/sso/callback` behind the bundled Caddy), and
registers both: sign-in returns to whichever address it started on, and a
callback that arrives at a different address than the one it started from is refused.

| Provider | What to enter | How it signs in |
| --- | --- | --- |
| Microsoft Entra ID | Client ID, secret, directory (tenant) ID | OpenID Connect, issuer `login.microsoftonline.com/<directory>/v2.0`; the token's `tid` must match |
| Google | Client ID, secret | OpenID Connect, `accounts.google.com`; email must be verified |
| Okta | Client ID, secret, Okta domain | OpenID Connect, issuer `https://<domain>` |
| Auth0 | Client ID, secret, Auth0 domain | OpenID Connect, issuer `https://<domain>/` |
| Custom OIDC | Client ID, secret, issuer URL | OpenID Connect via the issuer's discovery document |
| GitHub | Client ID, secret | OAuth 2; the primary verified email from the GitHub API |

The flow uses the authorization code with PKCE, a `state` (single use, 10 minutes, kept in
`oauth_sessions`) and, for OpenID Connect, a `nonce` and a signed ID token checked by
`openid-client`.

Who signed in is matched to a user like this:

1. A user already linked to this provider's **subject** (`external_identities`). Later
   sign-ins match on the subject only, so a changed or reused email at the provider can't
   take over an account.
2. Otherwise a user with the same **verified** email, who is then linked.
3. Otherwise, if the provider has *auto-provision* on, a new Tenant User is created and linked.

An invited (pending) user who signs in this way is activated. Inactive users are refused.
Problems come back to the sign-in page as `?sso_error=<code>&message=...`
(`SSO_EXPIRED`, `SSO_DENIED`, `SSO_UNVERIFIED`, `SSO_NO_ACCOUNT`, `SSO_MISCONFIGURED`,
`SSO_UNAVAILABLE`, `SSO_FAILED`, and `WRONG_DOMAIN` when it starts for another organization on a custom domain).

Outside production, plain-http identity providers are allowed (local testing).

## Two-factor (authenticator apps)

TOTP (RFC 6238: 6 digits, 30-second steps, SHA-1), which every authenticator app supports.

- **Required by the organization**: Authentication page → *Require two-factor sign-in*.
  Platform users: `PLATFORM_MFA_REQUIRED=true`.
- **Optional for anyone**: Profile → *Two-factor sign-in* (platform users: Platform Users page).

After a correct password or emailed code the endpoint returns `{ mfa: 'verify' | 'enroll', mfaToken }`
instead of setting cookies. The MFA token is signed with its own key, lasts 10 minutes and
can't be used as a session. Then:

- `POST /bff/auth/mfa/verify { mfaToken, code }`: a code from the app, or a recovery code.
- `POST /bff/auth/mfa/enroll/start { mfaToken }` and `POST /bff/auth/mfa/enroll/confirm { enrollToken, code }`:
  set up an app while signing in, when it's required and not set up yet.

Rules:

- The secret is encrypted at rest (`lib/secrets.ts`) and shown only while setting up.
- A code works for its 30-second step and one step either side, and only once (the last
  used step is stored; two simultaneous requests can't both use it).
- Ten single-use recovery codes are made when it's set up, stored as SHA-256 hashes and
  shown once. New ones can be made from the profile (with a current code).
- Five wrong codes per account per 15 minutes, however many MFA tokens are fetched.
- Turning it off needs a current code, and isn't possible while the organization requires it.
- An admin with `users:update` can reset a user's two-factor (lost phone): `POST /users/:id/mfa/reset`.
  Platform admins: `POST /platform/users/:id/mfa/reset`. The user sets it up again at the next sign-in.

Self-service endpoints (signed in): `GET /bff/two-factor`, `POST /bff/two-factor/enroll/start`,
`POST /bff/two-factor/enroll/confirm`, `POST /bff/two-factor/recovery-codes`, `POST /bff/two-factor/disable`.

## Changing your password or email

Everyone, tenant users and platform staff alike, changes their own sign-in details on their profile (Profile, or Platform users → Your sign-in). The API is `/bff/my-account`. Both changes need the current password.

- **Password.** It must meet the organization's password policy (STRONG for platform staff). Your other sessions are signed out; the current one goes on. The account's address is emailed about the change.
- **Email.** A link goes to the **new** address, valid for 24 hours. The current address gets a heads-up that a change was asked for. Nothing changes until the link is opened and confirmed with a click (`/confirm-email`), so mail scanners that open links don't trigger it. Then:
  - the account signs in with the new address, and every session ends;
  - the old address is told the change happened;
  - it's recorded in the audit log.

  A pending change can be cancelled, and asking again replaces the earlier link.
- **Administrators** correct someone else's address from the Users page (`POST /users/:id/email`, `users:update`, for user types they can manage):
  - for someone who hasn't accepted their invitation yet, the address simply changes and the invitation is sent again to it (the old link stops working);
  - for anyone else, the same confirmation goes to the new address.
- **Accounts without a password** (single sign-on or email codes only) can't change their own email. An administrator does it for them.

## Sessions

Every session has two limits, checked by the server:

| Limit | Tenants (Authentication page) | Platform users (env) |
| --- | --- | --- |
| Inactivity: no requests for this long ends the session | *Sign out after inactivity*, minutes (default 60) | `PLATFORM_SESSION_IDLE_MINUTES` (30) |
| Maximum length: from signing in, however active | *Maximum session length*, hours (default 12) | `PLATFORM_SESSION_MAX_HOURS` (12) |

How:

- The access token carries the session id (`sid`, the refresh-token family). Requests
  update the session's *last seen* time, at most once a minute.
- An access token never lives longer than the inactivity limit or the time left in the
  session, so an idle browser holds nothing usable.
- A refresh past either limit is refused with `SESSION_IDLE` or `SESSION_MAX`; the session
  is revoked and the cookies cleared. Refreshing keeps the session's start time.
- The browser goes to the sign-in page with a notice (*signed out after a period of
  inactivity* / *reached its maximum length*).

Access tokens must be session tokens (`type: 'access'`): any other token signed with the
same key is refused as a session.
