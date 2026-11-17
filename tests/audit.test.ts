import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { AUDIT_PAYLOAD_MAX, audit } from '../src/audit';
import type { EventRow } from '../src/db/queries';

// 同文件共用一个 D1：每个用例用独立 actor 邮箱隔离查询。
let seq = 0;
const uniqueActor = (label: string) => `${label}-${Date.now()}-${++seq}@peyt.studio`;

async function readEvent(actor: string): Promise<EventRow | null> {
  return env.DB.prepare(`SELECT * FROM events WHERE actor = ?`).bind(actor).first<EventRow>();
}

describe('audit', () => {
  it('writes an action event with the fixed kind prefix and actor email', async () => {
    const actor = uniqueActor('probe');
    const before = Date.now();

    await audit(env, {
      actor,
      action: 'probe.run',
      assetId: 'asset-1',
      payload: { targetId: 't-1', ok: true },
      ip: '203.0.113.7',
    });

    const row = await readEvent(actor);
    expect(row).not.toBeNull();
    expect(row?.kind).toBe('action.probe.run');
    expect(row?.actor).toBe(actor);
    expect(row?.asset_id).toBe('asset-1');
    expect(row?.ip).toBe('203.0.113.7');
    expect(row?.payload).toBe(JSON.stringify({ targetId: 't-1', ok: true }));
    expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(row?.at).toBeGreaterThanOrEqual(before);
    expect(row?.at).toBeLessThanOrEqual(Date.now());
  });

  it('truncates an oversized payload to 2000 characters', async () => {
    const actor = uniqueActor('big');
    const big = { note: 'x'.repeat(5000) };

    await audit(env, { actor, action: 'probe.run', assetId: null, payload: big, ip: null });

    const row = await readEvent(actor);
    expect(row?.payload).toHaveLength(AUDIT_PAYLOAD_MAX);
    expect(row?.payload).toBe(JSON.stringify(big).slice(0, AUDIT_PAYLOAD_MAX));
  });

  it('serializes a payload that JSON.stringify cannot represent as "null"', async () => {
    const actor = uniqueActor('undefined');
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await audit(env, { actor, action: 'probe.run', assetId: null, payload: undefined, ip: null });
    expect((await readEvent(actor))?.payload).toBe('null');

    const actor2 = uniqueActor('circular');
    await audit(env, { actor: actor2, action: 'probe.run', assetId: null, payload: circular, ip: null });
    expect((await readEvent(actor2))?.payload).toBe('null');
  });
});
