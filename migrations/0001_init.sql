-- P0 初始表结构：资产 / 监控目标 / 原始检查 / 分钟级汇总 / 事件 / 事故 / 用户
-- 时间统一存 epoch 毫秒（INTEGER），rollup 的 bucket 存分钟编号。

CREATE TABLE assets (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  grp TEXT, owner_email TEXT, tags TEXT, repo TEXT, notes TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);

CREATE TABLE targets (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  source TEXT NOT NULL, form TEXT NOT NULL, config TEXT NOT NULL,
  interval_sec INTEGER NOT NULL DEFAULT 180, timeout_ms INTEGER NOT NULL DEFAULT 8000,
  enabled INTEGER NOT NULL DEFAULT 1, next_run_at INTEGER NOT NULL
);
CREATE INDEX idx_targets_due ON targets(enabled, next_run_at);

CREATE TABLE checks_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL, at INTEGER NOT NULL,
  ok INTEGER NOT NULL, latency_ms INTEGER, error_kind TEXT, detail TEXT
);
CREATE INDEX idx_checks_raw_target_at ON checks_raw(target_id, at);

CREATE TABLE checks_rollup (
  target_id TEXT NOT NULL, bucket_min INTEGER NOT NULL,
  ok_count INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0,
  sum_ms INTEGER NOT NULL DEFAULT 0, max_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (target_id, bucket_min)
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY, target_id TEXT NOT NULL, opened_at INTEGER NOT NULL,
  closed_at INTEGER, state TEXT NOT NULL, cause TEXT
);
CREATE INDEX idx_incidents_open ON incidents(target_id, closed_at);

CREATE TABLE events (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT,
  asset_id TEXT, payload TEXT, ip TEXT
);
CREATE INDEX idx_events_at ON events(at DESC);

CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen INTEGER
);
