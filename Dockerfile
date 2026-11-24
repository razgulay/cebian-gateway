# ──────────────────────────────────────────────────────────────────────────────
# cebian-gateway - 3-process container, 9router-go built FROM SOURCE.
#
#   proxy.mjs  :8000  public  (splits /health,/webhook/telegram,/ws -> gateway;
#                              everything else -> router)
#   server.js  :8001  internal (Telegram relay + /ws)
#   9router-go :20130 internal (LLM router + embedded Svelte dashboard)
#
# WHY SOURCE BUILD (do not "simplify" this back to the prebuilt release binary):
# patch 0010 (CORS) is not in upstream v1.9.16, and the prebuilt release
# binaries on GitHub contain none of the local patches. Without 0010 the gateway
# emits no CORS headers and chi answers preflight OPTIONS /v1/messages with 405,
# so every browser-based client (Claude for Office webview, web apps) dies with
# a bare "Failed to fetch" while curl/SDK clients work fine.
#
# RESTORED TO VANILLA (2026-11-24): patches 0001-0009 were removed. This image
# now tracks upstream v1.9.16 with exactly one local patch. See NOTES.md for
# what each retired patch used to do and what regresses without it.
# ──────────────────────────────────────────────────────────────────────────────
# Pinned upstream commit = tag v1.9.16 (2026-11-12, 0a1cf78). Full 40-char SHA,
# not a branch — the build is reproducible. Bump to upgrade, then re-verify the
# patch still applies (the src stage fails the build if it no longer does).
ARG ROUTER_SHA=0a1cf7853f7d7e5392c0b790388f13847b3b0c6e

# ── Fetch upstream source once, at the pinned commit, and apply the local patch ─
FROM alpine:3.21 AS src
ARG ROUTER_SHA
COPY patches/ /patches/

# The grep assertions below fail the build if the patch ever lands as a no-op, so
# a silent revert can never ship. Each marker is a string only the patch adds.
RUN apk add --no-cache curl tar patch \
 && curl -fsSL "https://codeload.github.com/luqman-v1/9router-go/tar.gz/${ROUTER_SHA}" -o /tmp/src.tgz \
 && mkdir -p /src \
 && tar -xzf /tmp/src.tgz --strip-components=1 -C /src \
 && rm /tmp/src.tgz \
 && cd /src \
 && for p in /patches/*.patch; do echo "[patch] applying $(basename "$p")"; patch -p1 --no-backup-if-mismatch < "$p"; done \
 && grep -q "corsPreflightMaxAge" internal/middleware/cors.go \
 && grep -q "middleware.CORS" internal/app/handlers.go \
 && echo "[patch] all fix markers present"

# ── Build the dashboard SPA (bun + Vite) ──────────────────────────────────────
# web/dist/ is gitignored upstream and consumed via //go:embed dist/*, so the
# Go stage below MUST receive these built assets before it compiles.
#
# bun is PINNED: upstream's web/bun.lock is lockfileVersion 2, which bun 1.3
# cannot parse ("UnknownLockfileVersion ... Ignoring lockfile" then
# "lockfile had changes, but lockfile is frozen"). Upstream CI builds with
# 1.4.2; the unpinned `oven/bun:1-alpine` tag silently follows the newest 1.x,
# so a future major could break the frozen install the same way.
FROM oven/bun:1.4.3-alpine AS web-builder
WORKDIR /src
COPY --from=src /src/ ./
WORKDIR /src/web
RUN bun install --frozen-lockfile && bun run build

# ── Build the Go binary with the SPA embedded ─────────────────────────────────
FROM golang:1.27.3-alpine AS go-builder
WORKDIR /src
COPY --from=src /src/ ./
COPY --from=web-builder /src/web/dist ./web/dist
# CGO_ENABLED=0 is mandatory: the binary must run on musl (alpine). A cgo build
# links glibc and dies with "not found" (missing ld-linux).
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/9router-go ./cmd/9router-go/ \
 && /out/9router-go version

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine
COPY --from=go-builder /out/9router-go /usr/local/bin/9router-go
RUN chmod +x /usr/local/bin/9router-go
WORKDIR /app
# Gateway deps first (layer cache — only re-install when package.json changes)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Source
COPY server.js ./
COPY proxy.mjs ./
COPY start.sh ./
RUN chmod +x start.sh
ENV PORT=8000 \
    GATEWAY_PORT=8001 \
    ROUTER_PORT=20130 \
    DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 8000
CMD ["sh", "start.sh"]
