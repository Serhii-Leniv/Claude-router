import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handleMessages, type HandlerConfig } from './handler.js';

export function createProxyApp(config: HandlerConfig): Hono {
  const app = new Hono();

  app.use('*', cors());

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'claude-router-proxy',
      classifier: config.classifier,
    }),
  );

  app.post('/v1/messages', (c) => handleMessages(c, config));

  return app;
}
