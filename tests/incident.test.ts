import { describe, it, expect } from 'vitest';
import { step, initial, toStatus, type Machine } from '../src/domain/incident';

describe('incident state machine', () => {
  it('needs three consecutive failures to confirm down', () => {
    let m = initial();
    m = step(m, false);
    expect(m.state).toBe('suspect');
    m = step(m, false);
    expect(m.state).toBe('suspect');
    m = step(m, false);
    expect(m.state).toBe('down');
  });

  it('needs two consecutive successes to recover', () => {
    let m: Machine = { state: 'down', failStreak: 3, okStreak: 0 };
    m = step(m, true);
    expect(m.state).toBe('down');
    m = step(m, true);
    expect(m.state).toBe('ok');
  });

  // 规格 §9：恢复需要「2 次连续成功」。brief 原断言一次成功即 ok 与规格冲突，
  // 按控制器裁定以规格为准。
  it('resets failure streak on success', () => {
    let m = step(step(initial(), false), false);
    m = step(m, true);
    expect(m.failStreak).toBe(0);
    expect(toStatus(m)).toBe('suspect'); // 1 次成功还不足以恢复
    m = step(m, true);
    expect(toStatus(m)).toBe('ok'); // 连续 2 次成功才恢复
  });

  it('reports unknown before any observation', () => {
    expect(toStatus(initial())).toBe('unknown');
  });

  // unknown 不等于 ok：首次成功不能让新 target 宣称正常。
  it('reports suspect after the first success from unknown', () => {
    const m = step(initial(), true);
    expect(m.okStreak).toBe(1);
    expect(toStatus(m)).toBe('suspect');
  });
});
