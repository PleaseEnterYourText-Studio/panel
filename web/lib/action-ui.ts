/**
 * 动作区的可点性判定（规格 §10.3 硬规则 1 / 6）：
 *   - 规则 1：不可点的动作必须一眼看出来，不能「点了才知道不行」。
 *   - 规则 6：动作有可见的生命周期（pending → ok / error），不能点完毫无反馈。
 *
 * 判定纯函数，组件只负责把 reason 渲染成 disabled + title（+ 可见原因文案）。
 */

import { isEnabled, type ActionDef } from '../../src/domain/action';

export interface ActionContext {
  /** 所属 asset 是否启用；停用服务的探测会真的打出去，必须在入口挡住。 */
  serviceEnabled: boolean;
  enabledTargetCount: number;
  /** 当前是否有动作在执行。 */
  busy: boolean;
}

/** 返回不可点原因；null = 可点。 */
export function actionDisabledReason(action: ActionDef, ctx: ActionContext): string | null {
  if (!isEnabled(action)) return 'P3 提供';
  if (ctx.busy) return '正在执行';
  if (action.id === 'probe.run') {
    if (!ctx.serviceEnabled) return '服务已停用';
    if (ctx.enabledTargetCount === 0) return '无启用的检查目标';
  }
  return null;
}

/** 按钮文案：执行中要让人看见 pending，而不是只剩一个灰按钮。 */
export function actionButtonText(action: ActionDef, ctx: ActionContext): string {
  if (ctx.busy && action.id === 'probe.run') return `${action.label} · 执行中…`;
  return action.label;
}
