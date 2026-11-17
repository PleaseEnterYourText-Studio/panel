// 身份解析拆两层：
//   1. getIdentity(req, env)   —— HTTP 入口：读 Cf-Access-Jwt-Assertion → 验签 → 拿 email
//   2. resolveIdentity(email, env) —— email → Identity（KV 缓存 60s，miss 才查 users 表）
// 分层是为了可测：测试无法签出 Cloudflare 认可的真 JWT，但可以直接测 email → Identity。
// 默认拒绝：users 表里没有该 email、角色不在白名单内、任何存储异常，一律返回 null。

import type { Env } from '../env';
import { getUserByEmail } from '../db/queries';
import { verifyAccessJwt } from './access';

export type Role = 'owner' | 'ops' | 'viewer';

export interface Identity {
  email: string;
  role: Role;
}

export const IDENTITY_CACHE_TTL_SEC = 60;

const ROLES: readonly Role[] = ['owner', 'ops', 'viewer'];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

function cacheKey(email: string): string {
  return `identity:${email}`;
}

function parseCached(raw: string): Identity | null {
  try {
    const parsed = JSON.parse(raw) as { email?: unknown; role?: unknown };
    if (typeof parsed.email !== 'string' || typeof parsed.role !== 'string') return null;
    if (!isRole(parsed.role)) return null;
    return { email: parsed.email, role: parsed.role };
  } catch {
    return null;
  }
}

export async function resolveIdentity(email: string, env: Env): Promise<Identity | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  const key = cacheKey(normalized);

  const cached = await env.KV.get(key).catch(() => null);
  if (cached) {
    const hit = parseCached(cached);
    if (hit) return hit;
    // 缓存内容坏了就当作未命中，继续读库；不因为一条脏缓存拒绝合法用户。
  }

  try {
    const row = await getUserByEmail(env.DB, normalized);
    if (!row) return null;
    if (!isRole(row.role)) return null;

    const identity: Identity = { email: row.email, role: row.role };
    // 缓存写失败不影响本次鉴权结果（下次会再查库）。
    await env.KV.put(key, JSON.stringify(identity), { expirationTtl: IDENTITY_CACHE_TTL_SEC }).catch(() => {});
    return identity;
  } catch {
    return null;
  }
}

export async function getIdentity(req: Request, env: Env): Promise<Identity | null> {
  // bypass 是双条件闸门：PANEL_ENV === 'development' 且 DEV_BYPASS_EMAIL 非空。
  // 只看变量是否存在等于「生产里加一个变量就拿到 owner」——secret / dashboard 变量 /
  // 遗留 .dev.vars 都能触发。PANEL_ENV 未设或不是 development 时完全忽略该变量，
  // 继续走正常 JWT 路径（即使 DEV_BYPASS_EMAIL 被错误绑上了也不放行）。
  if (env.PANEL_ENV === 'development') {
    const devEmail = env.DEV_BYPASS_EMAIL?.trim().toLowerCase();
    if (devEmail) return { email: devEmail, role: 'owner' };
  }

  const token = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;

  const verified = await verifyAccessJwt(token, env);
  if (!verified) return null;

  return resolveIdentity(verified.email, env);
}
