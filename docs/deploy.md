# 部署手册（PEYT Panel P0）

面向：未来的运维 / 接手的人。目标是一台干净的机器上，**照顺序抄命令就能上线**。

本仓库是单个 Cloudflare Worker + D1 + KV + Cron，前端构建产物由 Worker 的静态资源
绑定（`ASSETS`）直接托管。全部资源在同一个 Worker 里，没有单独的前端服务。

## 为什么是这个顺序

部署顺序不是随手排的，有两处硬约束决定了它：

1. **`wrangler secret put` 要求 Worker 已经存在。** wrangler 会在首次部署前调用
   `/secrets` 接口，Worker 不存在时直接 404，所以 `ENCRYPTION_KEY` 必须放在
   **首次 `pnpm deploy` 之后**。
2. **Access 应用需要一个真实域名，而域名只能绑到已存在的 Worker。**
   `ACCESS_AUD` 只有建完 Access 应用才拿得到，而 Access 应用的应用域名又必须指向
   一个已经在跑的 Worker —— 这是个环。解法是先部署到 `workers.dev` 临时 URL，
   绑好自定义域名，再建 Access 应用，最后把 `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN`
   写进 `vars` 并**再部署一次**。

因此链路固定为：
**装依赖 → 建 D1/KV → 迁移 → 首次部署 → 绑域名 → 建 Access → 填 vars → 二次部署
→ 写 secret → 插首个 owner → 关 workers.dev**。

所有命令都在仓库根目录执行。需要 Node 22.12+、pnpm 10，并已 `wrangler login`
（或设置 `CLOUDFLARE_API_TOKEN`）。

---

## 1. 安装依赖并确认账号

```bash
pnpm install
pnpm exec wrangler whoami     # 确认登录的是目标账号
```

`whoami` 里必须能看到目标账号与 zone；绑自定义域名需要该账号对域名所在 zone 有权限。

## 2. 创建 D1 与 KV，把 ID 填回配置

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

输出里有 `id = "xxxx..."`（预览环境是 `preview_id`，这里用不到），填回
`wrangler.jsonc` 的 `kv_namespaces[0].id`：

```jsonc
"kv_namespaces": [{ "binding": "KV", "id": "<粘贴到这里>" }],
```

> 两个 `REPLACE_ME` 必须都替换掉，否则 `pnpm deploy` 会失败或绑到错误的资源上。

## 3. 应用数据库迁移（建表）

```bash
pnpm db:migrate:remote
```

等价于 `wrangler d1 migrations apply DB --remote`，按 `migrations/` 目录里的文件顺序
执行；重复执行是安全的（已应用的会被跳过）。

**必须先迁移再部署**：Worker 启动时就要查表，表不存在的话所有 API 都是 500。

## 4. 首次部署

```bash
pnpm deploy
```

等于 `pnpm build && wrangler deploy`。构建产物在 `dist/web`，由 `ASSETS` 绑定托管；
`run_worker_first` 只把 `/api/*` 交给 Worker，其余请求直接吃静态资源。

这次部署的目的是让 Worker 存在（后续绑定域名、预设 secret 都需要它），并拿到一个
临时的 `https://<worker>.<subdomain>.workers.dev` URL。

> **此时面板没有任何身份保护。** 不要把 `workers.dev` URL 发给别人，也不要在这个
> 状态下录入真实数据。Access 保护在第 6–8 步才生效。

## 5. 绑定自定义域名

Cloudflare Dashboard → Workers & Pages → `peyt-panel` → **Settings → Domains & Routes**
→ Add → Custom domain，填你的面板域名（例如 `panel.example.com`，域名必须在本账号的
zone 里）。绑定后 Cloudflare 会自动加 DNS 记录并签发证书，等状态变成 Active。

绑定完成后 `https://<你的域名>/` 就能打开面板（**仍然没有登录**，下一步补）。
记录下这个域名，第 6 步要用。

## 6. 建 Cloudflare Access 应用，保护该域名

Zero Trust 控制台 → **Access → Applications → Add an application → Self-hosted**：

1. Application name 随意；Session duration 建议 24h。
2. **Application domain** 填第 5 步绑好的自定义域名。
3. Policy 1：Allow，Include → Emails，填你自己的邮箱（以及其他要放行的人）。
4. 保存后进 **Access → Applications → 该应用 → Overview**，复制：
   - **Application Audience (AUD) Tag** → 第 7 步填 `ACCESS_AUD`
   - **Team domain**（形如 `https://your-team.cloudflareaccess.com`）→ 第 7 步填
     `ACCESS_TEAM_DOMAIN`

**不要用 `*.workers.dev` 域名建 Access 应用。** `workers.dev` 不属于你的 zone，
Access 通常建不出合法应用；照做会得到「页面能开、全员 401、没有登录页」的状态。

另外在同一个 Access 应用里加 **Policy 2：Bypass，Include → Everyone，
Path 填 `api/health`**（注意不带开头的 `/`）。P0 的 `/api/health` 是匿名探活入口，
不加这条 bypass，第 10 步的 curl 会拿到登录页或 302。

> 建完 Access 应用、但还没做第 8 步二次部署的这段窗口里，Worker 还不知道
> `ACCESS_AUD`，所有 API 会返回 401。这是预期状态，不是坏了。

## 7. 把 Access 配置写进 `vars`

`wrangler.jsonc` 里目前没有 `vars`，在 `main` 字段旁边新增一段（和现有字段同级）：

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "https://your-team.cloudflareaccess.com",
  "ACCESS_AUD": "从 Access 应用 Overview 复制的 AUD"
},
```

这两个值不是秘密（会随 Worker 下发，代码里也要用它验签），可以写在 `vars`。
`ENCRYPTION_KEY` 不行，它走 secret（第 9 步）。

## 8. 二次部署（让 Access 配置生效）

```bash
pnpm deploy
```

这次部署把 `vars` 推上去，Worker 开始校验 Access 的 `Cf-Access-Jwt-Assertion`。
之后未登录访问面板域名会被 Access 拦到登录页；登录后浏览器会自动带上 JWT。

## 9. 写入加密密钥

`ENCRYPTION_KEY` 在 P0 **只声明、尚未使用**（全仓只有 `src/env.ts` 的类型声明，没有
任何读取点）；P3 才会用于加密 accounts 凭据。现在先把它设好，免得以后补部署。

先生成 32 字节 base64：

```bash
openssl rand -base64 32
```

再写进 Worker secret（**不要提交进仓库**，也别写进 `wrangler.jsonc` 的 `vars`）：

```bash
pnpm exec wrangler secret put ENCRYPTION_KEY
# 粘贴上一步的 base64，回车
```

secret 写入后立即对该 Worker 生效，**不需要重新部署**。

本地开发不设 secret，用 `.dev.vars`（从 `.dev.vars.example` 复制）。

## 10. 启动自检与首个 owner（**不能漏**）

### 10.1 匿名探活

```bash
curl -s https://<你的域名>/api/health
# {"ok":true,"version":"0.1.0"}
```

成立的前提是第 6 步给 Access 应用加了 `api/health` 的 Bypass 策略。**没有那条
Bypass 时，匿名 curl 会拿到 Access 登录页或 302，而不是 JSON** —— 这不是 Worker 挂了。

替代方案（不开放任何匿名路径）：在 Access 里建一个 **Service Token**，然后用它的两个
请求头自检：

```bash
curl -s https://<你的域名>/api/health \
  -H "CF-Access-Client-Id: <服务令牌 Client ID>" \
  -H "CF-Access-Client-Secret: <服务令牌 Client Secret>"
```

Service Token 需要在该 Access 应用里加一条 Allow 策略（Include → Service Token）才会
被放行。

### 10.2 插入第一个 owner

权限模型是**默认拒绝**：`users` 表里没有的邮箱，即使 Access 放行了也会拿到
`401 unauthorized`。在任何人打开面板之前，必须手动插第一行 owner。

邮箱用 Access 策略里配的那个，**必须小写**（后端 `resolveIdentity` 会 `toLowerCase()`
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

### 10.3 打开面板确认

浏览器打开 `https://<你的域名>/`：

- 未登录 → 被 Access 挡在登录页（不是 500，也不是空面板）。
- 登录后 → 概览页显示「全部正常。」或故障摘要；首次部署没有 target 时四张卡都是 0，
  最近巡检显示「还没有巡检记录」。

## 11. 关闭 `workers.dev` 路由（别留洞）

Dashboard → Workers & Pages → `peyt-panel` → **Settings → Domains & Routes**，把
`workers.dev` 那条路由 **Disable**（或 `wrangler.jsonc` 里加 `"workers_dev": false`
后重新 `pnpm deploy`）。

不关的话，Access 只保护自定义域名，任何人拿 `workers.dev` URL 就能绕过登录直接拿到
面板 HTML / JS（API 仍会 401，不泄数据，但没必要留这个入口）。

关闭后用自定义域名再访问一次，确认正常。

## 12. 运行时事实（排障前先看这节）

- **Cron 每分钟触发一次**（`wrangler.jsonc` 的 `triggers.crons: ["* * * * *"]`）。每次
  tick 只吃一个分片窗口（最多 40 个到期 target），剩下的留给下一分钟。
- **默认探测间隔 180s**。一个 target 每天约 480 行写入（86400 / 180）。
- **免费版 D1 每天 100,000 行写入预算（自然日，含周末，不是工作日）。**
- `writeEstimate` 公式：后端按 enabled target 求和后取整，即
  `floor(Σ 86400 / interval_sec)`（不是每个 target 各自 floor 再相加）。按默认 180s
  估算：
  - 顶满 100,000 行 ≈ **208 个** target（208 × 480 = 99,840）；
  - 概览页的 80,000 预警线在约 **167 个** target 时先到（167 × 480 = 80,160）。
- 要降写入就调大 `interval_sec`（服务详情页的 target 配置）。概览页**常显**「每日写入
  估算」，超过 80,000 时另外出现黄色预警条。
- 定时器跑的是 `scheduled` handler；`wrangler dev` 本地默认不触发 cron，需要自测时
  用 `pnpm exec wrangler dev --test-scheduled`，然后请求
  `/__scheduled?cron=*+*+*+*+*`。
- 生产与测试跑在不同版本的 workerd 上，详见 `README.md`「测试与部署的运行时差异」。

## 13. 回滚与常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 面板 500，日志 `no such table` | 迁移没跑 / 顺序反了 | 执行 `pnpm db:migrate:remote` 后重新 `pnpm deploy` |
| 所有人 401 | `users` 表没插 owner，或邮箱大小写/拼错 | 按第 10.2 步插行并 `SELECT` 校验 |
| 所有人 401（刚建完 Access） | 还没做第 8 步二次部署，`vars` 未生效 | 执行 `pnpm deploy` |
| 匿名 curl `/api/health` 拿到登录页/302 | Access 应用没有 `api/health` 的 Bypass 策略 | 加 Bypass 策略，或用 Service Token 自检 |
| 页面能开但一直「加载中」 | `ASSETS` 里没有构建产物 | 用 `pnpm deploy`（内含 `pnpm build`）而不是裸 `wrangler deploy` |
| `wrangler secret put` 报 404 | Worker 还不存在（首次部署前） | 先执行第 4 步首次 `pnpm deploy` |
| `wrangler deploy` 报绑定不存在 | `wrangler.jsonc` 里还是 `REPLACE_ME` | 回到第 2 步填真实 ID |
| `workers.dev` 能打开面板但没登录页 | 没做第 11 步关闭路由 | 关闭 `workers.dev` 路由 |
| 概览页黄色预警条 | 写入估算 > 80,000 行/天 | 调大 `interval_sec`，或升级 D1 付费版 |

回滚 Worker：`wrangler rollback`（回上一个版本）。数据库迁移**不自动回滚**，涉及
schema 变更时要单独写回退脚本。
