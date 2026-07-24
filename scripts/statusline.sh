#!/usr/bin/env bash
# Claude Code statusline — shows last routed tier from claude-router proxy.
# This mirrors what `claude-router install` writes into ~/.claude/settings.json.
# The proxy serves a preformatted line at /statusline, so no JSON parsing is
# needed here — just curl.
#
# Usage: set as statusLine.command in Claude Code settings.json, e.g.
#   curl -sf --max-time 0.3 http://127.0.0.1:4000/statusline || echo [auto:off]

PORT="${CLAUDE_ROUTER_PORT:-4000}"
curl -sf --max-time 0.3 "http://127.0.0.1:${PORT}/statusline" || echo "[auto:off]"
