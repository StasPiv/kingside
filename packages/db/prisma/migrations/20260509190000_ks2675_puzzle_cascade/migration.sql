-- KS-2675. Cascade-FK при удалении пазла.
--
-- DELETE /puzzles/:id падал 500 на FK constraint
-- `puzzle_attempts_puzzle_id_fkey` (default RESTRICT). Чтобы автор/
-- админ мог удалить свой пазл вместе со связанной историей,
-- переключаем FK на ON DELETE CASCADE. Аффектные таблицы:
--   * `puzzle_attempts` — попытки решения; без пазла бессмысленны.
--   * `puzzle_rush_session_puzzles` — позиция в rush-сессии.
--   * `daily_puzzles` — выбор пазла дня.
--
-- `user_mistakes.puzzle_id_fkey` уже ON DELETE SET NULL (mistake-row
-- — про конкретный момент партии, остаётся валидной без ссылки на
-- источник).
--
-- Идемпотентно: каждый ALTER оборачиваем в DROP CONSTRAINT IF EXISTS
-- + ADD CONSTRAINT с явными параметрами.

ALTER TABLE "puzzle_attempts"
  DROP CONSTRAINT IF EXISTS "puzzle_attempts_puzzle_id_fkey";
ALTER TABLE "puzzle_attempts"
  ADD CONSTRAINT "puzzle_attempts_puzzle_id_fkey"
  FOREIGN KEY ("puzzle_id") REFERENCES "puzzles"("id")
  ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "puzzle_rush_session_puzzles"
  DROP CONSTRAINT IF EXISTS "puzzle_rush_session_puzzles_puzzle_id_fkey";
ALTER TABLE "puzzle_rush_session_puzzles"
  ADD CONSTRAINT "puzzle_rush_session_puzzles_puzzle_id_fkey"
  FOREIGN KEY ("puzzle_id") REFERENCES "puzzles"("id")
  ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "daily_puzzles"
  DROP CONSTRAINT IF EXISTS "daily_puzzles_puzzle_id_fkey";
ALTER TABLE "daily_puzzles"
  ADD CONSTRAINT "daily_puzzles_puzzle_id_fkey"
  FOREIGN KEY ("puzzle_id") REFERENCES "puzzles"("id")
  ON UPDATE CASCADE ON DELETE CASCADE;
