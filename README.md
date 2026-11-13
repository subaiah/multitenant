# Multitenant platform

The hub that a set of applications runs under. It holds the organizations (tenants), their people and what each person may do, and every application signs in through it, gets its permissions from it and is billed by it.

It has two portals:

- **Platform portal**, for the people who run the service: tenants, the application catalogue, platform staff, support access, the platform audit log.
- **Tenant portal**, for each customer organization: its users, groups, roles, sign-in settings, the applications it has turned on, audit and activity logs, notifications.

Applications are separate programs with their own repositories, and come in two kinds ([docs/hub/HUB_GAPS.md](docs/hub/HUB_GAPS.md)):

- **Specific applications** serve one domain, such as AppForge.
- **Generic applications** provide something other applications use, and also run on their own, such as Hearth (chat).

An application joins by publishing a manifest ([docs/PRODUCT_INTEGRATION.md](docs/PRODUCT_INTEGRATION.md), [docs/hub/MANIFEST_V2.md](docs/hub/MANIFEST_V2.md)) and asking to connect: a platform administrator approves, and the application collects its own credentials, so nobody copies a secret ([docs/hub/CONNECT.md](docs/hub/CONNECT.md)). From then on the hub:

- signs its users in with their organization account ([docs/SIGN_IN_WITH.md](docs/SIGN_IN_WITH.md));
- lets organizations turn it on and grant its permissions through their roles;
- tells it when organizations and people change;
- gives it tokens to call the hub and other applications;
- shows its pages in the tenant portal's sidebar;
- applies its plan limits and prices.

The hub can also be used the way it started, as a starter kit: a product forks it and adds its own tables, API and screens behind a few extension points ([docs/extending.md](docs/extending.md)).

| Part | Stack | Where |
| --- | --- | --- |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS | `src/` |
| API | Fastify 5, TypeScript, Node 24 | `backend/` |
| Data | PostgreSQL with Prisma 7 | `backend/prisma/` |
| Deployment | Docker images, Docker Compose, Caddy, GitHub Actions | `deploy/`, `.github/workflows/` |

## What's in it

- **Tenant isolation, chosen per tenant.** Shared tables, a schema of its own, or a database of its own. In every mode, tenant requests connect as the tenant's own Postgres role, and row-level security keeps tenants apart even if app code forgets a filter. ([docs/tenant-isolation.md](docs/tenant-isolation.md))
- **Sign-in.**
  - Passwords with per-tenant policies, one-time email codes, and single sign-on with Entra ID, Google, Okta, Auth0, GitHub, or any OpenID Connect provider.
  - Authenticator-app two-factor, idle and maximum session lengths, and sign out everywhere.
  - Sessions live in httpOnly cookies. ([backend/docs/AUTHENTICATION_METHODS.md](backend/docs/AUTHENTICATION_METHODS.md))
- **Access control.**
  - Roles with granular permissions, groups, and role assignments for the whole tenant or scoped to one organization or unit (enforced: a scoped role applies there only).
  - Delegation, access requests and access reviews.
  - Platform roles for staff. ([backend/docs/RBAC_SYSTEM.md](backend/docs/RBAC_SYSTEM.md))
- **Support access.** Platform staff see tenant data only through a time-limited support session that someone else approves. Sessions are read-only unless approved otherwise, the tenant sees them, and the tenant can end one at any time. ([backend/docs/PLATFORM_ACCESS.md](backend/docs/PLATFORM_ACCESS.md))
- **Audit log.**
  - Tamper-evident: each tenant's log and the platform's is a signed hash chain.
  - Entries are archived after a year. ([backend/docs/AUDIT_LOG.md](backend/docs/AUDIT_LOG.md))
- **Self-service sign-up, on by default.** Anyone can create an organization from the sign-in page: they confirm their email address, the organization starts as a trial on the `SIGNUP_PLAN` plan, and they become its administrator. Nothing is created until the address is confirmed. An optional Cloudflare Turnstile check and a block on throwaway email addresses keep bots out. Set `SELF_SIGNUP=false` to turn it off, so only platform staff create tenants.
- **Data export.** A tenant's administrators can download all their organization's data from Settings: a ZIP with one CSV file per table, including the product's own tables. It's read as the tenant's own database role, so only its rows are included, and passwords and other secrets are left out. ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#data-exports))
- **API keys and webhooks.** Organizations connect their other systems: API keys (limited to chosen permissions, hashed, revocable, recorded in the audit log as themselves) to call the API, and signed webhooks ([Standard Webhooks](https://www.standardwebhooks.com/) format, retried for two days, public addresses only) for any of their audit events. ([docs/API_ACCESS.md](docs/API_ACCESS.md))
- **API v1.** A versioned contract for integrations (`/api/v1`): people, groups, organizations, role assignments and the audit log, published as OpenAPI 3.1, with a generated TypeScript client. It only grows within v1: CI refuses breaking changes, and a test checks every route's real answers against it. ([docs/API_V1.md](docs/API_V1.md))
- **"Sign in with" for your applications.** The platform is an OpenID Connect provider for the applications in its catalogue. Platform staff turn sign-in on for an application and register where it returns to; organizations turn on the applications they use; their people open them from the Applications page and sign in with their account here. Code flow with PKCE, refresh tokens, and claims for the person's organization, roles and the application's permissions. Turning an application off for an organization, or deactivating someone, stops their sign-in and token refresh at once. ([docs/SIGN_IN_WITH.md](docs/SIGN_IN_WITH.md))
- **External products.** A separate application (such as AppForge) registers from a manifest kept in its own repository: sign-in, its own permissions for organizations' roles, and its pages in the tenant portal's sidebar. The rules it follows are in [docs/PRODUCT_INTEGRATION.md](docs/PRODUCT_INTEGRATION.md).
- **Plans and billing.** Plans set limits (users, organizations, groups) and features (single sign-on, custom domain), enforced when something is added. Organizations pay per user by subscription: Razorpay for INR (UPI, cards, netbanking), Stripe for other currencies. Seats follow the number of users; failed payments get a grace period, then the organization is read-only until paid. ([docs/BILLING.md](docs/BILLING.md))
- **Trials and closing.** Trials last `TRIAL_DAYS` (default 14). Admins are reminded before the end, and afterwards the organization is read-only until it subscribes or platform staff continue it. Tenant admins can close their own organization; it's deleted after a grace period, during which platform staff can restore it. ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#trials-and-closing-an-organization))
- **Custom domains.** A tenant can serve the app at its own address, such as `app.acme.com`. It adds the domain on its Settings page, adds a CNAME and a TXT record, and the platform checks the TXT record. Once the domain is verified:
  - the bundled Caddy gets an HTTPS certificate for it on first visit;
  - the address opens straight to that organization's sign-in page and signs in to that organization only;
  - emails and single sign-on use it.

  ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#custom-domains))
- **Notifications.** In-app and email, with organization rules and personal preferences. Products can add their own types. ([backend/docs/NOTIFICATIONS.md](backend/docs/NOTIFICATIONS.md))

## Look and feel

The interface uses IBM Plex Sans (with Plex Mono for literal values such as email addresses), a graphite sidebar, cool grey neutrals and a verdigris accent, in light and dark themes. Everyone can switch the theme from the sidebar; it follows the device until they do.

A product re-skins it in one place:

- **Colours and fonts:** the tokens at the top of `src/index.css`.
- **Its name:** `VITE_APP_NAME` when building (`APP_NAME` in `deploy/.env`).
- **Tenants' own branding:** each tenant's logo and colour on their sign-in page and in their sidebar, from their Settings page.

## Pages with sample data

Some pages show data the demo seed fills in, because nothing real reports it yet:

- deployed applications and their CPU, memory and request figures (the tenant's Deployments and Infrastructure pages);
- the API gateway settings;
- the backup and encryption switches;
- the platform's Global Policies and Settings pages.

Production hides them unless `PREVIEW_FEATURES=true`.

## Getting started

- **Develop:** [backend/README.md](backend/README.md) covers the databases, the API and the tests. Then run the frontend from this folder:

  ```sh
  npm install
  npm run dev          # http://localhost:5173, talks to the API at VITE_API_URL (default http://localhost:4000)
  ```

- **Deploy:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) covers a first installation with Docker Compose, continuous deployment from GitHub Actions, upgrades, backups, keys, scaling out and monitoring.
