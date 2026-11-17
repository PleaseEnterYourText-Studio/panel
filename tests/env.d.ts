// cloudflare:test 的 env 类型是全局 Cloudflare.Env（workers-types 里默认空接口）。
// 这里补齐测试会碰到的绑定，并补上 vitest.config.ts 注入的迁移数据。
// 生产代码仍用自己的 src/env.ts，不依赖此文件。
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    KV: KVNamespace;
    ASSETS: Fetcher;
    ENCRYPTION_KEY: string;
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    DEV_BYPASS_EMAIL?: string;
    TEST_MIGRATIONS: { name: string; queries: string[] }[];
  }
}
