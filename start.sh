#!/bin/sh
# Supervise two processes in one container. Koyeb runs one CMD per service, so
# we background the LLM router and keep the Telegram gateway in the foreground.
# If either dies, the container exits and Koyeb restarts the deployment.
set -eu

: "${PORT:=8000}"
: "${ROUTER_PORT:=20130}"
: "${DATA_DIR:=/data}"

echo "[boot] 9router-go on :${ROUTER_PORT}, cebian-gateway on :${PORT}"

# 9router-go: bind all interfaces (Koyeb's edge proxy is outside the container
# netns). DATA_DIR holds the SQLite DB shared with any local dashboard install.
PORT="${ROUTER_PORT}" \
DATA_DIR="${DATA_DIR}" \
HOST=0.0.0.0 \
  /usr/local/bin/9router-go &

ROUTER_PID=$!

# Fail fast if the router dies before the gateway even starts.
sleep 1
if ! kill -0 "$ROUTER_PID" 2>/dev/null; then
  echo "[boot] 9router-go exited immediately - check DATA_DIR permissions" >&2
  exit 1
fi

# Reap the router if the gateway stops (keeps the container from hanging).
trap 'kill "$ROUTER_PID" 2>/dev/null || true' EXIT INT TERM

# cebian-gateway in the foreground. `wait` keeps the trap alive so the router
# is always reaped when the gateway exits - no orphan holding the SQLite WAL.
node server.js &
GATEWAY_PID=$!
wait "$GATEWAY_PID"
