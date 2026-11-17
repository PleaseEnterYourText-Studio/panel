// /api 的统一鉴权中间件：身份每请求只解析一次（withIdentity），路由只用 authorize
// 纯函数判角色，不再重复调用 requireRole —— 那会在同一请求里重复读 KV 拿同一份身份。
//
// 角色是精确匹配、无继承（owner 不会自动通过 ops/viewer 的检查），所以每个路由必须
// 显式写全允许列表。401 = 没身份；403 = 有身份但角色不在允许列表。

import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import type { Identity, Role } from '../auth/identity';
import { authorize, type Vars } from '../auth/rbac';

export type ApiContext = Context<{ Bindings: Env; Variables: Vars }>;
export type ApiMiddleware = MiddlewareHandler<{ Bindings: Env; Variables: Vars }>;
export type IdentityResolver = (req: Request, env: Env) => Promise<Identity | null>;

/** 每个 /api 请求解析一次身份，放进 context；解析失败（null）不写入，交给 gate 判 401。 */
export function withIdentity(resolve: IdentityResolver): ApiMiddleware {
  return async (c, next) => {
    const identity = await resolve(c.req.raw, c.env);
    if (identity) c.set('identity', identity);
    await next();
  };
}

/** 读取 context 里的身份。未解析（withIdentity 之前）时为 null。 */
export function currentIdentity(c: ApiContext): Identity | null {
  return (c.get('identity') as Identity | undefined) ?? null;
}

/** 角色网关：只做 authorize 的 HTTP 翻译，不再读身份。 */
export function gate(...roles: Role[]): ApiMiddleware {
  return async (c, next) => {
    const result = authorize(currentIdentity(c), roles);
    if (result === 'unauthorized') return c.json({ error: 'unauthorized' }, 401);
    if (result === 'forbidden') return c.json({ error: 'forbidden' }, 403);
    await next();
  };
}
