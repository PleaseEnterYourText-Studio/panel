import { useEffect, useState } from 'react';
import type { Overview as OverviewDto } from '../lib/api';
import { ApiError, get } from '../lib/api';
import { describeError, formatClock } from '../lib/format';
import { needsWriteWarning, overviewHeadline, quotaWarningText } from '../lib/quota';

/** 刷新节奏与服务列表一致：30 秒一次（cron 每分钟跑，人眼看着够用）。 */
const REFRESH_MS = 30_000;

interface OverviewState {
  data: OverviewDto | null;
  error: ApiError | Error | null;
  /** 最近一次成功刷新的时刻；只显示 HH:MM:SS。 */
  lastRefreshAt: number | null;
}

const CARDS: ReadonlyArray<{ key: keyof OverviewDto; label: string; color: string }> = [
  { key: 'okCount', label: '正常', color: 'var(--ok)' },
  { key: 'suspectCount', label: '疑似', color: 'var(--warn)' },
  { key: 'downCount', label: '故障', color: 'var(--danger)' },
  { key: 'unknownCount', label: '无数据', color: 'var(--muted)' },
];

/**
 * 概览页：结论式主标题 + 一行计数摘要 + 四张计数卡 + 写入额度预警。
 *
 * 不造假数据：lastTickAt 为 null 时写「还没有巡检记录」，不编时间；没有数据就显示空，
 * 不画曲线。错误态保留上一次成功的数据，错误单独一条（显示 HTTP status）。
 */
export function Overview() {
  const [state, setState] = useState<OverviewState>({ data: null, error: null, lastRefreshAt: null });

  useEffect(() => {
    let alive = true;

    const load = () => {
      get<OverviewDto>('/api/overview')
        .then((data) => {
          if (!alive) return;
          setState({ data, error: null, lastRefreshAt: Date.now() });
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setState((prev) => ({
            data: prev.data,
            error: e instanceof Error ? e : new Error(String(e)),
            lastRefreshAt: prev.lastRefreshAt,
          }));
        });
    };

    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const { data, error, lastRefreshAt } = state;

  const header = (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
      <h1 style={{ margin: 0 }}>概览</h1>
      <span className="num" style={{ color: 'var(--muted)', fontSize: 'var(--fs-table)' }}>
        最近一次刷新 {formatClock(lastRefreshAt)}
      </span>
    </div>
  );

  if (error && data === null) {
    return (
      <div>
        {header}
        <div className="card">
          <div className="h">加载失败</div>
          <div style={{ padding: 10 }}>{describeError(error)}</div>
        </div>
      </div>
    );
  }

  if (data === null) {
    return (
      <div>
        {header}
        <div style={{ color: 'var(--muted)' }}>加载中…</div>
      </div>
    );
  }

  const tick = data.lastTickAt === null ? '还没有巡检记录' : formatClock(data.lastTickAt);
  const headline = overviewHeadline(data);

  return (
    <div>
      {header}

      {error ? (
        <div className="card" style={{ marginBottom: 8, borderColor: 'var(--warn)' }}>
          <div className="h">刷新失败（显示的是上一次数据）</div>
          <div style={{ padding: 10 }}>{describeError(error)}</div>
        </div>
      ) : null}

      {needsWriteWarning(data.writeEstimate) ? (
        <div
          role="status"
          style={{
            marginBottom: 10,
            padding: '8px 10px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--warn)',
            background: 'var(--panel-2)',
            color: 'var(--warn)',
            fontSize: 'var(--fs-table)',
          }}
        >
          {quotaWarningText(data.writeEstimate)} ·{' '}
          <a href="/services" style={{ color: 'var(--accent)' }}>
            去服务页调整探测间隔
          </a>
        </div>
      ) : null}

      <h1 style={{ fontSize: 20, fontWeight: 600, margin: '4px 0 4px' }}>{headline}</h1>
      <div style={{ color: 'var(--muted)', marginBottom: 14, fontSize: 'var(--fs-table)' }}>
        {data.okCount} 正常 · {data.downCount} 故障 · {data.suspectCount} 疑似 · {data.unknownCount} 无数据 · 最近巡检 {tick}
        {' · '}每日写入估算 {data.writeEstimate.toLocaleString('en-US')} 行
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        {CARDS.map(({ key, label, color }) => (
          <div key={key} className="card" style={{ padding: '8px 10px' }}>
            <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-meta)' }}>{label}</div>
            <div className="num" style={{ fontSize: 22, color }}>
              {String(data[key])}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
