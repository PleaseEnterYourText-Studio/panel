// 手动探测：POST /api/probes/:targetId/run。
//
// 顺序是硬约束（Task 6 裁定）——「无审计不执行」：
//   1. 确认 target 存在（只读，404 不进审计）
//   2. 先写审计；审计抛错 → 直接 500，后面的动作一行都不执行
//   3. 再把该 target 的 next_run_at 拨到 0，跑一次 tick
// 审计时间戳因此必然 <= 探测发起的时刻。
//
// 探测本身通过 runTick 复用调度器（claim-first / 落库 / 状态机都是同一套），不另写一遍。
// 返回 probed/skipped/failed 而不是单个 observation：runTick 是分片语义，手动触发时该
// target 是唯一到期项，probed=1 即成功；跳过（P0 未实现的 source）也如实计入 skipped。

import { Hono } from 'hono';
import type { Env } from '../env';
import type { Vars } from '../auth/rbac';
import { audit } from '../audit';
import { runTick, type TickDeps, type TickResult } from '../scheduler/run';
import { currentIdentity, gate } from './guard';

export interface RunProbeResponse extends TickResult {
  targetId: string;
}

interface TargetRef {
  id: string;
  asset_id: string;
}

export type ProbesApiDeps = TickDeps;

export function createProbesApi(deps: ProbesApiDeps): Hono<{ Bindings: Env; Variables: Vars }> {
  const api = new Hono<{ Bindings: Env; Variables: Vars }>();

  api.post('/:targetId/run', gate('owner', 'ops'), async (c) => {
    const identity = currentIdentity(c);
    // gate 已保证身份存在；这里只是为了类型收窄，正常路径永远不会命中。
    if (!identity) return c.json({ error: 'unauthorized' }, 401);

    const targetId = c.req.param('targetId');
    const target = await c.env.DB.prepare(`SELECT id, asset_id FROM targets WHERE id = ?`)
      .bind(targetId)
      .first<TargetRef>();
    if (!target) return c.json({ error: 'not_found' }, 404);

    // 1) 无审计不执行：审计失败直接 500，动作不执行。
    try {
      await audit(c.env, {
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
    const result = await runTick(c.env, deps);

    return c.json({ targetId, ...result } satisfies RunProbeResponse);
  });

  return api;
}
