// 概览计数：每个 enabled target 的「当前状态」= 未关闭 incident → down；否则看最后一条
// checks_raw：ok=0 → suspect，ok=1 → ok，没有 check → unknown。
//
// 计数语义是「target 视角」，不是「incident 视角」：一个 target 有 3 次失败但还没到
// 阈值时不会出现在 downCount 里，只会是 suspect。downCount 只数「有未关闭 incident」的
// target，所以它和 incidents 表的 open 行数（按 target 去重后）一致。
//
// 一条 SQL 取完全部计数：last_check 用相关子查询取每个 target 最新一行（ORDER BY at DESC,
// id DESC 与 listRecentChecks 的排序一致，同毫秒时结果稳定）。窗口函数也能写，但相关
// 子查询走 idx_checks_raw_target_at，且不再依赖 D1 SQLite 的窗口函数行为。

import { Hono } from 'hono';
import type { Env } from '../env';
import type { Vars } from '../auth/rbac';
import { gate } from './guard';

export interface Overview {
  okCount: number;
  suspectCount: number;
  downCount: number;
  unknownCount: number;
  /** checks_raw 里最新一条 check 的时间；空表为 null。 */
  lastTickAt: number | null;
  /** 每日写入估算：Σ floor(86400 / interval_sec)，enabled target 计。 */
  writeEstimate: number;
}

interface OverviewRow {
  ok_count: number;
  suspect_count: number;
  down_count: number;
  unknown_count: number;
  last_tick_at: number | null;
  write_estimate: number;
}

const OVERVIEW_SQL = `
  SELECT
    COALESCE(SUM(CASE WHEN oi.target_id IS NULL AND lc.ok = 1 THEN 1 ELSE 0 END), 0) AS ok_count,
    COALESCE(SUM(CASE WHEN oi.target_id IS NULL AND lc.ok = 0 THEN 1 ELSE 0 END), 0) AS suspect_count,
    COALESCE(SUM(CASE WHEN oi.target_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS down_count,
    COALESCE(SUM(CASE WHEN oi.target_id IS NULL AND lc.id IS NULL THEN 1 ELSE 0 END), 0) AS unknown_count,
    (SELECT MAX(at) FROM checks_raw) AS last_tick_at,
    (SELECT COALESCE(SUM(86400.0 / interval_sec), 0) FROM targets
      WHERE enabled = 1 AND interval_sec > 0) AS write_estimate
  FROM targets t
  LEFT JOIN checks_raw lc ON lc.id = (
    SELECT c.id FROM checks_raw c WHERE c.target_id = t.id ORDER BY c.at DESC, c.id DESC LIMIT 1
  )
  LEFT JOIN (
    SELECT DISTINCT target_id FROM incidents WHERE closed_at IS NULL
  ) oi ON oi.target_id = t.id
  WHERE t.enabled = 1
`;

export async function buildOverview(env: Env): Promise<Overview> {
  const row = await env.DB.prepare(OVERVIEW_SQL).first<OverviewRow>();

  return {
    okCount: Number(row?.ok_count ?? 0),
    suspectCount: Number(row?.suspect_count ?? 0),
    downCount: Number(row?.down_count ?? 0),
    unknownCount: Number(row?.unknown_count ?? 0),
    lastTickAt: row?.last_tick_at == null ? null : Number(row.last_tick_at),
    writeEstimate: Math.floor(Number(row?.write_estimate ?? 0)),
  };
}

export const overviewApi = new Hono<{ Bindings: Env; Variables: Vars }>();

overviewApi.get('/', gate('owner', 'ops', 'viewer'), async (c) => c.json(await buildOverview(c.env)));
