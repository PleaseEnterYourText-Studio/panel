import { useCallback, useEffect, useState } from 'react';
import type {
  ServiceDetail as ServiceDetailDto,
  ServiceDto,
  ServiceSummary,
  ServiceTarget,
  Status,
} from '../lib/api';
import { ApiError, get, post } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import {
  describeError,
  formatAgo,
  formatClock,
  formatDateTime,
  formatLatency,
  formatMinute,
  formatUptime,
} from '../lib/format';
import { ACTIONS, isEnabled, type ActionDef } from '../../src/domain/action';
import { countStatuses, deriveServiceStatus, latestByTarget } from '../lib/status';
import { actionButtonText, actionDisabledReason, type ActionContext } from '../lib/action-ui';

/**
 * 服务详情页：GitHub 对象页骨架。
 *
 * 头部：面包屑 + 名称 + StatusBadge + 动作按钮（来自 domain/action.ts 的 ACTIONS）。
 * 动作的可见性过滤（actionsFor / 角色）需要前端身份，P0 前端还没有 identity，
 * 所以这里先渲染全部动作，只用 isEnabled() 决定可点性——phase 3 的动作一律
 * disabled + P3 徽章。**不要**在组件里另凭 id 判断开放，那是绕过契约。
 *
 * 标签页：概览 / 检查 N 有内容；部署 / 事件 / 设置是 P1，显示「P1 提供」。
 * 正文两列：主列状态计数 + 检查表，右栏关于卡片。
 *
 * 动作区语义（规格 §10.3 规则 1 / 6）：可点性由 action-ui.ts 的纯函数判定，
 * 不可点时按钮 disabled 且 title + 可见原因写明（服务已停用 / 无启用的检查目标 /
 * 正在执行 / P3 提供）；执行中按钮进 pending 文案，成功后弹一条带时间戳的完成提示。
 *
 * 状态来源：优先用 /api/services 列表里的 summary（后端含未关闭 incident，
 * 能得出 down）；列表拿不到时用详情页的 recentChecks 按 target 推导，
 * 推导结果不含 down——没有事件数据就不编。
 */

type TabId = 'overview' | 'checks' | 'deploys' | 'events' | 'settings';

const TAB_ORDER: TabId[] = ['overview', 'checks', 'deploys', 'events', 'settings'];
const P1_TABS: ReadonlySet<TabId> = new Set<TabId>(['deploys', 'events', 'settings']);

const TAB_LABEL: Record<TabId, string> = {
  overview: '概览',
  checks: '检查',
  deploys: '部署',
  events: '事件',
  settings: '设置',
};

function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}

function repoHref(repo: string | null): string | null {
  if (!repo) return null;
  if (/^https?:\/\//i.test(repo)) return repo;
  // 允许只填 "org/repo" 的简写。
  if (repo.includes('/')) return `https://github.com/${repo}`;
  return null;
}

function isNotFound(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404;
}

export function ServiceDetail({ slug }: { slug: string }) {
  const [data, setData] = useState<ServiceDetailDto | null>(null);
  const [summary, setSummary] = useState<ServiceSummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabId>('overview');

  const load = useCallback(async () => {
    const path = `/api/services/${encodeURIComponent(slug)}`;
    const [detailResult, listResult] = await Promise.allSettled([
      get<ServiceDetailDto>(path),
      get<ServiceSummary[]>('/api/services'),
    ]);

    if (detailResult.status === 'rejected') {
      setError(detailResult.reason);
      setData(null);
      return;
    }

    setError(null);
    setData(detailResult.value);
    if (listResult.status === 'fulfilled') {
      setSummary(listResult.value.find((s) => s.slug === slug) ?? null);
    }
  }, [slug]);

  useEffect(() => {
    setData(null);
    setSummary(null);
    setError(null);
    setNotice(null);
    void load();
  }, [load]);

  // 成功提示是「短暂」的：6 秒后自己消失，不留在页面上冒充状态。
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const runProbe = async (service: ServiceDto, targets: ServiceTarget[]) => {
    const runnable = targets.filter((t) => t.enabled);
    // 按钮已经是 disabled，这里是第二道闸：停用服务 / 无目标绝不允许静默空点。
    if (!service.enabled || runnable.length === 0 || busy) return;

    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      // 每个 enabled target 各跑一次：手动探测是 target 粒度，不是 asset 粒度。
      // 后端对停用 asset 返回 409 asset_disabled，前端在此之前就不会发出去。
      await Promise.all(runnable.map((t) => post(`/api/probes/${encodeURIComponent(t.id)}/run`)));
      await load();
      setNotice({ text: `已探测 ${runnable.length} 个目标 · ${formatClock(Date.now())}` });
    } catch (e) {
      // 竞态兜底：页面还认为服务启用、后端已停用（他人刚改），409 要给人话。
      if (e instanceof ApiError && e.status === 409) {
        setActionError('服务已停用，探测请求被拒绝（409）');
      } else {
        setActionError(describeError(e));
      }
    } finally {
      setBusy(false);
    }
  };

  if (isNotFound(error)) {
    // 404 不白屏：给出「服务不存在」和回列表的路径。
    return (
      <div>
        <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-table)', marginBottom: 8 }}>
          服务 / <span style={{ color: 'var(--bright)' }}>{slug}</span>
        </div>
        <div className="card">
          <div className="h">服务不存在</div>
          <div style={{ padding: 10 }}>
            没有 slug 为 <code>{slug}</code> 的服务（可能已被删除或从未录入）。
            <div style={{ marginTop: 8 }}>
              <a href="/services">← 返回服务列表</a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-table)', marginBottom: 8 }}>
          服务 / <span style={{ color: 'var(--bright)' }}>{slug}</span>
        </div>
        <div className="card">
          <div className="h">加载失败</div>
          <div style={{ padding: 10 }}>{describeError(error)}</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div style={{ color: 'var(--muted)' }}>加载中…</div>;
  }

  const { service, targets, recentChecks } = data;
  const status: Status = summary?.status ?? deriveServiceStatus(targets, recentChecks);
  const counts = countStatuses(targets, recentChecks);
  const enabledTargets = targets.filter((t) => t.enabled);
  const targetById = new Map(targets.map((t) => [t.id, t]));
  // 一次算好「每个 target 最新检查」，检查表按行查即可，避免每行重扫 recentChecks。
  const latestByTargetId = latestByTarget(recentChecks);
  const now = Date.now();
  const repo = repoHref(service.repo);

  const tabLabel = (id: TabId): string => (id === 'checks' ? `检查 ${targets.length}` : TAB_LABEL[id]);

  const actionCtx: ActionContext = {
    serviceEnabled: service.enabled,
    enabledTargetCount: enabledTargets.length,
    busy,
  };
  const probeAction = ACTIONS.find((a) => a.id === 'probe.run');
  const probeReason = probeAction ? actionDisabledReason(probeAction, actionCtx) : null;

  // 故障计数与头部徽章对齐：列表 summary 判 down（有未关闭事件）时，详情页按检查
  // 推导不出 down，同屏徽章与数字会打架。以徽章为准，至少记 1 个故障 target。
  const displayCounts =
    status === 'down' ? { ...counts, down: Math.max(counts.down, 1) } : counts;

  return (
    <div>
      <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-table)', marginBottom: 6 }}>
        <a href="/services">服务</a>
        {' / '}
        <span>{service.group ?? '未分组'}</span>
        {' / '}
        <span style={{ color: 'var(--bright)' }}>{service.name}</span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          marginBottom: 10,
        }}
      >
        <h1 style={{ margin: 0 }}>{service.name}</h1>
        <StatusBadge status={status} />
        <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-table)' }} className="num">
          {service.slug}
        </span>
        <span
          className="num"
          title={formatDateTime(summary?.lastOkAt ?? null)}
          style={{ color: 'var(--muted)', fontSize: 'var(--fs-table)' }}
        >
          最近一次成功 {formatMinute(summary?.lastOkAt ?? null)}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {ACTIONS.map((action: ActionDef) => {
            // 规则 1：不可点必须带原因（disabled + title + 旁注），不能点了才知道。
            const reason = actionDisabledReason(action, actionCtx);
            const disabled = reason !== null;
            const isProbe = action.id === 'probe.run';
            return (
              <button
                key={action.id}
                className={'btn' + (action.danger === 'typed' ? ' danger' : '')}
                disabled={disabled}
                aria-disabled={disabled}
                aria-label={reason ? `${action.label}（${reason}）` : action.label}
                title={reason ?? action.label}
                onClick={isProbe ? () => void runProbe(service, targets) : undefined}
              >
                {actionButtonText(action, actionCtx)}
                {isEnabled(action) ? null : (
                  <span className="pill" style={{ marginLeft: 6 }}>
                    P3
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {probeReason ? (
        <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-table)', marginBottom: 8 }}>
          「立即探测」不可用：{probeReason}
        </div>
      ) : null}

      {notice ? (
        <div className="card" role="status" style={{ marginBottom: 10, borderColor: 'var(--ok)' }}>
          <div style={{ padding: '6px 10px', color: 'var(--ok)' }}>✓ {notice.text}</div>
        </div>
      ) : null}

      {actionError ? (
        <div className="card" style={{ marginBottom: 10, borderColor: 'var(--danger)' }}>
          <div className="h">动作失败</div>
          <div style={{ padding: 10 }}>{actionError}</div>
        </div>
      ) : null}

      <div className="tabs" role="tablist" aria-label="服务视图">
        {TAB_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'on' : ''}
            onClick={() => setTab(id)}
          >
            {tabLabel(id)}
          </button>
        ))}
      </div>

      {P1_TABS.has(tab) ? (
        <div className="card">
          <div className="h">{TAB_LABEL[tab]}</div>
          <div style={{ padding: 10, color: 'var(--muted)' }}>P1 提供</div>
        </div>
      ) : (
        <div className="split">
          <div className="main-col">
            {tab === 'overview' ? (
              <>
                <div className="card">
                  <div className="h">状态计数 · {targets.length} 个 target</div>
                  <div className="kv" style={{ gridTemplateColumns: '96px minmax(0, 1fr)' }}>
                    <span className="k">正常</span>
                    <span className="v num">{displayCounts.ok}</span>
                    <span className="k">疑似</span>
                    <span className="v num">{displayCounts.suspect}</span>
                    <span className="k">故障</span>
                    <span className="v num">{displayCounts.down}</span>
                    <span className="k">无数据</span>
                    <span className="v num">{displayCounts.unknown}</span>
                  </div>
                  <div style={{ padding: '0 10px 10px', color: 'var(--muted)' }}>
                    计数按各 target 最近一次检查推导；「故障」以存在未关闭事件为准，
                    <a href="/services">列表页</a>的状态含事件判断。
                  </div>
                </div>
                <div className="card">
                  <div className="h">最近检查 · {recentChecks.length}</div>
                  {recentChecks.length === 0 ? (
                    <div style={{ padding: 10, color: 'var(--muted)' }}>暂无检查记录</div>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>目标</th>
                          <th>时间</th>
                          <th>结果</th>
                          <th style={{ textAlign: 'right' }}>延迟</th>
                          <th>错误</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recentChecks.map((check, index) => {
                          const target = targetById.get(check.targetId);
                          return (
                            <tr key={`${check.targetId}-${check.at}-${index}`}>
                              <td title={check.targetId}>
                                <span style={{ color: 'var(--muted)' }}>{target?.source ?? '未知'}</span>{' '}
                                <span className="num">{shortId(check.targetId)}</span>
                              </td>
                              <td className="num" title={formatDateTime(check.at)}>
                                {formatDateTime(check.at)}
                              </td>
                              <td>
                                <StatusBadge status={check.ok ? 'ok' : 'suspect'} />
                              </td>
                              <td className="num" style={{ textAlign: 'right' }}>
                                {formatLatency(check.latencyMs)}
                              </td>
                              <td style={{ color: 'var(--muted)' }}>{check.errorKind ?? '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            ) : (
              <div className="card">
                <div className="h">检查 · {targets.length}</div>
                {targets.length === 0 ? (
                  <div style={{ padding: 10, color: 'var(--muted)' }}>还没有配置检查目标</div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>目标</th>
                        <th>源 / 形式</th>
                        <th style={{ textAlign: 'right' }}>间隔</th>
                        <th style={{ textAlign: 'right' }}>超时</th>
                        <th>启用</th>
                        <th>最近检查</th>
                      </tr>
                    </thead>
                    <tbody>
                      {targets.map((target) => {
                        const latest = latestByTargetId.get(target.id);
                        return (
                          <tr key={target.id}>
                            <td className="num" title={target.id}>
                              {shortId(target.id)}
                            </td>
                            <td>
                              <span style={{ color: 'var(--muted)' }}>{target.source}</span> / {target.form}
                            </td>
                            <td className="num" style={{ textAlign: 'right' }}>
                              {target.config.interval_sec}s
                            </td>
                            <td className="num" style={{ textAlign: 'right' }}>
                              {target.config.timeout_ms}ms
                            </td>
                            <td>{target.enabled ? '是' : '否'}</td>
                            <td
                              title={latest ? formatDateTime(latest.at) : '暂无检查记录'}
                              style={{ color: 'var(--muted)' }}
                            >
                              {latest
                                ? `${formatAgo(latest.at, now)} · ${latest.ok ? '成功' : '失败'}`
                                : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>

          <div className="side-col">
            <div className="card">
              <div className="h">关于</div>
              <div className="kv">
                <span className="k">仓库</span>
                <span className="v" title={service.repo ?? '—'}>
                  {repo ? (
                    <a href={repo} target="_blank" rel="noreferrer">
                      {service.repo}
                    </a>
                  ) : (
                    (service.repo ?? '—')
                  )}
                </span>
                <span className="k">分组</span>
                <span className="v">{service.group ?? '—'}</span>
                <span className="k">负责人</span>
                <span className="v" title={service.ownerEmail ?? '—'}>
                  {service.ownerEmail ?? '—'}
                </span>
                <span className="k">类型</span>
                <span className="v">{service.kind}</span>
                <span className="k">可用率</span>
                <span className="v num">{formatUptime(summary?.uptime24h ?? null)}</span>
              </div>
            </div>

            <div className="card">
              <div className="h">检查目标 · {targets.length}</div>
              {targets.length === 0 ? (
                <div style={{ padding: 10, color: 'var(--muted)' }}>—</div>
              ) : (
                targets.map((target) => (
                  <div className="r" key={target.id} style={{ opacity: target.enabled ? 1 : 0.6 }}>
                    <span title={target.id}>
                      <span style={{ color: 'var(--muted)' }}>{target.source}</span> {target.form}
                    </span>
                    <span className="num" style={{ color: 'var(--muted)' }}>
                      每 {target.config.interval_sec}s
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="card">
              <div className="h">启用状态</div>
              <div className="kv">
                <span className="k">服务</span>
                <span className="v">{service.enabled ? '已启用' : '已停用'}</span>
                <span className="k">启用的目标</span>
                <span className="v num">
                  {enabledTargets.length} / {targets.length}
                </span>
                <span className="k">录入时间</span>
                <span className="v num">{formatDateTime(service.createdAt)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
