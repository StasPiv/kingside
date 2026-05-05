-- KS-2433/KS-2435 (часть 2/5). Дроп старого KS-2355 индекса
-- `(type, sf_rejected, id)`. Замена `tactic_drills_type_id_idx`
-- создана в предыдущей миграции 20260505120000.

DROP INDEX CONCURRENTLY IF EXISTS "tactic_drills_type_sf_rejected_id_idx";
