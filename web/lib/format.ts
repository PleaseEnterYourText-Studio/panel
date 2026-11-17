/**
 * 展示格式化：列表页与详情页共用。
 *
 * 全部纯函数，`now` 显式传入——轮询页面重渲染时用同一次 tick 的时间，避免同一行
 * 内「刚刚」和「1 分钟前」互相打架。没有数据一律渲染「—」，不猜、不造假。
 */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** HH:MM:SS（本地时区）。null → 「—」。 */
export function formatClock(at: number | null): string {
  if (at === null || !Number.isFinite(at)) return '—';
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** HH:MM（本地时区）。头部「最近一次成功」用。null → 「—」。 */
export function formatMinute(at: number | null): string {
  if (at === null || !Number.isFinite(at)) return '—';
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** YYYY-MM-DD HH:MM:SS（本地时区）。给 title / 检查表用。 */
export function formatDateTime(at: number | null): string {
  if (at === null || !Number.isFinite(at)) return '—';
  const d = new Date(at);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${date} ${formatClock(at)}`;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前。null → 「—」。 */
export function formatAgo(at: number | null, now: number): string {
  if (at === null || !Number.isFinite(at)) return '—';
  const diff = now - at;
  // 负数 = 客户端时钟领先服务端；别显示「刚刚」，那是在替错误数据圆场。
  if (diff < 0) return '—';
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 延迟：整数毫秒。null → 「—」。 */
export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return `${Math.round(ms)}ms`;
}

/** 24h 可用率：两位小数百分比。null → 「—」（窗口内无 rollup 数据）。 */
export function formatUptime(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(2)}%`;
}

/** 把 API 错误压成一行：优先显示 HTTP status，非 ApiError 才落回 message。 */
export function describeError(e: unknown): string {
  if (e && typeof e === 'object' && 'status' in e && typeof (e as { status: unknown }).status === 'number') {
    const err = e as { status: number; message?: string };
    return `HTTP ${err.status}${err.message ? ` · ${err.message}` : ''}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
