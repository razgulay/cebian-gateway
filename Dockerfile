# ─────────────────────────────────────────────────────────────────────────────
# Koyeb single-service bundle: cebian-gateway (Telegram relay) + 9router-go
# (LLM router). One container, two ports, two public paths — no code merge.
#
# Koyeb free plan gives you ONE free instance, so both processes share the
# 512 MB budget. Node gateway ~60-80 MB + 9router-go ~42 MB = fits.
#
# Exposed ports (Koyeb -> Service -> Settings -> Exposed ports):
#   8000  Public  HTTP  /          -> cebian-gateway  (webhook + /ws)
#   20130 Public  HTTP  /router    -> 9router-go      (OpenAI/Claude API)
#
# Koyeb strips the route prefix before forwarding, so a request to
# /router/v1/chat/completions reaches the router as /v1/chat/completions.
# ─────────────────────────────────────────────────────────────────────────────

# Pull the router binary from the maintainer's own image, NOT the GitHub
# release asset. The release assets come from `make cross` on ubuntu-latest
# without CGO_ENABLED=0, so they link against glibc and die on musl with
# "not found" (missing ld-linux). The image below is built with CGO_ENABLED=0
# (see upstream Dockerfile) -> a real static binary that runs on alpine.
FROM luqmenul/9router-go:1.9.2 AS router

FROM node:20-alpine

COPY --from=router /usr/local/bin/9router-go /usr/local/bin/9router-go
RUN chmod +x /usr/local/bin/9router-go \
 && /usr/local/bin/9router-go version

WORKDIR /app

# Gateway deps first (layer cache — only re-install when package.json changes)
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Source
COPY server.js ./
COPY start.sh ./
RUN chmod +x start.sh

# Koyeb Web Services inject PORT; keep it explicit for the gateway.
ENV PORT=8000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data \
    ROUTER_PORT=20130

EXPOSE 8000 20130

# Run as the non-root "node" user. /data must be writable for the SQLite DB.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

CMD ["./start.sh"]
