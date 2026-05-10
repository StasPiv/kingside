-- KS-2699: clocks игроков на странице broadcast'а.
--
-- Lichess broadcast PGN содержит `%clk H:MM:SS` комментарии после каждого
-- хода (стандарт PGN annotation). До KS-2699 broadcast-sync эти комментарии
-- удалял на этапе `computeFenAndLastUci`, время игроков нигде не сохранялось.
--
-- Новые поля `broadcast_games`:
--   - `white_clock_ms` (BIGINT, nullable) — оставшееся время белых, мс
--     (на момент `clock_updated_at`).
--   - `black_clock_ms` (BIGINT, nullable) — оставшееся время чёрных, мс.
--   - `clock_updated_at` (TIMESTAMP, nullable) — момент применения свежего
--     `%clk` (фронт отсчитывает текущее значение активной стороны как
--     `<clock_ms> - (now - clock_updated_at)`).
--
-- Все три nullable: для партий до KS-2699 / партий без `%clk` остаются null,
-- API/UI отрабатывают placeholder без таймеров.

-- AlterTable
ALTER TABLE "broadcast_games" ADD COLUMN "white_clock_ms" BIGINT;
ALTER TABLE "broadcast_games" ADD COLUMN "black_clock_ms" BIGINT;
ALTER TABLE "broadcast_games" ADD COLUMN "clock_updated_at" TIMESTAMP(3);
