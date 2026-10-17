# syntax=docker/dockerfile:1
#
# The web front door: the React app as static files, and the API behind it
# under /api (deploy/Caddyfile). One address for both, so sign-in cookies are
# first-party and the browser needs no cross-origin requests.
# Build from the repository root:  docker build -f deploy/web.Dockerfile .

ARG NODE_VERSION=24
ARG CADDY_VERSION=2.10

# Debian (glibc): the lockfile's native build tools are resolved for it
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js tsconfig.json ./
COPY src ./src
# The API is on the same address, under /api
ENV VITE_API_URL=/api
RUN npm run build

FROM caddy:${CADDY_VERSION}-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
