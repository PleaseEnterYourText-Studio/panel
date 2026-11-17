// 故障状态机：纯函数，输入输出都是值，无 DB 依赖（规格 §9）。
// 收敛条件：连续 3 次失败 → down；连续 2 次成功才恢复 → ok。
// 从 unknown / suspect 起，1 次成功只到 suspect，不允许一次成功就宣称正常。
//
// 不变量（Invariants）：
// - 只能通过 step() 演进，禁止手改 state 字段；state 是下游 UI / incident 开关的依据，
//   手改会让 state 与两个 streak 自相矛盾。
// - state === 'ok' 蕴含 okStreak >= 2：ok 只能经连续 2 次成功进入。
// - state === 'down' 期间 failStreak 可能为 0（恢复中）：恢复尝试会把 failStreak 清零，
//   这是刻意的——failStreak 记录的是「最近一次失败起的连续失败数」，不记录历史故障。
// - down 是粘性状态，只能被连续 2 次成功解除。单次失败不会把 down 降级回 suspect，
//   否则已确认的故障会被「忘掉」，下游会当成新故障重复开 incident。
// - failStreak / okStreak 都 clamp 在各自阈值，避免持久化后无界增长。

export type Status = 'ok' | 'suspect' | 'down' | 'unknown';

export interface Machine {
  state: Status;
  failStreak: number;
  okStreak: number;
}

// 导出阈值：调度器从历史重建状态机时需要用 FAIL_THRESHOLD 给「有未关闭 incident」
// 的机器补一个饱和计数，不能把 3 抄成第二个魔数。
export const FAIL_THRESHOLD = 3;
export const OK_THRESHOLD = 2;

export function initial(): Machine {
  return { state: 'unknown', failStreak: 0, okStreak: 0 };
}

export function step(m: Machine, ok: boolean): Machine {
  if (ok) {
    const okStreak = Math.min(m.okStreak + 1, OK_THRESHOLD);
    if (okStreak >= OK_THRESHOLD) return { state: 'ok', failStreak: 0, okStreak };
    // down 需要连续 2 次成功才解除；其余状态（unknown / suspect）先降到 suspect。
    return { state: m.state === 'down' ? 'down' : 'suspect', failStreak: 0, okStreak };
  }
  const failStreak = Math.min(m.failStreak + 1, FAIL_THRESHOLD);
  // down 粘性：已确认故障不被单次失败降级，只有连续 2 次成功能离开。
  if (m.state === 'down') return { state: 'down', failStreak, okStreak: 0 };
  return {
    state: failStreak >= FAIL_THRESHOLD ? 'down' : 'suspect',
    failStreak,
    okStreak: 0,
  };
}

export function toStatus(m: Machine): Status {
  return m.state;
}
