import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Anthropic from '@anthropic-ai/sdk';
import { handleMessages, handlePassthrough, routeHistory, type HandlerConfig } from './handler.js';
import { renderDashboard } from './dashboard.js';
import { readLifetimeStats } from './history.js';
import { buildHealth } from './health.js';

export function createProxyApp(
  config: HandlerConfig,
  providerClient: Anthropic | null = null,
): Hono {
  const app = new Hono();

  app.use('*', cors());

  app.get('/health', (c) => c.json(buildHealth(config, routeHistory)));

  app.get('/api/last-route', (c) => {
    const last = routeHistory[routeHistory.length - 1] ?? null;
    return c.json(last);
  });

  app.get('/dashboard', (c) => {
    const lifetime = config.historyFile ? readLifetimeStats(config.historyFile) : undefined;
    return c.html(renderDashboard(routeHistory, lifetime));
  });

  app.post('/v1/messages', (c) => handleMessages(c, config, providerClient));

  // Everything else under /v1 (count_tokens, model listing, …) is not routable —
  // forward it verbatim to Anthropic so the client doesn't 404 on count_tokens.
  app.all('/v1/*', (c) => handlePassthrough(c, config));

  return app;
}
