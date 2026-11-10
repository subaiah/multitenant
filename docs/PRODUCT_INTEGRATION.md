# Integrating a product

How a separate application, such as AppForge, becomes part of the platform. The application keeps its own server, database and releases. The platform provides:

- the organizations and the people in them;
- sign-in;
- who may do what;
- the place people open the application from.

For where this is heading (applications that work with each other, not only with the platform), see [hub/HUB_GAPS.md](hub/HUB_GAPS.md).

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
| **Organizations, people and groups** in API v1, and the application's **event history** | Available | [Reading organizations and people](#reading-organizations-and-people) |
| **User events**: someone was added, changed, deactivated, reactivated or removed, or their permissions for the application changed | Available (opt-in) | [User events](#user-events) |
| **What organizations see**: each organization's administrators see what the application's server can learn about their people | Available | [What organizations see](#what-organizations-see) |
| **Back-Channel Logout** and a configurable **access token lifetime** | Available | [Ending access at once](#ending-access-at-once) |
| **Integrations page** for platform staff | Available | [The Integrations page](#the-integrations-page) |
| **Manifest version 2**: `kind` and declared notification and audit event types (more v2 fields to come) | Available (partly) | [hub/MANIFEST_V2.md](hub/MANIFEST_V2.md) |
| **The platform's services**: send notifications to an organization's people, write to its audit log | Available | [Using the platform's services](#using-the-platforms-services) |
| **Calling other applications**, as itself or on behalf of the person using it; organizations see and block connections | Available | [Calling other applications](#calling-other-applications) |

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
    "deletesDataOnDeprovision": true,
    "userEvents": true
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
| `signIn.backchannelLogoutUri` | No | Where the platform sends a logout token when it ends a person's sessions ([Back-Channel Logout](SIGN_IN_WITH.md#when-the-platform-ends-someones-sessions-back-channel-logout)). Same address rules as the lifecycle callback. |
| `signIn.accessTokenLifetime` | No | How long access tokens last, in seconds: 60 to 86400 (default 900, 15 minutes). Shorter means a change of access reaches the application sooner. |
| `provisioning.callbackUrl` | No | Where [lifecycle events](#lifecycle-events) go: an `http(s)` address without credentials or a `#fragment`. In production it must be `https` and not an inside address (loopback, private, link-local, cloud metadata), unless its host is listed in the platform's `PRODUCT_CALLBACK_ALLOWED_HOSTS` (an application on the same network, e.g. `appforge`). Without `provisioning`, organizations need no setup and no events are sent. |
| `provisioning.deletesDataOnDeprovision` | No | Whether the application deletes an organization's data when told it left (default `false`). Sent with `organization.deprovisioning_requested` and shown to platform staff. |
| `provisioning.userEvents` | No | Also send [user events](#user-events) when people change (default `false`). Organizations' administrators see this. |
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

## User events

With `provisioning.userEvents` (or **Also tell it when people change** on the Lifecycle events panel), the application is also told when people change in an organization that has it turned on. This lets it end access at once, without waiting for the person to sign in again. The events go to the same callback, signed and in the same order as lifecycle events, and show up in the event history.

| Event | When | `data` beyond `application` and `organization` |
| --- | --- | --- |
| `user.added` | Someone joined (invited, or signed in with single sign-on the first time) | `user`, `permissions` |
| `user.updated` | Their email, name or type changed, or they accepted their invitation (`changes` includes `status`) | `user`, `changes` (e.g. `["name"]`) |
| `user.deactivated` | Their account was deactivated: **end their sessions** | `user` |
| `user.reactivated` | Their account was reactivated | `user`, `permissions` |
| `user.removed` | They were removed from the organization: **end their sessions** and drop or anonymize what you keep about them | `user` (`id` and `subject` only) |
| `user.permissions_changed` | The application's own permissions they hold changed | `user`, `permissions` (now), `added`, `removed` |

`user` is `{ id, subject, email, name, userType, status }`, as in [Reading organizations and people](#reading-organizations-and-people). `permissions` are only the application's own.

How changes are found:
- **By comparing, not guessing.** After any change to people, groups, roles or delegations in an organization, each person is compared with what the application was last told. So editing or deleting a role, deactivating a group, or adding someone to a group all come out as the right `user.permissions_changed` events, for exactly the people affected. A burst of changes is gathered for a moment and sent as one pass.
- **Every hour, everyone is compared again.** This catches what changes with time, such as an assignment or delegation that expired, or anything that happened while the platform was down.
- **Nothing on the first pass.** When an organization turns the application on, or the application starts asking for user events, everyone is recorded without sending anything. The application reads the members through the API while setting the organization up.
- **No plain personal data is kept to do this.** The platform keeps keyed hashes of email and name, plus type, status and the application's permission names.

Answer with any `2xx`. An application that doesn't recognize an event type should still answer `2xx`. Don't let an unknown event stall the organization's queue.

## What organizations see

On **Application Entitlements**, an organization's administrators see, for each application they have on and in the **Add Application** dialog before turning one on, what its server can learn about their people:
- **read your people and groups**, when it has a live service credential with `members.read`;
- **be told when someone changes**, when it takes user events.

Ask only for what you use: these show up in plain words.

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
| `organizations.read` | Seeing the organizations that have the application, their setup status, and the application's lifecycle events |
| `members.read` | Seeing the people and groups in those organizations, while they have it on |
| `lifecycle.report` | [Reporting setup results](#answering-and-setting-the-organization-up) |
| `notifications.send` | [Sending its declared notifications](#notifications) to people in those organizations |
| `audit.write` | [Writing its declared audit events](#audit-events) to those organizations' audit logs |

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
| `403` | `NOT_ENTITLED` | The organization doesn't have the application on now (people and groups only) |
| `404` | `NOT_FOUND` | No organization with that id has the application (another application's organizations are not found either) |
| `409` | `ORGANIZATION_NOT_READY` | The organization is still being created |

### Replacing a credential

1. Make a new credential.
2. Deploy the application with it.
3. Revoke the old one.

Both work in between, so there's no downtime. A leaked secret: revoke the credential right away.

## Reading organizations and people

All under `/api/v1/product-integrations`, with a service token. Lists are paged with `page` and `limit` (at most 100) and answer `{ <items>, pagination: { page, limit, total, pages } }`.

| Route | Scope | What |
| --- | --- | --- |
| `GET /organizations` | `organizations.read` | The organizations with an entitlement to the application, **in any state**, oldest first. Filters: `active`, `setupStatus`, `search`. |
| `GET /organizations/{id}` | `organizations.read` | One of them (`404` for any other organization) |
| `GET /organizations/{id}/members` | `members.read` | Its people, oldest first. Filters: `status`, `groupId`, `updatedSince`, `search`. |
| `GET /organizations/{id}/groups` | `members.read` | Its groups, by name, with how many people are in each now |
| `GET /events` | `organizations.read` | The application's own lifecycle events, oldest first, from a cursor |

**An organization** carries:
- `entitlement`: its state and dates, and `active` (turned on now);
- `setup`: the status, error and current operation, as the lifecycle events left them;
- `suspended`;
- `available`: whether its people can sign in to the application now (turned on, not suspended, set up).

Use the list to **reconcile** with what the events said, for example after the application was down.

**People and groups** can be read only while the organization has the application turned on (`403 NOT_ENTITLED` otherwise), whether or not setup is finished: setting an organization up usually needs them.

**A person** carries:
- `subject`: the `sub` they sign in with (`<organization id>.<user id>`). Key them by it, not by email;
- `email`, `name`, `userType`, `status`;
- `groups`: the active groups they're in now;
- `roles`;
- `permissions`: **only the application's own permissions** that they hold now, as in the `permissions` claim at sign-in. Administrators hold them all. People who aren't `ACTIVE` hold none.

Nothing secret (passwords, two-factor settings) is ever included.

`updatedSince` finds people whose **account** changed (name, email, type, status). It doesn't see group or role changes, or people removed: take [user events](#user-events) for those, or run a full pass now and then.

**Events** come back exactly as they were sent (`payload`), with how delivery went. The answer has:
- `nextAfter`: pass it as `after` for the next page. It's given on the last page too, so keep it and poll from it to catch any event the application missed;
- `hasMore`.

## Using the platform's services

An application can use two of the platform's own services, so an organization has one notification bell and one audit trail across all its applications. Both need **manifest version 2** with the types declared under `platformServices` ([hub/MANIFEST_V2.md](hub/MANIFEST_V2.md)), and work only for organizations that have the application turned on (`404` for others, `403 NOT_ENTITLED` while it's off).

```json
"manifestVersion": 2,
"kind": "generic",
"platformServices": {
  "notifications": [
    { "type": "hearth.mention", "label": "Someone mentioned you", "description": "In a conversation", "defaultChannels": ["in_app", "email"] }
  ],
  "auditEvents": [
    { "type": "hearth.channel.archived", "label": "Channel archived" }
  ]
}
```

- **Type names** start with the `productId` and a dot, then lowercase letters, digits, `_` and `-` in dot-separated parts. Never one of the platform's own types.
- **Declared types appear only where they apply.** An organization sees an application's types in its notification rules, in people's preferences, in the audit log filter and as webhook event types only while it has that application on. Webhooks mean an organization can send an application's audit events to its own systems.
- **A type left out of a later manifest is retired, not removed.** It stays known, so old entries and saved rules still read right, but can't be sent or written. Putting it back brings it back. A version 1 manifest leaves declared types alone.

### Notifications

`POST /api/v1/product-integrations/organizations/{organizationId}/notifications`, scope `notifications.send`:

```json
{
  "type": "hearth.mention",
  "title": "Priya mentioned you",
  "body": "In #launch: can you check the copy?",
  "link": "/channels/launch",
  "to": { "subjects": ["<organization id>.<user id>"] }
}
```

The answer is `202`. The notification then reaches each person's bell, and their email if the organization's rules and their preferences allow it.

Notifications go out under the platform's name, so they're held to these rules:

- **Plain text.** `title` (up to 120 characters) and `body` (up to 1000) are never shown as HTML.
- **Always titled with the application's name**, e.g. "Hearth: Priya mentioned you".
- **Links only to the application's own pages.** Use a path (`/channels/launch`) or a full address on the same host as `baseUrl`. Anything else is refused (`INVALID_LINK`).
- **Recipients in the organization.** Use `to.subjects` (up to 500, as in the ID token), `to.groupIds` (up to 50, from the members API), or `to.permission`: everyone holding one of the application's own permissions. People outside the organization are refused (`UNKNOWN_RECIPIENTS`); people who aren't active are skipped.
- **The organization's rules and people's preferences apply.** An organization can turn a type off, or limit its channels.
- **At most 120 a minute** per service credential (`429 RATE_LIMITED`, with `Retry-After`).

### Audit events

`POST /api/v1/product-integrations/organizations/{organizationId}/audit-events`, scope `audit.write`:

```json
{
  "type": "hearth.channel.archived",
  "onBehalfOf": "<organization id>.<user id>",
  "resource": { "type": "channel", "id": "c_123", "label": "#launch" },
  "details": { "reason": "inactive" }
}
```

The answer is `201`, with `seq`, the entry's position in the organization's log.

- **The entry is the application's own.** It's recorded with actor type `APPLICATION` and the `productId` as the actor, and its category is `application`. A person the application says it acted for goes in `details.onBehalfOf` (subject and email), never as the actor. It's the application's report, kept apart from what the platform records itself.
- It goes into the same tamper-evident chain as everything else, so the organization's **Verify** still covers it.
- `details` can be up to 4000 characters as JSON. `outcome` is `SUCCESS` (the default) or `FAILURE`.
- **At most 600 a minute** per service credential.

## Calling other applications

One application can call another application's own API, for example CRMForge creating a conversation in Hearth. The platform issues the token, addressed to the target, and checks the organization ([ADR-0001](adr/0001-app-to-app-calls.md)). Both applications need **manifest version 2**.

**The target exposes scopes** (`api.scopes`). Names follow the permission rule, under its own key. A scope with `allowsOnBehalfOf` can also be used on behalf of a person. The target's audience is always `urn:mt:app:<productId>`.

```json
"api": {
  "scopes": [
    { "name": "hearth.threads:read",  "description": "Read record threads",        "allowsOnBehalfOf": true },
    { "name": "hearth.threads:write", "description": "Start and post to threads",  "allowsOnBehalfOf": true },
    { "name": "hearth.messages:post", "description": "Post messages as a bot" }
  ],
  "openApiUrl": "https://hearth.example.com/openapi.json"
}
```

**The caller consumes them** (`consumes`), with a reason. Organizations' administrators read the reason. Consuming a scope no registered application exposes yet only gives a warning on import (`api.notExposedYet`).

```json
"consumes": [
  { "scope": "hearth.threads:read",  "reason": "Show the conversation on a deal" },
  { "scope": "hearth.threads:write", "reason": "Start a conversation when a deal is created" }
]
```

### Getting a token

Any of the caller's service credentials can get one. It doesn't need a particular service scope: what it may ask for comes from the two manifests.

- **A machine call**, for one organization:

  ```
  POST /api/oidc/token   (Basic: the caller's service credential)
  grant_type=client_credentials&resource=urn:mt:app:hearth&organization_id=<id>&scope=hearth.threads:write
  ```

  The token is a JWT (`typ: at+jwt`, 10 minutes) with `aud` (the target), `tenant_id`, `product_id` (the caller), `client_id` and `scope`. Scopes asked for that the connection doesn't allow are left out.

- **On behalf of a person**, exchanging the access token they got signing in to the caller ([RFC 8693](https://www.rfc-editor.org/rfc/rfc8693)):

  ```
  POST /api/oidc/token   (Basic: the caller's service credential)
  grant_type=urn:ietf:params:oauth:grant-type:token-exchange
  &subject_token=<their access token for the caller>
  &subject_token_type=urn:ietf:params:oauth:token-type:access_token
  &resource=urn:mt:app:hearth            (audience= works too)
  &scope=hearth.threads:read             (optional: every scope that allows it)
  ```

  The token lasts 5 minutes, with no refresh token: exchange again when you need one. It adds:
  - `sub`, the person;
  - `act: { sub, product_id }`, who is acting;
  - `permissions`, **the person's permissions in the target application**, as when they sign in to it.

  A scope without `allowsOnBehalfOf` is refused (`invalid_scope`). So is a subject token issued to another application, or for a person who can't use the caller any more (`invalid_grant`).

A token is issued only when **all** of these hold:
- both applications are active;
- the organization has both turned on and set up;
- the caller consumes a scope the target exposes;
- the organization hasn't blocked the connection.

Otherwise the answer is `access_denied`, `invalid_target`, `invalid_scope` or `invalid_request`, with a description.

### Checking a token, in the target

- Check the signature against the platform's keys (`jwks_uri`), and `iss`, `aud` (your own `urn:mt:app:<productId>`), `exp` and `typ: at+jwt`.
- **Scope every query by `tenant_id`.**
- On behalf of a person, authorize with the token's `sub` and `permissions`, never the caller's, and record `act.sub` in your own audit entries.

The TypeScript client does both sides:

```ts
import { createAppTokens, createAppTokenVerifier } from '@multitenant/api-client';

// The caller
const tokens = createAppTokens({ tokenUrl, clientId, clientSecret });
const machine = await tokens.forOrganization('hearth', organizationId, ['hearth.threads:write']);
const asPerson = await tokens.onBehalfOf(personAccessToken, 'hearth', ['hearth.threads:read']);

// The target
const verify = createAppTokenVerifier({ issuer: 'https://app.example.com/api/oidc', productId: 'hearth' });
const caller = await verify(request.headers.authorization);   // { tenantId, productId, scopes, person }
```

Tokens are short-lived, so changes cut off **new** tokens at once:
- a credential revoked;
- an application made inactive;
- an entitlement removed;
- a connection blocked;
- a person deactivated.

Tokens already issued run out on their own (5 or 10 minutes).

### What organizations see

On **Application Entitlements**, **Connections between applications** lists every pair of applications the organization has on where one calls the other. For each, it shows:
- what the caller may do in the target, and why;
- which actions are done "as the person using it";
- how often the connection was used.

Connections are allowed by default. Administrators (`applications:manage`) can **Block** one, which stops new tokens at once, and **Allow** it again. Both go into the audit log. Platform staff see each application's connections and use on the **Integrations** page.

## Ending access at once

Three things together mean a person who loses access loses it in the application too, without waiting:

1. **Back-Channel Logout** (`signIn.backchannelLogoutUri`). The platform tells the application to end the person's sessions when they sign out everywhere, are deactivated or removed, or their organization is suspended, closed or turns the application off ([details](SIGN_IN_WITH.md#when-the-platform-ends-someones-sessions-back-channel-logout)).
2. **User events** ([above](#user-events)). The application learns about permission changes, and about deactivations and removals, even for people with no session.
3. **Short access tokens** (`signIn.accessTokenLifetime`, 15 minutes by default). Each refresh checks the person again.

## The Integrations page

Platform staff see every external product on one page (**Customers → Integrations**), with a link to each one's panels:
- whether sign-in is on, the token lifetime, and whether back-channel logout is set;
- the callback and user events;
- service credentials and when they were last used;
- its organizations' setup: ready, setting up or failed;
- lifecycle events and logout tokens: waiting, given up, and when the last one was delivered.

Products that need attention come first: a failed setup, events given up or waiting over an hour, or logout tokens given up.

## Checklist before going live

- [ ] The manifest is in the application's repository, imported, and the client secret is stored on the application's server.
- [ ] Service credentials (if used) ask only for the scopes needed, live on the server, and can be replaced without downtime.
- [ ] People read from the platform are keyed by `subject`; user events (or a periodic full pass) catch group, role and removal changes.
- [ ] User events, if taken, end a person's sessions on `user.deactivated` and `user.removed`, and unknown event types are answered `2xx`.
- [ ] Notifications and audit events, if used, are declared in the manifest (version 2), and links in notifications point to the application's own pages.
- [ ] Calls to other applications use tokens from the platform (never shared secrets), and an application that exposes scopes checks `aud`, `tenant_id` and, on behalf of a person, the token's `permissions`.
- [ ] A back-channel logout address is registered; its handler verifies the logout token (signature, `iss`, `aud`, `exp`, `events`), ends that person's sessions and answers `200`.
- [ ] Sign-in uses PKCE, with exact redirect URIs, and checks the ID token (issuer, audience, signature, nonce).
- [ ] People and organizations are keyed by `sub` and `tenant_id`, never by email.
- [ ] Every query is scoped to the organization; a test proves one organization can't read another's data.
- [ ] Access comes from the `permissions` claim; every page checks one, and its menu entry has the same.
- [ ] A refused sign-in or a failed refresh ends the session.
- [ ] Calls to the platform go to API v1, from the server.
- [ ] Webhooks, if used, are verified and handled idempotently.
- [ ] Lifecycle events, if used, are verified, handled idempotently, answered within 10 seconds (`202` for slow setup, then a report), and set up or clean up the organization.
- [ ] An organization's data can be deleted when it leaves.
