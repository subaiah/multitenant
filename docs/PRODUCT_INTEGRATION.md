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
| **A service credential** to call the platform for every organization that has it on | Planned | [Planned](#planned) |

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
10. **Should** be ready to delete an organization's data when the organization leaves: `organization.deprovisioned` announces it ([Lifecycle events](#lifecycle-events)).

### Calling the platform and receiving events

11. **Must** call only [API v1](API_V1.md) (`/api/v1/...`). It's the contract that stays compatible; other routes can change. **Must** call it from the application's server, never from the browser.
12. Until the service credential arrives, an organization that wants the application to read its data creates an [API key](API_ACCESS.md#api-keys) for it, limited to the permissions it needs.
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
| `provisioning.callbackUrl` | No | Where [lifecycle events](#lifecycle-events) go: an `http(s)` address without credentials or a `#fragment`. It may be on the same network as the platform, since platform staff register it. Without `provisioning`, organizations need no setup and no events are sent. |
| `provisioning.deletesDataOnDeprovision` | No | Whether the application deletes an organization's data when told it left (default `false`). Sent with `organization.deprovisioned` and shown to platform staff. |
| `permissions` | No | Up to 100. Each has a `name` (see rule 5) and a `description` of up to 200 characters, shown in the role editor. Names are unique across the platform. |
| `menu` | No | Up to 20 entries. Each has a `label` (up to 40 characters), a `path` starting with `/` (relative to `baseUrl`), an optional `icon`, and an optional `permission`, which must be one of the manifest's own permissions. Unknown icons show a generic one. |

### What an import does

- **Application:** creates it as `ACTIVE`, or updates its name, description, version and base address. It never changes the status: making an application `INACTIVE` stays a decision for platform staff.
- **Sign-in:**
  - The first import creates the client and returns the **client ID and, for confidential clients, the secret, once**.
  - Later imports update the addresses and keep the same credentials. Replacing the secret is a separate action on the sign-in panel.
  - Importing turns sign-in on.
- **Permissions:**
  - New names are added and existing ones get the new description.
  - Permissions that are no longer in the manifest are **not removed**: organizations' roles may still contain them. The import lists them, and platform staff remove them on the Applications page once no role uses them.
- **Menu:** replaced by the manifest's.
- **Lifecycle events:**
  - The manifest decides where they go: an import without `provisioning` turns them off.
  - The first time a callback address is set, the import returns the **signing secret, once**.
  - Organizations that already had the application on are sent `organization.entitled` then.
- **Response:** says what was created, updated, and left alone.

Each import is recorded in the platform's audit log.

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
| `organization.deprovisioned` | The organization turns the application off for good (removes the entitlement), or the organization is deleted. | Delete its data if `deleteData` is true; otherwise keep it as the application's policy says. |

An entitlement that simply passes its end date sends nothing; `validTo` was in the earlier events.

### What's sent

A `POST` with a JSON body, signed like [webhooks](API_ACCESS.md#checking-it-came-from-us), using the application's own **signing secret** (`whsec_…`). The signature is in the headers `webhook-id`, `webhook-timestamp` and `webhook-signature`, and `User-Agent` is `Multitenant-Lifecycle/1`.

```json
{
  "id": "evt_9mZ2cQ4kLx7pT1vB",
  "type": "organization.entitled",
  "timestamp": "2026-11-03T09:12:44.512Z",
  "data": {
    "application": { "key": "appforge" },
    "organization": { "id": "5b0f…", "slug": "acme-corp", "name": "Acme Corporation", "suspended": false },
    "entitlement": { "state": "ENABLED", "validFrom": "2026-11-03T09:12:44.000Z", "validTo": null }
  }
}
```

`organization.deprovisioned` has `"entitlement": null`. It also has `"reason"` (`entitlement_removed` or `organization_deleted`) and `"deleteData"`.

The application **must**:
- check the signature;
- handle the same `id` twice, because retries resend it;
- answer within 10 seconds.

### Answering, and setting the organization up

| The application answers | Meaning |
| --- | --- |
| `200`–`299`, except `202` | Done. For `organization.entitled`: the organization is set up (`READY`). |
| `202` | Accepted, finishing later. For `organization.entitled`, the organization stays `PENDING` until the application reports back (below). |
| Anything else, a redirect, or nothing within 10 seconds | Failed. Retried after 30 seconds, 2 minutes, 10 minutes, 30 minutes, 2 hours, 6 hours and 24 hours, then given up. For `organization.entitled`, the organization is then `FAILED`. |

While an organization is `PENDING` or `FAILED`, its Applications page shows "being set up" (or that setup didn't finish) instead of **Open**, and the application's sidebar section is hidden. Sign-in itself still works, so the application decides what a person sees before their organization is ready.

To report back after a `202`, the application calls the platform with its sign-in client ID and secret (HTTP Basic; confidential clients only):

```
POST /api/product-api/organizations/<organization id>/provisioning
Authorization: Basic base64(<client id>:<client secret>)
Content-Type: application/json

{ "status": "READY" }                        → 204
{ "status": "FAILED", "message": "Quota exceeded" }   → 204
```

It can report again at any time, e.g. `READY` after fixing a failure.

### Order and retries

Events for one organization are sent **in order**. A later event waits while an earlier one is still being retried, so `organization.suspended` never arrives before the `organization.entitled` it follows.

The **Lifecycle events** panel shows:
- each organization's setup status;
- the last 50 events, with the application's answers;
- **Retry now** for an event that's waiting or was given up.

## Planned

- **A service credential.** The application will get its own client credentials to call API v1 for any organization that has it turned on: to read people and groups, write to the organization's audit log, and send notifications. API keys from each organization will no longer be needed.

## Checklist before going live

- [ ] The manifest is in the application's repository, imported, and the client secret is stored on the application's server.
- [ ] Sign-in uses PKCE, with exact redirect URIs, and checks the ID token (issuer, audience, signature, nonce).
- [ ] People and organizations are keyed by `sub` and `tenant_id`, never by email.
- [ ] Every query is scoped to the organization; a test proves one organization can't read another's data.
- [ ] Access comes from the `permissions` claim; every page checks one, and its menu entry has the same.
- [ ] A refused sign-in or a failed refresh ends the session.
- [ ] Calls to the platform go to API v1, from the server.
- [ ] Webhooks, if used, are verified and handled idempotently.
- [ ] Lifecycle events, if used, are verified, handled idempotently, answered within 10 seconds (`202` for slow setup, then a report), and set up or clean up the organization.
- [ ] An organization's data can be deleted when it leaves.
