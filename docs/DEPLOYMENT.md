# Deploying and running in production

The platform ships as two container images, run together with Docker Compose from `deploy/`:

| Image | Built from | What it is |
| --- | --- | --- |
| API | `backend/Dockerfile` | The API server, plus the commands that go with it (`dist/cli`) |
| Web | `deploy/web.Dockerfile` | Caddy serving the React app, with the API behind it under `/api`, on one HTTPS address |

The same images run anywhere containers run (a single VM, Kubernetes, ECS and so on). The compose file is the reference for which settings each one needs. This guide uses a single server.

```
browser ──HTTPS──▶ web (Caddy) ──/api──▶ api (Node) ──▶ Postgres
                     └── app files                      ├─ control plane: multitenant
                                                        ├─ shared tenant database: multitenant_tenants
                                                        └─ one database per database-per-tenant tenant
```

The app and the API share one address, so sign-in cookies are first-party and the browser makes no cross-origin requests. To put the API on its own address instead, it must be on the same site, for example `app.example.com` and `api.example.com`. Then set `CORS_ORIGIN`, `FRONTEND_URL` and `BFF_URL` to match, and build the app with `VITE_API_URL=https://api.example.com`.

## First installation

You need a Linux server with Docker, a domain name pointing at it, and ports 80 and 443 open.

```sh
git clone https://github.com/subaiah/multitenant.git && cd multitenant/deploy
cp .env.example .env
```

Fill in `.env`:

- **Passwords:** each one `openssl rand -hex 24`.
- **Keys:** each one `openssl rand -base64 32`.
- **SMTP** details.
- `PUBLIC_URL` and `SITE_ADDRESS`.

Keep a copy of `.env` somewhere safe and separate from the server, such as a password manager or a secrets manager. Without `SECRETS_KEY_V1` the stored secrets can't be read. Without `AUDIT_KEY_V1` the audit log can't be verified.

```sh
docker compose up -d --build
docker compose logs -f migrate api        # the release step, then the server starting
docker compose run --rm --no-deps api node dist/cli/create-admin.js you@example.com "Your Name"
```

The first `up` does the following:

1. **Database.** The database container sets itself up with `deploy/postgres/init.sh`. It creates:
   - the control-plane database and its own non-superuser role;
   - the three tenant roles and the shared tenant database, from `backend/prisma/tenant/setup-roles.sql`.
2. **Release step.** `migrate` runs:
   - control-plane migrations;
   - the menu entries;
   - tenant migrations.
3. **Server.** The API starts.
4. **Front door.** Caddy gets a certificate for `SITE_ADDRESS`.

`create-admin` prints a link (and emails it) for setting the first administrator's password. Sign in at `PUBLIC_URL/platform/login`. Every platform user must set up an authenticator app (`PLATFORM_MFA_REQUIRED=true`).

Never run the demo seed (`npm run prisma:seed`) on a real installation. Its accounts have published passwords, and it refuses to run with `NODE_ENV=production`.

## Upgrading

With continuous deployment set up (below), merging to `main` is the upgrade. By hand:

```sh
git pull
docker compose up -d --build
```

`migrate` runs again before the new API starts. If it fails, the API doesn't start. The old containers are already stopped by then, so check `docker compose logs migrate`, fix the cause, and run `up` again.

- **Migrations only ever add.** A migration that changes or removes something comes with a note in the release that says what to do.
- **The server checks the schema.** In production it won't start on a control plane that is missing migrations.
- **Tenants that failed to migrate** are listed on the Tenants page. The rest keep working.
- **Several API servers:** run the release step once (`docker compose run --rm migrate`), then roll the servers. The release step takes locks, so two copies running at once is safe too.

## Email

Invitations, password resets, sign-in codes, sign-up confirmations, trial and closure notices, and notifications all go through `SMTP_URL`. Some working setups:

| Provider | `SMTP_URL` | Notes |
| --- | --- | --- |
| Gmail (personal) | `smtps://you%40gmail.com:APPPASSWORD@smtp.gmail.com:465` | Needs 2-Step Verification and an [app password](https://myaccount.google.com/apppasswords). About 500 emails a day. `MAIL_FROM` must be the same address. |
| Azure Communication Services | `smtp://SMTPUSERNAME:CLIENTSECRET@smtp.azurecomm.net:587` | An Entra app with the Communication and Email Service Owner role, plus an SMTP Username linked to it. The Azure-managed domain gives a `DoNotReply@….azurecomm.net` sender. |
| Brevo, Resend, Postmark, SES… | as their docs give it | Add their SPF and DKIM records to your domain. |

Put an `@` in the username as `%40`, and URL-encode any special characters in the password. Microsoft 365 mailboxes with a password (`smtp.office365.com`) stop working by default at the end of 2026, as Microsoft retires Basic authentication for SMTP, so don't start with them.

**Check it from the browser.** As a platform admin, go to Notifications → **Email**. It shows where email goes (never the password) and has **Send a test email**, which reports the problem in plain words if sending fails. Tenant admins have the same button under Notifications → Organization.

**When email fails anyway:**
- Tenants still finish setting up. The Tenants page marks one whose first administrator's invitation wasn't sent; **Resend invitation** there tries again and, if it still can't send, shows the link to pass on another way.
- Inviting a user on the Users page works the same way.
- Notifications are retried for about a day and listed as failed under Notifications → Organization.

## Continuous deployment

`.github/workflows/deploy.yml` deploys every commit on `main` that passes CI:

1. GitHub Actions builds the API and web images and pushes them to GitHub's container registry (`ghcr.io/<owner>/<repo>-api:<commit>` and `-web:<commit>`). The server no longer builds anything.
2. Over SSH, it moves the server's checkout to that commit and runs `deploy/deploy.sh`, which:
   - pulls the images;
   - runs the release step (migrations);
   - restarts what changed.

   If a migration fails, the running version keeps serving and the deploy stops.
3. It checks that `PUBLIC_URL/api/health` answers.

It stays off until you set it up.

**1. A deploy key for the server.** Run this on your own machine, not the server:

```sh
ssh-keygen -t ed25519 -N '' -C github-deploy -f deploy_key
ssh-keyscan -p 22 your.server.ip > known_hosts        # the server's host key
```

Add `deploy_key.pub` to `~/.ssh/authorized_keys` of the user that runs Docker on the server, the one in the `docker` group that owns `/srv/multitenant`. The server's checkout must be a clone of the repository (`git clone`, as in *First installation*), with its `deploy/.env` filled in.

**2. GitHub settings** (Settings → Environments → New environment `production`):

- **Secrets:**
  - `DEPLOY_HOST`: the server's address;
  - `DEPLOY_USER`: the user from step 1;
  - `DEPLOY_SSH_KEY`: the contents of `deploy_key`;
  - `DEPLOY_KNOWN_HOSTS`: the contents of `known_hosts`;
  - optionally `DEPLOY_PORT`.
- **Required reviewers** (optional): each deployment then waits for someone to approve it.

Under Settings → Secrets and variables → Actions → Variables, set:

- `DEPLOY_ENABLED` = `true`;
- `PUBLIC_URL`, for example `https://app.example.com`, for the health check;
- optionally `APP_NAME` (the product name built into the app) and `DEPLOY_PATH` (default `/srv/multitenant`).

Delete `deploy_key` from your machine once it's stored in GitHub.

**Deploying by hand, and rolling back.** Actions → Deploy → Run workflow. Give it a commit, branch or tag; an earlier commit rolls back. Images are kept per commit in the registry, so a rollback doesn't rebuild. Migrations only add, so the older version runs on the newer schema. Rollback works to commits from after continuous deployment was added, because older ones don't have `deploy/deploy.sh`.

**How the server pulls.** Each deploy logs the server in to the registry with the workflow's own token, which expires when the job ends, and logs out afterwards. No long-lived registry credential is stored on the server.

The images are recorded in `deploy/.env` (`API_IMAGE`, `WEB_IMAGE`), so a plain `docker compose up -d` on the server keeps using them. To build on the server again instead, remove those two lines and run `docker compose up -d --build`.

## Settings that matter in production

Every setting is described in `backend/.env.example`. The ones a deployment must get right:

| Setting | Why |
| --- | --- |
| `TRUST_PROXY` | How many proxies stand in front of the API. Compose sets `1` (Caddy). Behind a load balancer or a CDN such as Cloudflare as well, use `2`, and set Caddy's `trusted_proxies` so it passes their client address on. Wrong in one direction, every request seems to come from the proxy: per-IP limits hit everyone, and the audit log records the proxy. Wrong in the other, clients can forge their address. |
| `FRONTEND_URL`, `BFF_URL`, `CORS_ORIGIN` | Links in emails, single sign-on callbacks (`BFF_URL/bff/auth/sso/callback`, registered with each identity provider), and the browser origin that may call the API. |
| `SECRETS_KEY_V<n>`, `AUDIT_KEY_V<n>` | Required in production. See *Keys* below. |
| `EMAIL_TRANSPORT=smtp`, `SMTP_URL`, `MAIL_FROM` | Invitations, password resets, sign-in codes and notifications. The sending domain needs SPF, DKIM and DMARC records, or the mail lands in spam. |
| `PLATFORM_MFA_REQUIRED` | Two-factor for platform staff. Keep it on. |
| `SELF_SIGNUP`, `CUSTOM_DOMAINS` | On by default. Whether anyone can create an organization, and whether tenants can use their own domains. See *Self-service sign-up* and *Custom domains* below. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | A bot check on the sign-up form. Set them before opening sign-up to the public. |
| `TRIAL_DAYS`, `CLOSE_GRACE_DAYS` | How long trials last before the organization becomes read-only, and how long a closed organization is kept before it's deleted. See *Trials and closing an organization*. |
| `PREVIEW_FEATURES` | Off in production. It hides pages that show sample data: deployed applications and their resource use, the API gateway settings, the backup and encryption switches, and the platform's "coming soon" pages. |
| `API_DOCS` | Off in production. The interactive API reference at `/api/docs`. |
| `TENANT_POOL_MAX`, `TENANT_CLIENT_CACHE_MAX`, `POSTGRES_MAX_CONNECTIONS` | See *Database connections*. |

## Database connections

Every tenant's requests use that tenant's own database role, and each API server keeps a small pool per tenant. The most connections one API server can open is:

```
TENANT_CLIENT_CACHE_MAX × TENANT_POOL_MAX + about 15 (control plane, shared work)
```

With the defaults (100 × 3), that is up to about 315 per server. The least recently used tenants are closed first, so the real number follows how many tenants are active at once. Keep the total across all servers under Postgres's `max_connections`, with some headroom. With more tenants than that, either:

- lower `TENANT_CLIENT_CACHE_MAX` (rarely active tenants reconnect when they're next used); or
- put PgBouncer in session mode in front of Postgres.

Database-per-tenant tenants cost the most, because each has its own database. Shared-tables tenants share the one database but still use their own role.

## Backups

Two things need backing up. Together they are everything that can't be recreated:

1. **All databases on the Postgres server, and its roles.** That covers the control plane, the shared tenant database, and every database-per-tenant database.
2. **The audit archive** (the `audit-archive` volume): audit entries past `AUDIT_RETENTION_DAYS`, which have left the database.

`deploy/backup.sh` writes both to a folder. Run it nightly from cron, then copy the files off the server:

```sh
15 2 * * * cd /srv/multitenant && deploy/backup.sh /srv/backups && rclone copy /srv/backups remote:multitenant-backups
```

`pg_dumpall` is consistent within each database, which is enough for a nightly copy. For point-in-time recovery, use a managed Postgres with it turned on, or WAL archiving such as pgBackRest or WAL-G.

**Restore** (rehearse this before you need it):

```sh
docker compose down
docker volume rm multitenant_pgdata              # a fresh, empty database server
docker compose up -d db                          # init.sh runs again
gunzip -c db-<stamp>.sql.gz | docker compose exec -T db psql -U postgres -d postgres
docker compose run --rm --no-deps -T --entrypoint tar api -C /data -xzf - < audit-archive-<stamp>.tar.gz
docker compose up -d
docker compose run --rm --no-deps api node dist/cli/audit.js verify   # every chain should be intact
```

The `.env` must be the one the backup was made with. The keys especially: stored secrets and audit signatures depend on them.

## Keys

| Key | Protects | Rotating |
| --- | --- | --- |
| `SECRETS_KEY_V<n>` | Stored secrets: tenant connection strings, SSO client secrets, authenticator secrets | Add `SECRETS_KEY_V2` and deploy (the newest version encrypts). Run `node dist/cli/encrypt-secrets.js`, then remove V1 once `--check` reports nothing left on it. |
| `AUDIT_KEY_V<n>` | Audit log signatures | Add `AUDIT_KEY_V2` and deploy. Never remove an old version while entries signed with it remain, live or archived. |
| `JWT_SECRET` | Session tokens | Changing it signs everyone out. |
| `COOKIE_SECRET` | Signed cookies | Changing it signs everyone out. |

To add a key version, add the variable to `.env` and to the `x-api-env` block in `docker-compose.yml`.

## Self-service sign-up

On by default (`SELF_SIGNUP=true`). The sign-in page links to `/signup`, where someone enters an organization name, its sign-in address, their name, email and a strong password. Nothing is created yet. The server emails a link that works for 24 hours (so `EMAIL_TRANSPORT=smtp` must work). Opening it:

1. creates the tenant as a `TRIAL` on `SIGNUP_PLAN` (default `FREE`) with `DEFAULT_TENANT_STRATEGY`;
2. provisions it as usual;
3. makes the person its administrator with the password they chose, and emails them that it's ready.

Each sign-up is in the platform audit log (`tenant.signed_up`), and platform staff with `tenants:manage` get an in-app notification. Attempts are limited to 10 an hour per IP address, across all API servers.

To turn it off, so that only platform staff create tenants, set `SELF_SIGNUP=false`. The link disappears and `/bff/signup` answers 404.

**Keeping bots and throwaway accounts out:**

- **Bot check.** Set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to add a [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) check to the form. Turnstile is free and doesn't need your site to be on Cloudflare. The API verifies each answer with Cloudflare before anything is created. The bundled Caddyfile's content security policy already allows its script.
- **Throwaway addresses.** Addresses at common disposable-email services are refused (`SIGNUP_BLOCK_DISPOSABLE=true`, a built-in list). Add more domains with `SIGNUP_BLOCKED_EMAIL_DOMAINS`.

Turn on the bot check before you announce a public sign-up page.

## Trials and closing an organization

**Trials.** A tenant that signs up, or that platform staff create as a trial, gets an end date `TRIAL_DAYS` ahead (default 14; `0` means trials don't end).

- `TRIAL_REMINDER_DAYS` (default 3) before the end, its administrators get an email.
- When it ends, they get another, and the platform gets an in-app notification and a `tenant.trial_ended` audit entry.
- From then on the organization is **read-only**. People can sign in and see everything, but changes are refused (`403 TRIAL_ENDED`), and a banner explains why.
- Platform staff continue it from the tenant's panel: change its status to Active (for example, once it pays), or move the trial's end date.

**Closing.** A tenant administrator can close their organization from its Settings page. They type its address and their password to confirm.

- It is suspended at once: open sessions stop working and nobody can sign in.
- Its administrators get an email, and platform staff get a notification.
- After `CLOSE_GRACE_DAYS` (default 30) it is deleted with all its data.
- Until then, platform staff can **Restore** it from its panel.

## Data exports

A tenant's administrators can export all of their organization's data from Settings. The export also works on an ended trial and before closing.

- **Format.** A ZIP with:
  - one CSV file per tenant table (the product's own tables too), in UTF-8 with a header row;
  - `manifest.json`, listing the tables, columns and row counts;
  - a `README.txt`.
- **Isolation.** It's read in one read-only transaction as the tenant's own database role, so row-level security keeps every other tenant's rows out.
- **Left out:** password hashes, two-factor secrets and recovery codes, SSO client secrets, and short-lived sign-in records. A product leaves out more with `exportExclusions` in `src/product/index.ts`.
- **Spreadsheet safety.** Text that starts like a formula is prefixed with `'` so spreadsheet apps don't run it.
- **Background work.** Exports are built in the background. The person who asked gets an email when it's ready, and downloads it from Settings by signing in (the file is never attached to the email).
- **Storage.** Files are kept in `EXPORT_DIR` (`/data/exports` in the image, a volume in Compose) for `EXPORT_RETENTION_DAYS` (default 7), then removed. With more than one API server, `EXPORT_DIR` must be shared storage.
- **Who.** Only the organization's administrators, at most 5 exports a day. Platform staff can't export a tenant's data; support access stays within approved sessions in the app.

Requests and downloads are recorded in the organization's audit log.

A background check every `TENANT_LIFECYCLE_INTERVAL_MS` (default one hour, on one server at a time) sends the trial emails, deletes closed organizations whose time is up, removes old sign-up requests and expired data exports, and finishes exports a restart interrupted.

## Custom domains

Tenants can serve the app at their own address (`CUSTOM_DOMAINS=true`, the default).

1. A tenant admin enters the domain on the Settings page, for example `app.acme.com`.
2. They add two DNS records:
   - a CNAME from the domain to `CUSTOM_DOMAIN_TARGET` (default: the host of `PUBLIC_URL`);
   - a TXT record `_tenant-verify.app.acme.com` with the value shown, which proves the domain is theirs.
3. They choose **Check now**. Once the TXT record is found, the domain is verified.

Verified domains are checked again every `DOMAIN_RECHECK_HOURS` (default 24). A domain stays verified while it still points here (the CNAME, or one of the target's addresses for an apex domain) or still has its TXT record, and a DNS outage changes nothing. A domain that has neither on two checks in a row goes back to pending, and its admins get an email. Without this, emails would keep linking to an address that may now belong to someone else. Removing the domain from Settings stops using it. `DNS_SERVERS` picks the resolvers the check uses; the default is the system's.

**HTTPS.** The bundled Caddyfile has a catch-all `https://` site with on-demand TLS. The first visit to a new domain gets a certificate from Let's Encrypt. Before asking for one, Caddy asks the API (`/internal/tls-allowed`) whether the name is a verified domain, so nobody can make the server request certificates for other names. Ports 80 and 443 must reach Caddy. Behind your own proxy or a CDN instead, that proxy must terminate TLS for tenants' domains and pass the original `Host` header on.

**What changes on a verified domain:**

- The site opens straight to that organization's sign-in page.
- Signing in there works for that organization only. Another tenant's slug, or the platform portal, is refused (`WRONG_DOMAIN`), so one tenant's domain can't collect another's passwords.
- Sign-up isn't offered there.
- Invitations, password resets and notifications link to the domain.
- Single sign-on has a second redirect URI on the domain, and the tenant registers it with its identity provider.

Set `CUSTOM_DOMAINS=false` to turn custom domains off. Every domain then stops working, but the stored ones are kept.

## Running more than one API server

The server is safe to run several times behind a load balancer:

- **Background work is coordinated in the database.** Provisioning, migrations, audit archiving, notifications and usage snapshots take locks, so no work is done twice.
- **Shared limits.** Limits on sign-in attempts, one-time codes and two-factor codes are counted in the database, so two servers don't double the number of guesses.
- **Per-server limit.** The per-IP flood limit (`RATE_LIMIT_MAX` per `RATE_LIMIT_TIME_WINDOW`) is counted per server.
- **Shared audit archive.** Every server must write to the same folder, so mount shared storage (NFS, EFS) at `/data/audit-archive`, or run archiving on one server only (`AUDIT_ARCHIVE_INTERVAL_MS=0` on the others).

## Monitoring

- **Health:** `GET /api/health`, liveness with no database access (container health checks). `GET /api/health/ready` answers 200 when the control plane and the shared tenant database are reachable and 503 when not, and says nothing more: point an uptime monitor at it. `GET /api/health/detailed` adds latencies, memory and uptime, for signed-in platform staff only.
- **Request IDs:** Caddy gives every API request an ID (`X-Request-ID`). The API keeps it in its log lines and audit entries and sends it back in the response, so one request can be followed from Caddy's log into the API's, and a user reporting a problem can quote it.
- **Logs:** JSON on standard output, through `docker compose logs`, or ship them with your log collector. Request lines leave out headers and cookies, and the invitation and reset tokens and sign-in codes that some URLs carry.
- **Worth alerting on:**
  - the API container restarting;
  - `migrate` failing;
  - log lines at level 50 (`error`) and above;
  - "Tenant database server" errors at start-up;
  - emails failing (shown as Failed on the Notifications settings page);
  - an audit chain that doesn't verify (`node dist/cli/audit.js verify` from cron).

## Operations reference

| Task | Command |
| --- | --- |
| Release step by hand | `docker compose run --rm migrate` |
| First (or another) platform administrator | `docker compose run --rm --no-deps api node dist/cli/create-admin.js <email> ["Name"]` |
| Check the audit logs | `docker compose run --rm --no-deps api node dist/cli/audit.js verify` |
| Archive old audit entries now | `docker compose run --rm --no-deps api node dist/cli/audit.js archive` |
| Secrets still on an old key | `docker compose run --rm --no-deps api node dist/cli/encrypt-secrets.js --check` |
| A database shell | `docker compose exec db psql -U postgres -d multitenant` |
| Backup | `deploy/backup.sh <folder>` |
