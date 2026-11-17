// RBAC：authorize 是纯函数（三种角色 × 允许列表的矩阵好测），requireRole 是 Hono 中间件，
// 只负责把 getIdentity 的结果喂给 authorize 并把 HTTP 状态码翻译出来。
// 401 = 没有身份；403 = 有身份但角色不够。

import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { getIdentity, type Identity, type Role } from './identity';

export type Vars = { identity: Identity };

export type Authorization = 'ok' | 'unauthorized' | 'forbidden';

export function authorize(identity: Identity | null, roles: readonly Role[]): Authorization {
  if (!identity) return 'unauthorized';
  return roles.includes(identity.role) ? 'ok' : 'forbidden';
}

export function requireRole(
  ...roles: Role[]
): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const identity = await getIdentity(c.req.raw, c.env);

    switch (authorize(identity, roles)) {
      case 'unauthorized':
        return c.json({ error: 'unauthorized' }, 401);
      case 'forbidden':
        return c.json({ error: 'forbidden' }, 403);
      case 'ok':
        break;
    }

    if (identity) c.set('identity', identity);
    await next();
  };
}
