import { Hono } from 'hono';
import type { Env } from './env';
import { APP_VERSION } from './env';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ ok: true, version: APP_VERSION }));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, _env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.resolve());
  },
} satisfies ExportedHandler<Env>;
