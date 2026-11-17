// Action 契约（规格 §10.3）：UI 与 API 共用同一份动作声明，组件里不允许临时拼按钮行为。
//
// 两条职责必须分开，混在一起就是这一期最容易出的 bug：
//   - 过滤职责（actionsFor）：决定「谁能看到这个按钮」——按 roles 过滤。
//   - 禁用职责（isEnabled）：决定「按钮能不能点」——按 phase 判断。
// 典型例子：viewer 能看见 `service.logs`（danger='none'，roles 含 viewer），
// 但它是 phase 3，所以可见且禁用，UI 显示 P3 徽章。**因此 viewer 的过滤条件
// 不能只看 danger。**
//
// P0 只有 `probe.run`（phase 1）真正可用；其余动作全部 phase 3，只做声明与禁用，
// 执行路径由 UnavailableChannel 承接（API 返回 501，见规格 §10.3）。

import type { Identity } from '../auth/identity';

export type Danger = 'none' | 'confirm' | 'typed';

export interface ActionDef {
  id: string;
  label: string;
  roles: Identity['role'][];
  /** 1 = 本阶段真正可用；3 = 仅声明，UI 禁用 + P3 徽章。 */
  phase: 1 | 3;
  danger: Danger;
  reversible: boolean;
}

export const ACTIONS: ActionDef[] = [
  { id: 'probe.run', label: '立即探测', roles: ['owner', 'ops'], phase: 1, danger: 'none', reversible: true },
  { id: 'service.restart', label: '重启服务', roles: ['owner', 'ops'], phase: 3, danger: 'confirm', reversible: true },
  { id: 'service.logs', label: '查看日志', roles: ['owner', 'ops', 'viewer'], phase: 3, danger: 'none', reversible: true },
  { id: 'agent.restart', label: '重启 agent', roles: ['owner'], phase: 3, danger: 'typed', reversible: false },
];

// 过滤：谁能看到按钮。
// - owner / ops：看到 roles 含自己的全部动作（含 phase 3，UI 要显示 P3 徽章）。
// - viewer：只看到 danger === 'none' 且 roles 含 viewer 的动作（read-only 角色）。
export function actionsFor(role: Identity['role']): ActionDef[] {
  if (role === 'viewer') {
    return ACTIONS.filter((a) => a.danger === 'none' && a.roles.includes('viewer'));
  }
  return ACTIONS.filter((a) => a.roles.includes(role));
}

// 禁用：按钮能不能点。P0 没有任何 phase 3 动作可用。
export function isEnabled(action: ActionDef): boolean {
  return action.phase === 1;
}

// CommandChannel 接缝（规格 §10.3 / §6.4）：P0 全部 phase 3 动作由此承接。
// verb 是白名单联合类型，不是 string——dispatch 的调用点因此无法拼出未声明的命令。
export type AllowedVerb =
  | 'service.restart'
  | 'service.status'
  | 'docker.logs'
  | 'docker.restart'
  | 'deploy.pull'
  | 'disk.usage'
  | 'check.health';

export interface CommandReceipt {
  id: string;
  verb: AllowedVerb;
  acceptedAt: number;
}

export interface CommandChannel {
  dispatch(
    actorId: string,
    serverId: string,
    verb: AllowedVerb,
    args: unknown,
  ): Promise<CommandReceipt>;
}

export class CommandNotAvailableError extends Error {
  constructor() {
    super('command channel is not available until phase 3');
    this.name = 'CommandNotAvailableError';
  }
}

export class UnavailableChannel implements CommandChannel {
  async dispatch(): Promise<never> {
    throw new CommandNotAvailableError();
  }
}
