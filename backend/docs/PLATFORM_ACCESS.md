# Platform staff and tenant data

How people who run the platform are kept to what they need. Code: `src/lib/support.ts`,
`src/lib/platform-roles.ts`, `src/middleware/authenticate.ts` and `authorize.ts`.

## Platform roles

Platform users have a **user type** and any number of **platform roles**:

- **PLATFORM_ADMIN** can do everything on the platform.
- **PLATFORM_USER** starts with a read-only baseline. Roles add to it:

| Built-in role | Adds |
| --- | --- |
| Tenant Operations | create, change, suspend and delete tenants; run tenant migrations |
| Support | ask for support sessions |
| Support Manager | approve, review and end support sessions; read the platform audit log |
| Auditor | read, check and export audit logs |
| Catalogue Manager | the application catalogue and portal menus |
| Platform User Manager | give platform roles to people; create custom roles |

How roles work:

- **Built-ins:** these roles are created and kept up to date when the server starts, and
  can't be edited.
- **Custom roles:** admins with `platform-users:manage` can create their own on the
  Platform Users page.
- **Platform permissions only.** A platform role can only contain platform permissions,
  such as tenants, support, the audit log, the catalogue and menus. Tenant data isn't
  reachable through a role.
- **No escalation.** Nobody can give, take away or define a role with permissions they
  don't hold themselves.
- **Audited.** Giving and removing roles is recorded in the platform audit log, and the
  person is notified.

## Support sessions

Platform staff, including platform admins, can only work inside a tenant (requests that
select it with `x-tenant-id`) during an **active support session** for that tenant. A
session goes through these steps:

1. **Asked for** on the Support page, for one tenant, with a reason the tenant will see,
   for at most `SUPPORT_MAX_HOURS` (8).
   - It's **read-only** by default.
   - Read-write means naming the exact tenant permissions needed.
2. **Approved or rejected** by someone else with `support:manage`. Approving starts the
   clock.
   - Approving your own request is refused, unless `SUPPORT_SELF_APPROVAL=true` (for
     one-person teams).
   - The requester is notified either way.
3. **Active** until its time is up, the requester or a support manager ends it, or the
   tenant ends it. From then on, the next request is refused.

While a session is active:

- **Read-only:** the person can use every tenant read permission and nothing else. Their
  database connection is opened with `default_transaction_read_only=on`, so Postgres
  itself refuses any write, even one that slipped past the permission checks.
- **Read-write:** reading, plus the permissions that were approved.
- **Platform permissions never cover tenant data.** A platform admin's "everything"
  doesn't apply inside a tenant.
- **The tenant can see it:**
  - The start, the end and everything done in between are recorded in the tenant's audit
    log, under the support person's name.
  - The tenant's admins are notified when it starts.
  - Settings → *Platform support access* lists sessions, with their reasons. Admins with
    `settings:manage` can end one at once.

The platform's Support page has an **Open** button for active sessions. It opens the
tenant's own pages (Users, Groups, Audit log, Activity) with a banner showing the access
level and the time left.

## Usage snapshots

Platform pages read per-tenant usage snapshots, refreshed in the background
(`TENANT_USAGE_REFRESH_MS`).

- **One server at a time.** The refresh runs on one server at a time (an advisory lock in
  the control plane).
- **No duplicate work.** It's skipped when another server refreshed recently.
- **Deleted tenants.** Snapshots are only written for tenants that are still ready, so a
  tenant deleted during a refresh doesn't reappear.
