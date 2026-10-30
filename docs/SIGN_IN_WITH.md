# "Sign in with": your applications use accounts from here

The platform is an [OpenID Connect](https://openid.net/specs/openid-connect-core-1_0.html) provider for the applications in its catalogue. People sign in to those applications with the account they already have in their organization. The application learns who they are, which organization they belong to, and what they may do in it.

Three parties are involved:

- **Platform staff** add the application to the catalogue and turn on sign-in for it: **Applications** in the platform portal, then the **Sign in with your organization account** panel.
- **Organizations** turn on the applications they use: **Entitlements** (permission `applications:manage`). An entitlement can be `ENABLED` or `TRIAL`, and it can have an end date.
- **Their people** open the applications from the **Applications** page in the tenant portal, then sign in with their account here.

Code: `backend/src/lib/oidc/` (the provider, its storage, signing keys, and who may sign in), `backend/src/routes/oidc.ts` (the endpoints and the sign-in step), and `backend/src/routes/application-sign-in.ts` (the settings). Tests: `backend/test/sign-in-with.test.ts` plays the application through the whole flow.

## Setting up an application

In the platform portal, open **Applications**, choose the application, and fill in the sign-in panel:

| Setting | |
| --- | --- |
| Kind of application | **Server-side web application**: it gets a client secret and exchanges codes on its server (`client_secret_basic`). **Browser or mobile app**: no secret, PKCE only (`none`). |
| Redirect URIs | Where the application receives the result. `https://` only, except `http://localhost` (and `127.0.0.1`) while developing. They must match exactly. |
| After sign-out | Where the application may send people after signing out (`post_logout_redirect_uri`). Optional. |
| Open address | The application's page that starts signing in (OpenID's `initiate_login_uri`). The organization's **Applications** page links there with `?iss=<issuer>`. Optional: without it, the application is listed but has no **Open** button. |

Saving shows the **client ID** and the **issuer**. For a server-side application it also shows the **client secret, once**. Copy it then. **New secret** replaces it, and the old one stops working at once. Secrets are stored encrypted (`SECRETS_KEY_V*`, like other secrets).

Turning sign-in off, or setting the application to anything other than `ACTIVE`, makes the client unknown to the provider. Sign-in and token refresh then fail.

## What the application does

Give the application the issuer and let its OpenID Connect library discover the rest:

```
issuer:     https://app.example.com/api/oidc          (BFF_URL + /oidc)
discovery:  https://app.example.com/api/oidc/.well-known/openid-configuration
```

The flow is the authorization code flow, **with PKCE (S256) required for every client**:

1. Send the person to the authorization endpoint with `response_type=code`, `scope=openid …`, a `state`, a `nonce`, and a `code_challenge`.
2. If they aren't signed in here, they go to the sign-in page, then come back to finish. If their organization hasn't turned the application on, the application gets `error=access_denied` with a description.
3. Exchange the `code` at the token endpoint with the `code_verifier`. Server-side applications authenticate with HTTP Basic.
4. Check the ID token against the published keys (`RS256`). Most libraries do this for you.

For example, with [openid-client](https://github.com/panva/openid-client) in Node:

```js
import * as client from 'openid-client';

const config = await client.discovery(new URL('https://app.example.com/api/oidc'), CLIENT_ID, CLIENT_SECRET);

// Start signing in
const verifier = client.randomPKCECodeVerifier();
const url = client.buildAuthorizationUrl(config, {
  redirect_uri: 'https://crm.example.com/auth/callback',
  scope: 'openid email profile organization roles',
  code_challenge: await client.calculatePKCECodeChallenge(verifier),
  code_challenge_method: 'S256',
  state: client.randomState(),
});

// Back at the redirect URI
const tokens = await client.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: verifier, expectedState: state });
const claims = tokens.claims();            // sub, plus the ID token's claims
const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
```

### Scopes and claims

| Scope | Claims |
| --- | --- |
| `openid` | `sub`: `<tenant id>.<user id>`. It's stable and unique across organizations. |
| `email` | `email`. There's no `email_verified`: the kit doesn't record whether an address was confirmed. |
| `profile` | `name`, `updated_at` |
| `organization` | `tenant_id`, `tenant_slug`, `tenant_name` |
| `roles` | `roles`: the person's role names, directly and through groups. `permissions`: those of the permissions the application declares (its **Permissions** in the catalogue) that the person holds. |
| `offline_access` | A refresh token. The authorization request must also have `prompt=consent`, as the OpenID spec requires. |

The ID token carries `sub` (and `nonce`, `auth_time` and the usual fields). The other claims come from the userinfo endpoint.

### Tokens

| | Lifetime |
| --- | --- |
| Authorization code | 1 minute, single use |
| Access token (opaque) | 1 hour |
| ID token | 1 hour |
| Refresh token | 30 days, replaced on every use (the old one stops working) |

Refresh tokens need the `refresh_token` grant, which every application has, and the `offline_access` scope.

The provider checks again each time an application refreshes. Refreshing fails with `invalid_grant` when:

- the organization turned the application off, or its entitlement ended;
- the person was deactivated, or signed out everywhere after the token was issued;
- the organization was suspended or closed;
- sign-in was turned off for the application.

Revocation (`/token/revocation`) is available to the application for its own tokens.

### Silent sign-in and signing out

The provider keeps its own session, and it follows the site's. Every authorization request checks:

- that someone is signed in to the site;
- that it's the same person;
- that their organization still has the application on.

Otherwise the provider asks again. So `prompt=none` works while the person is signed in here, and returns `login_required` once they've signed out or someone else has signed in.

Applications sign people out through the end-session endpoint (`end_session_endpoint`), optionally with a registered `post_logout_redirect_uri`:

- **With `id_token_hint`**, the person is signed out straight away, of the provider and of the site.
- **Without it**, they're asked first, so another website can't sign them out.

## Where things are kept

All in the control plane:

| Table | Holds |
| --- | --- |
| `application_sign_ins` | Each application's client settings. The secret is encrypted. |
| `oidc_payloads` | The provider's sessions, sign-in steps, codes, tokens and grants. Rows hold only identifiers and the granted scopes, not claims. A background job removes expired rows hourly. |
| `oidc_signing_keys` | The RS256 signing key. It's made on first start, under a lock so servers agree, and stored encrypted. |

Cookies for the provider are signed with a key derived from `COOKIE_SECRET`, so every server accepts them.

Each sign-in to an application is recorded in the organization's audit log as **Signed in to an application** (`auth.application_signed_in`), so webhooks can follow it too.

Changes to an application's sign-in settings and new client secrets are recorded in the platform's audit log.

## Limits

- **No consent screen.** The organization turned the application on, and the catalogue holds the platform's own applications, so people aren't asked again.
- **Only organization accounts sign in.** Platform staff get `access_denied`.
- **`prompt=login` and `max_age` don't make people enter their password again.** A current session on the site counts as signing in.
- **Custom domains.** Sign-in for applications happens at the main address (`BFF_URL`), not at an organization's own domain. People signed in only at their organization's domain sign in again there once.
- **Signing keys aren't rotated.** One key, made on first start, signs every ID token. The table has room for more (`retired_at`), but nothing rotates them yet.
- **No dynamic client registration.** Applications are registered by platform staff only.
