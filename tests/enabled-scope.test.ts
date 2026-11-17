import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import type { Identity } from '../src/auth/identity';
import type { Overview } from '../src/api/overview';
import type { IncidentDto } from '../src/api/incidents';

// B3（enabled 口径统一）与 B4（写入系数 3）的回归测试。
const BASE = 'https://panel.test';
const OWNER: Identity = { email: 'owner@peyt.studio', role: 'owner' };

const app = () => createApp({ resolveIdentity: async () => OWNER });

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

async function truncate(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM checks_raw`),
    env.DB.prepare(`DELETE FROM checks_rollup`),
    env.DB.prepare(`DELETE FROM incidents`),
    env.DB.prepare(`DELETE FROM events`),
    env.DB.prepare(`DELETE FROM targets`),
    env.DB.prepare(`DELETE FROM assets`),
  ]);
}

interface SeedServiceOptions {
  slug: string;
  assetEnabled?: number;
  targetEnabled?: number;
  intervalSec?: number;
  config?: string;
}

async function seedService(opts: SeedServiceOptions): Promise<{ assetId: string; targetId: string }> {
  const assetId = nextId('asset');
  const targetId = nextId('target');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO assets (id, kind, name, slug, grp, owner_email, tags, repo, notes, enabled, created_at)
       VALUES (?, 'service', ?, ?, 'prod', 'owner@peyt.studio', NULL, NULL, NULL, ?, ?)`,
    ).bind(assetId, opts.slug, opts.slug, opts.assetEnabled ?? 1, Date.now()),
    env.DB.prepare(
      `INSERT INTO targets (id, asset_id, source, form, config, interval_sec, timeout_ms, enabled, next_run_at)
       VALUES (?, ?, 'http', 'https://example.invalid/health', ?, ?, 8000, ?, ?)`,
    ).bind(
      targetId,
      assetId,
      opts.config ?? '{"expectStatus":[200]}',
      opts.intervalSec ?? 180,
      opts.targetEnabled ?? 1,
      Date.now() + 3_600_000,
    ),
  ]);
  return { assetId, targetId };
}

async function seedOpenIncident(targetId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO incidents (id, target_id, opened_at, closed_at, state, cause)
     VALUES (?, ?, ?, NULL, 'down', NULL)`,
  )
    .bind(id, targetId, Date.now() - 60_000)
    .run();
  return id;
}

beforeEach(truncate);

describe('B3 enabled 口径（asset.enabled=1 且 target.enabled=1）', () => {
  it('excludes an enabled target under a disabled asset from overview counts and the write estimate', async () => {
    // 停用 asset + enabled target + 一条未关闭 incident：一个计数都不许出现。
    const disabled = await seedService({ slug: 'alpha', assetEnabled: 0 });
    await seedOpenIncident(disabled.targetId);
    // 正常对象：没有 check → unknown，占 1 个计数，interval 180s → 480 次 × 3 = 1,440。
    await seedService({ slug: 'beta' });

    const body = (await (await app().request(`${BASE}/api/overview`, {}, env)).json()) as Overview;

    expect(body).toMatchObject({ okCount: 0, suspectCount: 0, downCount: 0, unknownCount: 1 });
    expect(body.writeEstimate).toBe(1_440);
  });

  it('excludes incidents belonging to a disabled asset', async () => {
    const disabled = await seedService({ slug: 'alpha', assetEnabled: 0 });
    const disabledIncident = await seedOpenIncident(disabled.targetId);
    const enabled = await seedService({ slug: 'beta' });
    const enabledIncident = await seedOpenIncident(enabled.targetId);

    const res = await app().request(`${BASE}/api/incidents`, {}, env);
    const body = (await res.json()) as IncidentDto[];

    expect(body.map((i) => i.id)).toEqual([enabledIncident]);
    expect(body.map((i) => i.id)).not.toContain(disabledIncident);
  });
});

describe('B4 writeEstimate 计入真实写入系数 3', () => {
  it('multiplies the daily probe count by claim + checks_raw + checks_rollup rows', async () => {
    // interval 180 → 480 次/天，interval 60 → 1,440 次/天。
    await seedService({ slug: 'alpha', intervalSec: 180 });
    await seedService({ slug: 'beta', intervalSec: 60 });
    // 停用 asset 下的 target 不参与估算。
    await seedService({ slug: 'gamma', intervalSec: 60, assetEnabled: 0 });

    const body = (await (await app().request(`${BASE}/api/overview`, {}, env)).json()) as Overview;

    // floor(480 + 1,440) = 1,920 次探测 → × 3 = 5,760 行。
    expect(body.writeEstimate).toBe(5_760);
  });
});
