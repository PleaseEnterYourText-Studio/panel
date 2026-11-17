// D1 查询层：所有 SQL 均为 prepared statement，值只经 bind() 传入，不拼字符串。

export interface AssetRow {
  id: string;
  kind: string;
  name: string;
  slug: string;
  grp: string | null;
  owner_email: string | null;
  tags: string | null;
  repo: string | null;
  notes: string | null;
  enabled: number;
  created_at: number;
}

export interface TargetRow {
  id: string;
  asset_id: string;
  source: string;
  form: string;
  config: string;
  interval_sec: number;
  timeout_ms: number;
  enabled: number;
  next_run_at: number;
}

export interface CheckRow {
  id?: number;
  target_id: string;
  at: number;
  ok: number;
  latency_ms: number | null;
  error_kind: string | null;
  detail: string | null;
}

export interface RollupRow {
  target_id: string;
  bucket_min: number;
  ok_count: number;
  fail_count: number;
  sum_ms: number;
  max_ms: number;
}

export interface IncidentRow {
  id: string;
  target_id: string;
  opened_at: number;
  closed_at: number | null;
  state: string;
  cause: string | null;
}

export interface EventRow {
  id: string;
  at: number;
  kind: string;
  actor: string | null;
  asset_id: string | null;
  payload: string | null;
  ip: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  role: string;
  created_at: number;
  last_seen: number | null;
}

export interface NewAsset {
  id: string;
  kind: string;
  name: string;
  slug: string;
  grp: string | null;
  ownerEmail: string | null;
  repo: string | null;
  tags: string | null;
  notes: string | null;
  enabled: number;
  createdAt: number;
}

export async function insertAsset(db: D1Database, a: NewAsset): Promise<void> {
  await db
    .prepare(
      `INSERT INTO assets (id, kind, name, slug, grp, owner_email, tags, repo, notes, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(a.id, a.kind, a.name, a.slug, a.grp, a.ownerEmail, a.tags, a.repo, a.notes, a.enabled, a.createdAt)
    .run();
}

export async function listAssets(db: D1Database): Promise<AssetRow[]> {
  const { results } = await db.prepare(`SELECT * FROM assets ORDER BY name ASC`).all<AssetRow>();
  return results;
}

export async function getAssetBySlug(db: D1Database, slug: string): Promise<AssetRow | null> {
  return db.prepare(`SELECT * FROM assets WHERE slug = ?`).bind(slug).first<AssetRow>();
}

export async function listDueTargets(db: D1Database, now: number, limit: number): Promise<TargetRow[]> {
  // 口径：target.enabled = 1 且所属 asset.enabled = 1。停用 asset 下的 target 不再到期，
  // 因此不探测、不写 checks/rollup、不开 incident、不占 40 个分片名额。
  const { results } = await db
    .prepare(
      `SELECT t.* FROM targets t
         JOIN assets a ON a.id = t.asset_id AND a.enabled = 1
        WHERE t.enabled = 1 AND t.next_run_at <= ?
        ORDER BY t.next_run_at ASC LIMIT ?`,
    )
    .bind(now, limit)
    .all<TargetRow>();
  return results;
}

// 调度器重建状态机用：返回「新 → 旧」的最近 n 条结果（只取 ok，不取明细）。
// ORDER BY 里带 id 是为了 at 相同（同毫秒）时顺序稳定，折叠结果可复现。
export async function listRecentChecks(
  db: D1Database,
  targetId: string,
  limit: number,
): Promise<{ ok: number }[]> {
  const { results } = await db
    .prepare(`SELECT ok FROM checks_raw WHERE target_id = ? ORDER BY at DESC, id DESC LIMIT ?`)
    .bind(targetId, limit)
    .all<{ ok: number }>();
  return results;
}

export interface TargetClaim {
  id: string;
  /** 取到该行时读到的旧值；只有数据库里仍是它才允许推进（CAS）。 */
  expectedNextRunAt: number;
  nextRunAt: number;
}

// claim-first：调度器 tick 开始先用一条 batch 把本 tick 认领的 target 推进到下一周期，
// 用「旧 next_run_at」做 CAS 条件。返回真正认领成功的 id —— changes=0 说明该行已被
// 别的 tick 抢走（next_run_at 不再是取到时的值），本 tick 必须丢弃、不探测不写库。
// 一次 batch = 一次 D1 往返；逐条 UPDATE 会把 40 target 的 tick 变成 40 次往返。
export async function claimTargets(db: D1Database, claims: TargetClaim[]): Promise<string[]> {
  if (claims.length === 0) return [];
  const stmt = db.prepare(`UPDATE targets SET next_run_at = ? WHERE id = ? AND next_run_at = ?`);
  const results = await db.batch(
    claims.map((c) => stmt.bind(c.nextRunAt, c.id, c.expectedNextRunAt)),
  );
  const claimed: string[] = [];
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    if (claim !== undefined && (results[i]?.meta.changes ?? 0) > 0) claimed.push(claim.id);
  }
  return claimed;
}

export async function insertChecks(db: D1Database, checks: CheckRow[]): Promise<void> {
  if (checks.length === 0) return;
  // 一次性 batch：D1 每次 batch 只走一趟网络往返，禁止逐条 run()。
  const stmt = db.prepare(
    `INSERT INTO checks_raw (target_id, at, ok, latency_ms, error_kind, detail) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  await db.batch(checks.map((c) => stmt.bind(c.target_id, c.at, c.ok, c.latency_ms, c.error_kind, c.detail)));
}

// 契约：本函数非幂等 —— 同一条 check 重复调用会重复累加计数与耗时。
// 调度器必须保证「每个 target 每个 tick 只写一次 rollup」；重跑/重试前先确认。
// 若确实写重了，48 小时内可从 checks_raw 重新聚合修正（checks_raw 之后会被清理，
// checks_rollup 是长期唯一真相，写错不可逆）。
export async function upsertRollup(
  db: D1Database,
  targetId: string,
  bucketMin: number,
  ok: boolean,
  latencyMs: number | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO checks_rollup (target_id, bucket_min, ok_count, fail_count, sum_ms, max_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(target_id, bucket_min) DO UPDATE SET
         ok_count = ok_count + excluded.ok_count,
         fail_count = fail_count + excluded.fail_count,
         sum_ms = sum_ms + excluded.sum_ms,
         max_ms = MAX(max_ms, excluded.max_ms)`,
    )
    .bind(targetId, bucketMin, ok ? 1 : 0, ok ? 0 : 1, latencyMs ?? 0, latencyMs ?? 0)
    .run();
}

// 批量版 upsertRollup：一个 tick 的所有 rollup 一次 batch 写完（一次 D1 往返）。
// 非幂等契约不变 —— 调用方仍须保证每个 target 每个 tick 只出现一次。
export interface RollupUpsert {
  targetId: string;
  bucketMin: number;
  ok: boolean;
  latencyMs: number | null;
}

export async function upsertRollups(db: D1Database, rows: RollupUpsert[]): Promise<void> {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO checks_rollup (target_id, bucket_min, ok_count, fail_count, sum_ms, max_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(target_id, bucket_min) DO UPDATE SET
       ok_count = ok_count + excluded.ok_count,
       fail_count = fail_count + excluded.fail_count,
       sum_ms = sum_ms + excluded.sum_ms,
       max_ms = MAX(max_ms, excluded.max_ms)`,
  );
  await db.batch(
    rows.map((r) => stmt.bind(r.targetId, r.bucketMin, r.ok ? 1 : 0, r.ok ? 0 : 1, r.latencyMs ?? 0, r.latencyMs ?? 0)),
  );
}

export async function getOpenIncident(db: D1Database, targetId: string): Promise<IncidentRow | null> {
  return db
    .prepare(
      `SELECT * FROM incidents WHERE target_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`,
    )
    .bind(targetId)
    .first<IncidentRow>();
}

export interface NewIncident {
  id: string;
  targetId: string;
  openedAt: number;
  state: string;
  cause: string | null;
}

export interface NewEvent {
  id: string;
  at: number;
  kind: string;
  actor: string | null;
  assetId: string | null;
  payload: string | null;
  ip: string | null;
}

// 并发兜底：迁移 0002 建了部分唯一索引 idx_incidents_one_open（target_id where closed_at
// is null）。两个 tick 同时判定 down 时，后到的那条 INSERT 不会报错，被静默忽略。
// 返回「这次到底有没有真的插进去」，调用方据此决定要不要写 incident.opened。
export async function insertIncident(db: D1Database, i: NewIncident): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO incidents (id, target_id, opened_at, closed_at, state, cause)
       VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(i.id, i.targetId, i.openedAt, i.state, i.cause)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// 插入 incident + 写 incident.opened 事件，一次 db.batch（D1 batch 是事务）：
// 任一语句失败整批回滚，不会出现「incident 存在但事件永久缺失」的半写状态。
//
// 事件语句用 `WHERE EXISTS (SELECT 1 FROM incidents WHERE id = ?)` 守卫：同一条 batch
// 内先插 incident，事件只在「本行真的存在」时写入 —— 也就是 ON CONFLICT DO NOTHING
// 生效（并发 tick 已经开过一条 open incident）时不写重复事件。
// 插入后重新读一次 open incident，以数据库现状为准（可能是本次插的，也可能是并发那条）。
export async function insertIncidentWithEvent(
  db: D1Database,
  i: NewIncident,
  e: NewEvent,
): Promise<{ inserted: boolean; open: IncidentRow | null }> {
  const [incidentResult] = await db.batch([
    db
      .prepare(
        `INSERT INTO incidents (id, target_id, opened_at, closed_at, state, cause)
         VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(i.id, i.targetId, i.openedAt, i.state, i.cause),
    db
      .prepare(
        `INSERT INTO events (id, at, kind, actor, asset_id, payload, ip)
         SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM incidents WHERE id = ?)`,
      )
      .bind(e.id, e.at, e.kind, e.actor, e.assetId, e.payload, e.ip, i.id),
  ]);

  return {
    inserted: (incidentResult?.meta.changes ?? 0) > 0,
    open: await getOpenIncident(db, i.targetId),
  };
}

// 关闭 incident + 写 incident.closed 事件，同样一次 batch 原子写。
// 事件语句带 `AND closed_at = ? AND state = 'closed'` 守卫：只有当这条 batch 里的
// UPDATE 真的把它关掉（而不是并发已经关过）时才写事件。
// 事件 id 由 incident 派生（一条 incident 只可能关闭一次）：即使两次 close 落在同一
// 毫秒，第二次也只撞主键被 ON CONFLICT DO NOTHING 吞掉，不会产出重复事件。
export async function closeIncidentWithEvent(
  db: D1Database,
  id: string,
  at: number,
  e: NewEvent,
): Promise<boolean> {
  const eventId = `incident.closed:${id}`;
  const [closeResult] = await db.batch([
    db
      .prepare(`UPDATE incidents SET closed_at = ?, state = 'closed' WHERE id = ? AND closed_at IS NULL`)
      .bind(at, id),
    db
      .prepare(
        `INSERT INTO events (id, at, kind, actor, asset_id, payload, ip)
         SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM incidents WHERE id = ? AND closed_at = ? AND state = 'closed'
          )
         ON CONFLICT DO NOTHING`,
      )
      .bind(eventId, e.at, e.kind, e.actor, e.assetId, e.payload, e.ip, id, at),
  ]);
  return (closeResult?.meta.changes ?? 0) > 0;
}

export async function writeEvent(
  db: D1Database,
  e: {
    id: string;
    at: number;
    kind: string;
    actor: string | null;
    assetId: string | null;
    payload: string | null;
    ip: string | null;
  },
): Promise<void> {
  await db
    .prepare(`INSERT INTO events (id, at, kind, actor, asset_id, payload, ip) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(e.id, e.at, e.kind, e.actor, e.assetId, e.payload, e.ip)
    .run();
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first<UserRow>();
}
