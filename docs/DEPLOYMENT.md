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

```sh
git pull
docker compose up -d --build
```

`migrate` runs again before the new API starts. If it fails, the API doesn't start. The old containers are already stopped by then, so check `docker compose logs migrate`, fix the cause, and run `up` again.

- **Migrations only ever add.** A migration that changes or removes something comes with a note in the release that says what to do.
- **The server checks the schema.** In production it won't start on a control plane that is missing migrations.
- **Tenants that failed to migrate** are listed on the Tenants page. The rest keep working.
- **Several API servers:** run the release step once (`docker compose run --rm migrate`), then roll the servers. The release step takes locks, so two copies running at once is safe too.

## Settings that matter in production

Every setting is described in `backend/.env.example`. The ones a deployment must get right:

| Setting | Why |
| --- | --- |
| `TRUST_PROXY` | How many proxies stand in front of the API. Compose sets `1` (Caddy). Behind a load balancer or a CDN such as Cloudflare as well, use `2`, and set Caddy's `trusted_proxies` so it passes their client address on. Wrong in one direction, every request seems to come from the proxy: per-IP limits hit everyone, and the audit log records the proxy. Wrong in the other, clients can forge their address. |
| `FRONTEND_URL`, `BFF_URL`, `CORS_ORIGIN` | Links in emails, single sign-on callbacks (`BFF_URL/bff/auth/sso/callback`, registered with each identity provider), and the browser origin that may call the API. |
| `SECRETS_KEY_V<n>`, `AUDIT_KEY_V<n>` | Required in production. See *Keys* below. |
| `EMAIL_TRANSPORT=smtp`, `SMTP_URL`, `MAIL_FROM` | Invitations, password resets, sign-in codes and notifications. The sending domain needs SPF, DKIM and DMARC records, or the mail lands in spam. |
| `PLATFORM_MFA_REQUIRED` | Two-factor for platform staff. Keep it on. |
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

## Running more than one API server

The server is safe to run several times behind a load balancer:

- **Background work is coordinated in the database.** Provisioning, migrations, audit archiving, notifications and usage snapshots take locks, so no work is done twice.
- **Shared limits.** Limits on sign-in attempts, one-time codes and two-factor codes are counted in the database, so two servers don't double the number of guesses.
- **Per-server limit.** The per-IP flood limit (`RATE_LIMIT_MAX` per `RATE_LIMIT_TIME_WINDOW`) is counted per server.
- **Shared audit archive.** Every server must write to the same folder, so mount shared storage (NFS, EFS) at `/data/audit-archive`, or run archiving on one server only (`AUDIT_ARCHIVE_INTERVAL_MS=0` on the others).

## Monitoring

- **Health:** `GET /api/health`, liveness with no database access. `GET /api/health/detailed` also checks the control plane and the shared tenant database.
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
