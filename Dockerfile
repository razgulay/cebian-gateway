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

FROM node:20-alpine

# 9router-go is a single CGO-free static binary — nothing to compile.
# Pin the version + verify the checksum from the GitHub release page.
# Bump these two lines when a new release lands (no auto-update on Koyeb).
ARG ROUTER_VERSION=v1.9.2
ARG ROUTER_SHA256=dc016179d78e973f31435c5c1d00a98289ffbb8f201145647152c153720bbd09

RUN apk add --no-cache curl \
 && curl -fsSL -o /usr/local/bin/9router-go \
      "https://github.com/luqman-v1/9router-go/releases/download/${ROUTER_VERSION}/9router-go-linux-amd64" \
 && echo "${ROUTER_SHA256}  /usr/local/bin/9router-go" | sha256sum -c - \
 && chmod +x /usr/local/bin/9router-go \
 && apk del curl

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
