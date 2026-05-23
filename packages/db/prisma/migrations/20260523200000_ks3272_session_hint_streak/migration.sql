-- KS-3272 / ADR-077 §2.7.
-- Добавляем 2 поля в opening_trainer_sessions:
--   current_streak   — серия подряд правильных ходов для streak-bonus ×1.2
--   pending_hint_fen — FEN, на котором только что вызывался /hint,
--                      следующий /move из этой позиции считается «после подсказки»
ALTER TABLE "opening_trainer_sessions"
  ADD COLUMN "current_streak" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pending_hint_fen" TEXT;
