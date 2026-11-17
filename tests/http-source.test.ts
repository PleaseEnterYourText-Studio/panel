import { describe, it, expect, vi } from 'vitest';
import { ConfigError, probeHttp, readExpectStatus } from '../src/sources/http';
import { resolveSource, UnsupportedSourceError } from '../src/sources/index';
import type { Target } from '../src/domain/observation';

const target = (config: Record<string, unknown>): Target => ({
  id: 't1', source: 'http', form: 'https://example.com/health', config, timeoutMs: 8000,
});

describe('probeHttp', () => {
  it('ok when status is expected', async () => {
    const fakeFetch = vi.fn(async () => new Response('up', { status: 200 }));
    const obs = await probeHttp(target({ expectStatus: [200] }), { fetch: fakeFetch as unknown as typeof fetch, now: () => 1000 });
    expect(obs.ok).toBe(true);
    expect(obs.at).toBe(1000);
    expect(obs.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('fails with status errorKind on unexpected status', async () => {
    const fakeFetch = vi.fn(async () => new Response('bad', { status: 502 }));
    const obs = await probeHttp(target({ expectStatus: [200] }), { fetch: fakeFetch as unknown as typeof fetch, now: () => 1 });
    expect(obs.ok).toBe(false);
    expect(obs.errorKind).toBe('status');
    expect(obs.detail).toMatchObject({ status: 502 });
  });

  it('fails with timeout errorKind when fetch aborts', async () => {
    const fakeFetch = vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    const obs = await probeHttp(target({ expectStatus: [200] }), { fetch: fakeFetch as unknown as typeof fetch, now: () => 1 });
    expect(obs.ok).toBe(false);
    expect(obs.errorKind).toBe('timeout');
  });

  it('classifies dns failures', async () => {
    const fakeFetch = vi.fn(async () => { throw new TypeError('getaddrinfo ENOTFOUND example.com'); });
    const obs = await probeHttp(target({ expectStatus: [200] }), { fetch: fakeFetch as unknown as typeof fetch, now: () => 1 });
    expect(obs.errorKind).toBe('dns');
  });
});

// 以下为控制器补充要求的锁定用例（不动上面四个 brief 原文用例）。
describe('probeHttp contract', () => {
  it('at is the request-start instant, latencyMs is the delta', async () => {
    const times = [1000, 1750];
    const now = vi.fn(() => times.shift() as number);
    const fakeFetch = vi.fn(async () => new Response('up', { status: 200 }));
    const obs = await probeHttp(target({ expectStatus: [200] }), { fetch: fakeFetch as unknown as typeof fetch, now });
    expect(obs.at).toBe(1000);
    expect(obs.latencyMs).toBe(750);
    // now() 必须只在 fetch 前后各取一次（含 timer 在内不重复取时）。
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('keeps the original message in detail for timeout fallback', async () => {
    const fakeFetch = vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    const obs = await probeHttp(target({ expectStatus: [200] }), { fetch: fakeFetch as unknown as typeof fetch, now: () => 1 });
    expect(obs.errorKind).toBe('timeout');
    expect(obs.detail).toMatchObject({ message: 'aborted' });
  });

  it('keeps the original message in detail for unclassified failures', async () => {
    const fakeFetch = vi.fn(async () => { throw new Error('socket hang up'); });
    const obs = await probeHttp(target({ expectStatus: [200] }), { fetch: fakeFetch as unknown as typeof fetch, now: () => 1 });
    expect(obs.errorKind).toBe('timeout');
    expect(obs.detail).toMatchObject({ message: 'socket hang up' });
  });

  it('status detail is exactly { status }', async () => {
    const fakeFetch = vi.fn(async () => new Response('bad', { status: 503 }));
    const obs = await probeHttp(target({}), { fetch: fakeFetch as unknown as typeof fetch, now: () => 1 });
    expect(obs.detail).toEqual({ status: 503 });
  });

  it('clears the abort timer on both success and failure', async () => {
    const spy = vi.spyOn(globalThis, 'clearTimeout');
    const okFetch = vi.fn(async () => new Response('up', { status: 200 }));
    await probeHttp(target({ expectStatus: [200] }), { fetch: okFetch as unknown as typeof fetch, now: () => 1 });
    const before = spy.mock.calls.length;
    const badFetch = vi.fn(async () => { throw new Error('boom'); });
    await probeHttp(target({ expectStatus: [200] }), { fetch: badFetch as unknown as typeof fetch, now: () => 1 });
    expect(spy.mock.calls.length).toBeGreaterThan(before);
    spy.mockRestore();
  });
});

describe('resolveSource', () => {
  it('dispatches http targets to probeHttp', async () => {
    const fakeFetch = vi.fn(async () => new Response('up', { status: 200 }));
    const obs = await resolveSource(target({ expectStatus: [200] }), { fetch: fakeFetch as unknown as typeof fetch, now: () => 1 });
    expect(obs.ok).toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('throws UnsupportedSourceError naming the unimplemented source', async () => {
    const deps = { fetch: vi.fn() as unknown as typeof fetch, now: () => 1 };
    await expect(resolveSource({ ...target({}), source: 'tcp' }, deps)).rejects.toBeInstanceOf(UnsupportedSourceError);
    await expect(resolveSource({ ...target({}), source: 'dns' }, deps)).rejects.toThrow(/dns/);
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});


// B2：config 必须显式收窄。非法 expectStatus 是配置错误，不能落成失败观测；
// 字段缺失才是合法的「用默认值」。
describe('probeHttp config narrowing (B2)', () => {
  it('defaults to [200] when expectStatus is absent', async () => {
    expect(readExpectStatus({})).toEqual([200]);
    const fakeFetch = vi.fn(async () => new Response('up', { status: 200 }));
    const obs = await probeHttp(target({}), { fetch: fakeFetch as unknown as typeof fetch, now: () => 1 });
    expect(obs.ok).toBe(true);
  });

  it('throws ConfigError for expectStatus that is not an array, without fetching', async () => {
    const fakeFetch = vi.fn(async () => new Response('up', { status: 200 }));
    await expect(
      probeHttp(target({ expectStatus: 200 }), { fetch: fakeFetch as unknown as typeof fetch, now: () => 1 }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('throws ConfigError for an empty array or non-integer entries', () => {
    expect(() => readExpectStatus({ expectStatus: [] })).toThrow(ConfigError);
    expect(() => readExpectStatus({ expectStatus: [200, '204'] })).toThrow(ConfigError);
    expect(() => readExpectStatus({ expectStatus: [200.5] })).toThrow(ConfigError);
    expect(readExpectStatus({ expectStatus: [200, 204] })).toEqual([200, 204]);
  });
});

