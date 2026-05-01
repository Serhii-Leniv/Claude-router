import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handleMessages, routeHistory, type HandlerConfig } from './handler.js';
import { renderDashboard } from './dashboard.js';

export function createProxyApp(config: HandlerConfig): Hono {
  const app = new Hono();

  app.use('*', cors());

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'claude-router-proxy',
      classifier: config.classifier,
      requests: routeHistory.length,
    }),
  );

  app.get('/dashboard', (c) => {
    return c.html(renderDashboard(routeHistory));
  });

  app.post('/v1/messages', (c) => handleMessages(c, config));

  return app;
}
