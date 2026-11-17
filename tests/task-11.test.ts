import { describe, expect, it } from 'vitest';
import { needsWriteWarning, overviewHeadline, quotaWarningText } from '../web/lib/quota';
import overviewSource from '../web/routes/Overview.tsx?raw';
import deployDoc from '../docs/deploy.md?raw';
import readme from '../README.md?raw';
import wranglerConfig from '../wrangler.jsonc?raw';

// 概览页没有 DOM 测试（P0 不装 @testing-library），行为靠纯函数 + 源码守卫锁住：
// 锁的是「删了就坏」的那几行，不是实现细节。

describe('写入额度预警（纯函数）', () => {
  it('warns only above 80,000 rows/day', () => {
    expect(needsWriteWarning(80_000)).toBe(false);
    expect(needsWriteWarning(80_001)).toBe(true);
    expect(needsWriteWarning(0)).toBe(false);
    expect(needsWriteWarning(100_000)).toBe(true);
  });

  it('states the estimate, the free-plan ceiling and the fix', () => {
    const text = quotaWarningText(80_001);
    expect(text).toContain('80,001');
    expect(text).toContain('100,000');
    expect(text).toContain('interval_sec');
  });
});

describe('概览主标题', () => {
  it('says everything is fine only when nothing is red', () => {
    expect(overviewHeadline({ okCount: 3, suspectCount: 0, downCount: 0, unknownCount: 0 })).toBe('全部正常。');
  });

  it('omits the zero half of the failure summary', () => {
    expect(overviewHeadline({ okCount: 2, suspectCount: 1, downCount: 0, unknownCount: 0 })).toBe('1 个疑似。');
    expect(overviewHeadline({ okCount: 2, suspectCount: 0, downCount: 1, unknownCount: 0 })).toBe('1 个故障。');
    expect(overviewHeadline({ okCount: 2, suspectCount: 2, downCount: 1, unknownCount: 0 })).toBe(
      '1 个故障，2 个疑似。',
    );
  });

  it('never calls "no data" healthy', () => {
    expect(overviewHeadline({ okCount: 0, suspectCount: 0, downCount: 0, unknownCount: 4 })).toBe('4 个无数据。');
  });

});

describe('Overview 页契约', () => {
  it('polls /api/overview every 30 seconds', () => {
    expect(overviewSource).toContain('/api/overview');
    expect(overviewSource).toContain('setInterval');
    expect(overviewSource).toContain('30_000');
  });

  it('reuses the quota predicate instead of inlining the threshold', () => {
    expect(overviewSource).toContain('needsWriteWarning');
    expect(overviewSource).not.toContain('80_000');
    expect(overviewSource).not.toContain('80000');
  });

  it('shows four labelled counters plus the refresh clock', () => {
    for (const label of ['正常', '疑似', '故障', '无数据']) {
      expect(overviewSource).toContain(label);
    }
    expect(overviewSource).toContain('最近一次刷新');
    expect(overviewSource).toContain('formatClock');
  });

  it('links the quota warning to the services page', () => {
    expect(overviewSource).toContain('href="/services"');
  });

  it('always shows the write estimate, not only above the warning line', () => {
    expect(overviewSource).toContain('每日写入估算');
    expect(overviewSource).toContain('writeEstimate');
  });

  it('shows the real error status instead of swallowing it', () => {
    expect(overviewSource).toContain('describeError');
    expect(overviewSource).toContain('ApiError');
  });

  it('does not invent a tick time when lastTickAt is null', () => {
    expect(overviewSource).toContain('还没有巡检记录');
  });
});

describe('不许造假数据', () => {
  it('has no hardcoded uptime percentage', () => {
    expect(overviewSource).not.toContain('97.1');
    expect(overviewSource).not.toContain('%');
  });

  it('has no hardcoded clock literal', () => {
    // 只允许通过 formatClock 渲染时间；HH:MM:SS 字面量一律视为编造。
    expect(overviewSource).not.toMatch(/\b\d{2}:\d{2}:\d{2}\b/);
    expect(overviewSource).not.toMatch(/\b\d{1,2}:\d{2}\b/);
  });
});

describe('部署文档', () => {
  it('exists and is the only deployment entry point', () => {
    // 用 ?raw import 断言文件存在且内容够长：Workers pool 里 cwd 是 /bundle，
    // 不是仓库根，readFileSync 读不到工作区文件。
    expect(deployDoc.length).toBeGreaterThan(1000);
  });

  it('keeps every command the operator has to copy', () => {
    for (const cmd of [
      'pnpm install',
      'd1 create',
      'kv namespace create',
      'secret put ENCRYPTION_KEY',
      'openssl rand -base64 32',
      'ACCESS_TEAM_DOMAIN',
      'ACCESS_AUD',
      'db:migrate:remote',
      'pnpm deploy',
      'curl -s https://',
      '/api/health',
      'users',
      'interval_sec',
    ]) {
      expect(deployDoc, `docs/deploy.md 缺少：${cmd}`).toContain(cmd);
    }
  });

  it('documents the default-deny bootstrap step for the first owner', () => {
    expect(deployDoc).toMatch(/INSERT INTO users/);
    expect(deployDoc).toContain("'owner'");
    expect(deployDoc).toContain('默认拒绝');
  });

  it('documents cron, probe interval and the free-plan write budget', () => {
    expect(deployDoc).toContain('每分钟');
    expect(deployDoc).toContain('180');
    expect(deployDoc).toContain('100,000');
  });

  // Important 1：wrangler secret put 在 Worker 不存在时 404，必须排在首次 deploy 之后。
  it('puts the secret only after the worker exists', () => {
    const firstDeploy = deployDoc.indexOf('\npnpm deploy\n');
    const secretAt = deployDoc.indexOf('\npnpm exec wrangler secret put ENCRYPTION_KEY\n');
    expect(firstDeploy).toBeGreaterThan(0);
    expect(secretAt).toBeGreaterThan(firstDeploy);
  });

  // Important 2：域名 → Access → vars → 二次部署 的可执行链路。
  it('orders domain binding and Access before the redeploy that carries the vars', () => {
    const domainAt = deployDoc.indexOf('Custom domain');
    const accessAt = deployDoc.indexOf('Self-hosted');
    const varsAt = deployDoc.indexOf('"ACCESS_TEAM_DOMAIN"');
    const redeployAt = deployDoc.indexOf('## 8.');
    expect(domainAt).toBeGreaterThan(0);
    expect(accessAt).toBeGreaterThan(domainAt);
    expect(varsAt).toBeGreaterThan(accessAt);
    expect(redeployAt).toBeGreaterThan(varsAt);
    expect(deployDoc).toContain('"vars"');
  });

  // Important 3：/api/health 匿名 curl 只在 Access 有 Bypass 时成立；两处说法一致。
  it('explains the Access bypass and the service-token fallback for /api/health', () => {
    expect(deployDoc).toContain('Bypass');
    expect(deployDoc).toContain('api/health');
    expect(deployDoc).toContain('CF-Access-Client-Id');
    expect(deployDoc).toContain('CF-Access-Client-Secret');
  });

  // Minor：workers.dev 不属于自己的 zone，建不出合法 Access 应用。
  it('warns against the workers.dev Access fallback and tells you to disable the route', () => {
    expect(deployDoc).toContain('不要用 `*.workers.dev` 域名建 Access 应用');
    expect(deployDoc).not.toContain('或用 `*.workers.dev` 那条域名');
    expect(deployDoc).toContain('workers_dev');
    expect(deployDoc).toContain('关闭 `workers.dev` 路由');
  });

  // Minor：预算按自然日，不是工作日。
  it('states a daily budget, not a working-day budget', () => {
    expect(deployDoc).toContain('含周末');
    expect(deployDoc).not.toContain('每个工作日');
    expect(deployDoc).not.toContain('每工作日');
  });

  // B4：公式必须带写入系数 3，换算按「每次探测写 3 行」重算（180s ≈ 1,440 行/target，
  // 70 顶满、56 预警）。旧文档按 1 行/probe 算成 480/208/167，会让人以为还很有余量。
  it('states the write estimate with the 3-row factor and correct target counts', () => {
    expect(deployDoc).toContain('floor(Σ 86400 / interval_sec) * 3');
    expect(deployDoc).toContain('1,440');
    expect(deployDoc).toContain('70 个');
    expect(deployDoc).toContain('56 个');
    expect(deployDoc).not.toContain('208 个');
    expect(deployDoc).not.toContain('167 个');
  });

  // B1：生产不要设 DEV_BYPASS_EMAIL；PANEL_ENV 不是 development 时它被忽略。
  it('warns that the dev bypass is production-dangerous and gated by PANEL_ENV', () => {
    expect(deployDoc).toContain('DEV_BYPASS_EMAIL');
    expect(deployDoc).toContain('PANEL_ENV');
    expect(deployDoc).toContain('完全忽略');
  });

  // S9：P0 手工录 target 的可复制示例 + config 防呆点。
  it('shows how to insert an asset and a target by hand', () => {
    expect(deployDoc).toContain('INSERT INTO assets');
    expect(deployDoc).toContain('INSERT INTO targets');
    expect(deployDoc).toContain('expectStatus');
    expect(deployDoc).toContain("CAST(strftime('%s','now') AS INTEGER) * 1000");
    expect(deployDoc).toContain('必须是合法 JSON');
  });
});

describe('README 快速开始', () => {
  it('points at docs/deploy.md', () => {
    expect(readme).toContain('快速开始');
    expect(readme).toContain('docs/deploy.md');
  });

  it('states the license', () => {
    expect(readme).toContain('AGPL-3.0');
  });
});

// 防止文档里出现「照抄就炸」的旧命令：wrangler d1 migrations 的顺序是先 apply 再 deploy，
// 反过来 deploy 会拿到空库。
describe('部署文档顺序', () => {
  it('migrates before deploying', () => {
    // 全文里 'pnpm deploy' 会先作为警告出现在第 1 节，'db:migrate:remote' 也出现在
    // README 式命令串里；这里只比对两节代码块里的命令行本身（带换行锚定）。
    const migrateAt = deployDoc.indexOf('\npnpm db:migrate:remote\n');
    const deployAt = deployDoc.indexOf('\npnpm deploy\n');
    expect(migrateAt).toBeGreaterThan(0);
    expect(deployAt).toBeGreaterThan(migrateAt);
  });

  it('mentions that migrations live in migrations/', () => {
    expect(deployDoc).toContain('migrations/');
  });
});

describe('仓库文件检查', () => {
  it('has a wrangler config with the DB and KV bindings', () => {
    expect(wranglerConfig).toContain('"binding": "DB"');
    expect(wranglerConfig).toContain('"binding": "KV"');
    expect(wranglerConfig).toContain('"crons"');
  });
});

// 审阅修复（docs/deploy.md）：这些事实错误会直接卡住照抄的人，钉死在测试里。
describe('部署文档事实修正', () => {
  it('does not claim ENCRYPTION_KEY is used in P0', () => {
    expect(deployDoc).toContain('只声明、尚未使用');
    expect(deployDoc).not.toContain('用于审计');
  });

  it('explains why the first deploy comes before the secret', () => {
    expect(deployDoc).toContain('## 为什么是这个顺序');
    expect(deployDoc).toContain('要求 Worker 已经存在');
  });

  it('warns that the first deploy is unprotected', () => {
    expect(deployDoc).toContain('此时面板没有任何身份保护');
  });
});
