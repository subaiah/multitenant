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

## The application's permissions

An application declares what people can do in it as permissions. Platform staff add them on the application's **Permissions** panel.

- **Names.** A permission is `resource:action`, and the resource starts with the application's key: `crm:admin`, `crm.deals:approve`. So one application's permissions can never widen the platform's own or another application's.
- **Who can grant them.** While an organization has the application turned on, its role editor lists those permissions under the application's name, and administrators can put them in roles. The organization's administrators hold them all, as they hold everything else in the organization.
- **What the application receives.** It gets the ones a person holds in the `permissions` claim (`roles` scope), and checks them itself.
- **When it's turned off.** The permissions are no longer offered and grant nothing. Roles that already contain them keep them, so turning the application back on restores access as it was.

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
| `roles` | `roles`: the person's role names, directly and through groups. `permissions`: the application's own permissions that the person holds (see [The application's permissions](#the-applications-permissions)). |
| `offline_access` | A refresh token. The authorization request must also have `prompt=consent`, as the OpenID spec requires. |

The ID token carries `sub` (and `nonce`, `auth_time` and the usual fields). The other claims come from the userinfo endpoint.

### Tokens

| | Lifetime |
| --- | --- |
| Authorization code | 1 minute, single use |
| Access token (opaque) | 15 minutes, unless the application's sign-in settings say otherwise (1 minute to 24 hours: **Access token lifetime** on the Sign-in panel, or `signIn.accessTokenLifetime` in seconds in the manifest) |
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

### When the platform ends someone's sessions: Back-Channel Logout

An application with a **back-channel logout address** (Sign-in panel, or `signIn.backchannelLogoutUri` in the manifest) is told when the platform ends a person's sessions, so it can end its own sessions for them at once. It doesn't have to wait for its access token to expire. This is [OpenID Connect Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html), and discovery says `backchannel_logout_supported`.

It happens when the person:
- signs out everywhere;
- is deactivated or removed;
- belongs to an organization that is suspended, closed or deleted, or that turns the application off.

Each application the person signed in to is told. At the same moment, everything the provider issued them (access and refresh tokens, grants, and its own sessions) stops working.

Signing out of the site in one browser doesn't send a logout token. The token carries no session id, so it would end the person's sessions on every device. Applications sign people out from their own sign-out button, through the end-session endpoint, which also signs them out of the site.

The platform POSTs `logout_token=<JWT>`, form-encoded, to the address. The JWT is signed like ID tokens (RS256, the keys in `jwks_uri`, header `typ: logout+jwt`), with:

| Claim | Value |
| --- | --- |
| `iss` | The issuer |
| `aud` | The application's client ID |
| `sub` | The person (`<organization id>.<user id>`, as in the ID token) |
| `iat`, `exp` | Valid for 2 minutes |
| `jti` | Unique: ignore one you've seen |
| `events` | `{"http://schemas.openid.net/event/backchannel-logout": {}}` |

There's no `sid`, because session-level logout isn't required, and never a `nonce`.

The application checks the signature, `iss`, `aud`, `exp` and `events`, then ends that person's sessions and answers `200` (or `204`). Any other answer, or none within 10 seconds, is retried with backoff for about a day and a half, with a new token each time. Platform staff see waiting and given-up logout tokens on the **Integrations** page.

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
