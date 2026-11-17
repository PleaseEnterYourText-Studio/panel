/**
 * 状态推导：详情页只有 recentChecks，没有 incidents，所以在客户端按 target 最新一条
 * 检查推导。列表页的 /api/services 由后端带事件判断，是权威值；这里的推导只做兜底。
 *
 * 纯函数、无 React 依赖——测试可以直接断言，不用渲染组件。
 */

import type { ServiceCheck, ServiceTarget, Status } from './api';

const SEVERITY: Record<Status, number> = { down: 0, suspect: 1, ok: 2, unknown: 3 };

/** 每个 target 最新的一条检查（recentChecks 由服务端按 at DESC 排好）。 */
export function latestByTarget(checks: ServiceCheck[]): Map<string, ServiceCheck> {
  const latest = new Map<string, ServiceCheck>();
  for (const check of checks) {
    if (!latest.has(check.targetId)) latest.set(check.targetId, check);
  }
  return latest;
}

/** 停用 target 不参与状态（没有当前检查）；无检查 → unknown；失败 → suspect。 */
export function deriveTargetStatus(target: ServiceTarget, latest: ServiceCheck | undefined): Status {
  if (!target.enabled) return 'unknown';
  if (!latest) return 'unknown';
  return latest.ok ? 'ok' : 'suspect';
}

/** 一个 asset 多个 target 时取最坏状态（down > suspect > ok > unknown）。 */
export function deriveServiceStatus(targets: ServiceTarget[], checks: ServiceCheck[]): Status {
  const latest = latestByTarget(checks);
  let worst: Status = 'unknown';
  for (const target of targets) {
    const status = deriveTargetStatus(target, latest.get(target.id));
    if (SEVERITY[status] < SEVERITY[worst]) worst = status;
  }
  return worst;
}

export function countStatuses(targets: ServiceTarget[], checks: ServiceCheck[]): Record<Status, number> {
  const latest = latestByTarget(checks);
  const counts: Record<Status, number> = { ok: 0, suspect: 0, down: 0, unknown: 0 };
  for (const target of targets) {
    counts[deriveTargetStatus(target, latest.get(target.id))] += 1;
  }
  return counts;
}
