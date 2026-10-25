# HoV Router image, built from this checkout (no prebuilt image is published).
#
#   docker build -t hov-router:local .
#   docker build --build-arg GIT_SHA="$(git rev-parse HEAD)" -t hov-router:local .
#
# Single platform: whatever the Docker host builds natively (amd64 or arm64).

# Keep in step with .bun-version (production runs the same Bun release).
ARG BUN_VERSION=1.4.2

# ---- builder: compile the dashboard and the single-file binary ----
FROM oven/bun:${BUN_VERSION}-debian AS builder

WORKDIR /src

# Manifests first so the dependency layer is reused until a manifest or the
# lockfile changes.
COPY package.json bun.lock ./
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/lander/package.json ./apps/lander/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY packages/agents/package.json ./packages/agents/package.json
COPY packages/cli-commands/package.json ./packages/cli-commands/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/core-di/package.json ./packages/core-di/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/dashboard-web/package.json ./packages/dashboard-web/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/errors/package.json ./packages/errors/package.json
COPY packages/http-api/package.json ./packages/http-api/package.json
COPY packages/http-common/package.json ./packages/http-common/package.json
COPY packages/load-balancer/package.json ./packages/load-balancer/package.json
COPY packages/logger/package.json ./packages/logger/package.json
COPY packages/oauth-flow/package.json ./packages/oauth-flow/package.json
COPY packages/openai-formats/package.json ./packages/openai-formats/package.json
COPY packages/openai-responses-adapter/package.json ./packages/openai-responses-adapter/package.json
COPY packages/providers/package.json ./packages/providers/package.json
COPY packages/proxy/package.json ./packages/proxy/package.json
COPY packages/security/package.json ./packages/security/package.json
COPY packages/types/package.json ./packages/types/package.json
COPY packages/ui-common/package.json ./packages/ui-common/package.json
COPY packages/ui-constants/package.json ./packages/ui-constants/package.json

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY . .

# Same command as the repo build: dashboard, then the compiled CLI binary
# (apps/cli/dist/better-ccflare). .git is not in the build context, so the
# build embeds an "unknown" git SHA and emits no release provenance. The
# runtime stage supplies the SHA from the GIT_SHA build argument instead.
RUN bun run build

# ---- runtime ----
# Debian 13 (trixie) is the current stable release. The binary is dynamically
# linked against glibc and the builder image is also trixie, so the runtime
# glibc matches the one the binary was built against.
FROM debian:trixie-slim

# curl serves the HEALTHCHECK; ca-certificates lets the proxy verify upstream TLS.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /src/apps/cli/dist/better-ccflare /usr/local/bin/better-ccflare
RUN ln -s better-ccflare /usr/local/bin/hov-router

# Non-root user; /data holds the database and config.
RUN useradd -u 1000 -m -s /bin/bash ccflare && \
    mkdir -p /data /app/logs && \
    chown -R ccflare:ccflare /data /app

WORKDIR /app

# Build provenance for /health (packages/http-api/src/handlers/health.ts).
# A source build proves no release identity, so DISTRIBUTION stays "unknown"
# and /health reports distribution.proven=false. GIT_SHA only labels the build.
ARG VERSION=unknown
ARG GIT_SHA
ARG GIT_REF=unknown
ARG CHECKOUT_SHA=unknown
ARG EVENT_SHA=unknown
ARG TAG_SHA=unknown
ARG DISTRIBUTION=unknown
ARG PRODUCER=unknown
ARG ARTIFACT_MODE=unknown
ARG UPDATE_CHANNEL=unknown
ARG BUILD_DATE=unknown

ENV NODE_ENV=production
ENV BETTER_CCFLARE_DB_PATH=/data/better-ccflare.db
ENV XDG_CONFIG_HOME=/data
ENV BETTER_CCFLARE_LOG_DIR=/app/logs
# /health git_sha: the binary has no embedded SHA here, so it reads this.
# Empty when GIT_SHA is not passed, which /health reports as null.
ENV BETTER_CCFLARE_GIT_SHA=${GIT_SHA}
ENV CCFLARE_VERSION=${VERSION}
ENV CCFLARE_GIT_SHA=${GIT_SHA:-unknown}
ENV CCFLARE_GIT_REF=${GIT_REF}
# Redundant copies let the runtime reject a stale or conflicting tuple.
ENV CCFLARE_SOURCE_SHA=${GIT_SHA:-unknown}
ENV CCFLARE_SOURCE_REF=${GIT_REF}
ENV CCFLARE_CHECKOUT_SHA=${CHECKOUT_SHA}
ENV CCFLARE_EVENT_SHA=${EVENT_SHA}
ENV CCFLARE_TAG_SHA=${TAG_SHA}
ENV CCFLARE_BUILD_DATE=${BUILD_DATE}
ENV CCFLARE_DISTRIBUTION=${DISTRIBUTION}
ENV CCFLARE_PRODUCER=${PRODUCER}
ENV CCFLARE_ARTIFACT_MODE=${ARTIFACT_MODE}
ENV CCFLARE_UPDATE_CHANNEL=${UPDATE_CHANNEL}

LABEL org.opencontainers.image.title="HoV Router"
LABEL org.opencontainers.image.description="Use your AI accounts from one place, and see which account handled each request. Routes Claude Code and other clients across your provider accounts, with a dashboard for usage, cost and errors."
LABEL org.opencontainers.image.source="https://github.com/StartupBros/hov-router"
LABEL org.opencontainers.image.licenses="MIT"

# Startup banner, then hand over to the binary.
COPY <<'EOF' /usr/local/bin/entrypoint.sh
#!/bin/bash
echo "================================="
echo "HoV Router Docker Container"
echo "================================="
echo "Architecture: $(uname -m)"
echo ""
/usr/local/bin/better-ccflare --version
echo "================================="
echo ""
exec /usr/local/bin/better-ccflare "$@"
EOF
RUN chmod +x /usr/local/bin/entrypoint.sh

USER ccflare

VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["--serve", "--port", "8080"]
