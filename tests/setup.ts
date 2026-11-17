import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// 每个测试文件跑在独立的 worker isolate 里，迁移随 setupFiles 一起应用，
// 因此无需在测试里手动建表；测试之间共享同一个本地 D1，靠唯一主键隔离。
