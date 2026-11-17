# 部署手册（PEYT Panel P0）

面向：未来的运维 / 接手的人。目标是一台干净的机器上，**照顺序抄命令就能上线**。

本仓库是单个 Cloudflare Worker + D1 + KV + Cron，前端构建产物由 Worker 的静态资源
绑定（`ASSETS`）直接托管。全部资源在同一个 Worker 里，没有单独的前端服务。

所有命令都在仓库根目录执行。需要 Node 22.12+、pnpm 10，并已 `wrangler login`
（或设置 `CLOUDFLARE_API_TOKEN`）。

```bash
pnpm install
pnpm exec wrangler whoami     # 确认登录的是目标账号
```

---

## 1. 创建 D1 与 KV

```bash
pnpm exec wrangler d1 create peyt-panel
```

输出里有一行 `database_id = "xxxx-..."`，把它填回 `wrangler.jsonc` 的
`d1_databases[0].database_id`（现在是 `REPLACE_ME`）：

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "peyt-panel", "database_id": "<粘贴到这里>", "migrations_dir": "migrations" }
],
```

接着建 KV：

```bash
pnpm exec wrangler kv namespace create KV
```

输出里有 `id = "xxxx..."`（预览环境是 `preview_id`），填回 `wrangler.jsonc` 的
`kv_namespaces[0].id`：

```jsonc
"kv_namespaces": [{ "binding": "KV", "id": "<粘贴到这里>" }],
```

> `wrangler.jsonc` 里的两个 `REPLACE_ME` 必须都替换掉，否则 `pnpm deploy` 会失败或
> 绑到错误的资源上。

## 2. 写入加密密钥

`ENCRYPTION_KEY` 用来加密后续版本要落库的敏感字段（P0 里主要是占位与审计用）。

```bash
openssl rand -base64 32
```

把输出的 32 字节 base64 字符串写进 Worker secret（**不要提交进仓库**，也别写进
`wrangler.jsonc` 的 `vars`）：

```bash
pnpm exec wrangler secret put ENCRYPTION_KEY
# 粘贴上一步的 base64，回车
```

本地开发不设 secret，用 `.dev.vars`（从 `.dev.vars.example` 复制）。

## 3. Cloudflare Access（保护面板域名）

面板本身没有登录页，身份完全交给 Cloudflare Access。**不做这一步，任何人都能拿到
面板 HTML 与 API**（API 会拒绝没有 `Cf-Access-Jwt-Assertion` 的请求，但页面不该裸奔）。

1. Cloudflare Zero Trust 控制台 → **Access → Applications → Add an application → Self-hosted**。
2. Application name 随意；Session duration 建议 24h。
3. **Application domain** 填面板的域名（例如 `panel.example.com`；用 Worker 时把
   自定义域名绑到该 Worker 后再填，或先填 `*.workers.dev` 的那条）。
4. Policy：Allow，Include → Emails，填你自己的邮箱（以及其他要放行的人）。
5. 保存后进 **Access → Applications → 该应用 → Overview**，复制：
   - **Application Audience (AUD) Tag** → 填到 `wrangler.jsonc` 的
     `vars.ACCESS_AUD`
   - **Team domain**（形如 `https://your-team.cloudflareaccess.com`）→ 填到
     `vars.ACCESS_TEAM_DOMAIN`

`wrangler.jsonc` 顶层的 `vars` 需要新增（P0 目前只在测试与 `.dev.vars` 里给）：

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "https://your-team.cloudflareaccess.com",
  "ACCESS_AUD": "从 Access 应用复制的 AUD"
},
```

> 这两个值不是秘密（会随 Worker 下发），可以写在 `vars`。`ENCRYPTION_KEY` 不行。

## 4. 应用数据库迁移

```bash
pnpm db:migrate:remote
```

等价于 `wrangler d1 migrations apply DB --remote`，按 `migrations/` 目录里的文件顺序
执行；重复执行是安全的（已应用的会被跳过）。

**顺序不能反**：先迁移再 `pnpm deploy`。反过来的话 Worker 启动时表还不存在，
所有 API 都会 500。

## 5. 部署

```bash
pnpm deploy
```

等于 `pnpm build && wrangler deploy`。构建产物在 `dist/web`，由 `ASSETS` 绑定托管；
`run_worker_first` 只把 `/api/*` 交给 Worker，其余请求直接吃静态资源。

部署成功后输出里有 Worker 的 URL（`https://<worker>.<subdomain>.workers.dev` 或
你的自定义域名）。

## 6. 首次启动：插入第一个 owner（**不能漏**）

权限模型是**默认拒绝**：`users` 表里没有的邮箱，即使 Access 放行了也会拿到
`401 unauthorized`。所以在任何人打开面板之前，必须手动插第一行 owner。

邮箱用 Access 里配的那个，**必须小写**（后端 `resolveIdentity` 会 `toLowerCase()`
后查表）：

```bash
pnpm exec wrangler d1 execute peyt-panel --remote --command \
  "INSERT INTO users (id, email, role, created_at) VALUES ('owner-1', 'you@example.com', 'owner', CAST(strftime('%s','now') AS INTEGER) * 1000)"
```

校验：

```bash
pnpm exec wrangler d1 execute peyt-panel --remote --command \
  "SELECT id, email, role FROM users"
```

插完立刻生效（身份缓存只是 60s 的 KV 缓存，不需要重启 Worker）。

后续加人：

```bash
# ops：可以跑手动探测、改配置；viewer：只读
pnpm exec wrangler d1 execute peyt-panel --remote --command \
  "INSERT INTO users (id, email, role, created_at) VALUES ('u-2', 'teammate@example.com', 'viewer', CAST(strftime('%s','now') AS INTEGER) * 1000)"
```

角色只有 `owner` / `ops` / `viewer` 三种，写错角色的行会被当作未授权（同样是默认拒绝）。

## 7. 上线自检

```bash
curl -s https://<你的域名>/api/health
# {"ok":true,"version":"0.1.0"}
```

`/api/health` 是匿名探活入口（不要求 Access），用来确认 Worker 活着、路由挂上了。
其余 `/api/*` 都必须带 Access 的 JWT，浏览器里登录后自动带。

再打开面板首页 `https://<你的域名>/`：

- 未登录 → 被 Access 挡在登录页（不是 500，也不是空面板）。
- 登录后 → 概览页显示「全部正常。」或故障摘要；首次部署没有 target 时四张卡都是 0，
  最近巡检显示「还没有巡检记录」。

## 8. 运行时事实（排障前先看这节）

- **Cron 每分钟触发一次**（`wrangler.jsonc` 的 `triggers.crons: ["* * * * *"]`）。每次
  tick 只吃一个分片窗口（最多 40 个到期 target），剩下的留给下一分钟。
- **默认探测间隔 180s**（`interval_sec` 默认值）。一个 target 每天约写 480 行。
- **免费版 D1 每工作日 100,000 行写入预算**。`/api/overview` 的 `writeEstimate` 是
  `Σ floor(86400 / interval_sec)`（只算 enabled 的 target）的估算值；概览页在估算超过
  80,000 时显示黄色预警条。要降写入就调大 `interval_sec`（服务详情页的 target 配置）。
- 定时器跑的是 `scheduled` handler；`wrangler dev` 本地默认不触发 cron，需要自测时
  用 `pnpm exec wrangler dev --test-scheduled` 然后请求
  `/__scheduled?cron=*+*+*+*+*`。
- 生产与测试跑在不同版本的 workerd 上，详见 `README.md`「测试与部署的运行时差异」。

## 9. 回滚与常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 面板 500，日志 `no such table` | 迁移没跑 / 顺序反了 | 执行 `pnpm db:migrate:remote` 后重新 `pnpm deploy` |
| 所有人 401 | `users` 表没插 owner，或邮箱大小写/拼错 | 按第 6 步插行并 `SELECT` 校验 |
| 页面能开但一直「加载中」 | `ASSETS` 里没有构建产物 | 用 `pnpm deploy`（内含 `pnpm build`）而不是裸 `wrangler deploy` |
| API 返回 Access 登录页 HTML | 域名没经过 Access 应用，或缺 `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` | 检查第 3 步的 `vars` 与 Access 应用域名 |
| `wrangler deploy` 报绑定不存在 | `wrangler.jsonc` 里还是 `REPLACE_ME` | 回到第 1 步填真实 ID |
| 概览页黄色预警条 | 写入估算 > 80,000 行/天 | 调大 `interval_sec`，或升级 D1 付费版 |

回滚 Worker：`wrangler rollback`（回上一个版本）。数据库迁移**不自动回滚**，涉及
schema 变更时要单独写回退脚本。
