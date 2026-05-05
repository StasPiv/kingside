-- KS-2431 / ADR-041 §3.7. Partial UNIQUE на `puzzles(fen)` для
-- сгенерированных задач (`source='generated'`). Без него один и тот
-- же FEN из нескольких TWIC-партий породит дубли при повторных
-- запусках generator'а.
--
-- Lichess-данные (source='lichess') не трогаем — у них может быть
-- собственная дедупликация на стадии импорта.
--
-- IF NOT EXISTS — миграция идемпотентна (безопасный повторный запуск
-- если таблица уже создавалась с этим индексом, ADR §3.7).

CREATE UNIQUE INDEX IF NOT EXISTS puzzle_generated_fen_uniq
  ON puzzles (fen)
  WHERE source = 'generated';
