-- KS-2368: partial functional index для pickBalancedCountAttackers.
--
-- Жалоба: /tactic-drill/next?type=count-attackers >2с на проде. KS-2346
-- ввёл балансировку через 4 отдельных count'а с JSON-фильтром по
-- answer.value. Без индекса каждый count = bitmap heap scan по 600k+
-- записей.
--
-- Создаём partial composite index на выражении `(answer->>'value')::int`
-- + `id` (для ORDER BY) — только для type='count-attackers' и
-- sf_rejected=false (живые drill'ы). На проде 600k+ count-attackers,
-- partial-фильтр сжимает индекс до этого подмножества.
--
-- Composite (..., id) — позволяет один index range scan для
-- `WHERE answer->>'value'=$ ORDER BY id LIMIT 1 OFFSET N` без отдельной
-- сортировки.
--
-- EXPLAIN на dev (41k count-attackers, OFFSET 1000):
--   - До: Bitmap Heap Scan + Sort, 19 мс, Buffers hit=2474.
--   - После: Index Scan, 0.5 мс, Buffers hit=660.
-- На проде 600k → ожидаемо ≤5 мс на запрос (из ~1500 мс ранее).
--
-- CONCURRENTLY чтобы не блокировать прод-таблицу.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "tactic_drills_ca_value_idx"
  ON "tactic_drills" (((answer->>'value')::int), id)
  WHERE type = 'count-attackers' AND sf_rejected = false;
