// 从历史重建故障状态机：调度器每个 tick 都是无状态的（Cron 里没有常驻内存），
// 所以「当前是第几次连续失败 / 成功」只能从 checks_raw + 未关闭 incident 里推回来。
//
// 为什么不能每 tick 从 initial() 播种：那样 failStreak 每次都是 1，阈值 3 永远到不了，
// down 永远不会触发。必须先从最近的历史折叠出机器状态，再把本次 observation step 一次。
//
// 有未关闭 incident 时，把 down 当作「地基」而不是「最终值」：
//   machine = { down, FAIL_THRESHOLD, 0 }，再把最近历史按时间正序折叠上去。
// 只把 down 直接返回会死锁恢复：okStreak 每 tick 都被重置为 0，单次成功永远到不了
// 阈值 2，incident 永远关不掉（恢复用例直接失败）。折叠历史让连续成功跨 tick 累积：
//   - 历史里已有 1 次成功 → 折出 down / okStreak 1 → 本次再成功一次就恢复；
//   - 历史被清理成空 → 仍从 down / 饱和 failStreak 起步，不会「忘掉」已确认故障；
//   - 历史里是失败 → down 粘性保持，不会被单次失败降级。
//
// 约定：
// - recentDesc 是「新 → 旧」顺序（与 `SELECT ... ORDER BY at DESC LIMIT n` 一致），
//   函数内部反转后按时间正序折叠，调用方不要提前反转。

import { FAIL_THRESHOLD, initial, step, type Machine } from '../domain/incident';

/** 重建状态机时向前看的 check 条数（= FAIL_THRESHOLD + OK_THRESHOLD，覆盖最长收敛路径）。 */
export const RECENT_HISTORY = 5;

export function rebuildMachine(recentDesc: { ok: number }[], hasOpenIncident: boolean): Machine {
  let machine: Machine = hasOpenIncident
    ? { state: 'down', failStreak: FAIL_THRESHOLD, okStreak: 0 }
    : initial();

  for (const row of [...recentDesc].reverse()) {
    machine = step(machine, row.ok === 1);
  }
  return machine;
}
