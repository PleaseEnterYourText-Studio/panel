import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('health', () => {
  it('returns ok', async () => {
    const res = await SELF.fetch('https://panel.test/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
  });
});
