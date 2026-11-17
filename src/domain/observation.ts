// 领域类型：探测输入值。纯数据，无 DB / 网络依赖。
// 契约字段即使是 P0 暂不消费的（metrics）也保留，避免下游探测源各自扩展类型。

export type SourceKind = 'http' | 'tcp' | 'dns' | 'tls' | 'cloudflare' | 'agent';

export type ErrorKind = 'timeout' | 'dns' | 'tls' | 'status' | 'refused' | 'auth';

export interface Observation {
  targetId: string;
  at: number;
  ok: boolean;
  latencyMs?: number;
  metrics?: Record<string, number>;
  detail?: unknown;
  errorKind?: ErrorKind;
}

export interface Target {
  id: string;
  source: SourceKind;
  form: string;
  config: Record<string, unknown>;
  timeoutMs: number;
}
