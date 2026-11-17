# PEYT Panel

Cloudflare Workers 上的服务器 / 服务管理面板。

## 开发

需要 Node 22+ 与 pnpm 10。

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

## 部署前

`wrangler.jsonc` 里的 `database_id` 与 KV `id` 目前是 `REPLACE_ME` 占位。创建 D1 / KV 后替换为真实 ID，再执行 `pnpm deploy`。
