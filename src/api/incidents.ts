// 故障列表：未关闭的排前面（open 优先），同组内按 opened_at 倒序。
// incidents.state 落库只写 'down' / 'closed'（Task 3 裁定），活跃与否一律看 closed_at；
// 响应里把它映射成展示语义 'open' / 'closed'，不让下游去记落库口径。

import { Hono } from 'hono';
import type { Env } from '../env';
import type { Vars } from '../auth/rbac';
import { gate } from './guard';

const INCIDENTS_LIMIT = 100;

export interface IncidentDto {
  id: string;
  targetId: string;
  assetId: string | null;
  serviceSlug: string | null;
  serviceName: string | null;
  openedAt: number;
  closedAt: number | null;
  state: 'open' | 'closed';
  cause: string | null;
}

interface IncidentJoinRow {
  id: string;
  target_id: string;
  asset_id: string | null;
  service_slug: string | null;
  service_name: string | null;
  opened_at: number;
  closed_at: number | null;
  cause: string | null;
}

const LIST_SQL = `
  SELECT i.id, i.target_id, i.opened_at, i.closed_at, i.cause,
         t.asset_id AS asset_id,
         a.slug AS service_slug,
         a.name AS service_name
    FROM incidents i
    LEFT JOIN targets t ON t.id = i.target_id
    LEFT JOIN assets a ON a.id = t.asset_id
   ORDER BY (i.closed_at IS NULL) DESC, i.opened_at DESC
   LIMIT ?
`;

export async function listIncidents(env: Env): Promise<IncidentDto[]> {
  const { results } = await env.DB.prepare(LIST_SQL).bind(INCIDENTS_LIMIT).all<IncidentJoinRow>();

  return results.map((row) => ({
    id: row.id,
    targetId: row.target_id,
    assetId: row.asset_id,
    serviceSlug: row.service_slug,
    serviceName: row.service_name,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    state: row.closed_at === null ? 'open' : 'closed',
    cause: row.cause,
  }));
}

export const incidentsApi = new Hono<{ Bindings: Env; Variables: Vars }>();

incidentsApi.get('/', gate('owner', 'ops', 'viewer'), async (c) => c.json(await listIncidents(c.env)));
