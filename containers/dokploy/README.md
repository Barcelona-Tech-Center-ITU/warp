# Deploying WARP on Dokploy

[Dokploy](https://dokploy.com) is a self-hosted PaaS that deploys Docker Compose
services straight from a git repository and fronts them with its own Traefik
reverse proxy (TLS via Let's Encrypt). This directory is the WARP deployment for
it:

| File                 | Role                                                        |
| -------------------- | ----------------------------------------------------------- |
| `docker-compose.yml` | The two-service deployment Dokploy runs                     |
| `.env.example`       | Variables to paste into Dokploy's *Environment* tab          |

| Service    | Image                          | Role                                        |
| ---------- | ------------------------------ | ------------------------------------------- |
| `warp-db`  | `postgres:18-alpine`           | PostgreSQL, reachable from the app only     |
| `warp-app` | built from this repository     | WARP application (uWSGI on TCP port `8080`) |

Unlike the [compose](../compose/compose.yaml) and [Quadlet](../quadlet/)
deployments there is **no Caddy container**: Dokploy's Traefik terminates TLS
and routes to the app, and uWSGI serves `/static` itself, so the shared tmpfs
volume for static files and unix sockets is not needed. Traefik reaches the app
over `dokploy-network`; the database sits on a private network with no published
port.

## Prerequisites

- A running Dokploy host (v0.7.0 or later, for native domain management).
- A DNS `A` record for your hostname pointing at that host.
- Dokploy connected to this repository — a GitHub app installation, or the *Git*
  provider with a deploy key for a private repo.
- Room to build: the first deploy compiles the frontend bundle (webpack) and
  Python wheels on the host. A 1 GB VPS is tight; 2 GB is comfortable.

## Setup

### 1. Create the Compose service

In your Dokploy project choose *Create Service → Compose* and set:

| Field        | Value                                        |
| ------------ | -------------------------------------------- |
| Compose Type | **Docker Compose** (not *Stack* — it ignores `build`) |
| Provider     | GitHub / Git, this repository                 |
| Branch       | whatever you want deployed                    |
| Compose Path | `./containers/dokploy/docker-compose.yml`     |

Leave *Isolated Deployments* off unless you have a reason to enable it; the
compose file already declares its own private network for the database.

### 2. Set the environment

Paste [`.env.example`](.env.example) into the *Environment* tab and replace the
two `change-me` values:

| Variable            | How to set it                                        |
| ------------------- | ---------------------------------------------------- |
| `WARP_SECRET_KEY`   | `openssl rand -hex 32` — the Flask cookie-signing key |
| `POSTGRES_PASSWORD` | A strong password; used by both containers            |

Dokploy writes this tab into a `.env` file next to the compose file, and
`warp-app` loads it, so **any** setting from [CONFIGURATION.md](../../CONFIGURATION.md)
can be added here later without touching the compose file — auth backends
(`WARP_AUTH_OIDC`, `WARP_AUTH_SAML`, `WARP_AUTH_LDAP`, …), `WARP_WEEKS_IN_ADVANCE`,
`WARP_OMITTED_WEEKDAYS`, `WARP_LANGUAGES`, and so on. The exceptions are the
handful of keys the compose file sets explicitly (database address, uWSGI
sockets); those win over `.env` and have to be changed in the file itself.

### 3. Add the domain

*Domains* tab → *Add Domain*: service `warp-app`, container port `8080`, HTTPS
on with the Let's Encrypt certificate provider. Dokploy generates the Traefik
labels itself at deploy time, which is why the compose file carries none. Use
*Preview Compose* if you want to see the labels it will inject.

### 4. Deploy

Hit *Deploy* and watch the *Deployments* log. The first run builds the image
(several minutes; later deploys reuse the layer cache), starts PostgreSQL, waits
for its health check, then starts the app.

On an empty database WARP creates the schema and a default administrator:

```
admin / noneshallpass
```

Log in and **change that password immediately** (user menu → change password).

## Day-to-day

**Redeploying.** Push to the deployed branch and either press *Deploy* or wire
up the webhook Dokploy shows under *Deployments* for automatic deploys. Schema
migrations are applied automatically on startup, so an upgrade is just a
redeploy; WARP tracks its schema version in the database and runs the pending
`warp/sql/migration_*.sql` scripts in order.

**Configuration changes.** Edit the *Environment* tab and redeploy — the app
reads all `WARP_*` settings at startup.

**Logs and status.** The *Logs* and *Monitoring* tabs are per-service. The app
container has a health check that only proves uWSGI is accepting connections
(WARP has no health route, and `/login` behaves differently per auth backend),
so a healthy container is not by itself proof that the database is reachable —
check the app log for connection errors.

**Backups.** Database data lives in the `warp-db-data` **named** volume, which
means Dokploy's *Volume Backups* can back it up to S3. For a logical dump
instead:

```sh
docker exec "$(docker ps -qf name=warp-db)" pg_dump -U warp warp > warp-$(date +%F).sql
```

## Variants

**Run a published image instead of building on the host.** Delete the `build:`
block in `docker-compose.yml` and set an `image:` reference. The
[`containers.yml`](../../.github/workflows/containers.yml) workflow publishes
`ghcr.io/<owner>/warp` for the repository it runs in, but only on pushes to
`main` and on `v*.*.*` tags — a feature branch has no published image. Pin a
version tag in production.

**Use an external or Dokploy-managed PostgreSQL.** Remove the `warp-db` service
(and its volume, health check and `depends_on`) and change
`WARP_DATABASE_ADDRESS`, `WARP_DATABASE_NAME` and `WARP_DATABASE_USER` in the
app's `environment:` block to point at it. Those keys are set in the compose
file rather than `.env` precisely because they are wiring, not configuration.

**Mount extra files** (a replacement `theme.css`, SAML IdP metadata) via
*Advanced → Mounts* and reference the mount path from the compose file. Do
**not** bind-mount paths inside the repository checkout: Dokploy re-clones it on
every deploy, so those files are wiped.

## Troubleshooting

**Login form reloads instead of logging in, over plain http.** The compose file
defaults `WARP_SESSION_COOKIE_SECURE` to `true` and browsers silently discard a
`Secure` cookie on an http origin, so the session never sticks. Enable HTTPS on
the domain, or set `WARP_SESSION_COOKIE_SECURE=false` while testing on a
`*.traefik.me` domain.

**`received unexpected HTTP status: 500` or a pull rate limit.** The host cannot
pull from Docker Hub. Set both overrides from `.env.example` to the AWS ECR
Public copies of the same official images:

```
POSTGRES_IMAGE=public.ecr.aws/docker/library/postgres:18-alpine
ALPINE_IMAGE=public.ecr.aws/docker/library/alpine:3.24
```

Both are needed — `postgres` is the database image and `alpine` is the build
base, so overriding one alone just moves the failure to the other step. The
host-wide alternative is a pull-through mirror in `/etc/docker/daemon.json`
(`"registry-mirrors": ["https://mirror.gcr.io"]`, then `systemctl reload docker`),
which fixes every image at once but needs root on the host.

**Database starts empty after a redeploy.** The volume must be mounted at
`/var/lib/postgresql`, not the pre-18 `/var/lib/postgresql/data`: `postgres:18`
moved `PGDATA` to `/var/lib/postgresql/<major>/docker` and declares the volume
one level up. Keep the major version pinned too — a major upgrade needs a
dump/restore, not a tag bump.

**Changing `POSTGRES_PASSWORD` later has no effect.** The postgres image only
applies it when it initialises an empty data directory. Change it in the running
database and in the environment together:

```sh
docker exec "$(docker ps -qf name=warp-db)" \
  psql -U warp -c "ALTER ROLE warp WITH PASSWORD 'new-password'"
```

**iCal links come out as `http://`.** Traefik terminates TLS, so WARP itself
sees plain http and builds calendar deep links with that scheme; they still work
through Traefik's http→https redirect. The auth backends are unaffected — they
have their own `*_HTTPS_SCHEME` settings, which default to `https` and should
stay that way.

## Validating the compose file without Dokploy

It is a plain compose file, so a syntax check needs no Dokploy:

```sh
cd containers/dokploy
POSTGRES_PASSWORD=x WARP_SECRET_KEY=y docker compose config -q
```

Running it locally works too, but there is no Traefik to route to the app: add a
`ports: ["8080:8080"]` mapping to `warp-app` first, and note that
`dokploy-network` only exists on a Dokploy host.
