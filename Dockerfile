# ─────────────────────────────────────────────────────────────────────────────
# Koyeb single-service bundle: cebian-gateway (Telegram relay) + 9router-go
# (LLM router), behind one front proxy on a single public port.
#
# Koyeb's free plan keeps only ONE exposed port on the service, so the router
# cannot get its own route. proxy.mjs owns port 8000 (the port Koyeb exposes)
# and splits: /router/* -> router :20130, everything else -> gateway :8001.
#
# Memory: Node proxy ~10 MB + gateway ~70 MB + Go router ~42 MB, inside 512 MB.
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
