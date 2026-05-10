#!/usr/bin/env bash
# Claude Code statusline — shows last routed tier from claude-router proxy
# Usage: add to Claude Code settings.json statusLine.command

PORT="${CLAUDE_ROUTER_PORT:-4000}"
URL="http://localhost:${PORT}/health"

result=$(curl -sf --max-time 0.3 "$URL" 2>/dev/null)
if [ -z "$result" ]; then
  echo "[auto:off]"
  exit 0
fi

tier=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('lastTier') or 'ready')" 2>/dev/null)
requests=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('requests', 0))" 2>/dev/null)

echo "[auto:${tier:-ready} #${requests:-0}]"
