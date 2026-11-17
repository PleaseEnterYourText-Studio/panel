import { describe, expect, it } from 'vitest';
import { badgeText } from '../web/components/StatusBadge';
import { formatAgo, formatClock, formatLatency, formatMinute, formatUptime } from '../web/lib/format';
import { actionButtonText, actionDisabledReason } from '../web/lib/action-ui';
import { ACTIONS } from '../src/domain/action';
import { countStatuses, deriveServiceStatus } from '../web/lib/status';
import type { ServiceCheck, ServiceTarget } from '../web/lib/api';
import servicesSource from '../web/routes/Services.tsx?raw';
import detailSource from '../web/routes/ServiceDetail.tsx?raw';
import apiSource from '../web/lib/api.ts?raw';
import tokensCss from '../web/tokens.css?raw';

// 组件行为靠纯函数与源码断言守卫：P0 没装 @testing-library，渲染测试的收益
// 抵不上多一套 DOM 依赖；这里锁的是「删掉就坏」的那几行。

describe('StatusBadge', () => {
  it('labels every state with text and shape, not only color', () => {
    expect(badgeText('ok')).toBe('● OK');
    expect(badgeText('suspect')).toBe('▲ 疑似');
    expect(badgeText('down')).toBe('✕ 故障');
    expect(badgeText('unknown')).toBe('○ 无数据');
  });
});

describe('服务列表页契约', () => {
  it('polls /api/services every 30 seconds', () => {
    expect(servicesSource).toContain('/api/services');
    expect(servicesSource).toContain('setInterval');
    expect(servicesSource).toContain('30_000');
  });

  it('shows the last refresh clock instead of faking curves', () => {
    expect(servicesSource).toContain('最近一次刷新');
    expect(servicesSource).not.toContain('Sparkline');
    expect(servicesSource).not.toContain('UptimeBar');
  });

  it('renders every required column and the empty state', () => {
    for (const header of ['服务', '分组', '状态', '延迟', '24h 可用率', '最近成功']) {
      expect(servicesSource).toContain(header);
    }
    expect(servicesSource).toContain('还没有服务，先录入一台');
  });
});

describe('服务详情页契约', () => {
  it('keeps phase 3 actions disabled with a P3 badge', () => {
    expect(detailSource).toContain('P3');
    expect(detailSource).toContain('disabled');
  });

  it('imports the action contract instead of hardcoding buttons', () => {
    expect(detailSource).toContain('src/domain/action');
    expect(detailSource).toContain('isEnabled');
  });

  it('handles 404 without a blank page', () => {
    expect(detailSource).toContain('服务不存在');
    expect(detailSource).toMatch(/404/);
  });

  it('marks P1 tabs explicitly', () => {
    expect(detailSource).toContain('P1 提供');
  });

  // 规格 §10.3 规则 1：不可点的动作不能「点了才知道」，必须给出可见原因。
  it('explains why an action is not clickable', () => {
    expect(detailSource).toContain('服务已停用');
    expect(detailSource).toContain('无启用的检查目标');
    expect(detailSource).toContain('正在执行');
  });

  // 规格 §10.3 规则 6：pending → ok。执行中要有文案，成功要有带时间戳的终态提示。
  it('shows pending and success feedback for probe.run', () => {
    expect(detailSource).toContain('执行中');
    expect(detailSource).toContain('已探测');
    expect(detailSource).toContain('最近一次成功');
    // 停用服务不得再发探测：runProbe 里必须有 service.enabled 闸门。
    expect(detailSource).toMatch(/!service\.enabled/);
  });

  it('aligns the down counter with the header badge', () => {
    expect(detailSource).toContain('displayCounts');
  });
});

describe('api client non-JSON guard', () => {
  it('inspects content-type before parsing and keeps the status', () => {
    expect(apiSource).toContain('content-type');
    expect(apiSource).toContain('ApiError');
    expect(apiSource).toContain('204');
  });
});

describe('design token regressions', () => {
  it('keeps the section font size and the fixed card divider rule', () => {
    expect(tokensCss).toContain('--fs-section');
    expect(tokensCss).toContain('.card > .h + .r');
    expect(tokensCss).not.toContain('.card > .r:first-child');
    expect(tokensCss).toContain('--row-danger');
  });
});

function target(id: string, enabled = true): ServiceTarget {
  return {
    id,
    assetId: 'asset-1',
    source: 'http',
    form: 'status',
    enabled,
    nextRunAt: 0,
    config: { expectStatus: null, interval_sec: 60, timeout_ms: 5000 },
  };
}

function check(targetId: string, ok: boolean): ServiceCheck {
  return { targetId, at: 1_700_000_000_000, ok, latencyMs: 12, errorKind: ok ? null : 'timeout' };
}

describe('状态推导', () => {
  it('takes the worst target status', () => {
    const targets = [target('a'), target('b')];
    expect(deriveServiceStatus(targets, [check('a', true), check('b', false)])).toBe('suspect');
    expect(deriveServiceStatus(targets, [check('a', true), check('b', true)])).toBe('ok');
  });

  it('is unknown when there is no check at all', () => {
    expect(deriveServiceStatus([target('a')], [])).toBe('unknown');
  });

  it('counts disabled targets as unknown instead of guessing', () => {
    const counts = countStatuses([target('a'), target('b', false)], [check('a', true)]);
    expect(counts.ok).toBe(1);
    expect(counts.unknown).toBe(1);
    expect(counts.suspect).toBe(0);
    expect(counts.down).toBe(0);
  });
});

describe('动作可点性（§10.3 规则 1 / 6）', () => {
  const probe = ACTIONS.find((a) => a.id === 'probe.run')!;
  const restart = ACTIONS.find((a) => a.id === 'service.restart')!;

  it('blocks probe.run when the service is disabled and says why', () => {
    expect(actionDisabledReason(probe, { serviceEnabled: false, enabledTargetCount: 2, busy: false })).toBe(
      '服务已停用',
    );
  });

  it('blocks probe.run when there is no enabled target and says why', () => {
    expect(actionDisabledReason(probe, { serviceEnabled: true, enabledTargetCount: 0, busy: false })).toBe(
      '无启用的检查目标',
    );
  });

  it('reports pending while busy and P3 for phase 3 actions', () => {
    expect(actionDisabledReason(probe, { serviceEnabled: true, enabledTargetCount: 1, busy: true })).toBe(
      '正在执行',
    );
    expect(actionDisabledReason(restart, { serviceEnabled: true, enabledTargetCount: 1, busy: false })).toBe(
      'P3 提供',
    );
    expect(actionButtonText(probe, { serviceEnabled: true, enabledTargetCount: 1, busy: true })).toContain(
      '执行中',
    );
  });

  it('is clickable when everything is healthy', () => {
    expect(actionDisabledReason(probe, { serviceEnabled: true, enabledTargetCount: 1, busy: false })).toBeNull();
  });
});

describe('展示格式化', () => {
  it('renders a dash for missing data, never a fake number', () => {
    expect(formatLatency(null)).toBe('—');
    expect(formatUptime(null)).toBe('—');
    expect(formatClock(null)).toBe('—');
    expect(formatAgo(null, 0)).toBe('—');
  });

  it('formats latency, uptime and relative time', () => {
    expect(formatLatency(12.4)).toBe('12ms');
    expect(formatUptime(99.95)).toBe('99.95%');
    expect(formatAgo(Date.now() - 5 * 60_000, Date.now())).toBe('5 分钟前');
    expect(formatMinute(null)).toBe('—');
  });

  it('shows a dash for future timestamps instead of "刚刚"', () => {
    const now = Date.now();
    // 客户端时钟领先服务端：负数差值不能圆成「刚刚」。
    expect(formatAgo(now + 30_000, now)).toBe('—');
  });
});
