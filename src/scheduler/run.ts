// 调度器：Cron 每分钟触发一次，取最多 SHARD_LIMIT 个到期 target，探测、落库、推进状态。
//
// 关键约束（都来自平台额度 / 数据库契约，不是风格偏好）：
// - 分片：免费版单次调用最多 50 个外部 subrequest，本 tick 最多探测 40 个 target，
//   并发 6（Workers 出站连接上限），剩下的到期 target 留给下一分钟。
// - 每个 target 独立 try/catch：一个源的异常不能让整批 tick 挂掉。未实现的 source
//   抛 UnsupportedSourceError、坏 config 抛 ConfigError，都按 skip 处理（不写 check、
//   不动 incident）。未知异常同样 skip + 大声 log，绝不伪装成 timeout 失败。
// - 状态机从历史重建（rebuildMachine），绝不能用 initial() 播种：否则 failStreak
//   每 tick 都是 1，down 永远触发不了。
// - claim-first：tick 一开头就用一条 batch 推进本 tick 认领的 target（CAS）。
//   既避免中途落库失败导致下一分钟整片重探（rollup 非幂等会重复累加），
//   也让 40 target 的推进从 40 次 D1 往返压到 1 次。
// - insertChecks 按 ≤100 条分块：queries 层单个 db.batch 无上限。
// - upsertRollups 非幂等：每个 target 每 tick 只允许写一次 rollup；全部合成一次 batch。
// - 探测失败 / skip 的 target 也已在 claim 时推进了 next_run_at。

import type { Env } from '../env';
import {
  claimTargets,
  closeIncidentWithEvent,
  getOpenIncident,
  insertChecks,
  insertIncidentWithEvent,
  listDueTargets,
  listRecentChecks,
  upsertRollups,
  type CheckRow,
  type IncidentRow,
  type RollupUpsert,
  type TargetRow,
} from '../db/queries';
import { step, type Machine } from '../domain/incident';
import type { Observation, Target } from '../domain/observation';
import { ConfigError, UnsupportedSourceError, resolveSource } from '../sources';
import { RECENT_HISTORY, rebuildMachine } from './machine';

export const SHARD_LIMIT = 40;
export const CONCURRENCY = 6;

/** insertChecks 单批上限（queries 层的 batch 不限长，调度器负责切）。 */
const CHECKS_CHUNK = 100;

export interface TickDeps {
  now: () => number;
  fetch: typeof fetch;
}

export interface TickResult {
  /** 本 tick 真正探测过的 target 数（含失败，不含 skip / 未抢到 claim 的）。 */
  probed: number;
  /** 未探测的 target：未实现的 source / 配置损坏 / 探测源 bug，不写 check、不动 incident。 */
  skipped: number;
  /** 探测成功但落库（check / rollup / incident 流转）失败的 target 数。claim 不回滚。 */
  failed: number;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config);
  } catch (e) {
    // 手写 D1 时 config 写坏（少引号 / 尾逗号）是配置错误，不是目标故障：
    // 抛 ConfigError 让 probeTarget 走 skip，绝不产出一条 timeout 的失败 observation。
    throw new ConfigError(`target ${row.id} has malformed config JSON: ${String(e)}`, {
      config: row.config,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`target ${row.id} config must be a JSON object`, { config: row.config });
  }
  return {
    id: row.id,
    source: row.source as Target['source'],
    form: row.form,
    config: parsed as Record<string, unknown>,
    timeoutMs: row.timeout_ms,
  };
}

// 探测单个 target。返回 null 表示 skip（P0 未实现的 source / 配置损坏）。
// 历史必须在本次 check 落库之前读：否则会把本次结果先折叠一遍、再 step 一遍，重复计入。
//
// skip 的三种来源都必须「不写 checks_raw、不写 rollup、不动 incident」，并且
// next_run_at 已在 claim 时推进（不会占住分片名额反复被取到）：
//   1. UnsupportedSourceError —— source 在 P0 未实现；
//   2. ConfigError —— config 坏了（JSON 解析失败 / expectStatus 不是数组）；
//   3. 其它未知异常 —— 源码 bug。也走 skip 并大声 log，绝不伪装成 timeout。
async function probeTarget(env: Env, deps: TickDeps, row: TargetRow): Promise<TargetSnapshot | null> {
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
    if (e instanceof ConfigError) {
      // 配置错误：大声报出来（这是运维要修的手写数据），但不产生任何观测数据。
      console.error(`scheduler: config error for target ${row.id}, skipped: ${e.message}`);
      return null;
    }
    // 走到这里说明是探测源里的 bug（不该抛的异常）。上抛会拖垮整批 tick，
    // 记成失败 observation 会把 bug 伪装成目标故障——两条都不对，skip + 大声 log。
    console.error(`scheduler: unexpected probe error for target ${row.id}, skipped`, e);
    return null;
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
    // incident 行与 incident.opened 事件在同一条 db.batch（事务）里写：
    // 只成功一半的 incident 会永久缺失事件流，P0 验收的「事件流两条记录」就不成立。
    // 部分唯一索引 idx_incidents_one_open 兜住并发 tick 的重复开单，重复时事件不写。
    await insertIncidentWithEvent(
      env.DB,
      {
        id: incidentId,
        targetId: row.id,
        openedAt: observation.at,
        // 落库只允许 'down' / 'closed'；活跃与否一律用 closed_at IS NULL 判断。
        state: 'down',
        cause: observation.errorKind ?? null,
      },
      {
        id: crypto.randomUUID(),
        at: observation.at,
        kind: 'incident.opened',
        actor: null,
        assetId: row.asset_id,
        payload: JSON.stringify({ incidentId, errorKind: observation.errorKind ?? null }),
        ip: null,
      },
    );
    return;
  }

  if (next.state === 'ok' && open !== null) {
    await closeIncidentWithEvent(env.DB, open.id, observation.at, {
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

export async function runTick(env: Env, deps: TickDeps): Promise<TickResult> {
  const now = deps.now();
  const due = await listDueTargets(env.DB, now, SHARD_LIMIT);
  if (due.length === 0) return { probed: 0, skipped: 0, failed: 0 };

  // claim-first：tick 一开始就用一条 batch 把本 tick 认领的 target 推进到下一周期（CAS）。
  // 必须在任何探测/落库之前：中途写失败时 next_run_at 已经离开本分钟窗口，
  // 不会在下一分钟整片重探、把非幂等的 checks_rollup 重复累加，也不会让两个 tick
  // 重叠覆盖同一个 target 的 incident。changes=0 的行被别的 tick 抢走，本 tick 丢弃。
  const claimedIds = new Set(
    await claimTargets(
      env.DB,
      due.map((row) => ({
        id: row.id,
        expectedNextRunAt: row.next_run_at,
        nextRunAt: now + row.interval_sec * 1000,
      })),
    ),
  );
  const claimed = due.filter((row) => claimedIds.has(row.id));
  if (claimed.length === 0) return { probed: 0, skipped: 0, failed: 0 };

  const snapshots = await mapLimit(claimed, CONCURRENCY, (row) => probeTarget(env, deps, row));
  const probed = snapshots.filter((s): s is TargetSnapshot => s !== null);
  const observations = probed.map((s) => s.observation);

  // 落库失败不回滚 claim（该 target 已经排到下一周期，下一次自然到期会重探），
  // 但要记进 failed 并留日志：这部分数据是真丢了。
  const failedIds = new Set<string>();

  const checkRows = observations.map(toCheckRow);
  for (let i = 0; i < checkRows.length; i += CHECKS_CHUNK) {
    const chunk = checkRows.slice(i, i + CHECKS_CHUNK);
    try {
      await insertChecks(env.DB, chunk);
    } catch (e) {
      console.error('scheduler: insertChecks failed', e);
      for (const row of chunk) failedIds.add(row.target_id);
    }
  }

  // 每个 target 每个 tick 恰好一次（upsertRollups 非幂等，重复写会重复累加）；
  // 全部 rollup 合成一次 batch，40 target 的 rollup 往返从 40 次降到 1 次。
  const rollups: RollupUpsert[] = observations.map((o) => ({
    targetId: o.targetId,
    bucketMin: Math.floor(o.at / 60_000),
    ok: o.ok,
    latencyMs: o.latencyMs ?? null,
  }));
  for (let i = 0; i < rollups.length; i += CHECKS_CHUNK) {
    const chunk = rollups.slice(i, i + CHECKS_CHUNK);
    try {
      await upsertRollups(env.DB, chunk);
    } catch (e) {
      console.error('scheduler: upsertRollups failed', e);
      for (const row of chunk) failedIds.add(row.targetId);
    }
  }

  for (const snapshot of probed) {
    try {
      await applyTransition(env, snapshot);
    } catch (e) {
      console.error(`scheduler: incident transition failed for target ${snapshot.row.id}`, e);
      failedIds.add(snapshot.row.id);
    }
  }

  return {
    probed: probed.length,
    skipped: claimed.length - probed.length,
    failed: failedIds.size,
  };
}
