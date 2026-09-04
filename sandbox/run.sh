#!/usr/bin/env bash
# Run claude-router + Claude Code in a container, isolated from the host.
#
#   sandbox/run.sh build            build the image from the current checkout
#   sandbox/run.sh claude [args]    interactive Claude Code through the proxy (default)
#   sandbox/run.sh stats [--json]   the ledger from the sandbox's own history
#   sandbox/run.sh proxy-log [n]    tail the proxy's verbose log
#   sandbox/run.sh shell            a shell with the proxy + recorder running
#
# Credentials come from the host environment at run time and are passed to the
# container only: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN. Nothing is
# installed on the host, no host env var is set, the host's ~/.claude and
# ~/.claude-router are never mounted.
#
# State that persists between runs (all git-ignored, all under sandbox/):
#   .claude/    Claude Code config for the sandbox (login, settings)
#   .state/     the proxy's ~/.claude-router (history.jsonl, proxy.log)
#   .wire/      captured requests, gzipped JSON — contains prompts and code, do not share
#   workspace/  the project Claude Code works on inside the container (/work)
#
# Env knobs: SANDBOX_SESSION_MODEL (default opus), SANDBOX_ROLE_ROUTING (on|off).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
IMAGE="claude-router-sandbox"

mkdir -p "$HERE/.claude" "$HERE/.state" "$HERE/.wire" "$HERE/workspace"

build() {
  docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$ROOT"
}

run() {
  local tty=()
  if [ -t 0 ] && [ -t 1 ]; then tty=(-it); fi
  docker run --rm "${tty[@]}" \
    -e ANTHROPIC_API_KEY \
    -e CLAUDE_CODE_OAUTH_TOKEN \
    -e SANDBOX_SESSION_MODEL \
    -e SANDBOX_ROLE_ROUTING \
    -v "$HERE/.claude:/sandbox/config" \
    -v "$HERE/.state:/root/.claude-router" \
    -v "$HERE/.wire:/sandbox/wire" \
    -v "$HERE/workspace:/work" \
    "$IMAGE" "$@"
}

case "${1:-claude}" in
  build) build ;;
  *)
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then build; fi
    run "$@"
    ;;
esac
