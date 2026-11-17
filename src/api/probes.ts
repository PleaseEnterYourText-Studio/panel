// 手动探测：POST /api/probes/:targetId/run。
//
// 顺序是硬约束（Task 6 裁定）——「无审计不执行」：
//   1. 确认 target 存在（只读，404 不进审计）；所属 asset 已停用 → 409，同样不进审计
//   2. 先写审计；审计抛错 → 直接 500，后面的动作一行都不执行
//   3. 再把该 target 的 next_run_at 拨到 0，跑一次 tick
// 审计时间戳因此必然 <= 探测发起的时刻。
//
// 探测本身通过 runTick 复用调度器（claim-first / 落库 / 状态机都是同一套），不另写一遍。
// audit / probe 都是可注入依赖：审计失败分支与探测 stub 要在测试里能确定性复现。
// 返回 probed/skipped/failed 而不是单个 observation：runTick 是分片语义，手动触发时该
// target 是唯一到期项，probed=1 即成功；跳过（P0 未实现的 source）也如实计入 skipped。

import { Hono } from 'hono';
import type { Env } from '../env';
import type { Vars } from '../auth/rbac';
import { audit, type AuditInput } from '../audit';
import { runTick, type TickDeps, type TickResult } from '../scheduler/run';
import { currentIdentity, gate } from './guard';

export interface RunProbeResponse extends TickResult {
  targetId: string;
}

interface TargetRef {
  id: string;
  asset_id: string;
  /** 所属 asset 的启用位：停用对象的探测请求必须拒绝（P0 的到期查询不看 assets.enabled）。 */
  asset_enabled: number;
}

/** 审计写入口。抽成依赖是为了能注入「抛错」的审计，锁住「审计失败不执行动作」这条。 */
export type AuditFn = (env: Env, input: AuditInput) => Promise<void>;

export interface ProbesApiDeps {
  probe: TickDeps;
  /** 默认是生产 audit；测试注入抛错实现验证失败分支。 */
  audit: AuditFn;
}

export function createProbesApi(deps: ProbesApiDeps): Hono<{ Bindings: Env; Variables: Vars }> {
  const api = new Hono<{ Bindings: Env; Variables: Vars }>();

  api.post('/:targetId/run', gate('owner', 'ops'), async (c) => {
    const identity = currentIdentity(c);
    // gate 已保证身份存在；这里只是为了类型收窄，正常路径永远不会命中。
    if (!identity) return c.json({ error: 'unauthorized' }, 401);

    const targetId = c.req.param('targetId');
    // 同时取所属 asset 的 enabled：调度器的到期查询只过滤 targets.enabled，
    // 手动探测若放行停用对象，会真写 checks_raw、推进状态机并产生审计。
    const target = await c.env.DB.prepare(
      `SELECT t.id, t.asset_id, a.enabled AS asset_enabled
         FROM targets t JOIN assets a ON a.id = t.asset_id
        WHERE t.id = ?`,
    )
      .bind(targetId)
      .first<TargetRef>();
    if (!target) return c.json({ error: 'not_found' }, 404);

    // 停用对象：在写审计之前拒绝，审计只记录真正会执行的动作。
    if (target.asset_enabled !== 1) return c.json({ error: 'asset_disabled' }, 409);

    // 1) 无审计不执行：审计失败直接 500，动作不执行。
    try {
      await deps.audit(c.env, {
        actor: identity.email,
        action: 'probe.run',
        assetId: target.asset_id,
        payload: { targetId, trigger: 'manual' },
        ip: c.req.header('CF-Connecting-IP') ?? null,
      });
    } catch (e) {
      console.error(`api: audit failed for manual probe of target ${targetId}`, e);
      return c.json({ error: 'audit_failed' }, 500);
    }

    // 2) 动作：把该 target 拨回到期，交给调度器跑一个 tick。
    await c.env.DB.prepare(`UPDATE targets SET next_run_at = 0 WHERE id = ?`).bind(targetId).run();
    const result = await runTick(c.env, deps.probe);

    return c.json({ targetId, ...result } satisfies RunProbeResponse);
  });

  return api;
}
