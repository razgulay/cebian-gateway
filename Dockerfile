# ─────────────────────────────────────────────────────────────────────────────
# cebian-gateway - 3-process container, 9router-go built FROM SOURCE + patched.
#
#   proxy.mjs  :8000  public  (splits /health,/webhook/telegram,/ws -> gateway;
#                              everything else -> router)
#   server.js  :8001  internal (Telegram relay + /ws)
#   9router-go :20130 internal (LLM router + embedded Svelte dashboard)
#
# WHY SOURCE BUILD (do not "simplify" this back to the prebuilt release binary):
# the local patches under patches/ are not in upstream. 0001+0002 fix the
# antigravity OAuth 401 refresh loop, 0003 carries tool_call ids into the
# Gemini-native translator, 0004 ports the Vertex AI forwarding lane (without
# it every vertex model — gemini-3.1-pro-preview included — gets Google's HTML
# "404: The requested URL /v1 was not found" because the catalog shipped the
# provider with no executor and the generic forwarder POSTed the bare /v1).
# These are git-format diffs against the pinned upstream SHA, so the router
# must be compiled here. The v1.9.9 prebuilt release binary on GitHub contains
# none of them. A prebuilt download was tried on 2026-09-29 (commits 4a44423 /
# 4b930e4) and shipped the 401 loop straight back into production.
#
# That download path also forced a Debian base (the release binary links glibc).
# Building from source with CGO_ENABLED=0 keeps the alpine runtime.
# ─────────────────────────────────────────────────────────────────────────────

# Pinned upstream commit = tag v1.9.9 (2026-10-05, f52294d8). Full 40-char SHA,
# not a branch — the build is reproducible. Bump to upgrade, then re-verify the
# patches still apply (the src stage fails the build if one no longer does).
ARG ROUTER_SHA=f52294d836e0dc92bbe7aaf18143faa67288b7f4

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
 && grep -q "persistOAuthRefresh" internal/handlers/chat/gemini_handler.go \
 && grep -q "rememberFreshToken" internal/handlers/chat/oauth_freshtoken.go \
 && grep -q "isKiroApiKeyAuth" internal/handlers/chat/gemini_handler.go \
 && grep -q "json_extract(data, '\$.apiKey') = json_extract(data, '\$.accessToken')" internal/handlers/chat/gemini_handler.go \
 && grep -q "upstream 401 before reactive refresh" internal/handlers/chat/fallback.go \
 && grep -q "repairGeminiToolIDs" internal/translator/gemini.go \
 && grep -q "stripThoughtSig" internal/translator/gemini.go \
 && grep -q "isVertexProvider" internal/handlers/chat/fallback.go \
 && grep -q "publishers/google/models" internal/proxy/vertex.go \
 && grep -q "postProcessVertexBody" internal/proxy/vertex.go \
 && echo "[patch] all fix markers present"

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
