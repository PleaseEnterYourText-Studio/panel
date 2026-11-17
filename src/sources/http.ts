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
  const expectStatus = (target.config.expectStatus as number[] | undefined) ?? [200];
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
