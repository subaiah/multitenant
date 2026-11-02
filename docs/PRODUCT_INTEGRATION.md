# Integrating a product

How a separate application, such as AppForge, becomes part of the platform. The application keeps its own server, database and releases. The platform provides:

- the organizations and the people in them;
- sign-in;
- who may do what;
- the place people open the application from.

This document is the contract between them. Each rule says **must** (required to integrate) or **should** (strongly recommended). It links to the detailed documents rather than repeating them.

There are two ways to build on the platform:

| | An embedded product | An external product (this document) |
| --- | --- | --- |
| What it is | Code inside the platform's own repository (`src/product/`), one per fork | A separate application with its own server and database |
| Contract | `ProductModule` in `backend/src/kit/product.ts` ([extending.md](extending.md)) | The rules below, and a manifest |
| Data | Tables in the organization's own database | Its own database |
| Example | Invoices added to a fork of the kit | AppForge |

## The parts

| Part | Status | Detail |
| --- | --- | --- |
| A catalogue entry for the application, registered from a **manifest** | Available | [The manifest](#the-manifest) |
| **Sign-in** with the person's organization account (OpenID Connect) | Available | [SIGN_IN_WITH.md](SIGN_IN_WITH.md) |
| **Permissions** the application declares, granted in organizations' roles | Available | [SIGN_IN_WITH.md](SIGN_IN_WITH.md#the-applications-permissions) |
| **Menu entries** in the tenant portal, linking to the application's pages | Available | [The manifest](#the-manifest) |
| **Organizations turn it on** (entitlements) and open it from the Applications page | Available | [SIGN_IN_WITH.md](SIGN_IN_WITH.md) |
| **Lifecycle events**: an organization turned it on, was suspended or resumed, or left | Available | [Lifecycle events](#lifecycle-events) |
| **Service credentials** to call API v1 as the application, for the organizations that have it on | Available | [Calling the platform as the application](#calling-the-platform-as-the-application) |

## Rules

### Identity

1. **Must** sign people in only through the platform ([SIGN_IN_WITH.md](SIGN_IN_WITH.md)): the authorization code flow with PKCE, and exact redirect URIs. People don't get a separate password for the application.
2. **Must** identify a person by `sub` (`<tenant id>.<user id>`) and an organization by `tenant_id`, both from the ID token or userinfo. **Must not** use the email address as a key: the same address can belong to different people in different organizations, and it can change.
3. **Must** keep the client secret on the application's server (server-side applications), or use no secret (browser and mobile apps, registered as `PUBLIC`). A secret in browser code is a leaked secret.
4. **Should** ask only for the scopes it uses. `openid organization` is enough to know who and where. Add `email`, `profile` or `roles` when needed, and `offline_access` only for work done without the person present.

### Access

5. **Must** declare every permission it checks, named `<productId>:<action>` or `<productId>.<thing>:<action>` (e.g. `appforge:admin`, `appforge.workflows:run`). The platform refuses other names, so one product can't widen the platform's permissions or another product's.
6. **Must** decide what a person may do from the `permissions` claim, and nothing else. The organization's administrators manage access in the platform's role editor. The application **should not** have its own role screens that contradict them.
7. **Must** treat a failed token refresh, or a refused sign-in, as access withdrawn. It means the organization turned the application off, the person was deactivated or signed out everywhere, or the organization was suspended. **Must not** keep someone working on an old session after that. The platform checks again at every sign-in and refresh, not on every page load, so sessions **should** last no longer than the access token (one hour) before refreshing.

### Data

8. **Must** keep each organization's data apart, and scope every query by `tenant_id`. The platform keeps organizations apart in its own databases, but it can't see inside the application. Isolation there is the application's responsibility, and a leak between organizations is the worst failure it can have.
9. **Should** keep personal data (names, email addresses) as a cache of the platform's, refreshed at sign-in, rather than as a copy edited separately.
10. **Should** be ready to delete an organization's data when the organization leaves: `organization.deprovisioning_requested` announces it ([Lifecycle events](#lifecycle-events)).

### Calling the platform and receiving events

11. **Must** call only [API v1](API_V1.md) (`/api/v1/...`). It's the contract that stays compatible; other routes can change. **Must** call it from the application's server, never from the browser.
12. **Must** call the platform as itself with a [service credential](#calling-the-platform-as-the-application), asking only for the scopes it needs, and **must** keep its secret on the server. Organizations' API keys are for their own systems, not for products.
13. When receiving webhooks, the application **must** check the signature, **must** handle the same event twice (by its ID), and **should** answer within a few seconds and do slow work afterwards ([API_ACCESS.md](API_ACCESS.md#webhooks)).

### Presence in the platform

14. **Must** keep its manifest in its own repository and re-import it when it changes, so the catalogue matches what the application expects.
15. **Should** give each menu entry the permission that its page checks, so people only see links they can use.
16. **Should** set `openPath` to a page that starts signing in, so **Open** on the Applications page takes people straight in.

## The manifest

A JSON file in the application's repository (e.g. `appforge.manifest.json`). Platform staff import it on the platform's **Applications** page (**Import manifest**), or send it to `POST /api/applications/manifest`, which needs `app-registry:manage`.

Importing **creates the application if its `productId` is new, and updates it otherwise**. It can be imported as often as needed.

```json
{
  "manifestVersion": 1,
  "productId": "appforge",
  "name": "AppForge",
  "description": "Build applications and workflows without code",
  "version": "1.4.0",
  "baseUrl": "https://appforge.example.com",
  "provisioning": {
    "callbackUrl": "https://appforge.example.com/platform/events",
    "deletesDataOnDeprovision": true
  },
  "signIn": {
    "clientType": "CONFIDENTIAL",
    "redirectUris": ["https://appforge.example.com/auth/callback"],
    "postLogoutRedirectUris": ["https://appforge.example.com/"],
    "openPath": "/login"
  },
  "permissions": [
    { "name": "appforge:admin", "description": "Manage AppForge for the organization" },
    { "name": "appforge.apps:build", "description": "Create and change applications" },
    { "name": "appforge.workflows:run", "description": "Run workflows" }
  ],
  "menu": [
    { "label": "Applications", "path": "/apps", "icon": "Package", "permission": "appforge.apps:build" },
    { "label": "Workflows", "path": "/workflows", "icon": "Network", "permission": "appforge.workflows:run" }
  ]
}
```

| Field | Required | Rules |
| --- | --- | --- |
| `manifestVersion` | Yes | `1` |
| `productId` | Yes | Lowercase letters, digits and hyphens, 2–50 characters, starting with a letter or digit. It becomes the catalogue key and **can't change** later. Permission names start with it. |
| `name` | Yes | 2–100 characters. Shown to organizations. |
| `description` | No | Up to 500 characters. |
| `version` | Yes | The application's version, e.g. `1.4.0`. Shown on the Applications page; nothing depends on it. |
| `baseUrl` | Yes | Where the application lives: `https://`, or `http://localhost` while developing. No path, query or fragment. Menu paths and `openPath` are relative to it. |
| `signIn.clientType` | Yes | `CONFIDENTIAL` (a server keeps the secret) or `PUBLIC` (a browser or mobile app; PKCE only). |
| `signIn.redirectUris` | Yes | 1–10 exact addresses, `https://` or `http://localhost`, without a `#fragment`. |
| `signIn.postLogoutRedirectUris` | No | Up to 10, same rules. |
| `signIn.openPath` | No | A path starting with `/`, e.g. `/login`: the page that starts signing in. **Open** goes to `baseUrl + openPath` (OpenID's `initiate_login_uri`, with `?iss=`). |
| `provisioning.callbackUrl` | No | Where [lifecycle events](#lifecycle-events) go: an `http(s)` address without credentials or a `#fragment`. In production it must be `https` and not an inside address (loopback, private, link-local, cloud metadata), unless its host is listed in the platform's `PRODUCT_CALLBACK_ALLOWED_HOSTS` (an application on the same network, e.g. `appforge`). Without `provisioning`, organizations need no setup and no events are sent. |
| `provisioning.deletesDataOnDeprovision` | No | Whether the application deletes an organization's data when told it left (default `false`). Sent with `organization.deprovisioning_requested` and shown to platform staff. |
| `permissions` | No | Up to 100. Each has a `name` (see rule 5) and a `description` of up to 200 characters, shown in the role editor. Names are unique across the platform. |
| `menu` | No | Up to 20 entries. Each has a `label` (up to 40 characters), a `path` starting with `/` (relative to `baseUrl`), an optional `icon`, and an optional `permission`, which must be one of the manifest's own permissions. Unknown icons show a generic one. |

### What an import does

- **Application:** creates it as `ACTIVE`, or updates its name, description, version and base address. It never changes the status: making an application `INACTIVE` stays a decision for platform staff.
- **Sign-in:**
  - The first import creates the client and returns the **client ID and, for confidential clients, the secret, once**.
  - Later imports update the addresses and keep the same credentials. Replacing the secret is a separate action on the sign-in panel.
  - The first import turns sign-in on. Later imports leave it as platform staff set it, so a re-import never turns back on an application they turned off.
  - Switching between `CONFIDENTIAL` and `PUBLIC` must be confirmed (`?confirmClientTypeChange=true`, or the dialog asks), because it removes the client secret or makes a new one.
- **Permissions:**
  - New names are added and existing ones get the new description.
  - Permissions that are no longer in the manifest are **not removed**: organizations' roles may still contain them. The import lists them, and platform staff remove them on the Applications page once no role uses them.
- **Menu:** replaced by the manifest's.
- **Lifecycle events:**
  - The manifest decides where they go: an import without `provisioning` turns them off.
  - The first time a callback address is set, the import returns the **signing secret, once**.
  - Organizations that already had the application on are sent `organization.entitled` then.
- **Response:** says what was created, updated, and left alone.

Each import is recorded in the platform's audit log, with what changed: name, version, address, client type, redirect and sign-out addresses, open address, callback address. Secrets are never logged.

**Checking first:** `?dryRun=true` (the dialog's **Check** button) validates the manifest and reports what an import would change, without saving anything or making secrets.

Two imports of the same new product at the same time: one creates it, and the other updates it or answers `409 CONCURRENT_IMPORT` (import again).

### Menu entries in the tenant portal

For each organization that has the application turned on, the sidebar shows a section named after the application, placed after Dashboard. It holds the manifest's menu entries the person may use (those without a `permission`, or whose permission they hold). Each entry opens `baseUrl + path` in a new tab, where the person signs in with their organization account if they aren't already.

## Lifecycle events

The platform tells the application when something happens to an organization's use of it, so the application can set the organization up or clean it up. This is the external version of an embedded product's `onTenantCreated`.

They're sent only if the application has a callback address: the manifest's `provisioning.callbackUrl`, or the **Lifecycle events** panel on the platform's Applications page.

### The events

| Event | When | What the application should do |
| --- | --- | --- |
| `organization.entitled` | The organization turns the application on (ENABLED or TRIAL), or turns it on again. Also sent when a callback address is first added, to each organization that already has it on. | Create the organization's workspace. Must be safe to receive twice. |
| `organization.entitlement_changed` | The entitlement changes while it exists: TRIAL ↔ ENABLED, a new end date, or DISABLED. | Apply the change: e.g. trial limits, or read-only while DISABLED. |
| `organization.suspended` | Platform staff suspend the organization, or its admins close it. Sign-in and token refresh already stop. | Stop background work for it. Keep its data. |
| `organization.resumed` | It's active again. | Resume. |
| `organization.deprovisioning_requested` | The organization turns the application off for good (removes the entitlement), or the organization is deleted. | Delete its data if `deleteData` is true; otherwise keep it as the application's policy says. |

An entitlement that simply passes its end date sends nothing; `validTo` was in the earlier events.

### Operations

Setting an organization up is an **operation**. `organization.entitled` starts one, with a new `operation.id` and a `generation` one higher than the last. The events that follow (`entitlement_changed`, `suspended`, `resumed`) carry the same operation. `organization.deprovisioning_requested` starts a new operation for the clean-up.

If an organization turns the application off and on again before the first setup finished, the second `organization.entitled` has a higher generation. The application **should** drop work for an older generation. The platform refuses a result for an older operation (below), so a late answer can't mark the newer setup as done.

### What's sent

A `POST` with a JSON body, signed like [webhooks](API_ACCESS.md#checking-it-came-from-us), using the application's own **signing secret** (`whsec_…`). The signature is in the headers `webhook-id`, `webhook-timestamp` and `webhook-signature`, and `User-Agent` is `Multitenant-Lifecycle/1`.

```json
{
  "id": "evt_9mZ2cQ4kLx7pT1vB",
  "type": "organization.entitled",
  "timestamp": "2026-11-03T09:12:44.512Z",
  "schemaVersion": 1,
  "data": {
    "application": { "id": "9d3e…", "key": "appforge" },
    "organization": { "id": "5b0f…", "slug": "acme-corp", "name": "Acme Corporation", "suspended": false },
    "entitlement": { "state": "ENABLED", "validFrom": "2026-11-03T09:12:44.000Z", "validTo": null },
    "operation": { "id": "op_Qm4xT7c2LpZ9vW1b", "generation": 1 }
  }
}
```

`organization.deprovisioning_requested` has `"entitlement": null`. It also has `"reason"` (`entitlement_removed` or `organization_deleted`) and `"deleteData"`. `schemaVersion` changes only when a field changes meaning; new fields can appear at any time, so the application **must** ignore fields it doesn't know.

The application **must**:
- check the signature. During a [rotation](#rotating-the-signing-secret), `webhook-signature` holds two signatures separated by a space, and one matching is enough;
- refuse a `webhook-timestamp` more than 5 minutes from its own clock, so a captured request can't be replayed later;
- handle the same `id` twice, because retries resend it;
- answer within 10 seconds.

Standard Webhooks libraries (e.g. `standardwebhooks` for Node) do the first three.

### Answering, and setting the organization up

| The application answers | Meaning |
| --- | --- |
| `200`–`299`, except `202` | Done. For `organization.entitled`: the organization is set up (`READY`). |
| `202` | Accepted, finishing later. For `organization.entitled`, the organization stays `PENDING` until the application reports back (below). |
| Anything else, a redirect, or nothing within 10 seconds | Failed. Retried after 30 seconds, 2 minutes, 10 minutes, 30 minutes, 2 hours, 6 hours and 24 hours, then given up. For `organization.entitled`, the organization is then `FAILED`. |

While an organization is `PENDING` or `FAILED`:
- its Applications page shows "being set up", or that setup didn't finish, instead of **Open**;
- the application's sidebar section is hidden;
- **signing in to the application is refused**, with "still being set up" (fail closed).

To report back after a `202`, the application calls API v1 with a [service access token](#calling-the-platform-as-the-application) that has the `lifecycle.report` scope, naming the operation from the event:

```
POST /api/v1/product-integrations/operations/<operation id>/result
Authorization: Bearer <service access token>
Content-Type: application/json

{ "generation": 1, "status": "READY" }                                → 204
{ "generation": 1, "status": "FAILED", "message": "Quota exceeded" }  → 204
```

| Answer | Why |
| --- | --- |
| `204` | Recorded. The same result again is also `204`, so retrying a report is safe. |
| `401` | No token, or an invalid, expired or revoked one. |
| `403 INSUFFICIENT_SCOPE` | The token doesn't have `lifecycle.report`. |
| `404` | No such operation for this application. Another application's operations are not found. |
| `409 STALE_OPERATION` | A newer operation replaced this one, or the generation doesn't match. Drop this work. |
| `409 INVALID_TRANSITION` | The operation already finished `READY`. A later failure is the application's to handle, not a setup result. |

After `FAILED`, it can report `READY` once the problem is fixed.

### Order and retries

Events for one organization are sent **in order**. A later event waits while an earlier one is still being retried, so `organization.suspended` never arrives before the `organization.entitled` it follows.

The **Lifecycle events** panel shows:
- each organization's setup status;
- the last 50 events, with the application's answers;
- **Retry now** for an event that's waiting or was given up.

Retries are spread by ±20%, so after an outage events don't all arrive at once. An error on the platform's side (for example a secret that can't be decrypted) counts as a failed attempt too, and shows on the panel.

### Rotating the signing secret

**New signing secret** on the panel makes a new secret, shown once. For the next 24 hours, events are signed with both the new and the old secret. That way the application can switch to the new one without missing or rejecting events. After 24 hours only the new one signs.

## Calling the platform as the application

The application's server calls [API v1](API_V1.md) as itself with **service credentials**: OAuth 2.0 client credentials, separate from its sign-in client. Platform staff make them in the **Service credentials** panel on the Applications page.

Each credential has:
- a client ID (`mts_…`);
- a secret, **shown once** and stored encrypted;
- the scopes it may ask for.

An application can have several credentials at once.

### Scopes

| Scope | Allows |
| --- | --- |
| `organizations.read` | Seeing the organizations that have the application on, and their setup status (coming next) |
| `members.read` | Seeing the people and groups in those organizations (coming next) |
| `lifecycle.report` | [Reporting setup results](#answering-and-setting-the-organization-up) |

### Getting a token

```
POST /api/oidc/token
Authorization: Basic base64(<client id>:<client secret>)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&scope=lifecycle.report
```

```json
{ "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 600, "scope": "lifecycle.report" }
```

The answer only includes scopes the credential has. Asking for no scope gives a token that can only call `GET /api/v1/products/me`.

The token is a JWT signed by the platform (`typ: at+jwt`), valid for **10 minutes**. Its claims:
- `iss`: the issuer;
- `aud`: `urn:multitenant:api:v1`;
- `client_id`;
- `product_id`: the application's key;
- `scope`;
- `exp`.

The application doesn't need to check it; it only sends it:

```
GET /api/v1/products/me
Authorization: Bearer <access token>
→ { "product": { "id": "…", "key": "appforge", "name": "AppForge" }, "credential": { "id": "…", "name": "Production" }, "scopes": ["lifecycle.report"] }
```

With the TypeScript client, `createProductClient` gets tokens and renews them a minute before they expire ([clients/typescript](../clients/typescript/README.md)).

### What the platform checks on every call

1. The token: signature, issuer, audience, expiry.
2. That its credential still exists and isn't revoked, and that the application is active. So **revoking a credential stops it at once**, even its unexpired tokens.
3. That the route's scope is both in the token and still on the credential.
4. For anything about an organization: that the organization has the application on **now**. Nothing in the token decides which organizations it can see.

| Answer | Code | Meaning |
| --- | --- | --- |
| `401` | `INVALID_TOKEN`, `TOKEN_EXPIRED`, `CREDENTIAL_REVOKED` | Get a new token (or a new credential) |
| `403` | `INSUFFICIENT_SCOPE` | Ask for the scope, and have it on the credential |
| `403` | `APPLICATION_INACTIVE` | Platform staff took the application offline |

### Replacing a credential

1. Make a new credential.
2. Deploy the application with it.
3. Revoke the old one.

Both work in between, so there's no downtime. A leaked secret: revoke the credential right away.

## Planned

- **Organizations and members in API v1:**
  - the organizations that have the application on, with their setup status (`organizations.read`);
  - their people and groups, paginated (`members.read`).
- **Revocation:**
  - OpenID Connect Back-Channel Logout, so the platform tells the application to end a person's sessions;
  - user events (`user.deactivated`, `user.updated`, `user.removed`, `user.permissions_changed`);
  - a configurable access token lifetime.

## Checklist before going live

- [ ] The manifest is in the application's repository, imported, and the client secret is stored on the application's server.
- [ ] Service credentials (if used) ask only for the scopes needed, live on the server, and can be replaced without downtime.
- [ ] Sign-in uses PKCE, with exact redirect URIs, and checks the ID token (issuer, audience, signature, nonce).
- [ ] People and organizations are keyed by `sub` and `tenant_id`, never by email.
- [ ] Every query is scoped to the organization; a test proves one organization can't read another's data.
- [ ] Access comes from the `permissions` claim; every page checks one, and its menu entry has the same.
- [ ] A refused sign-in or a failed refresh ends the session.
- [ ] Calls to the platform go to API v1, from the server.
- [ ] Webhooks, if used, are verified and handled idempotently.
- [ ] Lifecycle events, if used, are verified, handled idempotently, answered within 10 seconds (`202` for slow setup, then a report), and set up or clean up the organization.
- [ ] An organization's data can be deleted when it leaves.
