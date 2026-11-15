# Connecting an application in one step

Registering an application used to end with someone copying its secrets out of
the platform and into the application's own configuration. Connecting does the
same registration without anyone seeing a secret: a platform administrator
approves the application's request, and the application's server collects its
credentials itself.

It works like installing an app from a marketplace, and borrows OAuth's
authorization-code-with-PKCE shape so it is familiar to implement.

```
 Application (admin's browser)        Platform                      Application (server)
 ─────────────────────────────        ────────                      ────────────────────
 1. "Connect to the platform"
    makes verifier + challenge ─────▶ 2. /platform/applications/connect
                                         reads <app>/.well-known/hub-manifest.json
                                         shows what it asks for
                                      3. admin approves
                                         registers it, makes credentials,
                                         keeps them behind a one-time code
 4. <redirect_uri>?code=…&state=… ◀──
                                                                    5. POST /application-connect/exchange
                                                                       { code, codeVerifier }
                                      ◀──────────────────────────────
                                      6. credentials, once ─────────▶ stores them (encrypted)
```

## What the application provides

### 1. Its manifest, at a fixed address

```
GET https://<your app>/.well-known/hub-manifest.json
```

The same manifest as [PRODUCT_INTEGRATION.md](../PRODUCT_INTEGRATION.md) and
[MANIFEST_V2.md](MANIFEST_V2.md), with one extra rule: **`baseUrl` must be the
address it is served from.** The platform refuses a manifest that speaks for a
different address. That is what ties the request to whoever controls the site.

The platform reads it with a 5-second timeout, does not follow redirects, and
accepts up to 256 KB. In production the address must be `https` and public,
unless its host is listed in the platform's `PRODUCT_CALLBACK_ALLOWED_HOSTS`
(an application on the same private network).

### 2. A "Connect" button that sends an administrator to the platform

Make a PKCE pair on the server and keep the verifier (in the session, or a
short-lived cookie):

```ts
const verifier = randomBytes(32).toString('base64url');            // 43 characters
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('base64url');               // also kept, to check on return
```

Then send the browser to:

```
https://<platform>/platform/applications/connect
  ?app_url=https://hearth.example.com
  &redirect_uri=https://hearth.example.com/hub/connected
  &code_challenge=<challenge>
  &state=<state>
  &scope=organizations.read%20members.read%20notifications.send
```

| Parameter | |
| --- | --- |
| `app_url` | The application's address: scheme, host and port, no path. Must equal the manifest's `baseUrl`. |
| `redirect_uri` | Where the browser comes back to. Must be on `app_url`. |
| `code_challenge` | `base64url(sha256(verifier))`, 43 characters (S256 only). |
| `state` | Anything; returned unchanged. Check it on return. |
| `scope` | Space-separated [service scopes](../PRODUCT_INTEGRATION.md) for calling the platform as the application. Leave it out if the application only signs people in. |

The administrator needs `app-registry:manage`. If they aren't signed in, the
platform signs them in and returns them to the request.

### 3. A return route that collects the credentials

The browser comes back to `redirect_uri` with either:

- `?code=<code>&state=<state>`: approved; or
- `?error=access_denied&state=<state>`: the administrator declined.

Check `state`, then from the **server**:

```
POST https://<platform>/api/application-connect/exchange
Content-Type: application/json

{ "code": "<code>", "codeVerifier": "<verifier>" }
```

```json
{
  "platform": { "url": "https://platform.example.com", "apiUrl": "https://platform.example.com/api" },
  "application": { "id": "…", "productId": "hearth", "name": "Hearth" },
  "signIn": {
    "issuer": "https://platform.example.com/api/oidc",
    "discoveryUrl": "https://platform.example.com/api/oidc/.well-known/openid-configuration",
    "clientId": "mtc_…",
    "clientSecret": "…"
  },
  "events": { "signingSecret": "…" },
  "service": {
    "tokenUrl": "https://platform.example.com/api/oidc/token",
    "resource": "urn:multitenant:api:v1",
    "clientId": "mts_…",
    "clientSecret": "…",
    "scopes": ["organizations.read", "members.read", "notifications.send"]
  }
}
```

- `signIn.clientSecret` is there for confidential clients only.
- `events` is there when the manifest has `provisioning.callbackUrl`. It signs the lifecycle and user events the platform sends there.
- `service` is there when scopes were asked for.

Store these encrypted. They are handed over **once**: a second exchange, a
wrong verifier, or a code older than **10 minutes** gets
`400 { "code": "INVALID_GRANT" }`, and the code is gone. Connect again to get a
new set.

## Connecting again

Connecting an application that is already registered (to pick up a new
manifest, or because its credentials were lost) re-imports the manifest and
**replaces** its secrets:

- **Sign-in client secret:** replaced at once; the old one stops working.
- **Events signing secret:** replaced; the old one keeps signing alongside for 24 hours, so events in flight still verify.
- **Service credential:** the one the previous connection made is revoked and a new one is made. Credentials made by hand on the Applications page are left alone.

The client ID stays the same, so people's sign-ins and organizations' settings
carry on.

The Connect page warns when the application is already registered, and more
strongly when it was registered at a different address.

## What is checked, and why it can be trusted

- **The manifest comes from the application's own address**, and its `baseUrl` must be that address. Whoever can publish a file there controls the application.
- **The code only goes back to that address.** `redirect_uri` must be on `app_url`.
- **The code alone is useless.** Collecting needs the PKCE verifier, which never left the application's server. A wrong verifier burns the code.
- **What is approved is what was shown.** The check returns a hash of the manifest it read; approving re-reads it and refuses (`409 MANIFEST_CHANGED`) if it differs.
- **Codes are single-use and expire in 10 minutes.** The credentials waiting behind a code are encrypted at rest and deleted when collected.
- **Nothing secret is logged.** The audit log records `application.connected` with which secrets were made, never their values.
- **Exchanges are rate-limited** to 10 per 15 minutes per address.

## What it doesn't do

- **It doesn't turn the application on for any organization.** Each organization still chooses that on its Applications page.
- **It doesn't keep the manifest in sync.** Connect again after changing it.
- **It doesn't replace testing the integration end to end.**

## Platform API (for the Connect page)

Both need a platform session with `app-registry:manage`.

| | |
| --- | --- |
| `POST /api/applications/connect/check` | The request as JSON (`appUrl`, `redirectUri`, `codeChallenge`, `state`, `scopes`). Reads the manifest and returns what connecting would do, with `manifestHash`. Saves nothing. |
| `POST /api/applications/connect/approve` | The same, plus `manifestHash`. Registers the application and returns `{ redirectTo }`. |
