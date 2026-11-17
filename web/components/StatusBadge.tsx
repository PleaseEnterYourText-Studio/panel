import type { Status } from '../lib/api';

/**
 * 状态徽章：颜色 + 文字 + 形状三重编码。
 *
 * 只靠颜色在色觉障碍下会丢信息，所以每种状态都带不同的字形：
 *   ● 实心圆（ok） / ▲ 三角（suspect） / ✕ 叉（down） / ○ 空心圆（unknown）。
 * aria-label 给出完整中文状态，读屏用户不依赖字形。
 */
export function badgeText(status: Status): string {
  switch (status) {
    case 'ok':
      return '● OK';
    case 'suspect':
      return '▲ 疑似';
    case 'down':
      return '✕ 故障';
    case 'unknown':
      return '○ 无数据';
  }
}

const STATUS_LABEL: Record<Status, string> = {
  ok: '正常',
  suspect: '疑似异常',
  down: '故障',
  unknown: '无数据',
};

const STATUS_COLOR: Record<Status, string> = {
  ok: 'var(--ok)',
  suspect: 'var(--warn)',
  down: 'var(--danger)',
  unknown: 'var(--muted)',
};

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      role="img"
      aria-label={`状态：${STATUS_LABEL[status]}`}
      title={STATUS_LABEL[status]}
      style={{ color: STATUS_COLOR[status], fontSize: 'var(--fs-table)', whiteSpace: 'nowrap' }}
    >
      {badgeText(status)}
    </span>
  );
}
