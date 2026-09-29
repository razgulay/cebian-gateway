# ─────────────────────────────────────────────────────────────────────────────
# cebian-gateway - 3-process container, 9router-go built FROM SOURCE + patched.
#
#   proxy.mjs  :8000  public  (splits /health,/webhook/telegram,/ws -> gateway;
#                              everything else -> router)
#   server.js  :8001  internal (Telegram relay + /ws)
#   9router-go :20130 internal (LLM router + embedded Svelte dashboard)
#
# WHY SOURCE BUILD (do not "simplify" this back to the prebuilt release binary):
# the antigravity OAuth 401 loop is fixed ONLY by patches/0001 + patches/0002.
# Those are local git-format diffs against the pinned upstream SHA, so the
# router must be compiled here. The v1.9.5 prebuilt release binary on GitHub
# does NOT contain the fix (verified: upstream main lacks isKiroApiKeyAuth and
# the mirrored-apiKey json_set), so downloading it reintroduces the loop.
# A prebuilt download was tried on 2026-09-29 (commits 4a44423 / 4b930e4) and
# shipped the loop straight back into production.
#
# That download path also forced a Debian base (the release binary links glibc).
# Building from source with CGO_ENABLED=0 keeps the alpine runtime.
# ─────────────────────────────────────────────────────────────────────────────

# Pinned upstream commit = tag v1.9.5 (2026-09-28, dfa59efc). Full 40-char SHA,
# not a branch — the build is reproducible. Bump to upgrade, then re-verify the
# patches still apply (the src stage fails the build if one no longer does).
ARG ROUTER_SHA=dfa59efc2f620ea9742e140818c2b304d34b12ec

# ── Fetch upstream source once, at the pinned commit, and apply local patches ─
FROM alpine:3.21 AS src
ARG ROUTER_SHA
COPY patches/ /patches/
# The grep assertions below fail the build if a patch ever lands as a no-op, so
# a silent revert can never ship. Each marker is a string only the patch adds.
RUN apk add --no-cache curl tar patch \
 && curl -fsSL "https://codeload.github.com/luqman-v1/9router-go/tar.gz/${ROUTER_SHA}" -o /tmp/src.tgz \
 && mkdir -p /src \
 && tar -xzf /tmp/src.tgz --strip-components=1 -C /src \
 && rm /tmp/src.tgz \
 && cd /src \
 && for p in /patches/*.patch; do echo "[patch] applying $(basename "$p")"; patch -p1 < "$p"; done \
 && grep -q "isKiroApiKeyAuth" internal/handlers/chat/gemini_handler.go \
 && grep -q "json_extract(data, '\$.apiKey') = json_extract(data, '\$.accessToken')" internal/handlers/chat/gemini_handler.go \
 && grep -q "upstream 401 before reactive refresh" internal/handlers/chat/fallback.go \
 && echo "[patch] all 401-loop fix markers present"

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
