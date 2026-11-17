import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { CONCURRENCY, SHARD_LIMIT, runTick } from '../src/scheduler/run';
import { rebuildMachine } from '../src/scheduler/machine';
import type { IncidentRow, RollupRow } from '../src/db/queries';

// 所有时间都是相对这里的偏移；bucket 一律按 Math.floor(at / 60_000) 现算，
// 不在测试里写死分钟编号（改 T0 时不会有第二处魔数要同步）。
//
// 本文件的用例共用同一个 D1：每个用例开始前先停用已播种的 target（否则上一个用例里
// 落在过去的 next_run_at 会在下个用例的 tick 里再次到期），再用 nextBase() 拿一个
// 相隔 1 小时的基准时刻，双重隔离。
const T0 = 1_700_000_000_000;
const INTERVAL_MS = 180_000;
let clock = T0 - 3_600_000;
const nextBase = (): number => (clock += 3_600_000);

const okFetch = () =>
  (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;

const statusFetch = (status: number) =>
  (async () => new Response('body', { status })) as unknown as typeof fetch;

interface SeedTargetOptions {
  id: string;
  nextRunAt: number;
  source?: string;
  intervalSec?: number;
}

async function seedTarget(opts: SeedTargetOptions): Promise<void> {
  const assetId = `asset-${opts.id}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO assets (id, kind, name, slug, grp, owner_email, tags, repo, notes, enabled, created_at)
       VALUES (?, 'service', ?, ?, 'prod', 'nowint@peyt.studio', NULL, NULL, NULL, 1, ?)`,
    ).bind(assetId, assetId, assetId, T0),
    env.DB.prepare(
      `INSERT INTO targets (id, asset_id, source, form, config, interval_sec, timeout_ms, enabled, next_run_at)
       VALUES (?, ?, ?, 'https://example.test/health', '{}', ?, 8000, 1, ?)`,
    ).bind(opts.id, assetId, opts.source ?? 'http', opts.intervalSec ?? 180, opts.nextRunAt),
  ]);
}

async function disableAllTargets(): Promise<void> {
  await env.DB.prepare(`UPDATE targets SET enabled = 0`).run();
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('runTick platform limits', () => {
  it('exposes the platform limits it must respect', () => {
    expect(SHARD_LIMIT).toBe(40);
    expect(CONCURRENCY).toBe(6);
  });

  // 必须最先跑：本文件共用同一个 D1，后续用例会播种到期 target。
  it('does nothing when no target is due', async () => {
    const res = await runTick(env, { now: () => T0, fetch: okFetch() });
    expect(res).toEqual({ probed: 0, skipped: 0 });
  });
});

describe('runTick probe pipeline', () => {
  it('probes a due target, records the check, rolls up the bucket and advances the schedule', async () => {
    await disableAllTargets();
    const base = nextBase();
    await seedTarget({ id: 'st-ok', nextRunAt: base - 1_000 });

    const res = await runTick(env, { now: () => base, fetch: okFetch() });
    expect(res).toEqual({ probed: 1, skipped: 0 });

    const checks = await env.DB.prepare(`SELECT * FROM checks_raw WHERE target_id = ?`)
      .bind('st-ok')
      .all<{ ok: number; at: number }>();
    expect(checks.results).toHaveLength(1);
    expect(checks.results[0]?.ok).toBe(1);

    // bucket 用与实现相同的公式断言。
    const bucket = Math.floor(base / 60_000);
    const rollup = await env.DB.prepare(
      `SELECT * FROM checks_rollup WHERE target_id = ? AND bucket_min = ?`,
    )
      .bind('st-ok', bucket)
      .first<RollupRow>();
    expect(rollup).toMatchObject({ ok_count: 1, fail_count: 0 });

    const target = await env.DB.prepare(`SELECT next_run_at FROM targets WHERE id = ?`)
      .bind('st-ok')
      .first<{ next_run_at: number }>();
    expect(target?.next_run_at).toBe(base + INTERVAL_MS);
  });

  it('skips unsupported sources without failing the tick', async () => {
    await disableAllTargets();
    const base = nextBase();
    await seedTarget({ id: 'st-tcp', source: 'tcp', nextRunAt: base - 1_000 });
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));

    const res = await runTick(env, {
      now: () => base,
      fetch: fetchMock as unknown as typeof fetch,
    });

    // tcp 在 P0 未实现：不计入 probed、不调用 fetch、不写 check、不改 incident。
    expect(res).toEqual({ probed: 0, skipped: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await count(`SELECT COUNT(*) AS n FROM checks_raw WHERE target_id = ?`, 'st-tcp')).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM incidents WHERE target_id = ?`, 'st-tcp')).toBe(0);

    // 跳过的 target 也必须推进 next_run_at，否则它会一直占着分片名额被反复取到。
    const target = await env.DB.prepare(`SELECT next_run_at FROM targets WHERE id = ?`)
      .bind('st-tcp')
      .first<{ next_run_at: number }>();
    expect(target?.next_run_at).toBe(base + INTERVAL_MS);
  });

  it('opens exactly one incident after three consecutive failures and closes it after two successes', async () => {
    await disableAllTargets();
    const base = nextBase();
    await seedTarget({ id: 'st-flap', nextRunAt: base - 1_000 });

    let now = base;
    for (let tick = 0; tick < 3; tick++) {
      const res = await runTick(env, { now: () => now, fetch: statusFetch(502) });
      expect(res).toEqual({ probed: 1, skipped: 0 });
      now += INTERVAL_MS;

      const open = await count(
        `SELECT COUNT(*) AS n FROM incidents WHERE target_id = ? AND closed_at IS NULL`,
        'st-flap',
      );
      // 前 3 次失败里只有第 3 次才允许开 incident。
      expect(open).toBe(tick === 2 ? 1 : 0);
    }

    expect(await count(`SELECT COUNT(*) AS n FROM incidents WHERE target_id = ?`, 'st-flap')).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE kind = 'incident.opened'`)).toBe(1);

    const firstOk = await runTick(env, { now: () => now, fetch: okFetch() });
    expect(firstOk.probed).toBe(1);
    // 单次成功不解故障：down 粘性，必须连续 2 次成功。
    expect(
      await count(`SELECT COUNT(*) AS n FROM incidents WHERE target_id = ? AND closed_at IS NULL`, 'st-flap'),
    ).toBe(1);

    now += INTERVAL_MS;
    const secondOk = await runTick(env, { now: () => now, fetch: okFetch() });
    expect(secondOk.probed).toBe(1);
    now += INTERVAL_MS;

    const incidents = await env.DB.prepare(`SELECT * FROM incidents WHERE target_id = ?`)
      .bind('st-flap')
      .all<IncidentRow>();
    expect(incidents.results).toHaveLength(1);
    expect(incidents.results[0]?.closed_at).not.toBeNull();
    expect(incidents.results[0]?.state).toBe('closed');

    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE kind = 'incident.opened'`)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE kind = 'incident.closed'`)).toBe(1);

    // 5 个 tick 各写一条 check，一条都不能丢。
    expect(await count(`SELECT COUNT(*) AS n FROM checks_raw WHERE target_id = ?`, 'st-flap')).toBe(5);
  });
});

describe('rebuildMachine', () => {
  it('returns unknown with no history and no open incident', () => {
    expect(rebuildMachine([], false)).toEqual({ state: 'unknown', failStreak: 0, okStreak: 0 });
  });

  it('reaches down after three consecutive failures', () => {
    expect(rebuildMachine([{ ok: 0 }, { ok: 0 }, { ok: 0 }], false)).toEqual({
      state: 'down',
      failStreak: 3,
      okStreak: 0,
    });
  });

  it('forces down with a saturated fail streak while an incident is open', () => {
    expect(rebuildMachine([], true)).toEqual({ state: 'down', failStreak: 3, okStreak: 0 });
  });

  it('counts success streak across ticks while an incident is open', () => {
    // incident 开着 + 历史里已有 1 次成功 → 折出 down / okStreak 1，本次再成功就恢复。
    expect(rebuildMachine([{ ok: 1 }], true)).toEqual({ state: 'down', failStreak: 0, okStreak: 1 });
    // 两次成功 → ok，允许关 incident（否则恢复永远到不了阈值 2）。
    expect(rebuildMachine([{ ok: 1 }, { ok: 1 }], true)).toEqual({
      state: 'ok',
      failStreak: 0,
      okStreak: 2,
    });
  });

  it('is ok after two consecutive successes', () => {
    expect(rebuildMachine([{ ok: 1 }, { ok: 1 }], false)).toEqual({
      state: 'ok',
      failStreak: 0,
      okStreak: 2,
    });
  });

  it('folds newest-first history in chronological order', () => {
    // 最近 5 条（新→旧）：ok, ok, fail, fail, fail。
    // 按时间正序折叠 = fail×3 → down，再 ok → down（粘性，okStreak 1），再 ok → ok。
    expect(rebuildMachine([{ ok: 1 }, { ok: 1 }, { ok: 0 }, { ok: 0 }, { ok: 0 }], false)).toEqual({
      state: 'ok',
      failStreak: 0,
      okStreak: 2,
    });
  });

  it('keeps down sticky while a single success comes in', () => {
    // 新→旧：ok, fail, fail, fail。
    expect(rebuildMachine([{ ok: 1 }, { ok: 0 }, { ok: 0 }, { ok: 0 }], false)).toEqual({
      state: 'down',
      failStreak: 0,
      okStreak: 1,
    });
  });
});
