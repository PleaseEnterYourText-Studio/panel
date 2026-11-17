/**
 * 后端 DTO 的唯一前端副本。字段名必须与 src/api/*.ts 一致：
 * - /api/overview  → Overview
 * - /api/services  → ServiceSummary[]
 * - /api/services/:slug → ServiceDetail
 *
 * 请求路径一律走 /api/ 前缀；带不带前缀都能调用，归一化在这里做，调用方不用记。
 */

const API_PREFIX = '/api/';

export type Status = 'ok' | 'suspect' | 'down' | 'unknown';

export interface Overview {
  okCount: number;
  suspectCount: number;
  downCount: number;
  unknownCount: number;
  /** checks_raw 最新一条 check 的时间；空表为 null。 */
  lastTickAt: number | null;
  /** 每日写入估算。 */
  writeEstimate: number;
}

export interface ServiceSummary {
  slug: string;
  name: string;
  group: string | null;
  status: Status;
  latencyMs: number | null;
  /** 24h 可用率，百分比 0–100；无数据为 null。 */
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

export class ApiError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number) {
    super(`${method} ${path} → ${status}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

function apiPath(path: string): string {
  if (path === '/api' || path.startsWith(API_PREFIX)) return path;
  return API_PREFIX + path.replace(/^\/+/, '');
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = apiPath(path);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) throw new ApiError(method, url, res.status);
  return (await res.json()) as T;
}

export function get<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

export const api = { get, post };
