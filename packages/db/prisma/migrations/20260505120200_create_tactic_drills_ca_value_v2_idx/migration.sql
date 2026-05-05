-- KS-2433/KS-2435 (часть 3/5). Перевыпускаем partial-индекс KS-2368
-- (`tactic_drills_ca_value_idx`) без условия `sf_rejected = false`
-- — после удаления SF-валидации все count-attackers drill'ы считаются
-- «живыми». Старый индекс будет дропнут в следующей миграции, чтобы
-- ALTER TABLE DROP COLUMN sf_rejected потом не упал на FK к WHERE
-- условию.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tactic_drills_ca_value_v2_idx"
  ON "tactic_drills" (((answer->>'value')::int), id)
  WHERE type = 'count-attackers';
