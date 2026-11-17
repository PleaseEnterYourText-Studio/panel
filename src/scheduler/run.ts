// 调度器：Cron 每分钟触发一次，取最多 SHARD_LIMIT 个到期 target，探测、落库、推进状态。
//
// 关键约束（都来自平台额度 / 数据库契约，不是风格偏好）：
// - 分片：免费版单次调用最多 50 个外部 subrequest，本 tick 最多探测 40 个 target，
//   并发 6（Workers 出站连接上限），剩下的到期 target 留给下一分钟。
// - 每个 target 独立 try/catch：一个源的异常不能让整批 tick 挂掉。未实现的 source
//   抛 UnsupportedSourceError，按 skip 处理（不写 check、不动 incident），
//   否则 seed 里一个 tcp target 就能让 scheduled 永久失败。
// - 状态机从历史重建（rebuildMachine），绝不能用 initial() 播种：否则 failStreak
//   每 tick 都是 1，down 永远触发不了。
// - insertChecks 按 ≤100 条分块：queries 层单个 db.batch 无上限。
// - upsertRollup 非幂等：每个 target 每 tick 只允许写一次 rollup。
// - 探测失败 / skip 也要推进 next_run_at，否则失败的 target 每分钟被重试打爆额度。

import type { Env } from '../env';
import {
  advanceTarget,
  closeIncident,
  getOpenIncident,
  insertChecks,
  insertIncident,
  listDueTargets,
  listRecentChecks,
  upsertRollup,
  writeEvent,
  type CheckRow,
  type IncidentRow,
  type TargetRow,
} from '../db/queries';
import { step, type Machine } from '../domain/incident';
import type { Observation, Target } from '../domain/observation';
import { UnsupportedSourceError, resolveSource } from '../sources';
import { RECENT_HISTORY, rebuildMachine } from './machine';

export const SHARD_LIMIT = 40;
export const CONCURRENCY = 6;

/** insertChecks 单批上限（queries 层的 batch 不限长，调度器负责切）。 */
const CHECKS_CHUNK = 100;

export interface TickDeps {
  now: () => number;
  fetch: typeof fetch;
}

interface TargetSnapshot {
  row: TargetRow;
  open: IncidentRow | null;
  recent: { ok: number }[];
  observation: Observation;
  /** 历史（open incident + 最近 check）是否读成功；失败时禁止做状态流转，避免开出重复 incident。 */
  historyOk: boolean;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

function toTarget(row: TargetRow): Target {
  return {
    id: row.id,
    source: row.source as Target['source'],
    form: row.form,
    config: JSON.parse(row.config) as Record<string, unknown>,
    timeoutMs: row.timeout_ms,
  };
}

// 探测单个 target。返回 null 表示 skip（P0 未实现的 source）。
// 历史必须在本次 check 落库之前读：否则会把本次结果先折叠一遍、再 step 一遍，重复计入。
async function probeTarget(
  env: Env,
  deps: TickDeps,
  row: TargetRow,
  now: number,
): Promise<TargetSnapshot | null> {
  let open: IncidentRow | null = null;
  let recent: { ok: number }[] = [];
  let historyOk = true;
  try {
    const [openIncident, recentChecks] = await Promise.all([
      getOpenIncident(env.DB, row.id),
      listRecentChecks(env.DB, row.id, RECENT_HISTORY),
    ]);
    open = openIncident;
    recent = recentChecks;
  } catch (e) {
    // 历史读失败不当成探测失败：用空历史降级，tick 继续（check / rollup 照写）。
    // 但状态流转必须跳过——用假历史开 incident 会开出重复的未关闭 incident。
    historyOk = false;
    console.error(`scheduler: failed to load history for target ${row.id}`, e);
  }

  try {
    const observation = await resolveSource(toTarget(row), deps);
    return { row, open, recent, observation, historyOk };
  } catch (e) {
    if (e instanceof UnsupportedSourceError) return null;
    // 探测本身抛错（配置损坏、解析失败等）按本次失败计，照常写 check / 推进状态。
    return {
      row,
      open,
      recent,
      historyOk,
      observation: {
        targetId: row.id,
        at: now,
        ok: false,
        errorKind: 'timeout',
        detail: { message: String(e) },
      },
    };
  }
}

function toCheckRow(o: Observation): CheckRow {
  return {
    target_id: o.targetId,
    at: o.at,
    ok: o.ok ? 1 : 0,
    latency_ms: o.latencyMs ?? null,
    error_kind: o.errorKind ?? null,
    detail: o.detail === undefined ? null : JSON.stringify(o.detail).slice(0, 1000),
  };
}

async function applyTransition(env: Env, snapshot: TargetSnapshot): Promise<void> {
  const { row, open, recent, observation } = snapshot;
  if (!snapshot.historyOk) return;
  const machine: Machine = rebuildMachine(recent, open !== null);
  const next = step(machine, observation.ok);

  if (next.state === 'down' && open === null) {
    const incidentId = crypto.randomUUID();
    await insertIncident(env.DB, {
      id: incidentId,
      targetId: row.id,
      openedAt: observation.at,
      // 落库只允许 'down' / 'closed'；活跃与否一律用 closed_at IS NULL 判断。
      state: 'down',
      cause: observation.errorKind ?? null,
    });
    await writeEvent(env.DB, {
      id: crypto.randomUUID(),
      at: observation.at,
      kind: 'incident.opened',
      actor: null,
      assetId: row.asset_id,
      payload: JSON.stringify({ incidentId, errorKind: observation.errorKind ?? null }),
      ip: null,
    });
    return;
  }

  if (next.state === 'ok' && open !== null) {
    await closeIncident(env.DB, open.id, observation.at);
    await writeEvent(env.DB, {
      id: crypto.randomUUID(),
      at: observation.at,
      kind: 'incident.closed',
      actor: null,
      assetId: row.asset_id,
      payload: JSON.stringify({ incidentId: open.id, durationMs: observation.at - open.opened_at }),
      ip: null,
    });
  }
}

export async function runTick(
  env: Env,
  deps: TickDeps,
): Promise<{ probed: number; skipped: number }> {
  const now = deps.now();
  const due = await listDueTargets(env.DB, now, SHARD_LIMIT);
  if (due.length === 0) return { probed: 0, skipped: 0 };

  const snapshots = await mapLimit(due, CONCURRENCY, (row) => probeTarget(env, deps, row, now));
  const probed = snapshots.filter((s): s is TargetSnapshot => s !== null);
  const observations = probed.map((s) => s.observation);

  const checkRows = observations.map(toCheckRow);
  for (let i = 0; i < checkRows.length; i += CHECKS_CHUNK) {
    await insertChecks(env.DB, checkRows.slice(i, i + CHECKS_CHUNK));
  }

  // 每个 target 每个 tick 恰好一次（upsertRollup 非幂等，重复调用会重复累加）。
  for (const o of observations) {
    await upsertRollup(env.DB, o.targetId, Math.floor(o.at / 60_000), o.ok, o.latencyMs ?? null);
  }

  // 所有到期 target 都推进（含失败与 skip）：用 tick 的 now 而不是 observation.at，
  // 保证同一 tick 内推进量一致；失败的 target 也必须离开本分钟的分片窗口。
  for (const row of due) {
    await advanceTarget(env.DB, row.id, now + row.interval_sec * 1000);
  }

  for (const snapshot of probed) {
    try {
      await applyTransition(env, snapshot);
    } catch (e) {
      console.error(`scheduler: incident transition failed for target ${snapshot.row.id}`, e);
    }
  }

  return { probed: probed.length, skipped: due.length - probed.length };
}
