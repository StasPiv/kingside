-- KS-2754. UCI ответного хода движка на user-ход в precision_attempt_moves.
-- NULL для последнего user-полухода (движок не успел) и для legacy-attempt'ов.
ALTER TABLE "precision_attempt_moves"
  ADD COLUMN "engine_uci" TEXT;
