import { Hono } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import { handleMessages, handlePassthrough, routeHistory, type HandlerConfig } from './handler.js';
import { renderDashboard } from './dashboard.js';
import { readLifetimeStats } from './history.js';
import { buildHealth, formatStatusLine } from './health.js';

export function createProxyApp(
  config: HandlerConfig,
  providerClient: Anthropic | null = null,
): Hono {
  const app = new Hono();

  // Deliberately NO CORS middleware. Every legitimate consumer is same-origin
  // (the dashboard) or CORS-exempt (Node fetch from the CLI/statusline). A
  // wildcard here let any webpage in the operator's browser POST /v1/messages
  // to localhost and read the response — with bedrock/vertex that spends the
  // operator's cloud credentials with no authentication. Browsers blocking
  // cross-origin reads IS the security boundary; do not add cors() back.

  app.get('/health', (c) => c.json(buildHealth(config, routeHistory)));

  // Preformatted statusline text for the shell statusline command — plain text,
  // so the installed `curl` one-liner needs no JSON parsing (no jq/python).
  app.get('/statusline', (c) => c.text(formatStatusLine(buildHealth(config, routeHistory))));

  app.get('/api/last-route', (c) => {
    const last = routeHistory[routeHistory.length - 1] ?? null;
    return c.json(last);
  });

  app.get('/dashboard', (c) => {
    const lifetime = config.historyFile ? readLifetimeStats(config.historyFile) : undefined;
    return c.html(renderDashboard(routeHistory, lifetime));
  });

  app.post('/v1/messages', (c) => handleMessages(c, config, providerClient));

  // Registered LAST, so every route above still wins on first match. Everything
  // else belongs to the origin, not to us: the non-routable /v1 endpoints
  // (count_tokens, model listing, …) and the paths outside /v1 alike — Claude
  // Code probes `HEAD /api/hello` on startup and also calls /api/organizations.
  // Scoping this to /v1/* made the router answer 404 for endpoints the origin
  // serves, which is a failure we invented rather than one the client would hit.
  app.all('*', (c) => handlePassthrough(c, config));

  return app;
}
