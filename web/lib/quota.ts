/**
 * 写入额度预警：纯函数，给概览页用。
 *
 * 免费版 D1 每天 100,000 行写入预算（自然日，含周末；规格 §7）。
 *
 * 关键：一次探测不是写 1 行，是写 3 行 —— claim 的 `UPDATE targets`、`checks_raw`
 * INSERT、`checks_rollup` upsert。所以后端 `writeEstimate` 的写入系数是 3：
 * 一个 interval_sec = 180 的 target 每天探测 480 次，真实写入约 1,440 行
 * （480 × 3）。按默认间隔换算：
 *   - 顶满 100,000 行 ≈ 70 个 target（69 × 1,440 = 99,360；70 个已 100,800 超限）；
 *   - 80,000 预警线在约 56 个 target 时先到（55 × 1,440 = 79,200；56 个 = 80,640）。
 * 阈值取 80,000（上限的 80%）——留 20,000 行给 events、审计和人工操作，
 * 超过这条线就该调大 interval_sec，而不是等写入失败。
 */

/**
 * 免费版每日写入上限（行）。
 */
export const FREE_PLAN_DAILY_WRITE_LIMIT = 100_000;

/** 预警阈值：严格大于才提示，正好等于 80,000 不提示。 */
export const WRITE_WARN_THRESHOLD = 80_000;

/** 每次探测的写入行数系数：claim UPDATE + checks_raw INSERT + checks_rollup upsert。 */
export const WRITE_FACTOR = 3;

/** writeEstimate 是否需要黄色预警条。 */
export function needsWriteWarning(writeEstimate: number): boolean {
  return writeEstimate > WRITE_WARN_THRESHOLD;
}

/** 预警文案；数字带千分位，不承诺「一定超限」——只是接近。 */
export function quotaWarningText(writeEstimate: number): string {
  return `按当前探测间隔估算每日写入 ${writeEstimate.toLocaleString('en-US')} 行，已接近免费版 ${FREE_PLAN_DAILY_WRITE_LIMIT.toLocaleString('en-US')} 上限，请调大 interval_sec`;
}

/** 概览页需要的计数字段（与 /api/overview 的 DTO 对齐）。 */
export interface OverviewCounts {
  okCount: number;
  suspectCount: number;
  downCount: number;
  unknownCount: number;
}

/**
 * 主标题。全部正常 →「全部正常。」；有故障/疑似 →「N 个故障，M 个疑似。」
 * 数字为 0 的那一段整段省略；两者都为 0 但有 unknown →「N 个无数据。」
 * （无数据不等于正常，不能算进「全部正常」）。
 *
 * 四个计数全为 0 是「空库」，不是健康：一个 target 都没配的仪表说「全部正常」
 * 会让人以为正在监控全部服务。这种情况单独给「尚未配置监控目标。」
 */
export function overviewHeadline(counts: OverviewCounts): string {
  const total = counts.okCount + counts.suspectCount + counts.downCount + counts.unknownCount;
  if (total === 0) return '尚未配置监控目标。';

  const parts: string[] = [];
  if (counts.downCount > 0) parts.push(`${counts.downCount} 个故障`);
  if (counts.suspectCount > 0) parts.push(`${counts.suspectCount} 个疑似`);
  if (parts.length > 0) return `${parts.join('，')}。`;
  if (counts.unknownCount > 0) return `${counts.unknownCount} 个无数据。`;
  return '全部正常。';
}
