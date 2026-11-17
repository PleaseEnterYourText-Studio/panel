import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// vitest-pool-workers 不会自动应用 migrations/，测试进程在 Node 里把 SQL 读成
// applyD1Migrations 需要的 { name, queries } 结构，通过 binding 注入 worker。
// 注意：sql.split(';') 只适用于本仓库的迁移（不含字符串字面量里的分号）。
const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url));
const testMigrations = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((name) => ({
    name,
    queries: readFileSync(join(migrationsDir, name), 'utf8')
      .split(';')
      .map((query) => query.trim())
      .filter((query) => query.length > 0),
  }));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // 测试用兼容日期低于生产：@cloudflare/vitest-pool-workers@0.23.0
        // 内嵌 wrangler 4.124.0 + miniflare 5.20260815，其 workerd 最高支持
        // 2026-08-22；生产用 wrangler.jsonc 的 2026-11-01（wrangler 4.163.0
        // 的 workerd 1.20261116.1）。覆盖使两边成为不同的运行时，2026-08-23
        // ~ 2026-11-01 新增的 compat flag 会测试通过、生产不一致。
        // 移除条件：迁移到 @cloudflare/vitest-plugin 后两边共用同一个 workerd，
        // 即可删掉这行覆盖，让测试直接继承 wrangler.jsonc 的日期。
        compatibilityDate: '2026-08-22',
        bindings: {
          ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com',
          ACCESS_AUD: 'test-aud',
          ENCRYPTION_KEY: 'test-key-0123456789abcdef0123456789',
          TEST_MIGRATIONS: testMigrations,
        },
      },
    }),
  ],
  test: {
    setupFiles: ['tests/setup.ts'],
  },
});
