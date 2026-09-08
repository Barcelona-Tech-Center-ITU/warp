# WARP Container Files

This directory contains all container-related files for building and deploying WARP.
Both Docker and Podman are supported — substitute `docker` with `podman` in any
command below if that is your runtime.

## Directory layout

```
containers/
  Dockerfile          — production image (uWSGI, no database)
  Dockerfile_debug    — all-in-one debug/test image (Flask + PostgreSQL)
  res/
    entrypoint.sh     — production image entrypoint (starts uWSGI)
    Caddyfile         — Caddy reverse-proxy config (static files + unix socket)
  compose/
    compose.yaml      — example deployment via Docker / Podman Compose
  dokploy/
    docker-compose.yml — deployment for Dokploy (app behind Dokploy's Traefik)
    .env.example       — variables to paste into Dokploy's Environment tab
  quadlet/
    warp.pod                — Podman Quadlet: pod definition (network, ports)
    warp-shared.volume      — shared tmpfs volume (unix sockets + static files)
    warp-db.container       — PostgreSQL database container
    warp-app.container      — WARP application container (uWSGI)
    warp-revproxy.container — Caddy reverse proxy container
    nftables_init.sh        — optional pod-level firewall script
```

---

## `Dockerfile`

**Production image.** Runs WARP via uWSGI. Contains **no database** —
run PostgreSQL separately and configure the connection via `WARP_DATABASE_ADDRESS`,
`WARP_DATABASE_NAME`, `WARP_DATABASE_USER`, and `WARP_DATABASE_PASSWORD`.

By default the app listens on two **unix sockets** in `/run/warp`, intended for an
in-pod reverse proxy that shares the volume (see the Quadlet/compose setups). Two
environment variables control the endpoints; set either to a `host:port` to listen
on TCP instead, or to an empty string to disable that endpoint:

| Variable                    | Default                     | uWSGI flag                         |
| --------------------------- | --------------------------- | ---------------------------------- |
| `WARPAPP_UWSGI_SOCKET`      | `/run/warp/uwsgi.sock`      | `--socket` (uWSGI binary protocol) |
| `WARPAPP_UWSGI_HTTP_SOCKET` | `/run/warp/uwsgi-http.sock` | `--http-socket` (plain HTTP)       |

Build from the repository root:

```sh
docker build -f containers/Dockerfile -t warp:latest .
```

The only build argument is `ALPINE_IMAGE` (default `alpine:3.24`), the base for
both stages. Point it at a mirror — e.g.
`--build-arg ALPINE_IMAGE=public.ecr.aws/docker/library/alpine:3.24` — when the
build host cannot pull from Docker Hub.

Run (replace values as needed). Bind the HTTP endpoint to a TCP port so it is
reachable without an in-pod proxy:

```sh
docker run -d \
  --name warp \
  -p 8080:8080 \
  -e WARPAPP_UWSGI_HTTP_SOCKET=0.0.0.0:8080 \
  -e WARP_DATABASE_ADDRESS="db-host:5432" \
  -e WARP_DATABASE_NAME=warp \
  -e WARP_DATABASE_USER=user \
  -e WARP_DATABASE_PASSWORD=password \
  -e WARP_SECRET_KEY="<generated-secret>" \
  warp:latest
```

Place a reverse proxy in front of it — see [`res/Caddyfile`](#rescaddyfile) for
the Caddy config used by the compose and Quadlet deployments.

---

## `Dockerfile_debug`

**Debug / end-to-end test image.** Single Alpine-based image that runs both
PostgreSQL and Flask's development server in the same container:

- PostgreSQL 18 — initialised with `postgres_password` as the superuser
  password. Listens on **localhost inside the container only** by default.
- Flask debug server on port 5000 — resets the database to `sql/sample_data.sql`
  on every start.

> **Not for production use.** This image trades isolation and security for
> convenience: a single container, auto-reset state, the Werkzeug debugger, a
> hard-coded Postgres password, `fsync=off`, and the `/debug/*` blueprint with
> its authentication bypass all enabled. The published `ghcr.io/<owner>/warp:debug`
> tag exists purely for e2e/interactive debugging — deploy `warp:latest` (or a
> versioned tag) instead.

Used automatically by the e2e Playwright suite in `../e2e/`. You can also start
it manually for interactive debugging:

```sh
docker build -f containers/Dockerfile_debug -t warp-debug .
docker run --rm -p 5000:5000 warp-debug
```

Then open http://127.0.0.1:5000 and log in as `admin` / `noneshallpass`.

**Reaching PostgreSQL from the host.** By default the database is bound to the
container's loopback interface, so `-p 5432:5432` alone will _not_ expose it
(the proxy connects to the container IP, which Postgres is not listening on). To
inspect the database from the host, set `EXPOSE_POSTGRES=1` so Postgres binds all
interfaces, and publish the port:

```sh
docker run --rm -p 5000:5000 -p 5432:5432 -e EXPOSE_POSTGRES=1 warp-debug
# then: psql "postgresql://postgres:postgres_password@127.0.0.1:5432/postgres"
```

---

## `res/Caddyfile`

Reverse-proxy configuration for the Caddy container, shared by the Quadlet
deployment and the compose demo. It serves WARP's static assets directly from
the shared `/run/warp` volume and forwards every other request to the app over
the `/run/warp/uwsgi-http.sock` unix socket. By default it listens on plain HTTP
(`auto_https off`); to let Caddy manage TLS certificates, set a real domain as
the site address and remove `auto_https off`.

If WARP is mounted under a URL prefix (`WARP_BASE_PATH`, see
[CONFIGURATION.md](../CONFIGURATION.md#mounting-under-a-url-prefix)), the
Caddyfile's `/static/*` matcher must be updated to include that prefix — it
serves static files directly from disk and does not go through WARP's own
prefix handling. See the comments in `res/Caddyfile` for the exact line to
change.

---

## `compose/compose.yaml`

**Example production deployment** using Docker / Podman Compose. It mirrors the
Quadlet architecture (app behind Caddy, sharing a tmpfs `/run/warp` volume for
the unix socket and static files) and brings up three services from published
images:

| Service         | Image                 | Role                                  |
| --------------- | --------------------- | ------------------------------------- |
| `warp-db`       | `postgres` (official) | PostgreSQL database                   |
| `warp-app`      | `ghcr.io/sebo-b/warp` | WARP application (uWSGI)              |
| `warp-revproxy` | `caddy` (official)    | Reverse proxy, published on port 8080 |

**Quick start** (from the `compose/` directory):

```sh
cd containers/compose
docker compose up
```

Then open http://127.0.0.1:8080 and log in as `admin` / `noneshallpass` — the
schema and this initial admin account are created automatically on an empty
database; **change the password immediately**. Uncomment
`WARP_DATABASE_POST_INIT_SCRIPTS` in `compose.yaml` to also seed sample
zones/users, or use the [debug image](#dockerfile_debug) for a throwaway
all-in-one demo.

The compose file is intentionally minimal. To enable auth backends (OIDC, SAML,
LDAP, …) or any other feature, add the relevant `WARP_*` variables under
`warp-app.environment` — see [CONFIGURATION.md](../CONFIGURATION.md).

**Before deploying for real**, change at minimum:

| Variable                  | Current value       | What to set                                                              |
| ------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `warp_secret_key` secret  | `mysecretkey`       | A random secret — see [CONFIGURATION.md](../CONFIGURATION.md#secret-key) |
| `warp_db_password` secret | `postgres_password` | A strong database password (used by both the DB and the app)             |
| `warp-app` image tag      | `:latest`           | A pinned version, e.g. `:v1.2.3`                                         |
| `WARP_LANGUAGES`          | `["en","de","fr","es","pl"]` | JSON array of locale codes offered in the picker (`en`/`de`/`fr`/`es`/`pl`) |
| `WARP_DEFAULT_LANGUAGE`   | `en`               | Fallback language (must be listed in `WARP_LANGUAGES`)                     |

---

## Dokploy

[Dokploy](https://dokploy.com) is a self-hosted PaaS that deploys Docker Compose
services from a git repository and fronts them with its own Traefik reverse
proxy. `dokploy/docker-compose.yml` is a two-service deployment for it:

| Service    | Image                | Role                                        |
| ---------- | -------------------- | ------------------------------------------- |
| `warp-db`  | `postgres:18-alpine` | PostgreSQL, reachable from the app only     |
| `warp-app` | built from this repo | WARP application (uWSGI on TCP port `8080`) |

There is **no Caddy container** here — Dokploy's Traefik terminates TLS and
routes to the app, and uWSGI serves `/static` itself, so the shared-volume
static/unix-socket arrangement of the compose and Quadlet setups is not needed.

### Setup

1. **Create the service.** In your Dokploy project: *Create Service → Compose*,
   Compose Type **Docker Compose**. Select this repository and branch, and set
   the **Compose Path** to `./containers/dokploy/docker-compose.yml`.

2. **Set the environment.** Paste [`dokploy/.env.example`](dokploy/.env.example)
   into the *Environment* tab and replace the two `change-me` values:
   `WARP_SECRET_KEY` (generate with `openssl rand -hex 32`) and
   `POSTGRES_PASSWORD`. Dokploy writes the tab into a `.env` file next to the
   compose file; the app service loads it, so **any** `WARP_*` setting from
   [CONFIGURATION.md](../CONFIGURATION.md) — auth backends, booking window,
   reminders — can be added there without editing the compose file.

3. **Add the domain.** *Domains* tab → service `warp-app`, port `8080`, and
   enable HTTPS (Let's Encrypt). Dokploy injects the Traefik labels itself, so
   the compose file needs none. Point an `A` record at the Dokploy host first.

4. **Deploy.** The first deploy builds the image from `containers/Dockerfile`
   (webpack + Python wheels, a few minutes; subsequent deploys reuse the layer
   cache). On the empty database WARP creates the schema and the default
   `admin` / `noneshallpass` account — **change that password immediately**.

To deploy a published image instead of building on the host, delete the `build:`
block in `dokploy/docker-compose.yml` and set an `image:` reference (the
[`containers.yml`](../.github/workflows/containers.yml) workflow publishes
`ghcr.io/<owner>/warp` for the repository it runs in).

### Notes

- **Database data** lives in the `warp-db-data` named volume, mounted at
  `/var/lib/postgresql` as `postgres:18` requires — not the pre-18
  `/var/lib/postgresql/data`, which would silently start an empty database on
  every redeploy. Named (not bind-mounted) so Dokploy's *Volume Backups* can
  back it up. The image is pinned to a major version on purpose: a major bump
  needs a dump/restore.
- **Login fails silently over plain http.** The compose file defaults
  `WARP_SESSION_COOKIE_SECURE` to `true`, and browsers discard a `Secure` cookie
  on an http origin, so the login form just returns to itself. Either enable
  HTTPS on the domain or set `WARP_SESSION_COOKIE_SECURE=false` while testing
  (e.g. on a `*.traefik.me` domain).
- **If Docker Hub pulls fail on the host** — `received unexpected HTTP status:
  500` or a rate limit — set `POSTGRES_IMAGE` and `ALPINE_IMAGE` in the
  Environment tab to the ECR Public copies listed in `.env.example`. Both images
  come from Docker Hub by default: `postgres` for the database and `alpine` as
  the build base, so overriding only one leaves the deploy failing at the other
  step. The alternative is a daemon-level pull-through mirror on the host
  (`registry-mirrors` in `/etc/docker/daemon.json`), which fixes it for every
  image but needs root on the host and a `systemctl reload docker`.
- **Don't bind-mount repository files.** Dokploy re-clones the repository on
  every deploy, so paths inside the checkout are wiped; use Dokploy's
  *Advanced → Mounts* for extra files (a replacement `theme.css`, SAML IdP
  metadata) and reference the mount path from the compose file.
- **TLS-scheme-dependent URLs.** Traefik terminates TLS, so WARP itself sees
  plain http. The auth backends have their own `*_HTTPS_SCHEME` settings
  (default `https`, keep it), but iCal feed deep links are built from the scheme
  WARP sees and come out as `http://` — they work through Traefik's http→https
  redirect.

The file is a plain compose file, so it can be validated without Dokploy:

```sh
cd containers/dokploy
POSTGRES_PASSWORD=x WARP_SECRET_KEY=y docker compose config -q
```

---

## Podman Quadlet (systemd integration)

[Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
lets Podman generate systemd services from declarative unit files. The files in
`quadlet/` define a production deployment as a systemd-managed pod. **This is the
deployment WARP uses in practice and the most thoroughly tested path** — prefer it
for production; the [compose setup](#composecomposeyaml) mirrors the same
architecture but is exercised less.

### Architecture

```
[ systemd ]
     │
     └─ warp-pod.service   (pod — shared network ns + shared /run/warp volume)
           ├─ warp-db.service        ← PostgreSQL on localhost:5432 (in-pod)
           ├─ warp-app.service       ← uWSGI: HTTP unix socket in /run/warp
           └─ warp-revproxy.service  ← Caddy on :80 (+ :443), published to host
```

All containers share `localhost`, so the app connects to the database at
`localhost:5432`. The app and Caddy also share the `warp-shared` tmpfs volume
mounted at `/run/warp`: the app exposes its HTTP socket
(`/run/warp/uwsgi-http.sock`) and copies its static assets there on start, and
Caddy reads both from the same volume. Only Caddy's ports (80/443) are published
to the host.

**Reverse proxy is optional.** If you run a reverse proxy on a _separate_ host,
you can drop the Caddy container entirely and have the app listen on a TCP port
instead: in `warp-app.container` set `WARPAPP_UWSGI_HTTP_SOCKET=0.0.0.0:8080`
(plain HTTP upstream) or `WARPAPP_UWSGI_SOCKET=0.0.0.0:8000` (uWSGI protocol), and
publish the matching port via the commented `PublishPort` lines in `warp.pod`.
Remove `warp-revproxy.container` (and its `warp-shared.volume`) in that case.

If you prefer an **external PostgreSQL**, remove `warp-db.container` and update
`WARP_DATABASE_ADDRESS` (and `WARP_DATABASE_NAME`/`WARP_DATABASE_USER`/password)
in `warp-app.container` with the external host.

### Quadlet files

| File                      | Type         | Role                                                                 |
| ------------------------- | ------------ | -------------------------------------------------------------------- |
| `warp.pod`                | `.pod`       | Pod definition — networking, port publishing, UserNS, restart policy |
| `warp-shared.volume`      | `.volume`    | Shared tmpfs at `/run/warp` (unix sockets + static files)            |
| `warp-db.container`       | `.container` | PostgreSQL database container                                        |
| `warp-app.container`      | `.container` | WARP application container (uWSGI)                                   |
| `warp-revproxy.container` | `.container` | Caddy reverse proxy container                                        |
| `nftables_init.sh`        | shell script | Optional: pod-level firewall via nftables                            |

### Setup

The examples below use system-wide (root) Podman. For rootless, drop `sudo` and
install the unit files under `~/.config/containers/systemd/` instead.

1. **Image.** `warp-app.container` pulls the application image from the GitHub
   Container Registry (`ghcr.io/sebo-b/warp:latest`), built and published by the
   [`containers.yml`](../.github/workflows/containers.yml) GitHub Actions
   workflow — `AutoUpdate=registry` keeps it current via `podman auto-update`.
   No local build is required; pin a version tag for production. (To build from
   source instead, run `podman build -f containers/Dockerfile -t warp:latest .`
   and set `Image=warp:latest`.)

2. **Create the podman secrets**:

   ```sh
   # Database password (used by both the DB and the app containers)
   printf '%s' 'a-strong-db-password' | sudo podman secret create warp-db-password -
   # Flask cookie-signing key
   python -c 'import os; print(os.urandom(16))' | sudo podman secret create warp-secret-key -
   ```

3. **Create the host directories.** With the default `UserNS=auto` mapping in
   `warp.pod` (base `100000`), container UIDs are shifted by `100000` on the host.

   ```sh
   # PostgreSQL data — owned by the in-container postgres user (999 → host 100999)
   sudo install -d -o 100999 -g 100999 /srv/warp/postgresql

   # Caddy config dir + the Caddyfile, and its certificate/data store.
   # Caddy runs as root in the container (0 → host 100000).
   sudo install -d -o 100000 -g 100000 /srv/caddy /srv/caddy_data
   sudo install -m644 containers/res/Caddyfile /srv/caddy/Caddyfile
   ```

   > Without `UserNS`, use the unshifted IDs instead (`999` and `0`).
   > The `/data` mount is important: Caddy stores issued TLS certificates there,
   > and a non-persistent path would re-request them on every start and quickly
   > hit rate limits.

4. **Review the unit files** and adjust paths if you changed any of the
   directories above (`Volume=` lines in `warp-db.container` and
   `warp-revproxy.container`), the image reference in `warp-app.container`, and
   `WARP_LANGUAGES` / `WARP_DEFAULT_LANGUAGE` (per-user language picker; see
   CONFIGURATION.md).

5. **Install the unit files** into the Quadlet drop-in directory and reload:

   ```sh
   sudo cp containers/quadlet/*.pod \
            containers/quadlet/*.volume \
            containers/quadlet/*.container \
            /etc/containers/systemd/
   sudo systemctl daemon-reload
   ```

   (You can also symlink them from a checkout so updates track the repository.)

6. **Start the pod** and enable it on boot:

   ```sh
   sudo systemctl start warp-pod.service
   sudo systemctl enable warp-pod.service
   ```

   Check status with `podman pod ps` and `podman logs warp-app`.

### Optional: pod-level firewall with nftables

`nftables_init.sh` applies firewall rules directly inside the pod's network
namespace after the pod starts. This lets you restrict which hosts can reach the
published ports — useful when you want only a trusted upstream (e.g. a load
balancer) to connect directly to the pod.

The script uses `nsenter` to enter the network namespace owned by the pod's infra
container and loads an nftables ruleset there, completely separate from the host
firewall. It locates that container via the pod-id-file passed as `%t/%N.pod-id`
(the same kind of ID file Quadlet uses for Caddy's reload), so it keeps working
regardless of how the pod or its containers are named.

To enable it:

```sh
# Install the script
sudo install -Dm755 containers/quadlet/nftables_init.sh /srv/warp/nftables_init.sh

# Edit /srv/warp/nftables_init.sh and set ALLOWED_HTTP_SOURCE to the IP or CIDR
# of your upstream reverse proxy (or leave 0.0.0.0/0 to allow all). HTTP_PORTS
# defaults to "80 443"; set it to the app port (8080/8000) if you publish those.

# Uncomment ExecStartPost= in containers/quadlet/warp.pod, then re-copy and reload:
sudo cp containers/quadlet/warp.pod /etc/containers/systemd/
sudo systemctl daemon-reload
sudo systemctl restart warp-pod.service
```

Dependencies: `nftables` and `nsenter` (from `util-linux`) must be installed on
the host.

### Optional: networking and user namespaces

By default the pod uses the default Podman network. To attach it to a named
network, create a `warp.network` Quadlet file and uncomment the `Network=` line
in `warp.pod`.

The `UserNS=auto:...` line in `warp.pod` maps container UIDs into an unprivileged
host range (base `100000`). Adjust it to match your `/etc/subuid` and
`/etc/subgid` entries, and remember to shift host directory ownership
accordingly (see step 3).
