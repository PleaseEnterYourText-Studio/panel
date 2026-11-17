// source 分派：P0 只实现 http，其余 source（tcp / dns / tls / cloudflare / agent）
// 显式抛 UnsupportedSourceError，而不是静默返回一个 unknown Observation ——
// 静默兜底会让调度器把「没实现」当成「探测失败」，误开 incident。

import type { Observation, Target } from '../domain/observation';
import { probeHttp, type ProbeDeps } from './http';

export class UnsupportedSourceError extends Error {
  readonly source: string;

  constructor(source: string) {
    super(`source not implemented in P0: ${source}`);
    this.name = 'UnsupportedSourceError';
    this.source = source;
  }
}

export async function resolveSource(target: Target, deps: ProbeDeps): Promise<Observation> {
  if (target.source === 'http') return probeHttp(target, deps);
  throw new UnsupportedSourceError(target.source);
}

export type { ProbeDeps };
