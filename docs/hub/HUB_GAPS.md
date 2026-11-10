# From product registry to application hub: gaps

**Status:** Proposal
**Date:** 9 Nov 2026
**Baseline:** `main` at `6e0b217` (2 Nov 2026)

The platform already registers external products and signs people in to them ([PRODUCT_INTEGRATION.md](../PRODUCT_INTEGRATION.md)). This document lists what is missing for it to be the hub over **many** applications that also work with **each other**:

- **Specific applications** serve one domain: AppForge, CRMForge, ERPForge.
- **Generic applications** provide a capability that other applications use, and also run on their own: Hearth (chat), document management.

## What already works

| Capability | Where |
| --- | --- |
| Catalogue entry from a manifest kept in the application's repository | `lib/product-manifest.ts`, `ApplicationRegistry` |
| Sign-in to every application with the organization account (OIDC, PKCE, `sub = <tenant>.<user>`) | `lib/oidc/`, [SIGN_IN_WITH.md](../SIGN_IN_WITH.md) |
| Applications declare permissions; organizations grant them in roles | `Permission`, `lib/application-permissions.ts` |
| Organizations turn applications on (entitlements, trial, end date) | `TenantApplication` |
| Lifecycle events with operations and generations; user events by comparison | `ProductEvent`, `lib/product-lifecycle.ts`, `lib/product-user-events.ts` |
| Service credentials (client credentials) for API v1 | `ProductServiceCredential`, `lib/product-service.ts` |
| Ending access at once: back-channel logout, short access tokens | `OidcLogoutDelivery`, `lib/oidc/logout.ts` |
| Sidebar entries in the tenant portal; Integrations page for platform staff | `ApplicationMenuItem` |

Identity stays where it is. Tenant users, roles and groups remain in the tenant's database; the platform is the identity provider for every application. No move is needed.

## The gaps

Each gap names what is missing, why the hub needs it, and the proposed direction. Priority: **P1** needed before a generic application (Hearth) can be used inside a specific one; **P2** needed for a good suite; **P3** later.

### G1. Applications can't call each other (P1): **done**

**Done (11 Nov 2026).** Machine calls (client credentials with `resource=urn:mt:app:<target>` and `organization_id`) and calls on behalf of a person (token exchange). Manifest v2 `api.scopes` and `consumes`. Organizations see and block connections on Application Entitlements. Client helpers both ways. See [PRODUCT_INTEGRATION.md](../PRODUCT_INTEGRATION.md#calling-other-applications); the introspection endpoint is still to come.


**Now.** Service tokens are issued only for API v1 (`aud: urn:multitenant:api:v1`), and service scopes are limited to `organizations.read`, `members.read` and `lifecycle.report` (`lib/service-scopes.ts`). There is no token an application can present to another application, and no way to act on behalf of the signed-in person in another application.

**Needed.**
- Applications declare the APIs they **expose** (scopes, e.g. `hearth.threads:write`) and the ones they **consume** from other applications, in the manifest.
- The token endpoint issues tokens whose audience is the **target application**, for machine calls (client credentials) and on behalf of a person (token exchange, RFC 8693).
- An organization's administrators see and approve which applications may call which, as they already see what a product can learn about their people.
- The target application checks the token (issuer, audience, scope, organization) against the platform's published keys.

Decision: [ADR-0001](../adr/0001-app-to-app-calls.md).

### G2. No application kinds, dependencies or bundles (P1): **done**

**Done (12 Nov 2026).** `kind`, `requires` and `integratesWith` in manifest v2. Required applications are enforced when organizations turn applications on and off, and refused with the reason, never turned on automatically. Bundles are made by platform staff and turned on by organizations in one step. The catalogue, Application Entitlements and the Integrations page show it all. See [PRODUCT_INTEGRATION.md](../PRODUCT_INTEGRATION.md#dependencies-and-bundles).


**Now.** The manifest has no `kind` and no dependencies. Turning CRMForge on doesn't turn on Hearth; turning Hearth off silently breaks CRMForge's embedded chat.

**Needed.**
- `kind: "specific" | "generic"` in the manifest (shown in the catalogue; generic applications can be offered as add-ons).
- `requires` (hard dependency) and `integratesWith` (optional; features light up when present).
- Entitling an application with a hard dependency entitles the dependency too, or refuses with a clear reason. Turning off a dependency that another enabled application requires is refused (or requires confirmation listing what breaks).
- **Until G6** (per-application billing), refuse with the reason rather than turning the dependency on. Turning it on automatically may change what the organization pays.
- Bundles: a named set of applications entitled together (e.g. "Sales suite" = CRMForge + Hearth + Documents).

### G3. Applications can't use the platform's own services (P1): **done** for notifications and audit

**Done (10 Nov 2026).** `notifications.send` and `audit.write`, with declared types in manifest v2 ([PRODUCT_INTEGRATION.md](../PRODUCT_INTEGRATION.md#using-the-platforms-services)). Organizations can already send an application's audit events to their own systems, because declared audit types are webhook event types. Application-defined domain events stay in G4.

The review found more to it than the table below suggests, and it was built in:
- The notification and audit catalogs were fixed in code and looked up synchronously (inside the audit transaction, too). Declared types now live in the database (`product_declared_types`), with an in-memory registry kept fresh across servers (`lib/product-catalog.ts`).
- A new audit actor type, `APPLICATION`, needed a migration on every tenant database. An application's entries can never pass for a person's or the platform's; a person it acted for is `details.onBehalfOf`.
- Anti-phishing rules, because notifications go out under the platform's name:
  - plain text only;
  - always titled with the application's name;
  - links only to its own host;
  - recipients must be in the organization;
  - a rate limit per credential.
- Organizations see an application's types (notification rules, preferences, audit filter, webhook types) only while they have it on.


**Now.** API v1 for products is read-only plus `lifecycle.report` (`routes/product-v1.ts`). Notification types can be added only by an **embedded** product (`ProductModule`). An external product can't write to the organization's audit log, send a notification, or have its events delivered through the organization's webhooks.

**Needed.** New service scopes and routes, all scoped to organizations that have the application on:

| Scope | Route | Purpose |
| --- | --- | --- |
| `notifications.send` | `POST /api/v1/product-integrations/organizations/{id}/notifications` | One bell and one email channel across applications; respects organization rules and personal preferences |
| `audit.write` | `POST /api/v1/product-integrations/organizations/{id}/audit-events` | One tamper-evident trail; event types prefixed with the product id |
| `webhooks.emit` | (via G4 events) | Organizations subscribe their own systems to application events |

Notification and audit event types are declared in the manifest, so organization rules and the webhook UI can list them.

### G4. Events flow only from the platform to applications (P2): **done**

**Now.** `ProductEvent` delivers lifecycle and user events to a product. A product can't publish domain events (e.g. `crmforge.deal.won`) for other applications or for the organization's webhooks.

**Needed.**
- Manifest `events.emits` (types and JSON schemas) and `events.subscribes`.
- `POST /api/v1/product-integrations/organizations/{id}/events` (scope `events.publish`).
- The platform relays to subscribed applications whose organization has both applications on, reusing the existing signed, ordered, retried delivery (Standard Webhooks headers, per-organization ordering, backoff, Retry now).
- Organization administrators can see which applications receive which events.

**Done.**
- Manifest `events.emits` (with `schemaUrl`) and `events.subscribes`.
- `POST …/events` (`events.publish`, idempotent), relayed through the lifecycle outbox to subscribing applications the organization has on and set up.
- The types are in the organization's webhook catalog.
- **Events between applications** on Application Entitlements.

See [Events between applications](../PRODUCT_INTEGRATION.md#events-between-applications).

### G5. No embedding contract (P2): **done**

**Now.** Menu entries open `baseUrl + path` in a new tab. The OIDC pages send `frame-ancestors 'none'` (correct, and must stay), and the deployed CSP forbids framing.

**Needed.**
- Manifest `embeds`: the Web Components a generic application offers (tag, script URL, attributes), e.g. `<hearth-channel>`, `<hearth-record-thread>`.
- Embedded components authenticate through the **host application's** server (token exchange from G1), never by running the OIDC flow inside a frame.
- Theme tokens and the tenant's branding available to applications (a `GET /api/v1/product-integrations/organizations/{id}/branding` route, or claims).
- An application launcher (switch between an organization's applications) available as a Web Component for every application's header.

**Done.**
- Manifest `embeds`.
- `GET …/embeds`: what the organization's other applications offer, and whether the caller can get the component's token now.
- `GET …/branding`, with theme tokens.
- `<mt-app-launcher>`, served at `/api/embed/v1/launcher.js` and fed by `GET …/members/{subject}/applications` (`launcher.read`).
- Components get their tokens from the host application's server, through G1's token exchange.

See [Embedding another application](../PRODUCT_INTEGRATION.md#embedding-another-application).

### G6. Billing is per tenant, not per application (P2): **limits and usage done**; prices next

**Now.** One `Subscription` per tenant, priced per seat. `BillingPlan` limits cover users, organizations, groups, SSO and custom domain only. Entitlement events carry state and dates, not limits.

**Needed.**
- Per-application prices and add-ons (seat-based or flat), on the same Razorpay/Stripe subscription as extra items.
- Limits per application and plan (e.g. Hearth file size and history; AppForge workflow runs), declared in the manifest and sent in `organization.entitled` / `organization.entitlement_changed`, and readable through the API.
- Usage reporting for metered features (`POST …/usage`, scope `usage.report`), e.g. AI tokens in AppForge.

**Done so far:**
- Limits per application and plan: declared in the manifest, values set by platform staff, sent in `organization.entitled` and `organization.entitlement_changed`, readable on the organization, and told again when they change.
- Usage reporting (`usage.report`, idempotent), with monthly totals for the application, platform staff and administrators.

See [Plans, limits and usage](../PRODUCT_INTEGRATION.md#plans-limits-and-usage). **Next:** per-application prices and add-ons on the subscription, and charging for metered usage.

### G7. Scoped permissions and org units don't reach applications (P2): **done**

**Now.** The kit enforces role assignments scoped to an organization, unit or resource (`lib/scopes.ts`). The `permissions` claim and the members API carry tenant-wide permissions only (`lib/oidc/accounts.ts`), so an application can't honour a unit-scoped grant. Product integrations expose people and groups but not organizations and units.

**Needed.**
- A `scoped_permissions` claim (and members API field): `[{ permission, scopeType, scopeId }]`, application permissions only.
- `GET …/organizations/{id}/org-units` and unit membership under `members.read`.
- `unit.*` user events (membership changed) for applications that take user events.

**Done.** The `scoped_permissions` claim (also in tokens made on a person's behalf), the members API's `scopedPermissions` and `memberOf` (with an `orgUnitId` filter), and `GET …/org-units` (under `members.read`) are in place. So are the user events `user.units_changed` and `units.changed`, with scoped changes in `user.permissions_changed`. The TypeScript client's `allows()` applies them the way the platform does. See [Scoped permissions and units](../PRODUCT_INTEGRATION.md#scoped-permissions-and-units).

### G8. No shared way to refer to another application's records (P3)

**Needed.** A resource identifier convention, `mt://<productId>/<type>/<id>` (tenant implied by the token), and an exposed scope `<productId>.records:check` with `POST /access-check` on each application that owns records. Hearth record threads and document attachments use it to ask the owning application whether a person can see a record.

### G9. No application health or deployment view (P3)

**Now.** The Deployments and Infrastructure pages show sample data (`PREVIEW_FEATURES`).

**Needed.** Manifest `health.url`; the platform polls it and shows version, status and response time on the Integrations page, and can warn organizations when an application they use is degraded.

## Order of work

1. ~~**G3** platform services for applications~~ (done: notifications and audit)
2. ~~**G1** application-to-application tokens~~ (done)
3. ~~**G2** kinds, dependencies, bundles~~ (done)
4. ~~**G7** scoped permissions and org units~~ (done)
5. ~~**G5** embedding contract~~ (done)
6. ~~**G4** application events~~ (done)
7. **G6** per-application billing and usage
8. **G8**, **G9**

All of it ships as **manifest version 2** ([MANIFEST_V2.md](MANIFEST_V2.md)). Version 1 manifests keep working unchanged.
