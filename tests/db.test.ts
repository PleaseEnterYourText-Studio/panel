import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
  getAssetBySlug,
  insertAsset,
  insertChecks,
  listDueTargets,
  upsertRollup,
  type NewAsset,
  type RollupRow,
} from '../src/db/queries';

const seedAsset = (id: string, slug: string): NewAsset => ({
  id,
  kind: 'service',
  name: slug,
  slug,
  grp: 'prod',
  ownerEmail: 'nowint@peyt.studio',
  repo: 'NoWint/xiatian-ai-newapi',
  tags: 'ai',
  notes: null,
  enabled: 1,
  createdAt: 1_700_000_000_000,
});

const seedTarget = (db: D1Database, id: string, assetId: string, nextRunAt: number) =>
  db
    .prepare(
      `INSERT INTO targets (id, asset_id, source, form, config, interval_sec, timeout_ms, enabled, next_run_at)
       VALUES (?, ?, 'http', 'status', '{}', 180, 8000, 1, ?)`,
    )
    .bind(id, assetId, nextRunAt);

describe('queries', () => {
  it('inserts and reads an asset by slug', async () => {
    await insertAsset(env.DB, {
      id: 'a1', kind: 'service', name: 'newapi', slug: 'newapi',
      grp: 'prod', ownerEmail: 'nowint@peyt.studio', repo: 'NoWint/xiatian-ai-newapi',
      tags: 'ai', notes: null, enabled: 1, createdAt: 1_700_000_000_000,
    });
    const row = await getAssetBySlug(env.DB, 'newapi');
    expect(row?.name).toBe('newapi');
  });

  it('returns only due targets up to the limit', async () => {
    await insertAsset(env.DB, seedAsset('a2', 'svc-due'));
    await env.DB.batch([
      seedTarget(env.DB, 't-past', 'a2', 1_700_000_000_000),
      seedTarget(env.DB, 't-future', 'a2', 1_700_000_500_000),
    ]);

    const due = await listDueTargets(env.DB, 1_700_000_100_000, 1);
    expect(due).toHaveLength(1);
    expect(due[0]?.id).toBe('t-past');

    // 不设 limit 时未来目标也必须被过滤掉。
    const all = await listDueTargets(env.DB, 1_700_000_100_000, 40);
    expect(all.map((t) => t.id)).toEqual(['t-past']);
  });

  it('accumulates rollups across repeated upserts', async () => {
    await upsertRollup(env.DB, 't-rollup', 29_333_334, true, 120);
    await upsertRollup(env.DB, 't-rollup', 29_333_334, false, null);

    const row = await env.DB
      .prepare(`SELECT * FROM checks_rollup WHERE target_id = ? AND bucket_min = ?`)
      .bind('t-rollup', 29_333_334)
      .first<RollupRow>();

    // 失败的 null latency 不能污染 sum_ms / max_ms。
    expect(row).toMatchObject({ ok_count: 1, fail_count: 1, sum_ms: 120, max_ms: 120 });
  });

  it('inserts checks in one batch', async () => {
    await insertChecks(env.DB, [
      { target_id: 't-checks', at: 1_700_000_000_000, ok: 1, latency_ms: 120, error_kind: null, detail: null },
      { target_id: 't-checks', at: 1_700_000_180_000, ok: 0, latency_ms: null, error_kind: 'timeout', detail: 'etimeout' },
    ]);

    const { results } = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM checks_raw WHERE target_id = ?`)
      .bind('t-checks')
      .all<{ n: number }>();

    expect(results[0]?.n).toBe(2);
  });
});
