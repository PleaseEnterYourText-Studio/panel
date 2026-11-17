// Cloudflare Access JWT 验签：createRemoteJWKSet + jwtVerify。
//
// JWKS 对象按 team domain 缓存在模块级 Map 里（per-isolate），不能每次请求新建：
// createRemoteJWKSet 自带内部 key 缓存，重建会让每个请求都重新拉 /cdn-cgi/access/certs。
// 契约：任何异常（畸形 token、issuer/audience 不符、JWKS 拉取失败、时钟偏差）都由本模块
// 吞掉并返回 null，绝不把异常抛给调用方 —— 鉴权失败只能表现为「没有身份」。

import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface AccessConfig {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}

type RemoteJwks = ReturnType<typeof createRemoteJWKSet>;

const jwksCache = new Map<string, RemoteJwks>();

function normalizeTeamDomain(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function jwksFor(teamDomain: string): RemoteJwks {
  const cached = jwksCache.get(teamDomain);
  if (cached) return cached;
  const set = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
  jwksCache.set(teamDomain, set);
  return set;
}

export async function verifyAccessJwt(
  token: string,
  env: AccessConfig,
): Promise<{ email: string } | null> {
  try {
    const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
    if (!teamDomain || !env.ACCESS_AUD) return null;

    const { payload } = await jwtVerify(token, jwksFor(teamDomain), {
      issuer: teamDomain,
      audience: env.ACCESS_AUD,
    });

    // Access 把邮箱放在 email claim；缺 email 的 token 即使验签通过也不算身份。
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    return email ? { email } : null;
  } catch {
    return null;
  }
}
