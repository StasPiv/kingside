-- KS-2433: удаляем Stockfish-валидацию drill'ов вместе с движком
-- из api. Поля `sf_validated_at`, `sf_rejected`, `sf_rejection_reason`
-- больше никем не читаются и не пишутся (TS-код удалён в коммите
-- 823135e3, фильтры сняты в 3d6b534c / bbcbd208).
--
-- Prisma migrate deploy выполняет каждый ;-разделённый statement
-- отдельно (не оборачивает файл в общую транзакцию), поэтому
-- CREATE/DROP INDEX CONCURRENTLY работают штатно. BEGIN/COMMIT здесь
-- не используем — даёт конфликт с CONCURRENTLY (см. провалившийся
-- деплой digest 3f712213).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tactic_drills_type_id_idx"
  ON "tactic_drills" ("type", "id");

DROP INDEX CONCURRENTLY IF EXISTS "tactic_drills_type_sf_rejected_id_idx";

DROP INDEX IF EXISTS "tactic_drills_sf_validated_at_idx";

-- Партиал-индекс KS-2368 ссылается на `sf_rejected = false` в WHERE
-- clause — DROP COLUMN провалится, пока этот индекс существует.
-- Перевыпускаем без `sf_rejected`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tactic_drills_ca_value_v2_idx"
  ON "tactic_drills" (((answer->>'value')::int), id)
  WHERE type = 'count-attackers';

DROP INDEX CONCURRENTLY IF EXISTS "tactic_drills_ca_value_idx";

ALTER TABLE "tactic_drills"
  DROP COLUMN IF EXISTS "sf_validated_at",
  DROP COLUMN IF EXISTS "sf_rejected",
  DROP COLUMN IF EXISTS "sf_rejection_reason";
