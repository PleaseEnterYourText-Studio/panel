# PEYT Panel

Cloudflare Workers 上的服务器 / 服务管理面板。

## 快速开始

**线上部署（D1 / KV / Access / 迁移 / 首个 owner / 自检）看 [`docs/deploy.md`](docs/deploy.md)。**
那份文档是给运维照抄的，包含全部命令的顺序；本文件只讲本地开发与仓库约定。

本地开发最短路径：

```bash
pnpm install
cp .dev.vars.example .dev.vars     # 填本地 secrets
pnpm db:migrate:local              # 初始化本地 D1
pnpm exec wrangler dev             # 终端 A：Worker + 本地 D1/KV，:8787
pnpm dev                           # 终端 B：Vite 前端，/api 代理到 :8787
```

## 开发

需要 Node 22.12+ 与 pnpm 10。

```bash
pnpm install
cp .dev.vars.example .dev.vars   # 填写本地 secrets
```

开两个终端：

- 终端 A：`pnpm exec wrangler dev` —— Worker + 本地 D1/KV，监听 `http://127.0.0.1:8787`
- 终端 B：`pnpm dev` —— Vite 前端，`/api` 通过 proxy 转发到 `127.0.0.1:8787`

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm test` | 跑 Workers pool 测试（vitest） |
| `pnpm exec tsc --noEmit` | 类型检查 |
| `pnpm build` | 构建前端到 `dist/web` |
| `pnpm deploy` | 构建并部署到 Cloudflare |
| `pnpm db:migrate:local` | 本地应用 D1 migrations |
| `pnpm db:migrate:remote` | 远端应用 D1 migrations |

## 测试与部署的运行时差异

**测试跑在一个更老的 workerd 上，不是生产那个。** 具体：

- 生产：`wrangler@4.163.0` → `workerd 1.20261116.1`，compatibility date 用 `wrangler.jsonc` 的 `2026-11-01`。
- 测试：`@cloudflare/vitest-pool-workers@0.23.0` 自带 `wrangler@4.124.0` + `miniflare 5.20260815`，其 workerd 最高只支持 `2026-08-22`，所以 `vitest.config.ts` 里显式覆盖成 `2026-08-22`。
- 仓库因此存在两套 wrangler/miniflare/workerd。任何在 `2026-08-23` ~ `2026-11-01` 之间新增的 compat flag，都会表现为「测试通过、生产行为不同」，且没有任何报错信号。
- 排查运行时相关 bug 时，先确认它是否只是这个日期差造成的。升级测试栈后需重新核对两边版本是否对齐。
- 移除条件：迁移到 `@cloudflare/vitest-plugin`，两边共用同一个 workerd，即可删掉 `compatibilityDate` 覆盖。

TODO(migrate): @cloudflare/vitest-pool-workers → @cloudflare/vitest-plugin

## 部署前

`wrangler.jsonc` 里的 `database_id` 与 KV `id` 目前是 `REPLACE_ME` 占位。创建 D1 / KV 后替换为真实 ID，再执行 `pnpm deploy`。完整步骤见 [`docs/deploy.md`](docs/deploy.md)。

## 许可证

本项目以 **AGPL-3.0** 发布，全文见 [`LICENSE`](LICENSE)。修改后以网络服务形式对外提供，同样需要按 AGPL-3.0 提供完整源码。
