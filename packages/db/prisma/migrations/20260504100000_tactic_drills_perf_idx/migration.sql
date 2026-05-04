-- KS-2355: индексы для ускорения /tactic-drill/next.
--
-- Жалоба на проде: `/tactic-drill/next?type=find-loose-piece` ~15 сек
-- на банке 600k+ count-attackers / 180k+ find-loose-piece. Корень —
-- отсутствие подходящего индекса для пары `(type, sf_rejected)` +
-- `ORDER BY id LIMIT 1 OFFSET N` (планировщик шёл через PRIMARY KEY
-- с filter, что давало seq-walk по сотням тысяч строк).
--
-- Добавляем композитный индекс `(type, sf_rejected, id)`:
--   1. Покрывает фильтр `WHERE type=$1 AND sf_rejected=false`.
--   2. ORDER BY id LIMIT 1 OFFSET N — index range scan O(log N + N_skip),
--      сейчас 5–50 мс вместо 15 сек.
--   3. count(*) с тем же фильтром получит index-only scan.
--
-- `CREATE INDEX CONCURRENTLY` чтобы не блокировать запись на проде:
-- индекс строится без acquire-lock на таблицу, prod-запросы продолжают
-- работать. Минус: нельзя в транзакции, поэтому без BEGIN/COMMIT.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tactic_drills_type_sf_rejected_id_idx"
  ON "tactic_drills" ("type", "sf_rejected", "id");
