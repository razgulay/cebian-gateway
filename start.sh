#!/bin/sh
# Three processes, one container:
#   proxy.mjs  :8000  (public — splits /router/* to the router)
#   server.js  :8001  (internal — Telegram relay + /ws)
#   9router-go :20130 (internal — LLM router)
#
# Koyeb's free plan only exposes one port, so proxy.mjs owns the public one and
# the other two bind loopback-only internal ports the edge never sees.
set -eu

: "${PORT:=8000}"
: "${GATEWAY_PORT:=8001}"
: "${ROUTER_PORT:=20130}"
: "${DATA_DIR:=/data}"

echo "[boot] router :${ROUTER_PORT} | gateway :${GATEWAY_PORT} | proxy :${PORT}"

# 9router-go: bind all interfaces (the proxy is in the same netns). DATA_DIR
# holds the SQLite DB shared with any local dashboard install.
PORT="${ROUTER_PORT}" \
DATA_DIR="${DATA_DIR}" \
HOST=0.0.0.0 \
  /usr/local/bin/9router-go &

ROUTER_PID=$!

# Fail fast if the router dies before anything else starts.
sleep 1
if ! kill -0 "$ROUTER_PID" 2>/dev/null; then
  echo "[boot] 9router-go exited immediately - check DATA_DIR permissions" >&2
  exit 1
fi

# Telegram gateway, on the internal port the proxy forwards to.
PORT="${GATEWAY_PORT}" \
  node server.js &

GATEWAY_PID=$!

# Reap both children when the container stops.
trap 'kill "$ROUTER_PID" "$GATEWAY_PID" 2>/dev/null || true' EXIT INT TERM

# Front proxy owns the public port and the container lifetime.
node proxy.mjs
