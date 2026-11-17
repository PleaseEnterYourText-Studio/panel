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

/** 错误信息里保留的响应体片段长度：够定位是 Access 登录页还是 Worker 崩溃，不刷屏。 */
const BODY_SNIPPET = 200;

export class ApiError extends Error {
  readonly status: number;
  /** 响应体片段（最多 200 字）；无 body 的 204 / 空响应为 null。 */
  readonly body: string | null;

  constructor(method: string, path: string, status: number, body: string | null = null) {
    super(`${method} ${path} → ${status}${body ? `: ${body}` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** 读文本片段；读失败也返回 null，错误路径上不能再抛第二个错。 */
async function snippet(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    const trimmed = text.trim();
    return trimmed === '' ? null : trimmed.slice(0, BODY_SNIPPET);
  } catch {
    return null;
  }
}

function isJsonContentType(res: Response): boolean {
  // 注意：先看 content-type，不能直接 res.json()。Cloudflare Access 未登录时
  // 返回 text/html 的登录页，裸 res.json() 会抛 SyntaxError，调用方就拿不到
  // status，错误态只能显示 "Unexpected token '<'"。
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  return contentType.includes('application/json');
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

  // 204 / 空 body：没有可解析的内容，调用方按 undefined 处理。
  if (res.status === 204) return undefined as T;

  if (!res.ok) throw new ApiError(method, url, res.status, await snippet(res));

  if (!isJsonContentType(res)) {
    // 2xx 但不是 JSON：多半是被 Access 拦下或 SPA fallback 返回了 index.html。
    // 抛 ApiError 而不是 SyntaxError，页面才能显示 status。
    throw new ApiError(method, url, res.status, await snippet(res));
  }

  return (await res.json()) as T;
}

export function get<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

export const api = { get, post };
