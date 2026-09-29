# cebian-gateway - 3-process container
#   proxy.mjs  :8000  public  (splits /health,/webhook/telegram,/ws -> gateway; rest -> router)
#   server.js  :8001  internal (Telegram relay + /ws)
#   9router-go :20130 internal (LLM router + embedded Svelte dashboard)
#
# Replaces the stale Koyeb-era Dockerfile that only ran "node server.js"
# (no proxy.mjs, no start.sh, no 9router-go binary) - which is why
# /dashboard returned 404 and the router appeared dead.
FROM node:20-alpine

# 9router-go release pinned to v1.9.5 with SHA256 verification.
ARG NINEROUTER_VERSION=v1.9.5
ARG NINEROUTER_SHA256=fedd2608922dce990590cf4689fa467eda5d9b8104174f55834e11a46ae73e10

RUN apk add --no-cache curl \
 && curl -fsSL --retry 3 -o /usr/local/bin/9router-go \
      "https://github.com/luqman-v1/9router-go/releases/download/${NINEROUTER_VERSION}/9router-go-linux-amd64" \
 && echo "${NINEROUTER_SHA256}  /usr/local/bin/9router-go" | sha256sum -c - \
 && chmod +x /usr/local/bin/9router-go \
 && /usr/local/bin/9router-go version || true

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

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
