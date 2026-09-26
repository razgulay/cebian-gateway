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
# ─────────────────────────────────────────────────────────────────────────────

# Pinned upstream commit. Why build from source and not use a released image?
# No published artifact carries the fresh-DATA_DIR schema bootstrap: tag v1.9.2
# closed at 03:55, the "feat(db): self-bootstrap upstream core schema" commit
# landed at 04:33, and the Docker Hub "latest" image was pushed at 04:04 with
# the same digest as 1.9.2. On a brand-new DATA_DIR that build never creates the
# core tables, so every write fails with "no such table: settings" and OAuth
# connect dies at the final INSERT.
#
# A full 40-char SHA, not a branch — the build is reproducible. Bump to upgrade.
ARG ROUTER_SHA=da3d26542b9c6c625898fc9855196828cd46d4d8

# ── Fetch upstream source once, at the pinned commit ─────────────────────────
FROM alpine:3.21 AS src
ARG ROUTER_SHA
RUN apk add --no-cache curl tar \
 && curl -fsSL "https://codeload.github.com/luqman-v1/9router-go/tar.gz/${ROUTER_SHA}" -o /tmp/src.tgz \
 && mkdir -p /src \
 && tar -xzf /tmp/src.tgz --strip-components=1 -C /src \
 && rm /tmp/src.tgz

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
