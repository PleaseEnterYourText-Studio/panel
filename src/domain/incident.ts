// 故障状态机：纯函数，输入输出都是值，无 DB 依赖（规格 §9）。
// 收敛条件：连续 3 次失败 → down；连续 2 次成功才恢复 → ok。
// 从 unknown / suspect 起，1 次成功只到 suspect，不允许一次成功就宣称正常。

export type Status = 'ok' | 'suspect' | 'down' | 'unknown';

export interface Machine {
  state: Status;
  failStreak: number;
  okStreak: number;
}

const FAIL_THRESHOLD = 3;
const OK_THRESHOLD = 2;

export function initial(): Machine {
  return { state: 'unknown', failStreak: 0, okStreak: 0 };
}

export function step(m: Machine, ok: boolean): Machine {
  if (ok) {
    const okStreak = m.okStreak + 1;
    if (okStreak >= OK_THRESHOLD) return { state: 'ok', failStreak: 0, okStreak };
    // down 需要连续 2 次成功才解除；其余状态（unknown / suspect）先降到 suspect。
    return { state: m.state === 'down' ? 'down' : 'suspect', failStreak: 0, okStreak };
  }
  const failStreak = m.failStreak + 1;
  return {
    state: failStreak >= FAIL_THRESHOLD ? 'down' : 'suspect',
    failStreak,
    okStreak: 0,
  };
}

export function toStatus(m: Machine): Status {
  return m.state;
}
