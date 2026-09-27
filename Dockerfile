# ─────────────────────────────────────────────────────────────────────────────
# Koyeb single-service bundle: cebian-gateway (Telegram relay) + 9router-go
# (LLM router), behind one front proxy on a single public port.
#
# Koyeb's free plan keeps only ONE exposed port on the service, so the router
# cannot get its own route. proxy.mjs owns port 8000 and splits by exact path:
#
#   /health, /webhook/telegram, /ws  -> gateway :8001  (fixed paths only)
#   everything else                  -> router  :20130 (dashboard, /v1, /api)
#
# The router keeps ROOT because its dashboard is a SPA with hardcoded absolute
# asset paths; mounting it under a prefix breaks /assets/* and renders blank.
# The gateway needs no prefix because it serves no assets.
#
# Memory: Node proxy ~10 MB + gateway ~70 MB + Go router ~42 MB, inside 512 MB.
#
# Local patches: patches/*.patch are applied on top of the pinned upstream
# commit (see the src stage). Keep them minimal and re-derivable — on an
# upstream fix landing, drop the patch and bump ROUTER_SHA.
# ─────────────────────────────────────────────────────────────────────────────

# Pinned upstream commit = tag v1.9.3 (2026-09-26): Kiro tool calling end-to-end
# (tool catalogue on request + fragmented-argument reassembly), accessToken
# instead of apiKey + endpoint rotation, /v1/models at full upstream parity,
# and a GetCombos pool-deadlock fix. Ahead of the old v1.9.2-era pin, so the
# fresh-DATA_DIR schema bootstrap stays in.
#
# Why build from source and not use a released image? Docker Hub artifacts have
# lagged git history before: the v1.9.2 "latest" image was pushed before the
# schema-bootstrap commit landed, so on a brand-new DATA_DIR it never created
# the core tables and every write failed with "no such table: settings".
# Building the exact commit sidesteps image staleness entirely.
#
# A full 40-char SHA, not a branch — the build is reproducible. Bump to upgrade.
ARG ROUTER_SHA=044166efe11fbe16bcfa3e9188d47e2d463a08cd

# ── Fetch upstream source once, at the pinned commit ─────────────────────────
FROM alpine:3.21 AS src
ARG ROUTER_SHA
# Local fixes carried on top of the pinned upstream commit. Each patch is a
# git-format diff generated against ROUTER_SHA exactly; a bump that breaks one
# fails the build HERE instead of shipping a silently reverted fix.
COPY patches/ /patches/
RUN apk add --no-cache curl tar patch \
 && curl -fsSL "https://codeload.github.com/luqman-v1/9router-go/tar.gz/${ROUTER_SHA}" -o /tmp/src.tgz \
 && mkdir -p /src \
 && tar -xzf /tmp/src.tgz --strip-components=1 -C /src \
 && rm /tmp/src.tgz \
 && cd /src \
 && for p in /patches/*.patch; do echo "[patch] applying $(basename "$p")"; patch -p1 < "$p"; done

# ── Build the dashboard SPA (bun + Vite) ─────────────────────────────────────
# web/dist/ is gitignored upstream and consumed via //go:embed dist/*, so the
# Go stage below MUST receive these built assets before it compiles.
FROM oven/bun:1-alpine AS web-builder
WORKDIR /src
COPY --from=src /src/ ./
WORKDIR /src/web
RUN bun install --frozen-lockfile && bun run build

# ── Build the Go binary with the SPA embedded ────────────────────────────────
FROM golang:1.27-alpine AS go-builder
WORKDIR /src
COPY --from=src /src/ ./
COPY --from=web-builder /src/web/dist ./web/dist
# CGO_ENABLED=0 is mandatory: the binary must run on musl (alpine). A cgo build
# links glibc and dies with "not found" (missing ld-linux).
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/9router-go ./cmd/9router-go/ \
 && /out/9router-go version

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:20-alpine

COPY --from=go-builder /out/9router-go /usr/local/bin/9router-go
RUN chmod +x /usr/local/bin/9router-go

WORKDIR /app

# Gateway deps first (layer cache — only re-install when package.json changes)
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Source
COPY server.js ./
COPY proxy.mjs ./
COPY start.sh ./
RUN chmod +x start.sh

# Koyeb Web Services inject PORT; the front proxy binds it. The gateway and
# router listen on internal ports the edge never sees.
ENV PORT=8000 \
    GATEWAY_PORT=8001 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data \
    ROUTER_PORT=20130

EXPOSE 8000

# Run as the non-root "node" user. /data must be writable for the SQLite DB.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

CMD ["./start.sh"]
