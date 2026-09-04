#!/usr/bin/env bash
# Container entrypoint. Starts the proxy and the wire recorder, then runs the
# requested command with Claude Code pointed at them. All addresses are loopback
# inside the container's own network namespace.
set -euo pipefail

PROXY_PORT="${CLAUDE_ROUTER_PORT:-4000}"
WIRE_PORT=4200
PROXY_ARGS=(--force-route --session-model "${SANDBOX_SESSION_MODEL:-opus}" --restore-delegation --port "$PROXY_PORT" --verbose)
if [ "${SANDBOX_ROLE_ROUTING:-on}" = "off" ]; then PROXY_ARGS+=(--role-routing off); fi

start_proxy() {
  node /app/dist/proxy/cli.js start "${PROXY_ARGS[@]}" >> /root/.claude-router/proxy.log 2>&1 &
  for _ in $(seq 1 50); do
    if curl -sf "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  echo "proxy did not come up; see /root/.claude-router/proxy.log" >&2
  tail -20 /root/.claude-router/proxy.log >&2 || true
  exit 1
}

start_recorder() {
  # Claude Code → recorder (captures headers + bodies) → proxy (routes) → Anthropic.
  PORT="$WIRE_PORT" UPSTREAM="http://127.0.0.1:${PROXY_PORT}" OUT_DIR=/sandbox/wire \
    node /app/research/scripts/record-wire.mjs >> /sandbox/wire/recorder.log 2>&1 &
  sleep 0.3
}

case "${1:-claude}" in
  claude)
    shift || true
    start_proxy
    start_recorder
    echo "claude-router sandbox: proxy :${PROXY_PORT} (${PROXY_ARGS[*]}), recorder :${WIRE_PORT} → /sandbox/wire"
    export ANTHROPIC_BASE_URL="http://127.0.0.1:${WIRE_PORT}"
    exec claude --plugin-dir /app/plugin "$@"
    ;;
  stats)
    exec node /app/dist/proxy/cli.js stats "${@:2}"
    ;;
  proxy-log)
    exec tail -n "${2:-200}" /root/.claude-router/proxy.log
    ;;
  shell)
    start_proxy
    start_recorder
    export ANTHROPIC_BASE_URL="http://127.0.0.1:${WIRE_PORT}"
    exec bash
    ;;
  *)
    exec "$@"
    ;;
esac
