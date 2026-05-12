-- KS-2798: wall-clock последнего хода в партии broadcast'а.
--
-- Контекст: KS-2699 ввёл `clock_updated_at` — момент применения свежего
-- `%clk` из PGN-комментариев Lichess. Но если источник broadcast'а не
-- отдаёт clocks (старые партии, некоторые турниры), `clock_updated_at`
-- остаётся NULL, и фронт KS-2795 не может показать «последний ход
-- X минут назад». Нужен идеальный wall-clock — обновляемый при ЛЮБОМ
-- изменении основной линии PGN, независимо от наличия `%clk`.
--
-- Логика sync'а (broadcast-sync.service.ts::processPgnUpdate):
--   - при update партии: если `current_fen` фактически изменился
--     (новая позиция ⇒ был новый ход) → `last_move_at = now()`.
--   - при create партии: если PGN уже содержит ходы (fen ≠ starting)
--     → `last_move_at = now()`, иначе NULL.
--
-- Backfill: для существующих партий, у которых есть current_fen и она
-- не равна стартовой, выставляем `last_move_at = updated_at`. Это
-- приблизительная оценка (updated_at апдейтится на любой PGN-update,
-- не только при ходе), но единственный доступный сигнал для
-- ретроактивного значения. После следующего сделанного хода в партии
-- значение станет точным.

-- AlterTable
ALTER TABLE "broadcast_games" ADD COLUMN "last_move_at" TIMESTAMP(3);

-- Backfill: партии с непустой и не-стартовой позицией → updatedAt.
UPDATE "broadcast_games"
SET "last_move_at" = "updated_at"
WHERE "current_fen" IS NOT NULL
  AND "current_fen" <> 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
