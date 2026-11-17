import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeIncidentWithEvent,
  getOpenIncident,
  insertIncident,
  insertIncidentWithEvent,
  type NewEvent,
} from '../src/db/queries';

// S2（部分唯一索引 + ON CONFLICT 静默跳过）与 S3（incident 行与事件同 batch 原子写）的回归测试。
let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

async function truncate(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM incidents`),
    env.DB.prepare(`DELETE FROM events`),
    env.DB.prepare(`DELETE FROM targets`),
    env.DB.prepare(`DELETE FROM assets`),
  ]);
}

async function seedTarget(): Promise<{ assetId: string; targetId: string }> {
  const assetId = nextId('asset');
  const targetId = nextId('target');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO assets (id, kind, name, slug, grp, owner_email, tags, repo, notes, enabled, created_at)
       VALUES (?, 'service', ?, ?, 'prod', NULL, NULL, NULL, NULL, 1, ?)`,
    ).bind(assetId, assetId, assetId, Date.now()),
    env.DB.prepare(
      `INSERT INTO targets (id, asset_id, source, form, config, interval_sec, timeout_ms, enabled, next_run_at)
       VALUES (?, ?, 'http', 'https://example.invalid/health', '{"expectStatus":[200]}', 180, 8000, 1, ?)`,
    ).bind(targetId, assetId, Date.now() + 3_600_000),
  ]);
  return { assetId, targetId };
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const eventFor = (kind: string, assetId: string | null, payload: unknown): NewEvent => ({
  id: crypto.randomUUID(),
  at: Date.now(),
  kind,
  actor: null,
  assetId,
  payload: JSON.stringify(payload),
  ip: null,
});

beforeEach(truncate);

describe('S2 每条 target 最多一条未关闭 incident', () => {
  it('silently ignores the second open-incident insert and only writes one incident.opened', async () => {
    const { assetId, targetId } = await seedTarget();

    const first = await insertIncidentWithEvent(
      env.DB,
      { id: crypto.randomUUID(), targetId, openedAt: Date.now(), state: 'down', cause: 'timeout' },
      eventFor('incident.opened', assetId, { incidentId: 'first' }),
    );
    expect(first.inserted).toBe(true);
    expect(first.open?.target_id).toBe(targetId);

    // 并发 tick / 手动探测的第二次插入：部分唯一索引冲突 → 静默跳过，不写事件。
    const second = await insertIncidentWithEvent(
      env.DB,
      { id: crypto.randomUUID(), targetId, openedAt: Date.now(), state: 'down', cause: 'timeout' },
      eventFor('incident.opened', assetId, { incidentId: 'second' }),
    );
    expect(second.inserted).toBe(false);
    // 重新读到的仍是同一条 open incident，不会凭空多出第二条。
    expect(second.open?.id).toBe(first.open?.id);

    expect(await count(`SELECT COUNT(*) AS n FROM incidents WHERE target_id = ?`, targetId)).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM incidents WHERE target_id = ? AND closed_at IS NULL`,
        targetId,
      ),
    ).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE kind = 'incident.opened'`)).toBe(1);
  });

  it('reports inserted=false from the raw insert on conflict', async () => {
    const { targetId } = await seedTarget();

    expect(
      await insertIncident(env.DB, {
        id: crypto.randomUUID(),
        targetId,
        openedAt: Date.now(),
        state: 'down',
        cause: null,
      }),
    ).toBe(true);
    expect(
      await insertIncident(env.DB, {
        id: crypto.randomUUID(),
        targetId,
        openedAt: Date.now(),
        state: 'down',
        cause: null,
      }),
    ).toBe(false);
    expect(await count(`SELECT COUNT(*) AS n FROM incidents WHERE target_id = ?`, targetId)).toBe(1);
  });
});

describe('S3 incident 行与事件原子写', () => {
  it('rolls back the incident row when the event insert fails inside the same batch', async () => {
    const { assetId, targetId } = await seedTarget();
    const duplicatedEventId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO events (id, at, kind, actor, asset_id, payload, ip) VALUES (?, ?, 'seed', NULL, NULL, NULL, NULL)`,
    )
      .bind(duplicatedEventId, Date.now())
      .run();

    const incidentId = crypto.randomUUID();
    // 事件行主键冲突 → 整批回滚：incident 行不能留下来，否则就是「有 incident 没事件」。
    await expect(
      insertIncidentWithEvent(
        env.DB,
        { id: incidentId, targetId, openedAt: Date.now(), state: 'down', cause: null },
        { ...eventFor('incident.opened', assetId, {}), id: duplicatedEventId },
      ),
    ).rejects.toBeTruthy();

    expect(await count(`SELECT COUNT(*) AS n FROM incidents WHERE id = ?`, incidentId)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM incidents WHERE target_id = ?`, targetId)).toBe(0);
  });

  it('closes the incident and writes exactly one incident.closed event atomically', async () => {
    const { assetId, targetId } = await seedTarget();
    const { open } = await insertIncidentWithEvent(
      env.DB,
      { id: crypto.randomUUID(), targetId, openedAt: Date.now() - 10_000, state: 'down', cause: null },
      eventFor('incident.opened', assetId, {}),
    );
    expect(open).not.toBeNull();

    const closedAt = Date.now();
    const closed = await closeIncidentWithEvent(
      env.DB,
      open!.id,
      closedAt,
      eventFor('incident.closed', assetId, { incidentId: open!.id, durationMs: 1 }),
    );
    expect(closed).toBe(true);
    expect(await getOpenIncident(env.DB, targetId)).toBeNull();
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE kind = 'incident.closed'`)).toBe(1);

    // 已关闭再关一次：UPDATE changes=0，事件不重复写。
    const again = await closeIncidentWithEvent(
      env.DB,
      open!.id,
      closedAt,
      eventFor('incident.closed', assetId, { incidentId: open!.id, durationMs: 1 }),
    );
    expect(again).toBe(false);
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE kind = 'incident.closed'`)).toBe(1);
  });
});
