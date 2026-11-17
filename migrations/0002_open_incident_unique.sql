-- 每个 target 最多一条未关闭 incident。
--
-- 为什么需要：手动探测（POST /api/probes/:id/run 把 next_run_at 拨到 0）与在飞的 cron
-- tick 可能同时判定 down，两边都读到 `open === null`，各插一条 closed_at IS NULL 的行，
-- 事件流里就会出现两条 incident.opened，故障列表也重复。
--
-- 部分索引只约束「未关闭」的行：历史 incident（closed_at 非空）不受影响，同一 target
-- 可以有多条已关闭记录。插入侧用 `ON CONFLICT DO NOTHING` 静默跳过冲突，不报错。
--
-- 注意：如果现网已经存在同一 target 的多条 open incident，本迁移会失败。P0 尚未上线，
-- 直接重建；已上线的库需要先手工关闭重复行再执行。
CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_one_open
  ON incidents(target_id)
  WHERE closed_at IS NULL;
