import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';
import type { Env } from '../src/env';
import { getIdentity, resolveIdentity, type Identity } from '../src/auth/identity';
import { authorize, requireRole, type Vars } from '../src/auth/rbac';
import wranglerConfig from '../wrangler.jsonc?raw';
import devVarsExample from '../.dev.vars.example?raw';

// 同一个测试文件共用一个本地 D1 / KV：每个用例用独立邮箱，避免缓存与唯一索引互咬。
let seq = 0;
const uniqueEmail = (label: string) => `${label}-${Date.now()}-${++seq}@peyt.studio`;

async function seedUser(email: string, role: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO users (id, email, role, created_at, last_seen) VALUES (?, ?, ?, ?, NULL)`)
    .bind(crypto.randomUUID(), email, role, Date.now())
    .run();
}

async function setRole(email: string, role: string): Promise<void> {
  await env.DB.prepare(`UPDATE users SET role = ? WHERE email = ?`).bind(role, email).run();
}

describe('resolveIdentity', () => {
  it('resolves a user from the users table', async () => {
    const email = uniqueEmail('owner');
    await seedUser(email, 'owner');

    await expect(resolveIdentity(email, env)).resolves.toEqual({ email, role: 'owner' });
  });

  it('denies an email that is not in the users table', async () => {
    const email = uniqueEmail('stranger');

    await expect(resolveIdentity(email, env)).resolves.toBeNull();
    // 未授权的 email 不允许被缓存成身份。
    await expect(env.KV.get(`identity:${email}`)).resolves.toBeNull();
  });

  it('denies a row whose role is not a known role', async () => {
    const email = uniqueEmail('bogus-role');
    await seedUser(email, 'superadmin');

    await expect(resolveIdentity(email, env)).resolves.toBeNull();
  });

  it('normalizes the email before lookup and before caching', async () => {
    const email = uniqueEmail('mixed-case');
    await seedUser(email, 'ops');

    const identity = await resolveIdentity(email.toUpperCase(), env);
    expect(identity).toEqual({ email, role: 'ops' });
    await expect(env.KV.get(`identity:${email}`)).resolves.not.toBeNull();
  });

  it('serves the second call from KV, not the users table', async () => {
    const email = uniqueEmail('cached');
    await seedUser(email, 'viewer');

    await expect(resolveIdentity(email, env)).resolves.toEqual({ email, role: 'viewer' });
    // 缓存写入是这条用例的前提：KV 里必须已经有 key。
    const cached = await env.KV.get(`identity:${email}`);
    expect(cached).not.toBeNull();

    // 绕过缓存：直接改库里的角色。若第二次仍读库会拿到 owner；只有走 KV 才保持 viewer。
    await setRole(email, 'owner');
    await expect(resolveIdentity(email, env)).resolves.toEqual({ email, role: 'viewer' });
  });
});

describe('getIdentity', () => {
  it('rejects requests without an assertion header', async () => {
    const req = new Request('https://panel.test/api/services');
    await expect(getIdentity(req, env)).resolves.toBeNull();
  });

  it('rejects a malformed assertion', async () => {
    const req = new Request('https://panel.test/api/services', {
      headers: { 'Cf-Access-Jwt-Assertion': 'not-a-jwt' },
    });
    await expect(getIdentity(req, env)).resolves.toBeNull();
  });

  it('rejects an assertion with JWT shape but garbage contents', async () => {
    const req = new Request('https://panel.test/api/services', {
      headers: { 'Cf-Access-Jwt-Assertion': 'aaa.bbb.ccc' },
    });
    await expect(getIdentity(req, env)).resolves.toBeNull();
  });

  it('resolves the dev bypass identity only when DEV_BYPASS_EMAIL is bound', async () => {
    const req = new Request('https://panel.test/api/services');
    const localEnv = { ...env, DEV_BYPASS_EMAIL: 'dev@peyt.studio' } as Env;

    await expect(getIdentity(req, localEnv)).resolves.toEqual({ email: 'dev@peyt.studio', role: 'owner' });
  });
});

describe('authorize', () => {
  const owner: Identity = { email: 'owner@peyt.studio', role: 'owner' };
  const ops: Identity = { email: 'ops@peyt.studio', role: 'ops' };
  const viewer: Identity = { email: 'viewer@peyt.studio', role: 'viewer' };

  it('returns unauthorized for an absent identity', () => {
    expect(authorize(null, ['owner'])).toBe('unauthorized');
    expect(authorize(null, [])).toBe('unauthorized');
  });

  it('returns forbidden when the role is not allowed', () => {
    expect(authorize(viewer, ['ops'])).toBe('forbidden');
    expect(authorize(ops, ['owner'])).toBe('forbidden');
    expect(authorize(owner, ['ops', 'viewer'])).toBe('forbidden');
  });

  it('returns ok when the role is allowed', () => {
    expect(authorize(ops, ['owner', 'ops'])).toBe('ok');
    expect(authorize(owner, ['owner'])).toBe('ok');
    expect(authorize(viewer, ['owner', 'ops', 'viewer'])).toBe('ok');
  });

  it('covers the full role matrix', () => {
    const identities = [owner, ops, viewer];
    const expectations: Record<Identity['role'], Record<Identity['role'], 'ok' | 'forbidden'>> = {
      owner: { owner: 'ok', ops: 'forbidden', viewer: 'forbidden' },
      ops: { owner: 'forbidden', ops: 'ok', viewer: 'forbidden' },
      viewer: { owner: 'forbidden', ops: 'forbidden', viewer: 'ok' },
    };

    for (const identity of identities) {
      for (const role of ['owner', 'ops', 'viewer'] as const) {
        expect(authorize(identity, [role])).toBe(expectations[identity.role][role]);
      }
    }
  });
});

describe('requireRole middleware', () => {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.get('/protected', requireRole('owner', 'ops', 'viewer'), (c) => c.json({ email: c.get('identity').email }));
  app.get('/owner-only', requireRole('owner'), (c) => c.json({ email: c.get('identity').email }));

  it('returns 401 when there is no identity', async () => {
    const res = await app.request('https://panel.test/protected', {}, env);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it('returns 403 when the identity role is not allowed', async () => {
    // dev bypass 固定 owner：owner 访问 requireRole('viewer') 必须 403。
    const ownerEnv = { ...env, DEV_BYPASS_EMAIL: 'owner@peyt.studio' } as Env;
    const viewerOnly = new Hono<{ Bindings: Env; Variables: Vars }>();
    viewerOnly.get('/viewer-only', requireRole('viewer'), (c) => c.json({ ok: true }));

    const res = await viewerOnly.request('https://panel.test/viewer-only', {}, ownerEnv);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden' });
  });

  it('passes the identity through to the handler when allowed', async () => {
    const ownerEnv = { ...env, DEV_BYPASS_EMAIL: 'owner@peyt.studio' } as Env;
    const res = await app.request('https://panel.test/owner-only', {}, ownerEnv);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ email: 'owner@peyt.studio' });
  });
});

describe('production config guard', () => {
  it('never ships DEV_BYPASS_EMAIL in wrangler.jsonc', () => {
    // 守卫：DEV_BYPASS_EMAIL 只允许来自本地 .dev.vars；写进 wrangler.jsonc 等于给生产开后门。
    expect(wranglerConfig).not.toContain('DEV_BYPASS_EMAIL');
  });

  it('keeps the dev bypass documented in .dev.vars.example only', () => {
    expect(devVarsExample).toContain('DEV_BYPASS_EMAIL');
  });
});
