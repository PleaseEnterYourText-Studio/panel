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
    const m = initial();
    expect(m.failStreak).toBe(0);
    expect(m.okStreak).toBe(0);
    expect(toStatus(m)).toBe('unknown');
  });

  // unknown 不等于 ok：首次成功不能让新 target 宣称正常。
  it('reports suspect after the first success from unknown', () => {
    const m = step(initial(), true);
    expect(m.okStreak).toBe(1);
    expect(toStatus(m)).toBe('suspect');
  });

  it('reaches ok from unknown with two consecutive successes', () => {
    const m = step(step(initial(), true), true);
    expect(m.okStreak).toBe(2);
    expect(toStatus(m)).toBe('ok');
  });

  it('drops ok to suspect on a single failure', () => {
    const ok = step(step(initial(), true), true);
    const m = step(ok, false);
    expect(m.failStreak).toBe(1);
    expect(toStatus(m)).toBe('suspect');
  });

  // down 是粘性状态：已确认的故障只能靠连续 2 次成功解除。
  // 否则「成功一次把 failStreak 清零 → 再失败一次」会把故障降级成 suspect，
  // 下游会当成新故障，产生重复 incident.opened。
  it('keeps down when a recovery attempt is interrupted by a failure', () => {
    let m: Machine = { state: 'down', failStreak: 3, okStreak: 0 };
    m = step(m, true);
    expect(m.state).toBe('down');
    expect(m.okStreak).toBe(1);
    const interrupted = step(m, false);
    expect(interrupted.state).toBe('down'); // 不掉回 suspect
    expect(interrupted.failStreak).toBe(1);
    // 恢复进度被清零，必须重新攒满 2 次成功。
    const again = step(interrupted, true);
    expect(again.state).toBe('down');
    expect(again.okStreak).toBe(1);
    expect(step(again, true).state).toBe('ok');
  });

  it('clamps the failure streak at the threshold', () => {
    let m = initial();
    m = step(m, false);
    m = step(m, false);
    m = step(m, false);
    expect(m.state).toBe('down');
    expect(m.failStreak).toBe(3);
    m = step(m, false);
    expect(m.state).toBe('down'); // 第 4 次失败不产生第二次 down 进入
    expect(m.failStreak).toBe(3); // clamp，避免持久化后数值漂到无穷大
  });
});
