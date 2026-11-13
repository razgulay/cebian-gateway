# ─────────────────────────────────────────────────────────────────────────────
# cebian-gateway - 3-process container, 9router-go built FROM SOURCE + patched.
#
#   proxy.mjs  :8000  public  (splits /health,/webhook/telegram,/ws -> gateway;
#                              everything else -> router)
#   server.js  :8001  internal (Telegram relay + /ws)
#   9router-go :20130 internal (LLM router + embedded Svelte dashboard)
#
# WHY SOURCE BUILD (do not "simplify" this back to the prebuilt release binary):
# the local patches under patches/ are not in upstream. 0001 breaks the
# reactive-401 OAuth refresh loop (atomic json_set persist that checks
# RowsAffected, plus an in-memory fresh-token hand-off so a lost persist cannot
# feed the dead token to the next request), 0002 carries tool_call ids into
# functionCall/functionResponse and repairs id-less pairs, 0003 stops the
# per-chunk "empty envelope response" warning spam on native Gemini/Vertex
# streams, 0004 validates thought signatures before sending so a corrupted or
# stale one is replaced with the known-accepted default upfront instead of
# paying Google's 400 + reactive re-send, 0005 enforces the Gemini role
# contract (contents carry only user/model; system text hoisted into
# systemInstruction), answers a terminal model turn, and wires HTTP/2
# dead-connection probing (ReadIdleTimeout=2m) so a silently-dead connection
# fails fast into the retry chain instead of hanging into an unhelpful 502 on
# heavy prompts, 0006 makes RTK report no-op compressions as no-ops and
# byte-truncates huge line-poor tool outputs (the saved_est=0 on 90k-token
# payloads), 0007 ports the Vertex AI forwarding lane (without it every vertex
# model — gemini-3.1-pro-preview included — gets Google's HTML
# "404: The requested URL /v1 was not found" because the catalog ships the
# provider with no executor and the generic forwarder POSTs the bare /v1; the
# body post-process keeps the role and every top-level key, since the old
# struct rewrite dropped both), 0008 adds a GEMINI_STREAM_DEBUG wire capture,
# 0009 adds the REASONING_FIELD selector, 0010 adds a CORS middleware
# (internal/middleware.CORS): the gateway previously emitted no CORS headers
# and chi answered preflight OPTIONS /v1/messages with 405, so every
# browser-based client (Claude for Office webview, web apps) died with a bare
# "Failed to fetch" while curl/SDK clients worked fine.
#
# These are git-format diffs against the pinned upstream SHA, so the router
# must be compiled here. The prebuilt release binaries on GitHub contain none
# of them. A prebuilt download was tried on 2026-09-29 (commits 4a44423 /
# 4b930e4) and shipped the 401 loop straight back into production.
#
# That download path also forced a Debian base (the release binary links glibc).
# Building from source with CGO_ENABLED=0 keeps the alpine runtime.
# ─────────────────────────────────────────────────────────────────────────────

# Pinned upstream commit = tag v1.9.16 (2026-11-12, 0a1cf78). Full 40-char SHA,
# not a branch — the build is reproducible. Bump to upgrade, then re-verify the
# patches still apply (the src stage fails the build if one no longer does).
ARG ROUTER_SHA=0a1cf7853f7d7e5392c0b790388f13847b3b0c6e

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
 && for p in /patches/*.patch; do echo "[patch] applying $(basename "$p")"; patch -p1 --no-backup-if-mismatch < "$p"; done \
 && grep -q "persistOAuthRefresh" internal/handlers/chat/gemini_handler.go \
 && grep -q "rememberFreshToken" internal/handlers/chat/oauth_freshtoken.go \
 && grep -q "upstream 401 before reactive refresh" internal/handlers/chat/fallback.go \
 && grep -q "repairGeminiToolIDs" internal/translator/gemini.go \
 && grep -q "validThoughtSignature" internal/translator/gemini.go \
 && grep -q "NormalizeGeminiRequest" internal/translator/gemini.go \
 && grep -q "EnsureGeminiTerminalUserTurn" internal/translator/gemini.go \
 && grep -q "ApplyHTTP2Keepalive" internal/constants/transport.go \
 && grep -q "truncateBytes" internal/tokensaver/compress.go \
 && grep -q "byte-truncation" internal/tokensaver/rtk.go \
 && grep -q "isVertexProvider" internal/handlers/chat/fallback.go \
 && grep -q "publishers/google/models" internal/proxy/vertex.go \
 && grep -q "postProcessVertexBody" internal/proxy/vertex.go \
 && grep -q "GEMINI_STREAM_DEBUG" internal/handlers/chat/gemini_stream_debug.go \
 && grep -q "applyStreamReasoningField" internal/translator/reasoning_field.go \
 && grep -q "corsPreflightMaxAge" internal/middleware/cors.go \
 && grep -q "middleware.CORS" internal/app/handlers.go \
 && ! grep -q "empty envelope response" internal/translator/antigravity.go \
 && echo "[patch] all fix markers present"

# ── Build the dashboard SPA (bun + Vite) ─────────────────────────────────────
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
