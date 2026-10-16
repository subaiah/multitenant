# Audit log

A tamper-evident record of who did what, to which record, when and from where. It sits
next to the activity log: the activity log is a feed for people to skim, and the audit log
is the record you rely on for accountability. Code: `src/lib/audit.ts`, the event catalog
in `src/kit/audit-events.ts`, endpoints in `src/routes/audit.ts`.

## What's recorded

Each entry records:

- **When:** the time it happened.
- **What:** the event key from the catalog, e.g. `role.assigned`, and its category.
- **Outcome:** succeeded or failed.
- **Who:** a user of the tenant, platform staff, the system, or someone not signed in.
- **On what:** the record's type, id and name.
- **Changes:** for edits, every changed field as `[before, after]`.
- **Details:** anything else worth keeping about the event.
- **Where from:** IP address, browser and request id.

Secrets are never written. Client secrets, two-factor secrets, passwords, tokens and codes
show as `[redacted]` / `[changed]`.

Covered so far:

- **Sign-ins:** successful and refused. Refusals include a wrong password, an unknown
  account, an inactive account, a wrong or expired emailed code, a wrong two-factor code,
  and failed single sign-on.
- **Own account:** two-factor turned on or off, recovery codes, sign out everywhere,
  password reset, accepted invitation.
- **People and access:** users, roles and role assignments, groups and members,
  delegations, policies, access requests and reviews, organizations and org units.
- **Settings:** sign-in settings and identity providers, API settings, database settings,
  application entitlements, the organization's profile.
- **Platform:**
  - tenants: created, changed, set up, deleted, credentials rotated, migrations run
  - the application catalogue, permissions and menus
  - support sessions, which also appear in the tenant's own log
  - platform users' two-factor
- **The audit log itself:** exports and archiving.

## Where it lives

| Log | Table | Who sees it |
| --- | --- | --- |
| Each tenant's | `audit_events` in the tenant's own data (shared tables, its schema or its database) | `audit:read` (Tenant Admins by default); `audit:export` to export and download archives |
| The platform's | `platform_audit_events` in the control plane | `platform-audit:read`; `platform-audit:manage` to check any log, export and archive |

When a platform user works in a tenant (support), their actions go in that tenant's log,
marked as *Platform staff*.

## Tamper evidence

- **Append-only.** Tenant database roles may only insert and read audit rows; the migration
  runner grants nothing else. A trigger refuses updates and truncation for everyone.
- **Hash chain.** Each entry has a sequence number and an HMAC-SHA256 over its content and
  the previous entry's hash.
  - The key comes from the environment (`AUDIT_KEY_V<n>`), not the database. Someone who
    can write to the database still can't rebuild a consistent chain.
  - Editing, removing or reordering entries breaks the chain.
- **Head kept apart.** The latest entry of every log is also stored in the control plane
  (`audit_heads`), so removing entries from the end is detected too.
- **Checking.** *Check integrity* on the Audit Log page, `GET /audit/verify` (or
  `/platform-audit/verify?chain=platform|<tenantId>`), or `npm run audit:verify` walks every
  link, archives included, and lists any problem by entry number.

Keys rotate like `SECRETS_KEY_V*`: add `AUDIT_KEY_V2`, and new entries use the highest
version. Keep old versions for as long as entries signed with them exist, live or archived.

## Retention and archives

- **Moving old entries.** Entries older than `AUDIT_RETENTION_DAYS` (365) are moved to
  gzipped JSON-lines files under `AUDIT_ARCHIVE_DIR` and removed from the live table:
  - It runs daily (`AUDIT_ARCHIVE_INTERVAL_MS`). It can also be run with `npm run audit:archive`,
    or *Archive now* on the platform page.
  - Each run writes one file per log and records the file's SHA-256 and where the chain
    continues (`audit_archives`).
  - Verification carries on across archives. An altered or missing archive file is reported.
- **Downloads.** Tenant admins can download their own archives from the Audit Log page.
  Platform admins can download any.
- **Deleted tenants.** When a tenant is deleted, its whole audit log is archived first, so
  the record outlives the tenant.
- **Back up the archive folder.** `AUDIT_ARCHIVE_DIR` is a local folder: back it up, or point
  it at durable storage (a mounted volume).

## Recording from product code

Declare the product's events in `src/product/index.ts`:

```ts
auditEvents: {
  'invoice.approved': { label: 'Invoice approved', category: 'data', scope: 'tenant' },
},
```

Then record from a route:

```ts
import { audit, diff } from '../lib/audit.js';

await audit(request, 'invoice.approved', {
  resource: { type: 'invoice', id: invoice.id, label: invoice.number },
  changes: diff(before, { status: 'APPROVED' }),
  details: { amount: invoice.total },
});
```

Recording an event that isn't in a catalog throws, and `test/audit.test.ts` checks every key
used in the code. Recording never fails the request: the action has already happened, so
a failure to record is logged as `AUDIT ENTRY NOT RECORDED`. Background work uses
`recordAudit(ctx, event, input)`.

`onAudit(listener)` runs for every entry recorded. This is where notifications will attach.
