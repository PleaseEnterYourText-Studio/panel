// HTTP 探测器：P0 唯一的探测源。纯 I/O 边界，返回领域值 Observation，不碰 DB。
//
// 约定（与 Task 5 的 rollup 分桶 / 延迟统计对齐）：
// - at 是「发起请求的时刻」，不是结束时刻。否则延迟统计和按分钟分桶都会漂。
// - detail 永远保留原始 error message，方便线上定位真实原因；不要把 message 换成人话。
// - AbortController 的定时器在成功与失败路径都必须清掉，否则常驻 worker 里会积压 timer。

import type { Observation, Target } from '../domain/observation';

export interface ProbeDeps {
  fetch: typeof fetch;
  now: () => number;
}

/**
 * 目标 config 非法（例如手写 D1 里把 expectStatus 写成 200 而不是 [200]）。
 *
 * 这类错误是「配置坏了」，不是「目标挂了」：绝不能落成 timeout 的失败 observation，
 * 否则会写 check、拉低 uptime、3 个 tick 后开出假 incident。调度器把它当 skip 处理。
 */
export class ConfigError extends Error {
  /** 原始 config，方便调度器把坏字段原样打进日志。 */
  readonly config: Record<string, unknown>;

  constructor(message: string, config: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ConfigError';
    this.config = config;
  }
}

/** config 缺 expectStatus 时的默认期望状态。 */
export const DEFAULT_EXPECT_STATUS: readonly number[] = [200];

// expectStatus 必须是非空整数数组。合法性检查放在探测之前：非法配置不该产生任何
// check / rollup / incident，连 fetch 都不该发出去。
export function readExpectStatus(config: Record<string, unknown>): number[] {
  const raw = config.expectStatus;
  if (raw === undefined) return [...DEFAULT_EXPECT_STATUS];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigError(
      `expectStatus must be a non-empty number[] (got ${Array.isArray(raw) ? 'empty array' : JSON.stringify(raw)})`,
      config,
    );
  }
  if (!raw.every((v) => typeof v === 'number' && Number.isInteger(v))) {
    throw new ConfigError(`expectStatus must contain only integers (got ${JSON.stringify(raw)})`, config);
  }
  return raw;
}

function classify(e: unknown): { errorKind: 'timeout' | 'dns' | 'tls' | 'refused'; message: string } {
  const err = e as { name?: string; message?: string };
  const msg = err?.message ?? String(e);
  if (err?.name === 'AbortError') return { errorKind: 'timeout', message: msg };
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return { errorKind: 'dns', message: msg };
  if (/certificate|SSL|TLS/i.test(msg)) return { errorKind: 'tls', message: msg };
  if (/ECONNREFUSED/i.test(msg)) return { errorKind: 'refused', message: msg };
  return { errorKind: 'timeout', message: msg };
}

export async function probeHttp(target: Target, deps: ProbeDeps): Promise<Observation> {
  const expectStatus = readExpectStatus(target.config);
  const started = deps.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs);
  try {
    const res = await deps.fetch(target.form, { method: 'GET', redirect: 'follow', signal: controller.signal });
    const latencyMs = deps.now() - started;
    const ok = expectStatus.includes(res.status);
    return {
      targetId: target.id,
      at: started,
      ok,
      latencyMs,
      ...(ok ? {} : { errorKind: 'status' as const, detail: { status: res.status } }),
    };
  } catch (e) {
    const { errorKind, message } = classify(e);
    return { targetId: target.id, at: started, ok: false, errorKind, detail: { message } };
  } finally {
    clearTimeout(timer);
  }
}
