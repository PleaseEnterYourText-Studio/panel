/**
 * 写入额度预警：纯函数，给概览页用。
 *
 * 免费版 D1 每天 100,000 行写入预算（自然日，含周末；规格 §7）。探测频率越高，
 * checks_raw 写得越多：一个 interval_sec = 180 的 target 每天约 480 行
 * （86400 / 180）。按默认间隔换算：
 *   - 顶满 100,000 行 ≈ 208 个 target（208 × 480 = 99,840）；
 *   - 80,000 预警线在约 167 个 target 时先到（167 × 480 = 80,160）。
 * 阈值取 80,000（上限的 80%）——留 20,000 行给 rollup、events 和人工操作，
 * 超过这条线就该调大 interval_sec，而不是等写入失败。
 */

/**
 * 免费版每日写入上限（行）。
 * 后端 `writeEstimate` = floor(Σ 86400 / interval_sec)，不是 Σ floor(86400 / interval_sec)。
 */
export const FREE_PLAN_DAILY_WRITE_LIMIT = 100_000;

/** 预警阈值：严格大于才提示，正好等于 80,000 不提示。 */
export const WRITE_WARN_THRESHOLD = 80_000;

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
 */
export function overviewHeadline(counts: OverviewCounts): string {
  const parts: string[] = [];
  if (counts.downCount > 0) parts.push(`${counts.downCount} 个故障`);
  if (counts.suspectCount > 0) parts.push(`${counts.suspectCount} 个疑似`);
  if (parts.length > 0) return `${parts.join('，')}。`;
  if (counts.unknownCount > 0) return `${counts.unknownCount} 个无数据。`;
  return '全部正常。';
}
