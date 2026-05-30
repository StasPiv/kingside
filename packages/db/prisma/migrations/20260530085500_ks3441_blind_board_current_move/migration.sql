-- KS-3441 / ADR-088 §11 B2. Текущий ход компа `{from, to}` храним
-- отдельно от `next_target_piece` (та после ответа игрока становится
-- target для следующего хода). Без этого нельзя восстановить состояние
-- между POST /sessions и POST /sessions/:id/answer на разных запросах.

ALTER TABLE "blind_board_sessions"
  ADD COLUMN "current_comp_move" JSONB;
