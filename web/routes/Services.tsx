import { useEffect, useState } from 'react';
import type { ServiceSummary } from '../lib/api';
import { ApiError, get } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import {
  describeError,
  formatAgo,
  formatClock,
  formatDateTime,
  formatLatency,
  formatUptime,
} from '../lib/format';

/** 刷新节奏：P0 用轮询，30 秒一次（调度器 cron 也是每分钟；列表停留期间人眼够用）。 */
const REFRESH_MS = 30_000;

interface ListState {
  rows: ServiceSummary[] | null;
  error: ApiError | Error | null;
  /** 最近一次成功刷新的时刻；只显示 HH:MM:SS，完整时间进 title。 */
  lastRefreshAt: number | null;
}

/**
 * 服务列表。列：服务 / 分组 / 状态 / 延迟 / 24h 可用率 / 最近成功。
 *
 * P0 的 /api/services 不返回分桶数据，所以这里不画折线、不画可用率条——
 * 没有数据就渲染「—」，不造曲线（假数据比空表更糟）。
 * 异常行（suspect / down）整行淡红底，颜色只是辅助，状态列有文字 + 字形。
 */
export function Services() {
  const [state, setState] = useState<ListState>({ rows: null, error: null, lastRefreshAt: null });

  useEffect(() => {
    let alive = true;

    const load = () => {
      get<ServiceSummary[]>('/api/services')
        .then((rows) => {
          if (!alive) return;
          setState({ rows, error: null, lastRefreshAt: Date.now() });
        })
        .catch((e: unknown) => {
          if (!alive) return;
          // 保留上一次的行（有数据时不清空），错误单独展示。
          setState((prev) => ({
            rows: prev.rows,
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

  const { rows, error, lastRefreshAt } = state;
  const header = (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
      <h1 style={{ margin: 0 }}>服务</h1>
      <span className="num" style={{ color: 'var(--muted)', fontSize: 'var(--fs-table)' }}>
        最近一次刷新 {formatClock(lastRefreshAt)}
      </span>
    </div>
  );

  if (error && rows === null) {
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

  if (rows === null) {
    return (
      <div>
        {header}
        <div style={{ color: 'var(--muted)' }}>加载中…</div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div>
        {header}
        <div className="card">
          <div className="h">还没有服务</div>
          <div style={{ padding: 10 }}>还没有服务，先录入一台</div>
        </div>
      </div>
    );
  }

  const now = Date.now();

  return (
    <div>
      {header}
      {error ? (
        <div className="card" style={{ marginBottom: 8, borderColor: 'var(--warn)' }}>
          <div className="h">刷新失败（显示的是上一次数据）</div>
          <div style={{ padding: 10 }}>{describeError(error)}</div>
        </div>
      ) : null}
      <div className="card">
        <div className="h">
          服务 · {rows.length}
          <span className="pill" style={{ marginLeft: 8 }}>
            30s 轮询
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>服务</th>
              <th>分组</th>
              <th>状态</th>
              <th style={{ textAlign: 'right' }}>延迟</th>
              <th style={{ textAlign: 'right' }}>24h 可用率</th>
              <th>最近成功</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const abnormal = row.status === 'suspect' || row.status === 'down';
              return (
                <tr
                  key={row.slug}
                  style={abnormal ? { background: 'var(--row-danger)' } : undefined}
                >
                  <td>
                    <a href={`/services/${encodeURIComponent(row.slug)}`}>{row.name}</a>
                  </td>
                  <td style={{ color: 'var(--muted)' }}>{row.group ?? '—'}</td>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {formatLatency(row.latencyMs)}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {formatUptime(row.uptime24h)}
                  </td>
                  <td title={formatDateTime(row.lastOkAt)} style={{ color: 'var(--muted)' }}>
                    {formatAgo(row.lastOkAt, now)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
