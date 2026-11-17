// 服务列表与详情。响应全部映射成显式 DTO：D1 行原样吐出会把 targets.config 里的
// 敏感字段（headers / token 等）带出去，config 只暴露 expectStatus / interval_sec / timeout_ms。
//
// 状态推导与 /api/overview 同源：未关闭 incident → down，否则最后一条 check 决定
// ok / suspect / unknown。一个 asset 可以有多个 target，取最坏状态（down > suspect >
// ok > unknown），延迟取决定状态的那个 target 的最后一次延迟。

import { Hono } from 'hono';
import type { Env } from '../env';
import type { Vars } from '../auth/rbac';
import type { Status } from '../domain/incident';
import type { AssetRow, CheckRow, TargetRow } from '../db/queries';
import { getAssetBySlug } from '../db/queries';
import { gate } from './guard';

/** 24h 窗口：rollup 是分钟桶，按 bucket_min >= 当前分钟 - 1440 取。 */
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_BUCKETS = DAY_MS / MINUTE_MS;
const RECENT_CHECKS_LIMIT = 50;

const SEVERITY: Record<Status, number> = { down: 0, suspect: 1, ok: 2, unknown: 3 };

export interface ServiceSummary {
  slug: string;
  name: string;
  group: string | null;
  status: Status;
  latencyMs: number | null;
  /** 24h 可用率，百分比 0–100（保留 2 位）；窗口内无 rollup 数据为 null。 */
  uptime24h: number | null;
  lastOkAt: number | null;
}

export interface ServiceTargetConfig {
  expectStatus: number[] | null;
  interval_sec: number;
  timeout_ms: number;
}

export interface ServiceTarget {
  id: string;
  assetId: string;
  source: string;
  form: string;
  enabled: boolean;
  nextRunAt: number;
  config: ServiceTargetConfig;
}

export interface ServiceCheck {
  targetId: string;
  at: number;
  ok: boolean;
  latencyMs: number | null;
  errorKind: string | null;
}

export interface ServiceDto {
  id: string;
  slug: string;
  name: string;
  kind: string;
  group: string | null;
  ownerEmail: string | null;
  tags: string | null;
  repo: string | null;
  notes: string | null;
  enabled: boolean;
  createdAt: number;
}

export interface ServiceDetail {
  service: ServiceDto;
  targets: ServiceTarget[];
  recentChecks: ServiceCheck[];
}

interface ServiceRow {
  asset_id: string;
  slug: string;
  name: string;
  grp: string | null;
  target_id: string | null;
  last_ok: number | null;
  last_latency_ms: number | null;
  open_target: string | null;
  last_ok_at: number | null;
  ok_24h: number;
  fail_24h: number;
}

// 每行 = 一个 (asset, enabled target)；asset 没有 enabled target 时 target 列全为 null。
// last_ok_at / ok_24h / fail_24h 都是按 target 的相关子查询：走 target 索引，避免先拉全表
// checks_raw 再在 Worker 里聚合。
const LIST_SQL = `
  SELECT
    a.id AS asset_id, a.slug, a.name, a.grp,
    t.id AS target_id,
    lc.ok AS last_ok, lc.latency_ms AS last_latency_ms,
    oi.target_id AS open_target,
    (SELECT MAX(c2.at) FROM checks_raw c2 WHERE c2.target_id = t.id AND c2.ok = 1) AS last_ok_at,
    (SELECT COALESCE(SUM(r.ok_count), 0) FROM checks_rollup r
      WHERE r.target_id = t.id AND r.bucket_min >= ?) AS ok_24h,
    (SELECT COALESCE(SUM(r.fail_count), 0) FROM checks_rollup r
      WHERE r.target_id = t.id AND r.bucket_min >= ?) AS fail_24h
  FROM assets a
  LEFT JOIN targets t ON t.asset_id = a.id AND t.enabled = 1
  LEFT JOIN checks_raw lc ON lc.id = (
    SELECT c.id FROM checks_raw c WHERE c.target_id = t.id ORDER BY c.at DESC, c.id DESC LIMIT 1
  )
  LEFT JOIN (
    SELECT DISTINCT target_id FROM incidents WHERE closed_at IS NULL
  ) oi ON oi.target_id = t.id
  WHERE a.kind = 'service' AND a.enabled = 1
  ORDER BY a.grp, a.name, t.id
`;

function targetStatus(row: ServiceRow): Status {
  if (row.open_target !== null) return 'down';
  if (row.last_ok === null) return 'unknown';
  return row.last_ok === 1 ? 'ok' : 'suspect';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function listServiceSummaries(env: Env): Promise<ServiceSummary[]> {
  const sinceBucket = Math.floor(Date.now() / MINUTE_MS) - DAY_BUCKETS;
  const { results } = await env.DB.prepare(LIST_SQL)
    .bind(sinceBucket, sinceBucket)
    .all<ServiceRow>();

  const order: string[] = [];
  const acc = new Map<
    string,
    { summary: ServiceSummary; rank: number; ok: number; fail: number; lastOkAt: number | null }
  >();

  for (const row of results) {
    let entry = acc.get(row.asset_id);
    if (!entry) {
      entry = {
        summary: {
          slug: row.slug,
          name: row.name,
          group: row.grp,
          status: 'unknown',
          latencyMs: null,
          uptime24h: null,
          lastOkAt: null,
        },
        rank: SEVERITY.unknown,
        ok: 0,
        fail: 0,
        lastOkAt: null,
      };
      acc.set(row.asset_id, entry);
      order.push(row.asset_id);
    }

    // target 列为 null：该 asset 没有 enabled target，状态保持 unknown。
    if (row.target_id === null) continue;

    entry.ok += Number(row.ok_24h ?? 0);
    entry.fail += Number(row.fail_24h ?? 0);
    if (row.last_ok_at !== null && (entry.lastOkAt === null || row.last_ok_at > entry.lastOkAt)) {
      entry.lastOkAt = row.last_ok_at;
    }

    const status = targetStatus(row);
    const rank = SEVERITY[status];
    if (rank < entry.rank) {
      entry.rank = rank;
      entry.summary.status = status;
      entry.summary.latencyMs = status === 'unknown' ? null : (row.last_latency_ms ?? null);
    }
  }

  return order.map((assetId) => {
    const entry = acc.get(assetId);
    if (!entry) throw new Error(`service summary missing for asset ${assetId}`);
    const total = entry.ok + entry.fail;
    entry.summary.uptime24h = total > 0 ? round2((entry.ok / total) * 100) : null;
    entry.summary.lastOkAt = entry.lastOkAt;
    return entry.summary;
  });
}

function toServiceDto(a: AssetRow): ServiceDto {
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    kind: a.kind,
    group: a.grp,
    ownerEmail: a.owner_email,
    tags: a.tags,
    repo: a.repo,
    notes: a.notes,
    enabled: a.enabled === 1,
    createdAt: a.created_at,
  };
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // config 损坏时按空对象处理，详情页仍要能打开（探测侧会单独报错）。
  }
  return {};
}

function toTargetDto(t: TargetRow): ServiceTarget {
  const cfg = parseConfig(t.config);
  const expectStatus = Array.isArray(cfg.expectStatus)
    ? cfg.expectStatus.filter((v): v is number => typeof v === 'number')
    : null;

  return {
    id: t.id,
    assetId: t.asset_id,
    source: t.source,
    form: t.form,
    enabled: t.enabled === 1,
    nextRunAt: t.next_run_at,
    // 白名单：config 里其余字段（headers / token / body）一律不出网。
    config: {
      expectStatus,
      interval_sec: t.interval_sec,
      timeout_ms: t.timeout_ms,
    },
  };
}

function toCheckDto(row: CheckRow): ServiceCheck {
  return {
    targetId: row.target_id,
    at: row.at,
    ok: row.ok === 1,
    latencyMs: row.latency_ms ?? null,
    errorKind: row.error_kind ?? null,
  };
}

export async function getServiceDetail(env: Env, slug: string): Promise<ServiceDetail | null> {
  const asset = await getAssetBySlug(env.DB, slug);
  if (!asset) return null;

  const { results: targetRows } = await env.DB.prepare(
    `SELECT * FROM targets WHERE asset_id = ? ORDER BY id`,
  )
    .bind(asset.id)
    .all<TargetRow>();

  let recentChecks: ServiceCheck[] = [];
  if (targetRows.length > 0) {
    const placeholders = targetRows.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, target_id, at, ok, latency_ms, error_kind
         FROM checks_raw
        WHERE target_id IN (${placeholders})
        ORDER BY at DESC, id DESC
        LIMIT ?`,
    )
      .bind(...targetRows.map((t) => t.id), RECENT_CHECKS_LIMIT)
      .all<CheckRow>();
    recentChecks = results.map(toCheckDto);
  }

  return {
    service: toServiceDto(asset),
    targets: targetRows.map(toTargetDto),
    recentChecks,
  };
}

export const servicesApi = new Hono<{ Bindings: Env; Variables: Vars }>();

servicesApi.get('/', gate('owner', 'ops', 'viewer'), async (c) =>
  c.json(await listServiceSummaries(c.env)),
);

servicesApi.get('/:slug', gate('owner', 'ops', 'viewer'), async (c) => {
  const detail = await getServiceDetail(c.env, c.req.param('slug'));
  if (!detail) return c.json({ error: 'not_found' }, 404);
  return c.json(detail);
});
