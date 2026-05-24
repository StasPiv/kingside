-- KS-3290 (M2 B4). Поле для review-режима: какая именно линия сейчас
-- review'ится (pathUci из OpeningLineProgress). Используется в
-- makeMove чтобы знать какой pathHash апдейтить через SM-2 на
-- wrong / clean-line-complete. NULL для не-review сессий.
ALTER TABLE "opening_trainer_sessions"
  ADD COLUMN "review_line_path_uci" JSONB;
