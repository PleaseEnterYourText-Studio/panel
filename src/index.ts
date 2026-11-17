import { Hono } from 'hono';
import type { Env } from './env';
import { APP_VERSION } from './env';
import type { Vars } from './auth/rbac';
import type { Identity } from './auth/identity';
import { getIdentity } from './auth/identity';
import { runTick, type TickDeps } from './scheduler/run';
import { withIdentity } from './api/guard';
import { overviewApi } from './api/overview';
import { servicesApi } from './api/services';
import { incidentsApi } from './api/incidents';
import { createProbesApi, type AuditFn } from './api/probes';
import { audit } from './audit';

export interface AppDeps {
  /** 身份解析入口。默认走 Cloudflare Access；测试注入固定身份来覆盖各角色。 */
  resolveIdentity?: (req: Request, env: Env) => Promise<Identity | null>;
  /** 手动探测的时钟与出站 fetch。默认全局 Date.now / fetch；测试注入 stub 避免真实网络。 */
  probe?: TickDeps;
  /** 审计写入口。默认生产 audit；测试注入抛错实现验证「审计失败 → 500 且不执行动作」。 */
  audit?: AuditFn;
}

const defaultProbeDeps: TickDeps = {
  now: () => Date.now(),
  fetch: (input, init) => fetch(input, init),
};

// 可注入依赖的 app 工厂：生产入口用默认值；测试用它注入身份和探测 stub。
// 身份只在 /api/* 上解析一次，写进 context；health 是匿名探活入口，跳过解析（省一次 KV 读）。
export function createApp(deps: AppDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  const identity = withIdentity(deps.resolveIdentity ?? getIdentity);

  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'GET' && c.req.path === '/api/health') return next();
    return identity(c, next);
  });

  app.get('/api/health', (c) => c.json({ ok: true, version: APP_VERSION }));

  app.route('/api/overview', overviewApi);
  app.route('/api/services', servicesApi);
  app.route('/api/incidents', incidentsApi);
  app.route(
    '/api/probes',
    createProbesApi({ probe: deps.probe ?? defaultProbeDeps, audit: deps.audit ?? audit }),
  );

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  // Cron 不经过 HTTP 入口，因此不受 Cloudflare Access 拦截（规格 §6.1）：scheduled 事件由
  // 平台直接投递给 Worker，既不经过浏览器也不带 JWT。所有 /api/* 的鉴权都在 fetch 侧，
  // 调度器只依赖自己的 fetch/DB 绑定 —— 不要在这里加身份检查，它永远不会被触发。
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
