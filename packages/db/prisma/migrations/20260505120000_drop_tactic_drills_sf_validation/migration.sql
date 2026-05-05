-- KS-2433: удаляем Stockfish-валидацию drill'ов вместе с движком
-- из api. Поля `sf_validated_at`, `sf_rejected`, `sf_rejection_reason`
-- больше никем не читаются и не пишутся (TS-код удалён в коммите
-- 823135e3, фильтры в `tactic-drill.service` / `daily-tactic-drill
-- .service` сняты в этом же релизе).
--
-- Перед DROP COLUMN перевыпускаем индекс KS-2355: вместо
-- `(type, sf_rejected, id)` создаём `(type, id)` — keyset-random
-- (`/tactic-drill/next`) и `pickCountAttackerByValue` теперь
-- фильтруют только по `type`.
--
-- `CREATE/DROP INDEX CONCURRENTLY` нельзя в транзакции, поэтому
-- разбиваем на нетранзакционную часть (индексы) и транзакционную
-- часть (DROP COLUMN).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tactic_drills_type_id_idx"
  ON "tactic_drills" ("type", "id");

DROP INDEX CONCURRENTLY IF EXISTS "tactic_drills_type_sf_rejected_id_idx";

DROP INDEX IF EXISTS "tactic_drills_sf_validated_at_idx";

-- Партиал-индекс KS-2368 ссылается на `sf_rejected = false` в WHERE
-- clause — DROP COLUMN провалится, пока этот индекс существует.
-- Перевыпускаем без `sf_rejected`: после удаления валидации все drill'ы
-- считаются «живыми», поэтому условие `sf_rejected = false` лишнее.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tactic_drills_ca_value_v2_idx"
  ON "tactic_drills" (((answer->>'value')::int), id)
  WHERE type = 'count-attackers';

DROP INDEX CONCURRENTLY IF EXISTS "tactic_drills_ca_value_idx";

BEGIN;

ALTER TABLE "tactic_drills"
  DROP COLUMN IF EXISTS "sf_validated_at",
  DROP COLUMN IF EXISTS "sf_rejected",
  DROP COLUMN IF EXISTS "sf_rejection_reason";

COMMIT;
