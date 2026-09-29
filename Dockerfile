# cebian-gateway - 3-process container
#   proxy.mjs  :8000  public  (splits /health,/webhook/telegram,/ws -> gateway; rest -> router)
#   server.js  :8001  internal (Telegram relay + /ws)
#   9router-go :20130 internal (LLM router + embedded Svelte dashboard)
#
# Base is Debian slim, NOT alpine. The 9router-go release binary is built by
# `make cross` with CGO_ENABLED unset (=1), so it links dynamically against
# glibc (/lib64/ld-linux-x86-64.so.2). Alpine ships musl only -> execve fails
# with a bare "/usr/local/bin/9router-go: not found" even though the file and
# its SHA256 are present. Debian slim gives it the glibc it needs.
FROM node:20-bookworm-slim

# 9router-go release pinned to v1.9.5 with SHA256 verification.
# NOTE: the trailing `|| true` must NOT be here - it would swallow a failed
# download and let the build "succeed" with no binary (that bug shipped once).
ARG NINEROUTER_VERSION=v1.9.5
ARG NINEROUTER_SHA256=fedd2608922dce990590cf4689fa467eda5d9b8104174f55834e11a46ae73e10

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL --retry 3 -o /usr/local/bin/9router-go \
      "https://github.com/luqman-v1/9router-go/releases/download/${NINEROUTER_VERSION}/9router-go-linux-amd64" \
 && echo "${NINEROUTER_SHA256}  /usr/local/bin/9router-go" | sha256sum -c - \
 && chmod +x /usr/local/bin/9router-go

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
