# Manifest version 2 (proposal)

**Status:** Partly implemented: `kind` and `platformServices` (10 Nov 2026), `api` and `consumes` (11 Nov 2026), `requires` and `integratesWith` (12 Nov 2026). The rest is a proposal.
**Date:** 9 Nov 2026
**Builds on:** manifest v1 in [PRODUCT_INTEGRATION.md](../PRODUCT_INTEGRATION.md#the-manifest)

Version 2 adds what an application needs to work **with other applications** in the hub ([HUB_GAPS.md](HUB_GAPS.md)). Every v1 field keeps its meaning and rules. A v1 manifest keeps working; importing it never removes v2 data set earlier (the import reports it as left alone).

## What's implemented

| Field | Status |
| --- | --- |
| `manifestVersion: 2`, `kind` | Implemented |
| `platformServices.notifications`, `platformServices.auditEvents` | Implemented, with `notifications.send` and `audit.write` ([PRODUCT_INTEGRATION.md](../PRODUCT_INTEGRATION.md#using-the-platforms-services)) |
| `api` (scopes, openApiUrl), `consumes` | Implemented, with application-to-application tokens ([PRODUCT_INTEGRATION.md](../PRODUCT_INTEGRATION.md#calling-other-applications)) |
| `requires`, `integratesWith` | Implemented: enforced when organizations turn applications on and off, never turned on automatically; plus bundles ([PRODUCT_INTEGRATION.md](../PRODUCT_INTEGRATION.md#dependencies-and-bundles)) |
| `embeds` | Implemented, with the embeds list, branding and the application launcher ([PRODUCT_INTEGRATION.md](../PRODUCT_INTEGRATION.md#embedding-another-application)) |
| `events` (emits, subscribes) | Implemented, with `events.publish` ([PRODUCT_INTEGRATION.md](../PRODUCT_INTEGRATION.md#events-between-applications)) |
| `limits`, `usage` | Implemented: values per plan, sent with lifecycle events and told again when they change; usage reported with `usage.report` and totalled per month ([PRODUCT_INTEGRATION.md](../PRODUCT_INTEGRATION.md#plans-limits-and-usage)). Charged per application with prices staff set ([Prices](../PRODUCT_INTEGRATION.md#prices)). |
| `resources`, `health` | Not yet. A version 2 manifest with any of them is **refused** with a message naming the field, rather than having it silently dropped. |

Also implemented:
- A version 1 manifest with any version 2 field, supported or not yet, is refused (`kind: needs "manifestVersion": 2`), for the same reason.
- Declared types keep the manifest's order.
- A declared type can't be one of the platform's own types, even for a product whose id matches a platform prefix (e.g. `auth`).

## Example: Hearth (a generic application)

```json
{
  "manifestVersion": 2,
  "productId": "hearth",
  "name": "Hearth",
  "description": "Team chat for every application",
  "version": "0.3.0",
  "kind": "generic",
  "baseUrl": "https://hearth.example.com",

  "signIn": {
    "clientType": "CONFIDENTIAL",
    "redirectUris": ["https://hearth.example.com/auth/callback"],
    "openPath": "/login",
    "backchannelLogoutUri": "https://hearth.example.com/auth/backchannel-logout"
  },

  "provisioning": {
    "callbackUrl": "https://hearth.example.com/platform/events",
    "deletesDataOnDeprovision": true,
    "userEvents": true
  },

  "permissions": [
    { "name": "hearth:admin", "description": "Manage Hearth for the organization" },
    { "name": "hearth.channels:create", "description": "Create channels" }
  ],

  "menu": [
    { "label": "Chat", "path": "/", "icon": "MessageSquare" }
  ],

  "api": {
    "scopes": [
      { "name": "hearth.threads:read",  "description": "Read record threads",           "allowsOnBehalfOf": true },
      { "name": "hearth.threads:write", "description": "Create and post to threads",    "allowsOnBehalfOf": true },
      { "name": "hearth.messages:post", "description": "Post messages as a bot",        "allowsOnBehalfOf": false }
    ],
    "openApiUrl": "https://hearth.example.com/openapi.json"
  },

  "consumes": [],

  "embeds": [
    {
      "tag": "hearth-record-thread",
      "scriptUrl": "https://hearth.example.com/embed/v1/hearth.js",
      "attributes": ["resource"],
      "description": "A conversation attached to a record"
    },
    {
      "tag": "hearth-channel",
      "scriptUrl": "https://hearth.example.com/embed/v1/hearth.js",
      "attributes": ["channel-id"],
      "description": "One channel"
    }
  ],

  "platformServices": {
    "notifications": [
      { "type": "hearth.mention",  "label": "Someone mentioned you", "defaultChannels": ["in_app", "email"] },
      { "type": "hearth.dm",       "label": "Direct message",        "defaultChannels": ["in_app"] }
    ],
    "auditEvents": [
      { "type": "hearth.channel.archived", "label": "Channel archived" },
      { "type": "hearth.message.deleted_by_admin", "label": "Message deleted by an administrator" }
    ]
  },

  "events": {
    "emits": [
      { "type": "hearth.message.created", "label": "Message posted", "schemaUrl": "https://hearth.example.com/schemas/message.created.v1.json" }
    ],
    "subscribes": []
  },

  "limits": [
    { "key": "hearth.history_days",    "label": "Message history",   "type": "integer", "unlimited": true, "default": 90, "unit": "days" },
    { "key": "hearth.file_max_mb",     "label": "Largest file",      "type": "integer", "default": 25, "unit": "MB" },
    { "key": "hearth.agents_enabled",  "label": "AI agents in chat", "type": "boolean", "default": false }
  ],

  "usage": [],

  "health": { "url": "https://hearth.example.com/health" }
}
```

## Example: CRMForge (a specific application using Hearth)

```json
{
  "manifestVersion": 2,
  "productId": "crmforge",
  "name": "CRMForge",
  "version": "0.1.0",
  "kind": "specific",
  "baseUrl": "https://crm.example.com",
  "signIn": { "clientType": "CONFIDENTIAL", "redirectUris": ["https://crm.example.com/auth/callback"], "openPath": "/login" },

  "requires": [],
  "integratesWith": [
    { "productId": "hearth", "reason": "Conversations on deals and accounts" }
  ],

  "consumes": [
    { "scope": "hearth.threads:read",  "reason": "Show the conversation on a deal" },
    { "scope": "hearth.threads:write", "reason": "Start a conversation when a deal is created" }
  ],

  "api": {
    "scopes": [
      { "name": "crmforge.records:check", "description": "Check whether a person can see a record", "allowsOnBehalfOf": false }
    ]
  },

  "resources": [
    { "type": "deal",    "label": "Deal",    "urlTemplate": "/deals/{id}" },
    { "type": "account", "label": "Account", "urlTemplate": "/accounts/{id}" }
  ],

  "events": {
    "emits": [ { "type": "crmforge.deal.won", "label": "Deal won", "schemaUrl": "https://crm.example.com/schemas/deal.won.v1.json" } ],
    "subscribes": [ { "type": "hearth.message.created", "reason": "Show new messages on the deal" } ]
  }
}
```

## New fields

| Field | Required | Rules |
| --- | --- | --- |
| `kind` | No (default `specific`) | `specific` or `generic`. Shown in the catalogue; generic applications can be offered as add-ons and in bundles. |
| `requires` | No | Up to 10 `{ productId, reason }`. Turning this application on needs these on already (or in the same bundle); otherwise refused with the reason. They're never turned on automatically (until per-application billing, G6). Turning off a required application is refused while a dependant is on. |
| `integratesWith` | No | Up to 20 `{ productId, reason }`. Optional; features appear when both are on. Shown to administrators. |
| `api.scopes` | No | Up to 50. `name` follows the permission rule (`<productId>[.<thing>]:<action>`); `description` up to 200 characters; `allowsOnBehalfOf` (default `false`). The audience is always `urn:mt:app:<productId>`. |
| `api.openApiUrl` | No | Where the exposed API's OpenAPI document lives. Shown to developers on the platform's Developers page. |
| `consumes` | No | Up to 50 `{ scope, reason }`. Each scope must be exposed by another registered application (a warning, not an error, if that application isn't registered yet). Shown to organization administrators; they can block a connection ([ADR-0001](../adr/0001-app-to-app-calls.md)). |
| `embeds` | No | Up to 20. `tag` is a custom element name starting with `<productId>-`; `scriptUrl` same address rules as `baseUrl` and on the same host; `attributes` up to 10 lowercase names; `description` (shown to other applications). |
| `platformServices.notifications` | No | Up to 50 types named `<productId>.<name>`, with `label` and `defaultChannels` (`in_app`, `email`). Appear in organization notification rules and personal preferences. Needs the `notifications.send` service scope to send. |
| `platformServices.auditEvents` | No | Up to 100 types named `<productId>.<name>`, with `label`. Appear in the audit log filter and as webhook event types. Needs `audit.write`. |
| `events.emits` | No | Up to 50 types named `<productId>.<name>` (not also an audit or notification type), each with a `label`, optional `description` and optional JSON Schema `schemaUrl`. Needs `events.publish`. |
| `events.subscribes` | No | Up to 50 event types from other applications, each with a `reason` (shown to administrators). Delivered to `provisioning.callbackUrl` only for organizations that have both applications on, once it has set them up. |
| `resources` | No | Up to 50 record types the application owns: `type`, `label`, `urlTemplate` (relative path with `{id}`). Identifiers: `mt://<productId>/<type>/<id>`. |
| `limits` | No | Up to 50. `key` named `<productId>.<name>`, `label`, `type` (`integer` or `boolean`), `default` (for plans without a value; `null` is no limit and needs `unlimited`), integer only: `unlimited` (whether a plan may set no limit) and `unit`. Values are set per plan by platform staff and sent in `organization.entitled` and `organization.entitlement_changed` (`data.limits`). |
| `usage` | No | Up to 20 metered features: `key` (named like limits, not the same as one), `label`, `unit`. Reported with `usage.report`. |
| `health.url` | No | An `https://` address on the same host answering `200` with `{ "status": "ok", "version": "…" }`. Polled every minute; shown on the Integrations page. |

## New service scopes

| Scope | Allows |
| --- | --- |
| `notifications.send` | Sending the application's declared notification types to people in organizations that have it on |
| `audit.write` | Writing the application's declared audit event types to those organizations' audit logs |
| `events.publish` | Publishing the application's declared event types |
| `usage.report` | Reporting usage of declared metered features |
| ~~`units.read`~~ | Folded into `members.read`: organizations, org units and unit membership come with people (G7, done) |

## Import behaviour (additions)

- `requires`, `integratesWith`, `consumes`, `embeds`, `platformServices`, `events`, `resources`, `limits`, `usage`, `health`: **replaced** by the manifest's, like `menu`, except:
  - declared notification types, audit event types, API scopes and limits that disappear are **not removed** while something still uses them (organization rules, saved webhooks, plan values, blocked connections). The import lists them, as it does for permissions today.
- A new `requires` entry doesn't turn anything on for organizations that already have the application; the Integrations page lists organizations missing a dependency.
- `?dryRun=true` reports v2 changes the same way as v1.

## Compatibility

- `manifestVersion: 1` stays valid with exactly today's rules.
- The schema becomes a discriminated union on `manifestVersion` in `lib/product-manifest.ts`.
- API v1 grows only by addition (new routes and scopes), as the contract requires; CI's breaking-change check covers it.
