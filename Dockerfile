# ──────────────────────────────────────────────────────────────────────────────
# cebian-gateway - 3-process container, 9router-go built FROM SOURCE.
#
#   proxy.mjs  :8000  public  (splits /health,/webhook/telegram,/ws -> gateway;
#                              everything else -> router)
#   server.js  :8001  internal (Telegram relay + /ws)
#   9router-go :20130 internal (LLM router + embedded Svelte dashboard)
#
# WHY SOURCE BUILD (do not "simplify" this back to the prebuilt release binary):
# neither local patch is in upstream v1.9.17, and the prebuilt release binaries
# on GitHub contain none of them.
#   0010 CORS: without it the gateway emits no CORS headers and chi answers
#   preflight OPTIONS /v1/messages with 405, so every browser-based client
#   (Claude for Office webview, web apps) dies with a bare "Failed to fetch"
#   while curl/SDK clients work fine.
#   0011 placeholder: upstream marks the injected empty-schema `reason` field as
#   REQUIRED, so the model emits {"reason":"..."} for tools that take no
#   arguments and a strict client rejects the call. Verified against
#   ag/gemini-3.8-flash: required -> bogus reason, dropped -> {}.
#
# RESTORED TO VANILLA (2026-11-24): patches 0001-0009 were removed. This image
# tracks upstream v1.9.17 with two local patches. See NOTES.md for what each
# retired patch used to do and what regresses without it.
# ──────────────────────────────────────────────────────────────────────────────
# Pinned upstream commit = tag v1.9.17 (2026-11-26, 2a809a7). Full 40-char SHA,
# not a branch — the build is reproducible. Bump to upgrade, then re-verify the
# patches still apply (the src stage fails the build if one no longer does).
ARG ROUTER_SHA=2a809a7e2974cc9140a928fbf2bdde5bcacadcf2

# ── Fetch upstream source once, at the pinned commit, and apply the local patches ─
FROM alpine:3.21 AS src
ARG ROUTER_SHA
COPY patches/ /patches/

# The grep assertions below fail the build if a patch ever lands as a no-op, so
# a silent revert can never ship. Each marker is a string only its patch adds.
RUN apk add --no-cache curl tar patch \
 && curl -fsSL "https://codeload.github.com/luqman-v1/9router-go/tar.gz/${ROUTER_SHA}" -o /tmp/src.tgz \
 && mkdir -p /src \
 && tar -xzf /tmp/src.tgz --strip-components=1 -C /src \
 && rm /tmp/src.tgz \
 && cd /src \
 && for p in /patches/*.patch; do echo "[patch] applying $(basename "$p")"; patch -p1 --no-backup-if-mismatch < "$p"; done \
 && grep -q "corsPreflightMaxAge" internal/middleware/cors.go \
 && grep -q "middleware.CORS" internal/app/handlers.go \
 && grep -q "placeholder field must stay OPTIONAL" internal/translator/schema.go \
 && grep -q "TestCleanParametersSchema_EmptyPlaceholderIsOptional" internal/translator/schema_placeholder_optional_test.go \
 && grep -q "Only include this when a short justification" internal/translator/schema.go \
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
# Pinned to 1.27.4, not the floating 1.27-alpine tag: v1.9.17's go.mod carries
# `toolchain go1.27.4`, and matching it here keeps the build off a toolchain
# download at compile time.
FROM golang:1.27.4-alpine AS go-builder
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
