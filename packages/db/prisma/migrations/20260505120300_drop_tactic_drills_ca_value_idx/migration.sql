-- KS-2433/KS-2435 (часть 4/5). Дроп старого partial-индекса KS-2368
-- (`tactic_drills_ca_value_idx`) — он содержит `sf_rejected = false`
-- в WHERE clause, что заблокировало бы DROP COLUMN sf_rejected.
-- Замена создана в 20260505120200.

DROP INDEX CONCURRENTLY IF EXISTS "tactic_drills_ca_value_idx";
