# syntax=docker/dockerfile:1
#
# The API server, and the commands that go with it (dist/cli):
#   node dist/server.js                       the server (default)
#   node dist/cli/migrate.js                  release step: migrate the control plane and every tenant
#   node dist/cli/create-admin.js <email>     the first platform administrator
#   node dist/cli/audit.js verify             check the audit logs' hash chains
#   node dist/cli/encrypt-secrets.js --check  after rotating SECRETS_KEY_V<n>
# See docs/DEPLOYMENT.md.

ARG NODE_VERSION=24

# Debian (glibc) throughout: the lockfile's native packages are resolved for it.

# ---- build: compile TypeScript and generate the Prisma clients
FROM node:${NODE_VERSION}-slim AS build
# prisma generate looks for OpenSSL to pick its engine build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# prisma generate reads the configs, which name these; it doesn't connect
RUN DATABASE_URL=postgresql://build@localhost/build TENANT_DATABASE_URL=postgresql://build@localhost/build_tenant \
      npm run prisma:generate \
 && npm run build

# ---- production dependencies only. --omit=optional also drops the Prisma
# CLI and TypeScript, which npm otherwise installs as optional peers of
# @prisma/client; the runtime needs neither (migrations run through dist/cli).
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund && npm cache clean --force

# ---- runtime
FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production \
    PORT=4000 \
    AUDIT_ARCHIVE_DIR=/data/audit-archive \
    EXPORT_DIR=/data/exports
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
# Read at runtime: the release step applies them, and the server compares
# each tenant's schema with the newest one
COPY --chown=root:root prisma/control/migrations ./prisma/control/migrations
COPY --chown=root:root prisma/tenant/migrations ./prisma/tenant/migrations
COPY --chown=root:root prisma/tenant/setup-roles.sql ./prisma/tenant/setup-roles.sql
# Audit archives and data exports must outlive the container: mount volumes here
RUN mkdir -p /data/audit-archive /data/exports && chown node:node /data/audit-archive /data/exports
VOLUME ["/data/audit-archive", "/data/exports"]
# The code is owned by root and read-only to the server's own user
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# node, not npm: signals reach the server, so it shuts down cleanly
CMD ["node", "dist/server.js"]
