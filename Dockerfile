# syntax=docker/dockerfile:1.7
#
# spacehub images, server and client, from one Dockerfile.
#
#   docker build -t spacehub-server .                 (server is the default target)
#   docker run -d -p 3000:3000 -v spacehub-data:/data spacehub-server
#
#   docker build --target client -t spacehub .
#   docker run --rm -it -e SPACEHUB_SERVER=wss://hub.example.com -v spacehub-home:/home/node/.spacehub spacehub auth status
#
# The server is SpacetimeDB with the spacehub module published on every start,
# the web service (sign in, sign up, GitHub import) and a built-in allowlist
# proxy on $PORT. The client is git plus the spacehub CLI and
# git-remote-quirq.

ARG SPACETIME_VERSION=v2.12.0
ARG NODE_VERSION=22
ARG CADDY_VERSION=2.8.4

# The module and CLI bundles are plain JavaScript, so they build on the
# builder's own platform; only the server binaries follow --platform.
FROM --platform=$BUILDPLATFORM clockworklabs/spacetime:${SPACETIME_VERSION} AS spacetime-tools
FROM clockworklabs/spacetime:${SPACETIME_VERSION} AS spacetime
FROM caddy:${CADDY_VERSION} AS caddy
FROM node:${NODE_VERSION}-bookworm-slim AS node-runtime

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS module
COPY --from=spacetime-tools /opt/spacetime/spacetimedb-cli /usr/local/bin/spacetime
WORKDIR /src/module
COPY module/package.json module/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY module/tsconfig.json ./
COPY module/src ./src
RUN spacetime build

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS cli
WORKDIR /src/cli
COPY cli/package.json cli/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY cli/tsconfig.json ./
COPY cli/src ./src
# The web service shares the UI's stylesheet and the sign-in steps with the
# module, `spacehub collab` reads the chat's format from it, and every client
# checks the hub's protocol against the module's
# (cli/test/dockerfile.test.ts).
COPY module/src/style.ts /src/module/src/style.ts
COPY module/src/protocol.ts /src/module/src/protocol.ts
COPY module/src/howto.ts /src/module/src/howto.ts
COPY module/src/collab.ts /src/module/src/collab.ts
RUN npm run build

# The hub's app (open-chat's interface), served by the web service at /.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS app
WORKDIR /src/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/tsconfig.json app/build.mjs ./
COPY app/src ./src
COPY app/public ./public
RUN npm run build

# ------------------------------------------------------------------ client
FROM node:${NODE_VERSION}-alpine AS client
RUN apk add --no-cache git openssh-client ca-certificates
COPY --from=cli /src/cli/dist /opt/spacehub/dist
COPY cli/bin /opt/spacehub/bin
RUN ln -s /opt/spacehub/bin/spacehub /usr/local/bin/spacehub \
 && ln -s /opt/spacehub/bin/git-remote-quirq /usr/local/bin/git-remote-quirq \
 && ln -s /opt/spacehub/bin/git-remote-spacehub /usr/local/bin/git-remote-spacehub
USER node
# Your identity lives in ~/.spacehub; mount a volume there to keep it.
RUN mkdir -p /home/node/.spacehub /home/node/work
WORKDIR /home/node/work
ENTRYPOINT ["spacehub"]
CMD ["help"]

# ------------------------------------------------------------------ server (default)
# SpacetimeDB's binaries, Caddy, and Node + git for the web service's GitHub
# imports; the stock SpacetimeDB image also carries Rust and .NET toolchains
# for building modules, which a server does not need.
FROM debian:bookworm-slim AS server
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 spacetime \
 && mkdir -p /data /opt/spacehub \
 && chown spacetime:spacetime /data
COPY --from=spacetime /opt/spacetime /opt/spacetime
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=cli /src/cli/dist /opt/spacehub/cli/dist
COPY --from=app /src/app/dist /opt/spacehub/app
COPY cli/bin /opt/spacehub/cli/bin
RUN ln -s /opt/spacetime/spacetimedb-cli /usr/local/bin/spacetime \
 && ln -s /opt/spacehub/cli/bin/spacehub /usr/local/bin/spacehub \
 && ln -s /opt/spacehub/cli/bin/git-remote-quirq /usr/local/bin/git-remote-quirq \
 && ln -s /opt/spacehub/cli/bin/git-remote-spacehub /usr/local/bin/git-remote-spacehub
COPY --from=module /src/module/dist/bundle.js /opt/spacehub/module.js
COPY docker/server.Caddyfile /opt/spacehub/Caddyfile
COPY docker/starting.Caddyfile /opt/spacehub/starting.Caddyfile
COPY --chmod=755 docker/server-entrypoint.sh /usr/local/bin/spacehub-server
# Backups of /data: spacehub-db backup | list | verify | restore (README, Back up and restore).
COPY --chmod=755 scripts/spacehub-db /usr/local/bin/spacehub-db
# The entrypoint starts as root only to take ownership of /data (platform
# volumes usually mount root-owned), then runs everything as `spacetime`.
# /data holds the databases, the server's signing keys and the identity that
# owns the spacehub database. Mount persistent storage there, or every
# restart forgets all spaces and logs every client out.
ENV SPACEHUB_DB=spacehub \
    SPACEHUB_APP_DIR=/opt/spacehub/app \
    SPACETIME_ROOT=/data \
    SPACETIME_INTERNAL_PORT=3001 \
    SPACEHUB_BACKUP_DIR=/backups \
    SPACEHUB_WEB_PORT=3002 \
    PORT=3000
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s \
  CMD curl -sf "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["spacehub-server"]
