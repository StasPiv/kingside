-- KS-2659. Fix data-mismatch: для пазлов с `source='generated'` поле
-- `solution_mode` должно быть `'play-vs-engine'` (ADR-050 §3 #1).
--
-- Источник проблемы (см. KS-2657, KS-2659): `POST /puzzles/batch`
-- использовал `solutionMode: p.solutionMode ?? 'forced-line'` — если
-- KS-2584 клиентский WDL-генератор не передавал поле, в БД попадал
-- `'forced-line'`. Frontend ожидал PVE-runner на `/precision` и
-- ломался; KS-2657 прикрыл defensive override'ом, эта миграция чинит
-- БД.
--
-- Идемпотентно (повторный запуск меняет 0 строк).
-- Лог количества обновлённых строк — через RAISE NOTICE (виден в
-- `prisma migrate deploy` stdout).

DO $$
DECLARE
  fixed INT;
BEGIN
  UPDATE puzzles
     SET solution_mode = 'play-vs-engine'
   WHERE source = 'generated'
     AND solution_mode IS DISTINCT FROM 'play-vs-engine';
  GET DIAGNOSTICS fixed = ROW_COUNT;
  RAISE NOTICE 'KS-2659: fixed solution_mode for % generated puzzles', fixed;
END
$$;
