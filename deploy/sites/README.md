# Other applications on this server

The front door (Caddy, `deploy/Caddyfile`) imports every `*.caddy` file here. An application that runs on this server under its own hostname adds its site here:

1. Its containers join the Docker network `apps`, which this compose file creates.
2. Its deploy script writes `<name>.caddy` here, a site block for its hostname that proxies to its containers by their names on `apps`.
3. It reloads Caddy: `docker exec <the web container> caddy reload --config /etc/caddy/Caddyfile`.

Caddy gets and renews the certificate for each hostname on its own, as it does for the platform's address.

The files are the applications', not this repository's: they are not committed (`.gitignore`). Example: Hearth's `deploy/site.caddy` and `deploy/deploy.sh`.
