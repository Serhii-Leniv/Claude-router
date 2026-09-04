# Isolated Claude Code + claude-router. Nothing here touches the host: the
# proxy, the wire recorder, Claude Code's config dir and the routing ledger all
# live inside the container (persisted only through the mounts run.sh sets up).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# Claude Code's own state (login, settings, plugins) — never the host's ~/.claude.
ENV CLAUDE_CONFIG_DIR=/sandbox/config
# The proxy's state (~/.claude-router inside the container).
ENV HOME=/root
RUN mkdir -p /sandbox/config /sandbox/wire /root/.claude-router /work

WORKDIR /work
ENTRYPOINT ["/app/sandbox/entrypoint.sh"]
CMD ["claude"]
