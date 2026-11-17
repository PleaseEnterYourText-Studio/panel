# PEYT Panel — 服务器与线上服务管理面板 · 设计规格

- 日期：2026-11-17
- 仓库：`PleaseEnterYourText-Studio/panel`
- 许可证：AGPL-3.0（仓库已有 LICENSE）
- 状态：设计已确认，待实施

---

## 1. 背景

PEYT Studio 与 NoWint 名下的服务器和线上服务数量已经超出「靠记忆 + 逐个后台」的管理容量：

- GitHub 两个组织，公开/私有仓库数十个
- 一批自建 VPS
- 一组 AI 网关与中转服务（newapi / sub2api / PAI-api / relay 等）
- 若干对外站点与服务（官网、文档、聊天服务端）
- Cloudflare 上的资产（Workers、Pages、DNS、证书）

现状的问题不是「看不到数据」，而是**没有一个地方能回答「现在有没有东西挂了」**，以及「挂了之后是哪台机器的哪个服务」。

## 2. 目标

构建一个**部署在 Cloudflare Workers 上**的一站式管理面板，用于：

1. 汇总所有服务器与线上服务的健康状态
2. 展示资源的资源曲线与事件时间线，支持故障定位
3. 提供日常运维动作的入口（白名单动词，P3 落地）
4. 集中呈现到期与配额信息（证书、域名、平台用量）
5. 维护服务目录 / 资产台账
6. 对每一次人工操作留下审计记录

## 3. 非目标

明确**不做**的事，避免范围蔓延：

- 不做通用 PaaS / 应用部署平台（不重造 Coolify、1Panel）
- 不做公开的对外状态页（内部工具，访问需要登录）
- 不做日志全文检索（阶段一只做「最近事件」，日志流在阶段三由 agent 提供）
- 不做多租户（所有资产属于同一个组织）
- 不做告警外发通道（阶段一只写库，见 §9）

## 4. 硬约束

| 约束 | 来源 | 影响 |
|---|---|---|
| 全部逻辑运行在 Cloudflare Workers | 用户明确要求 | 没有常驻服务器、没有容器、没有本地守护进程 |
| 无法从 Workers 反向连接服务器内部 | 平台能力 | 主机层数据必须由服务器侧主动上报（阶段三 agent），或走平台 API |
| 多人使用 | 用户确认 | 必须有 RBAC 与审计 |
| 操作仅限白名单动词 | 用户确认 | 命令通道不接受任意命令 |
| 免费版额度 | 成本 | D1 写入、subrequest 数量、Cron 粒度全部受约束（见 §7） |
| AGPL-3.0 | 仓库既有 | 作为网络服务必须向使用者提供源码 |

## 5. 用户与角色

工作室内部成员使用，无外部用户。角色三种：

| 角色 | 权限 |
|---|---|
| `owner` | 全部权限；管理用户、凭据、删除资产 |
| `ops` | 增删改 target 与资产；触发探测；阶段三可下发白名单动作 |
| `viewer` | 只读：健康墙、资产详情、事件、配额 |

角色的唯一来源是 D1 的 `users` 表，键是 Cloudflare Access 验证后的 email。未在表中登记的 email 一律拒绝（默认拒绝，不是默认放行）。

## 6. 架构

### 6.1 运行时结构

单一 Worker，单一部署单元。

```text
Cloudflare Worker (Hono + TypeScript)
├── /                → SPA 静态资源（Workers Assets，Vite + React）
├── /api/*           → JSON API，RBAC + 审计中间件
└── scheduled()      → Cron Trigger，每分钟一次

Bindings
├── DB       D1     台账 + 探测结果 + 事件 + 审计（唯一真相源）
├── KV       KV     配置缓存、探测游标、短期令牌
├── R2       R2     阶段三：日志与诊断快照（阶段一不绑定）
└── Secrets         ENCRYPTION_KEY（凭据加密）、CF API Token（bootstrap）
```

**Cron 不经过 HTTP**，因此不受 Access 拦截。这是必须写进实现注释的事实，避免上线时误判「探测全挂」。

### 6.2 鉴权

面板整体挂在 **Cloudflare Access**（Zero Trust）之后。Worker 侧只做三件事：

1. 校验 `Cf-Access-Jwt-Assertion`（JWKS 缓存 + 验签 + `aud` 校验）
2. 取 email，查 D1 `users` 表得到角色
3. 把身份放进请求上下文，供 RBAC 与审计中间件使用

不实现自建注册、密码找回、防爆破。身份提取收敛成**单一函数**：

```ts
function getIdentity(req: Request, env: Env): Promise<Identity>;
```

若将来要换鉴权方案，只替换此函数的实现。

审计记录所有非 GET 请求：`actor / action / asset_id / 请求摘要 / ip / ua / 时间`。凭据明文永不进入审计。

### 6.3 数据源接缝

所有数据来源实现同一个接口，业务层只认 `Observation`：

```ts
type SourceKind = 'http' | 'tcp' | 'dns' | 'tls' | 'cloudflare' | 'agent';

interface Source {
  readonly kind: SourceKind;
  probe(target: Target): Promise<Observation>;
}

interface Observation {
  targetId: string;
  at: number;                          // UTC 毫秒
  ok: boolean;
  latencyMs?: number;
  metrics?: Record<string, number>;    // cpu / mem / disk / traffic（agent 专有）
  detail?: unknown;                    // 原始响应，截断后存
  errorKind?: 'timeout' | 'dns' | 'tls' | 'status' | 'refused' | 'auth';
}
```

阶段一实现 `http / tcp / dns / tls / cloudflare`。阶段三新增 `agent` 实现，**业务代码零改动**。

### 6.4 命令通道接缝

阶段一就钉死契约，实现为一个诚实报错的空壳：

```ts
type AllowedVerb =
  | 'service.restart' | 'service.status'
  | 'docker.logs'     | 'docker.restart'
  | 'deploy.pull'     | 'disk.usage'
  | 'check.health';

interface CommandChannel {
  dispatch(actorId: string, serverId: string, verb: AllowedVerb, args: JsonValue)
    : Promise<CommandReceipt>;
}

class UnavailableChannel implements CommandChannel {
  async dispatch(): Promise<never> {
    throw new CommandNotAvailableError();   // HTTP 501，并写审计
  }
}
```

`AllowedVerb` 是编译期白名单，任何不在联合类型中的 verb 无法通过类型检查，也无法通过 API 校验。

**验收标准：阶段三接入 agent 时，改动业务文件数量不超过 3 个。** 超出即视为设计失败。

## 7. 配额与调度约束

### 7.1 D1 写入预算

免费版 D1 额度约 **100k 行写入 / 天**。探测频次直接换算成写入行数：

| 场景 | 每天写入行数 | 判定 |
|---|---|---|
| 100 target × 60s | ~144,000 | 超限，会静默丢写 |
| 100 target × 180s | ~48,000 | 安全 |
| 60 target × 180s | ~28,800 | 很安全 |

**默认 `interval_sec = 180`。** 设置页呈现「当前 target 数 × 间隔」估算的每日写入量；逼近 100k 的 80% 时显著警告，而不是等 D1 开始丢写。

### 7.2 Subrequest 分片

免费版每次调用最多 50 个外部 subrequest。调度器**必须分片**：

1. Cron 触发，按 `next_run_at <= now` 取候选 target
2. **本次最多取 40 个**执行探测
3. 写回结果与新的 `next_run_at`
4. 剩余候选留给下一分钟

一次性探测全部 target 会被平台截断，这是硬设计而非优化。

### 7.3 时间粒度

Cron 最小间隔是 1 分钟。因此阶段一的故障发现最坏情况为：

```text
180s 探测间隔 + 3 次失败确认 ≈ 3 分钟内发现
```

此数字写进 UI 的说明文案，避免误期待「秒级告警」。

## 8. 数据模型

```sql
-- 台账：管理对象
CREATE TABLE assets (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,          -- server | service | endpoint | repo
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  grp         TEXT,                   -- 分组：prod | game | ai | site ...
  owner_email TEXT,
  tags        TEXT,                   -- 逗号分隔
  repo        TEXT,                   -- 关联 GitHub 仓库
  notes       TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- 探测目标：怎么探、多久一次
CREATE TABLE targets (
  id           TEXT PRIMARY KEY,
  asset_id     TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,         -- SourceKind
  form         TEXT NOT NULL,         -- 具体形态：url | host:port | domain | account
  config       TEXT NOT NULL,         -- JSON：期望状态码 / 超时 / 证书阈值
  interval_sec INTEGER NOT NULL DEFAULT 180,
  timeout_ms   INTEGER NOT NULL DEFAULT 8000,
  enabled      INTEGER NOT NULL DEFAULT 1,
  next_run_at  INTEGER NOT NULL
);

-- 原始结果，仅保留 48 小时
CREATE TABLE checks_raw (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id  TEXT NOT NULL,
  at         INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  latency_ms INTEGER,
  error_kind TEXT,
  detail     TEXT
);
CREATE INDEX idx_checks_raw_target_at ON checks_raw(target_id, at);

-- 分钟级预聚合，长期保留
CREATE TABLE checks_rollup (
  target_id  TEXT NOT NULL,
  bucket_min INTEGER NOT NULL,
  ok_count   INTEGER NOT NULL,
  fail_count INTEGER NOT NULL,
  p50_ms     INTEGER,
  p95_ms     INTEGER,
  PRIMARY KEY (target_id, bucket_min)
);

-- 故障态
CREATE TABLE incidents (
  id        TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  state     TEXT NOT NULL,            -- suspect | open | closed
  cause     TEXT
);

-- 事件：故障与审计共用一张表
CREATE TABLE events (
  id       TEXT PRIMARY KEY,
  at       INTEGER NOT NULL,
  kind     TEXT NOT NULL,             -- incident.opened | incident.closed | action.*
  actor    TEXT,
  asset_id TEXT,
  payload  TEXT,
  ip       TEXT
);
CREATE INDEX idx_events_at ON events(at DESC);

-- 身份
CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL,           -- owner | ops | viewer
  created_at INTEGER NOT NULL,
  last_seen  INTEGER
);

-- 外部账号与凭据（密文落库）
CREATE TABLE accounts (
  id         TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,           -- cloudflare | github | vendor
  label      TEXT NOT NULL,
  secret_enc TEXT NOT NULL,           -- AES-GCM(ENCRYPTION_KEY)
  meta       TEXT
);
```

### 8.1 三个刻意的选择

1. **原始与聚合分离。** `checks_raw` 48 小时后清理，`checks_rollup` 永久保留。能看 7 天曲线，不需要 7 天原始行。
2. **`events` 一表两用。** `kind='incident.*'` 是故障，`kind='action.*'` 是审计。收件箱与审计流是同源数据的不同过滤，不会出现互相矛盾的两份账。
3. **凭据密文落库。** 明文只存在于请求生命周期内，`secret_enc` 用 `ENCRYPTION_KEY` 做 AES-GCM 加解密，密钥只在 Worker Secret 中。

## 9. 探测与故障状态机

`Incident` 状态流转为纯函数：

```text
        3 次连续失败
healthy ──────────────▶ suspect ──▶ open
   ▲                       │          │
   │      2 次连续成功      │          │ 2 次连续成功
   └───────────────────────┴──────────┘
```

- `suspect`：疑似异常，UI 黄色，不产生告警事件
- `open`：确认故障，写入 `incident.opened` 事件
- `closed`：恢复，写入 `incident.closed` 事件，记录持续时长

实现为纯函数 `nextState(history, observation) → State`，输入输出都是值，无 DB 依赖，可直接单测。

## 10. 界面与信息架构

```text
/            健康墙      分组卡片网格；状态色；最近一次成功/失败；30s 轮询刷新
/a/:slug     资产详情    状态 + 24h/7d 曲线 + 事件时间线 + 元数据 +（阶段三）操作区
/inventory   服务目录    表格 + 搜索/过滤/分组 + CRUD
/quota       到期与配额  证书倒计时、域名到期、平台用量条
/events      事件与审计  收件箱 + 审计流，按 actor / kind / asset 过滤
/settings    设置        targets、users、accounts、额度仪表
```

### 10.1 健康墙的硬规则

健康墙是唯一门面，必须在一屏内回答「有没有东西挂了」。规格要求：

- **异常资产排在最前**，正常资产收缩为小卡片
- 每个卡片必须显示：名称、分组、状态、最近成功时间、最近失败时间
- 全绿时给一行明确的「全部正常 · 最近一次巡检 HH:MM」，而不是一片沉默的绿色
- 30 秒轮询刷新（阶段一不做 WebSocket）

## 11. 分期与验收

### P0 — 能上线

骨架 + D1 migrations + Access 鉴权 + RBAC + HTTP 探测 + 健康墙 + 手动「立即探测」。

**验收：** 录入 5 个真实 URL，手动下线其中一个，3 分钟内健康墙变红；恢复后变绿；事件流出现 `incident.opened` 与 `incident.closed` 两条记录。

### P1 — 能定位

rollup 聚合 + 曲线图 + 事件页 + 服务目录 CRUD + 审计流。

**验收：** 任一资产能看到 24 小时成功率曲线；任一写操作在审计流里能查到 actor 与时间。

### P2 — 能预警

TCP / DNS / TLS / Cloudflare 四个 source + 证书到期倒计时 + 配额看板。

**验收：** 一张即将过期的证书在 `/quota` 上以天数为单位倒计时，剩余 14 天内变红。

### P3 — 能动手

agent（Go 单二进制）+ ServerHub Durable Object + 白名单动词 + 日志流。

**验收：** 阶段三接入后，业务文件改动不超过 3 个。

## 12. 风险清单

| 风险 | 真实后果 | 对策 |
|---|---|---|
| DO 连接时长计费（P3） | 免费额度被吃穿 | WebSocket hibernation；不达标则降级为 HTTP 轮询（transport 已隔离） |
| D1 写额度 | 探测静默丢写 | 默认 180s + 分片 + 额度仪表 80% 预警 |
| Access 依赖 | 换鉴权要动所有路由 | 身份提取收敛为 `getIdentity()` 单函数 |
| 边缘探测的地理盲区 | 测的是「边缘→服务」而非「用户→服务」 | UI 标注探测来源区域；延迟绝对值不宣称 SLA |
| AGPL-3.0 | 作为网络服务必须提供源码 | 项目本就开源，无冲突；README 中说明 |
| 多 source 数据形状不一致 | UI 到处特判 | 统一 `Observation`，UI 只认一种形状 |

## 13. 待定项

以下内容明确推迟，不在本规格范围内：

- 告警外发渠道（Telegram / 邮件 / Webhook）：阶段一只写 `events` 表，不做发送
- 公开对外状态页：暂不做
- 日志全文检索：阶段三的日志流只做最近 N 条
- 多组织 / 多租户：不做

## 14. 参考项目

| 项目 | 借鉴点 |
|---|---|
| [p-sw/flarebot](https://github.com/p-sw/flarebot) | Workers + D1 + DO 的探测调度模型、状态页、免费额度实践 |
| [nezhahq/nezha](https://github.com/nezhahq/nezha) | 反向连接 agent 协议、Web 终端、定时任务的分层 |
| [komari-monitor/komari](https://github.com/komari-monitor/komari) | 同思路的现代化实现、主题系统 |
| [Nechja/Uppies](https://github.com/Nechja/Uppies) | Workers 上的实时状态推送 |
| [iamjjchang/cloudflare-usage-dashboard](https://github.com/iamjjchang/cloudflare-usage-dashboard) | Cloudflare GraphQL Analytics 用量口径 |

结论：**不存在可直接复用的「Workers 上的服务器综合管理面板」开源项目**。本项目是 flarebot 的调度模型 + Nezha 的 agent 模型 + 自建资产台账的合成体。
