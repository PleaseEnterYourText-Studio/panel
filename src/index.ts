import { Hono } from 'hono';
import type { Env } from './env';
import { APP_VERSION } from './env';
import type { Vars } from './auth/rbac';
import { runTick } from './scheduler/run';

// Variables 里带上 identity，后续挂在 /api 下的路由才能直接用 c.get('identity')
// 拿到 requireRole 中间件写入的身份（Task 7 挂载路由时消费）。
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.get('/api/health', (c) => c.json({ ok: true, version: APP_VERSION }));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Cron 每分钟一次：每次只吃一个分片窗口（SHARD_LIMIT 个到期 target），
    // 剩下的留给下一分钟。runTick 的 DB 写每 tick 只发生一次（upsertRollup 非幂等）。
    ctx.waitUntil(
      runTick(env, {
        now: () => Date.now(),
        fetch: (input, init) => fetch(input, init),
      }),
    );
  },
} satisfies ExportedHandler<Env>;
