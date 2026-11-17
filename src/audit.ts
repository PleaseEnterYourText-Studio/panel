// 审计：把一次动作写成 events 表的一行。kind 固定前缀 action.<action>，
// payload 序列化后截断到 2000 字符 —— events 是长期表，单条 payload 不能失控。

import type { Env } from './env';
import { writeEvent } from './db/queries';

export const AUDIT_PAYLOAD_MAX = 2000;

export interface AuditInput {
  actor: string;
  action: string;
  assetId: string | null;
  payload: unknown;
  ip: string | null;
}

export function serializeAuditPayload(payload: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    // 循环引用等无法序列化的值：记 null，绝不让审计写失败拖垮业务请求。
    json = undefined;
  }
  // JSON.stringify(undefined) 返回 undefined（不是字符串），统一落成 'null'。
  return (json ?? 'null').slice(0, AUDIT_PAYLOAD_MAX);
}

export async function audit(env: Env, input: AuditInput): Promise<void> {
  await writeEvent(env.DB, {
    id: crypto.randomUUID(),
    at: Date.now(),
    kind: `action.${input.action}`,
    actor: input.actor,
    assetId: input.assetId,
    payload: serializeAuditPayload(input.payload),
    ip: input.ip,
  });
}
