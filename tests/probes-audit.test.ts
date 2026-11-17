import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index';

// S4：审计失败分支的回归测试。顺序契约是「无审计不执行」：审计抛错 → 500，
// 且 next_run_at 不能被拨到 0、不写 checks_raw、不产生任何事件。
const BASE = 'https://panel.test';

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

async function seedTarget(nextRunAt: number): Promise<string> {
  const assetId = nextId('asset');
  const targetId = nextId('target');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO assets (id, kind, name, slug, grp, owner_email, tags, repo, notes, enabled, created_at)
       VALUES (?, 'service', ?, ?, 'prod', NULL, NULL, NULL, NULL, 1, ?)`,
    ).bind(assetId, assetId, assetId, Date.now()),
    env.DB.prepare(
      `INSERT INTO targets (id, asset_id, source, form, config, interval_sec, timeout_ms, enabled, next_run_at)
       VALUES (?, ?, 'http', 'https://example.invalid/health', '{"expectStatus":[200]}', 180, 8000, 1, ?)`,
    ).bind(targetId, assetId, nextRunAt),
  ]);
  return targetId;
}

async function count(sql: string): Promise<number> {
  const row = await env.DB.prepare(sql).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(truncate);

describe('POST /api/probes/:targetId/run 审计失败（S4）', () => {
  it('returns 500 and performs no action when the audit write fails', async () => {
    const beforeRunAt = 4_000_000_000_000;
    const targetId = await seedTarget(beforeRunAt);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = createApp({
      resolveIdentity: async () => ({ email: 'ops@peyt.studio', role: 'ops' }),
      audit: async () => {
        throw new Error('audit storage is down');
      },
    });
    const res = await app.request(`${BASE}/api/probes/${targetId}/run`, { method: 'POST' }, env);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'audit_failed' });
    expect(await count(`SELECT COUNT(*) AS n FROM events`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM checks_raw`)).toBe(0);
    const target = await env.DB.prepare(`SELECT next_run_at FROM targets WHERE id = ?`)
      .bind(targetId)
      .first<{ next_run_at: number }>();
    // 动作一步都不能执行：不能被拨到 0 交给 tick。
    expect(target!.next_run_at).toBe(beforeRunAt);
    errorSpy.mockRestore();
  });
});
