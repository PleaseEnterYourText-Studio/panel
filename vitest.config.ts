import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// vitest-pool-workers 不会自动应用 migrations/。用包自带的 readD1Migrations
// （内部走 wrangler 的 SQL 拆分器，能正确处理字符串字面量中的分号）在 Node
// 侧读出 { name, queries }，再通过 binding 注入 worker，由 tests/setup.ts 应用。
const testMigrations = await readD1Migrations('./migrations');

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
          // bypass 的双条件闸门默认只开环境位；DEV_BYPASS_EMAIL 由需要它的用例显式传。
          PANEL_ENV: 'development',
          TEST_MIGRATIONS: testMigrations,
        },
      },
    }),
  ],
  test: {
    setupFiles: ['tests/setup.ts'],
    // Vitest 默认把 CSS 模块替换成空串（css: false），连 `?raw` 也变成 ''，
    // tests/ui-shell.test.ts 需要读 tokens.css 原文，所以打开 CSS 处理。
    css: true,
  },
});
