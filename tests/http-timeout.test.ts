import { describe, it, expect, vi } from 'vitest';
import { probeHttp } from '../src/sources/http';
import type { Target } from '../src/domain/observation';

// S5：超时/abort 接线必须有测试兜底。现在删掉 `signal: controller.signal` 或
// `setTimeout(() => controller.abort(), timeoutMs)` 仍然全绿的话，线上超时永远不生效，
// 请求会一直挂到平台默认超时，`errorKind` 也永远到不了 'timeout'。
const target = (): Target => ({
  id: 't1',
  source: 'http',
  form: 'https://example.com/health',
  config: { expectStatus: [200] },
  timeoutMs: 8000,
});

// 永不 resolve 的 fetch：只有 controller.abort() 触发 signal 的 abort 事件时才 reject。
const neverFetch = () =>
  vi.fn((_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      });
    });
  });

describe('probeHttp timeout wiring (S5)', () => {
  it('aborts via init.signal after timeoutMs and keeps at = request start', async () => {
    vi.useFakeTimers();
    try {
      const started = 1_700_000_000_000;
      const fakeFetch = neverFetch();
      const pending = probeHttp(target(), {
        fetch: fakeFetch as unknown as typeof fetch,
        now: () => started,
      });

      // 定时器必须真的挂在 timeoutMs 上：没到点不能 abort。
      await vi.advanceTimersByTimeAsync(7_999);
      expect(fakeFetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      const obs = await pending;

      expect(obs.ok).toBe(false);
      expect(obs.errorKind).toBe('timeout');
      // at 是发起时刻，不是超时时刻（否则延迟/分桶都会漂）。
      expect(obs.at).toBe(started);
      const init = fakeFetch.mock.calls[0]?.[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });
});
