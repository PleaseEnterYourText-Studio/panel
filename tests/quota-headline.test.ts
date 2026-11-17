import { describe, expect, it } from 'vitest';
import { overviewHeadline } from '../web/lib/quota';

// S1：0 个目标不能读成「全部正常」——空库恰恰是「一个都没监控」。
// 单独一个文件，让这条回归跟着 quota 的修复一起被 lock。
describe('概览主标题空库边界（S1）', () => {
  it('does not call an empty control plane healthy', () => {
    expect(overviewHeadline({ okCount: 0, suspectCount: 0, downCount: 0, unknownCount: 0 })).toBe(
      '尚未配置监控目标。',
    );
  });

  it('still calls a configured, healthy plane healthy', () => {
    // 边界：只有 ok 非零 → 真的是全部正常，不能被空库分支吃掉。
    expect(overviewHeadline({ okCount: 1, suspectCount: 0, downCount: 0, unknownCount: 0 })).toBe('全部正常。');
    expect(overviewHeadline({ okCount: 0, suspectCount: 0, downCount: 0, unknownCount: 0 })).not.toBe(
      '全部正常。',
    );
  });
});
