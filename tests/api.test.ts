import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import type { Identity, Role } from '../src/auth/identity';
import type { Overview } from '../src/api/overview';
import type { ServiceDetail, ServiceSummary } from '../src/api/services';
import type { IncidentDto } from '../src/api/incidents';
import type { RunProbeResponse } from '../src/api/probes';

// 本文件共用同一个本地 D1（每个测试文件一个 isolate），beforeEach 全表清空做隔离。
// 身份注入：SELF 绑定的是生产解析器（只认 Cloudflare Access / DEV_BYPASS），无法按角色
// 切换；所以「未登录 401」走 SELF.fetch 验证默认导出真的挂上了路由，其余用例走
// createApp({ resolveIdentity }) 注入固定身份 —— 同一个 app 工厂、同一套路由。
const BASE = 'https://panel.test';

type App = ReturnType<typeof createApp>;

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

function appAs(role: Role, probe?: { fetch: typeof fetch; now: () => number }): App {
  const identity: Identity = { email: `${role}@peyt.studio`, role };
  return createApp({ resolveIdentity: async () => identity, ...(probe ? { probe } : {}) });
}

async function request(app: App, path: string, init?: RequestInit): Promise<Response> {
  // app.request 的返回类型是 Response | Promise<Response>（Hono 允许同步 handler），
  // async 包一层统一成 Promise<Response>。
  return await app.request(`${BASE}${path}`, init ?? {}, env);
}

async function truncate(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM checks_raw`),
    env.DB.prepare(`DELETE FROM checks_rollup`),
    env.DB.prepare(`DELETE FROM incidents`),
    env.DB.prepare(`DELETE FROM events`),
    env.DB.prepare(`DELETE FROM targets`),
    env.DB.prepare(`DELETE FROM assets`),
    env.DB.prepare(`DELETE FROM users`),
  ]);
}

interface SeedTargetOptions {
  id: string;
  config?: unknown;
  source?: string;
  intervalSec?: number;
  timeoutMs?: number;
  nextRunAt?: number;
  enabled?: number;
}

interface SeedServiceOptions {
  slug: string;
  name?: string;
  grp?: string | null;
  kind?: string;
  enabled?: number;
  target?: SeedTargetOptions;
}

async function seedService(opts: SeedServiceOptions): Promise<{ assetId: string; targetId: string | null }> {
  const assetId = nextId('asset');
  await env.DB.prepare(
    `INSERT INTO assets (id, kind, name, slug, grp, owner_email, tags, repo, notes, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 'owner@peyt.studio', NULL, NULL, NULL, ?, ?)`,
  )
    .bind(
      assetId,
      opts.kind ?? 'service',
      opts.name ?? opts.slug,
      opts.slug,
      opts.grp ?? 'prod',
      opts.enabled ?? 1,
      Date.now(),
    )
    .run();

  if (!opts.target) return { assetId, targetId: null };

  const target = opts.target;
  await env.DB.prepare(
    `INSERT INTO targets (id, asset_id, source, form, config, interval_sec, timeout_ms, enabled, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      target.id,
      assetId,
      target.source ?? 'http',
      'https://example.invalid/health',
      JSON.stringify(target.config ?? { expectStatus: [200] }),
      target.intervalSec ?? 180,
      target.timeoutMs ?? 8000,
      target.enabled ?? 1,
      target.nextRunAt ?? Date.now() + 3_600_000,
    )
    .run();

  return { assetId, targetId: target.id };
}

async function seedCheck(targetId: string, ok: number, at: number, latencyMs = 12): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO checks_raw (target_id, at, ok, latency_ms, error_kind, detail) VALUES (?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(targetId, at, ok, latencyMs)
    .run();
}

async function seedIncident(
  targetId: string,
  opts: { openedAt: number; closedAt?: number | null } = { openedAt: Date.now() - 60_000 },
): Promise<string> {
  const id = crypto.randomUUID();
  const closedAt = opts.closedAt ?? null;
  await env.DB.prepare(
    `INSERT INTO incidents (id, target_id, opened_at, closed_at, state, cause)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  )
    .bind(id, targetId, opts.openedAt, closedAt, closedAt === null ? 'down' : 'closed')
    .run();
  return id;
}

async function seedRollup(targetId: string, okCount: number, failCount: number): Promise<void> {
  const bucketMin = Math.floor((Date.now() - 60_000) / 60_000);
  await env.DB.prepare(
    `INSERT INTO checks_rollup (target_id, bucket_min, ok_count, fail_count, sum_ms, max_ms)
     VALUES (?, ?, ?, ?, 0, 0)`,
  )
    .bind(targetId, bucketMin, okCount, failCount)
    .run();
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(truncate);

describe('api auth', () => {
  it.each(['/api/overview', '/api/services', '/api/services/alpha', '/api/incidents'])(
    'rejects unauthenticated access to %s',
    async (path) => {
      const res = await SELF.fetch(`${BASE}${path}`);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
    },
  );
});

describe('GET /api/overview', () => {
  it('returns zeroed counters on an empty database', async () => {
    const res = await request(appAs('owner'), '/api/overview');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      okCount: 0,
      suspectCount: 0,
      downCount: 0,
      unknownCount: 0,
      lastTickAt: null,
      writeEstimate: 0,
    });
  });

  it('counts a target whose last check is ok', async () => {
    const at = Date.now();
    const { targetId } = await seedService({ slug: 'alpha', target: { id: nextId('target') } });
    await seedCheck(targetId!, 1, at);

    const res = await request(appAs('viewer'), '/api/overview');
    const body = (await res.json()) as Overview;

    expect(body).toEqual({
      okCount: 1,
      suspectCount: 0,
      downCount: 0,
      unknownCount: 0,
      lastTickAt: at,
      // 单个 target，interval 180s → floor(86400 / 180) = 480 次探测 × 写入系数 3
      writeEstimate: 1440,
    });
  });

  it('counts a failing last check as suspect', async () => {
    const at = Date.now();
    const { targetId } = await seedService({ slug: 'alpha', target: { id: nextId('target') } });
    await seedCheck(targetId!, 1, at - 60_000);
    // 同一条 target 的最新一条是失败：suspect，不是 down（还没到 incident 阈值）。
    await seedCheck(targetId!, 0, at);

    const body = (await (await request(appAs('owner'), '/api/overview')).json()) as Overview;
    expect(body).toMatchObject({ okCount: 0, suspectCount: 1, downCount: 0, unknownCount: 0 });
    expect(body.lastTickAt).toBe(at);
  });

  it('counts a target with an open incident as down even when the last check is ok', async () => {
    const at = Date.now();
    const { targetId } = await seedService({ slug: 'alpha', target: { id: nextId('target') } });
    await seedCheck(targetId!, 1, at);
    await seedIncident(targetId!, { openedAt: at - 30_000 });

    const body = (await (await request(appAs('owner'), '/api/overview')).json()) as Overview;
    expect(body).toMatchObject({ okCount: 0, suspectCount: 0, downCount: 1, unknownCount: 0 });
  });

  it('counts a target without checks as unknown and ignores disabled targets', async () => {
    await seedService({ slug: 'alpha', target: { id: nextId('target') } });
    await seedService({ slug: 'beta', target: { id: nextId('target'), enabled: 0 } });

    const body = (await (await request(appAs('ops'), '/api/overview')).json()) as Overview;
    expect(body).toMatchObject({ okCount: 0, suspectCount: 0, downCount: 0, unknownCount: 1 });
    // 停用的 target 不计入每日写入估算（1,440 = 480 次探测 × 3 行写入）。
    expect(body.writeEstimate).toBe(1440);
  });
});

describe('GET /api/services', () => {
  it('lists enabled service assets with derived status, latency, uptime and lastOkAt', async () => {
    const at = Date.now();
    const { targetId } = await seedService({ slug: 'alpha', name: 'Alpha', target: { id: nextId('target') } });
    await seedCheck(targetId!, 1, at, 23);
    await seedRollup(targetId!, 9, 1);
    // 停用的 asset / 非 service 的 asset 不出现。
    await seedService({ slug: 'beta', enabled: 0, target: { id: nextId('target') } });
    await seedService({ slug: 'server-1', kind: 'server', target: { id: nextId('target') } });

    const res = await request(appAs('viewer'), '/api/services');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ServiceSummary[];

    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      slug: 'alpha',
      name: 'Alpha',
      group: 'prod',
      status: 'ok',
      latencyMs: 23,
      uptime24h: 90,
      lastOkAt: at,
    });
  });

  it('reports unknown for a service with no checks', async () => {
    await seedService({ slug: 'alpha', target: { id: nextId('target') } });

    const body = (await (await request(appAs('owner'), '/api/services')).json()) as ServiceSummary[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ status: 'unknown', latencyMs: null, uptime24h: null, lastOkAt: null });
  });
});

describe('GET /api/services/:slug', () => {
  it('returns 404 for an unknown slug', async () => {
    const res = await request(appAs('owner'), '/api/services/nope');
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'not_found' });
  });

  it('returns the service with sanitized target config and recent checks', async () => {
    const at = Date.now();
    const targetId = nextId('target');
    await seedService({
      slug: 'alpha',
      name: 'Alpha',
      target: {
        id: targetId,
        // config 里混入敏感字段：响应只能带 expectStatus / interval_sec / timeout_ms。
        config: {
          expectStatus: [200, 204],
          interval_sec: 60,
          timeout_ms: 500,
          headers: { Authorization: 'Bearer secret-token' },
          token: 'secret-token',
        },
      },
    });
    await seedCheck(targetId, 1, at, 15);

    const res = await request(appAs('viewer'), '/api/services/alpha');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ServiceDetail;

    expect(body.service).toMatchObject({ slug: 'alpha', name: 'Alpha', group: 'prod', kind: 'service' });
    expect(body.service).not.toHaveProperty('config');

    expect(body.targets).toHaveLength(1);
    expect(body.targets[0]?.id).toBe(targetId);
    expect(body.targets[0]?.config).toEqual({ expectStatus: [200, 204], interval_sec: 180, timeout_ms: 8000 });

    expect(body.recentChecks).toEqual([
      { targetId, at, ok: true, latencyMs: 15, errorKind: null },
    ]);
    expect(JSON.stringify(body)).not.toContain('secret-token');
  });
});

describe('GET /api/incidents', () => {
  it('lists open incidents before closed ones', async () => {
    const now = Date.now();
    const { targetId, assetId } = await seedService({ slug: 'alpha', target: { id: nextId('target') } });
    await seedIncident(targetId!, { openedAt: now - 10 * 60_000 });
    await seedIncident(targetId!, { openedAt: now - 5 * 60_000, closedAt: now - 60_000 });

    const res = await request(appAs('viewer'), '/api/incidents');
    expect(res.status).toBe(200);
    const body = (await res.json()) as IncidentDto[];

    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      state: 'open',
      openedAt: now - 10 * 60_000,
      closedAt: null,
      assetId,
      serviceSlug: 'alpha',
    });
    expect(body[1]).toMatchObject({ state: 'closed', closedAt: now - 60_000 });
  });
});

describe('POST /api/probes/:targetId/run', () => {
  it('audits before probing and returns the tick result', async () => {
    const targetId = nextId('target');
    const { assetId } = await seedService({ slug: 'alpha', target: { id: targetId, nextRunAt: 0 } });

    const fetchMock = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const before = Date.now();

    const res = await request(appAs('ops', { fetch: fetchMock, now: () => Date.now() }), `/api/probes/${targetId}/run`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunProbeResponse;
    expect(body).toMatchObject({ targetId, probed: 1, skipped: 0, failed: 0 });

    const event = await env.DB.prepare(`SELECT * FROM events WHERE kind = 'action.probe.run'`).first<{
      at: number;
      actor: string | null;
      asset_id: string | null;
      payload: string | null;
    }>();
    expect(event).not.toBeNull();
    expect(event?.actor).toBe('ops@peyt.studio');
    expect(event?.asset_id).toBe(assetId);
    expect(event?.payload).toContain(targetId);

    const check = await env.DB.prepare(`SELECT * FROM checks_raw WHERE target_id = ? ORDER BY at DESC LIMIT 1`)
      .bind(targetId)
      .first<{ at: number; ok: number }>();
    expect(check).not.toBeNull();
    expect(check?.ok).toBe(1);
    // 无审计不执行：审计行的时间戳必须 <= 探测执行（check 的 at）。
    expect(check!.at).toBeGreaterThanOrEqual(event!.at);
    expect(check!.at).toBeGreaterThanOrEqual(before);
  });

  it('returns 404 for an unknown target without writing an audit row', async () => {
    const res = await request(appAs('ops'), '/api/probes/does-not-exist/run', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await count(`SELECT COUNT(*) AS n FROM events`)).toBe(0);
  });

  // P0 的到期查询只过滤 targets.enabled，不看 assets.enabled：手动探测必须自己挡住
  // 停用对象，否则停用服务的探测会真写 checks_raw、推进状态机并留审计。
  it('rejects a target whose asset is disabled with 409 and does nothing', async () => {
    const targetId = nextId('target');
    // 显式钉死 next_run_at：默认播种用 Date.now()，与断言时刻差几毫秒会变成 flaky。
    const beforeRunAt = 4_000_000_000_000;
    const { assetId } = await seedService({
      slug: 'alpha',
      enabled: 0,
      target: { id: targetId, nextRunAt: beforeRunAt },
    });

    const res = await request(appAs('ops'), `/api/probes/${targetId}/run`, { method: 'POST' });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'asset_disabled' });
    // 不写审计、不落检查、不产生事件，next_run_at 也不能被拨到 0。
    expect(await count(`SELECT COUNT(*) AS n FROM events`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM checks_raw`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM incidents`)).toBe(0);
    const target = await env.DB.prepare(`SELECT next_run_at, asset_id FROM targets WHERE id = ?`)
      .bind(targetId)
      .first<{ next_run_at: number; asset_id: string }>();
    expect(target?.asset_id).toBe(assetId);
    expect(target!.next_run_at).toBe(beforeRunAt);
  });

  it('rejects a viewer with 403 and performs no action', async () => {
    const targetId = nextId('target');
    await seedService({ slug: 'alpha', target: { id: targetId } });

    const res = await request(appAs('viewer'), `/api/probes/${targetId}/run`, { method: 'POST' });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden' });
    expect(await count(`SELECT COUNT(*) AS n FROM events`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM checks_raw`)).toBe(0);
    // next_run_at 保持未来时间：看门失败时动作一步都不能执行（不能被拨到 0）。
    const target = await env.DB.prepare(`SELECT next_run_at FROM targets WHERE id = ?`)
      .bind(targetId)
      .first<{ next_run_at: number }>();
    expect(target!.next_run_at).toBeGreaterThan(Date.now());
  });
});
