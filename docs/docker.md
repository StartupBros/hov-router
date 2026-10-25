# Run HoV Router in Docker

HoV Router publishes no container image. You build the image from a checkout of this repository, which compiles the dashboard and the `better-ccflare` binary inside Docker. Nothing from [tombii/better-ccflare](https://github.com/tombii/better-ccflare) is downloaded: the `ghcr.io/tombii/better-ccflare` image and its release binaries are upstream's, not this fork's.

You need Docker with BuildKit (any current Docker Engine or Docker Desktop). The build works on whatever platform your Docker host builds natively (amd64 or arm64); it is not cross-built.

## Build and run with Docker Compose

```bash
git clone https://github.com/StartupBros/hov-router.git
cd hov-router
docker compose up -d --build
```

Open <http://localhost:8080> and add accounts in the dashboard. Account sign-in that needs a browser (OAuth modes) works through the dashboard; the container has no browser for CLI-driven sign-in.

A fresh install with no accounts reports `unhealthy` on `/health` (HTTP 503) once the 40-second start period ends, because `/health` is `ok` only when at least one account can serve requests. Add an account and the container turns healthy.

The compose file keeps the service, container and volume names `better-ccflare` and `better-ccflare-data` from before the rename, so a second container name doesn't fight an existing one for port 8080. Docker Compose prefixes the volume with the project name, which defaults to the checkout's directory name: the clone above stores its data in `hov-router_better-ccflare-data`. Run compose from the same directory (or with the same `COMPOSE_PROJECT_NAME`) to keep using that data.

`docker compose` reads an optional `.env` file next to `docker-compose.yml` (see [`.env.example`](../.env.example)); it starts fine without one.

## Build and run with plain Docker

```bash
docker build -t hov-router:local .

docker run -d --name hov-router \
  -p 8080:8080 \
  -v hov-router-data:/data \
  hov-router:local
```

To label the build with its commit, pass the SHA. `/health` then reports it as `git_sha`:

```bash
docker build --build-arg GIT_SHA="$(git rev-parse HEAD)" -t hov-router:local .
```

Pass settings with `-e NAME=value` or `--env-file .env`. The container runs `--serve --port 8080`; append other flags after the image name, for example `hov-router:local --serve --port 8080 --help`. Both `hov-router` and `better-ccflare` are on the container's `PATH`.

## What the image contains

- A two-stage build: the `oven/bun` builder (pinned to the Bun version in `.bun-version`) compiles with the same `bun run build` as a source checkout; the runtime stage is `debian:trixie-slim` (Debian 13, the current stable release) with `ca-certificates` and `curl` (for the health check) and the compiled binary.
- A non-root user, `ccflare` (uid 1000).
- Port 8080 and a `HEALTHCHECK` on `/health`.
- `/data`, a volume holding the database and config.

## Data, config and backups

| Variable | Value in the image |
| --- | --- |
| `BETTER_CCFLARE_DB_PATH` | `/data/better-ccflare.db` |
| `XDG_CONFIG_HOME` | `/data` (config lands in `/data/better-ccflare/better-ccflare.json`) |
| `BETTER_CCFLARE_LOG_DIR` | `/app/logs` |
| `NODE_ENV` | `production` |

All the usual settings (`LOG_LEVEL`, `LB_STRATEGY`, `STORE_PAYLOADS`, `PAYLOAD_ENCRYPTION_KEY`, `HEALTH_DETAIL_ENABLED`, and the rest) are described in [configuration](configuration.md) and work as environment variables here.

Back up with the container stopped, so SQLite has flushed its WAL. `--volumes-from better-ccflare` mounts whichever volume that container actually uses, whatever compose project created it, and the command refuses to write an archive when the database is missing:

```bash
docker compose stop
docker run --rm --volumes-from better-ccflare -v "$PWD":/backup debian:trixie-slim \
  sh -c 'test -f /data/better-ccflare.db && tar czf /backup/hov-router-data.tgz -C /data .'
docker compose start
```

To restore, stop the container and replace everything in its volume with the archive. The command checks that the archive is readable and contains the database before it deletes anything:

```bash
docker compose stop
docker run --rm --volumes-from better-ccflare -v "$PWD":/backup debian:trixie-slim \
  sh -c 'tar tzf /backup/hov-router-data.tgz ./better-ccflare.db >/dev/null && find /data -mindepth 1 -delete && tar xzf /backup/hov-router-data.tgz -C /data'
docker compose start
```

With plain Docker, use `docker stop` / `docker start` and replace `better-ccflare` with your container's name (`hov-router` in the example above). To use a host directory instead of a named volume, mount it at `/data` and make it writable by uid 1000: `chown 1000:1000 ./data`.

## Health and provenance

`/health` reports `version`, `git_sha`, and a `distribution` block. A source build proves no release identity, so `distribution.proven` is `false` with reason `unknown_distribution`, and `git_sha` is the `GIT_SHA` you built with (`null` if you passed none). The update checker therefore never treats a locally built image as an upstream release.

## Upgrade

From the same checkout:

```bash
cd hov-router
git pull
docker compose up -d --build
```

The volume is untouched, and the database migrates on start.

### Moving from upstream's compose file

An install from upstream's compose file (the one that ran `ghcr.io/tombii/better-ccflare:latest`) keeps its data in `<old-project>_better-ccflare-data`, where `<old-project>` is usually the directory it ran from. A new `hov-router` checkout would get a different, empty volume, so reuse the old project name. Back up first with the commands above, run from the old install's directory.

1. Read the old project name while the old container still exists:

   ```bash
   docker inspect better-ccflare --format '{{ index .Config.Labels "com.docker.compose.project" }}'
   ```

2. Remove the old container from its directory, keeping its volume (no `-v`):

   ```bash
   cd /path/to/old-install
   docker compose down
   ```

3. In the new checkout, set the old project name, then build and start:

   ```bash
   cd hov-router
   echo "COMPOSE_PROJECT_NAME=<old-project>" >> .env
   docker compose up -d --build
   ```

4. Check that the container mounted the old volume and that the database is there:

   ```bash
   docker inspect better-ccflare --format '{{ range .Mounts }}{{ .Name }}{{ end }}'
   docker compose exec better-ccflare ls -l /data/better-ccflare.db
   ```

   The first command prints `<old-project>_better-ccflare-data`, and your accounts appear in the dashboard as before.

## Related

- [Deployment options](deployment.md), including the systemd service in [systemd](systemd.md).
- [Release policy](hov-router-releases.md): releases here are draft-only GitHub releases of the binary; no container image is part of them.
- [Acknowledgements](acknowledgements.md) for upstream credit.
