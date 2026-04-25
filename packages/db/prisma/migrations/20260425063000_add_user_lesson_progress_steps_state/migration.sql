-- KS-1879: store per-step state for user-lesson progress so the
-- step-progress API can be idempotent by stepId and the UI can
-- restore the state of a previously played lesson.
--
-- Backward-compat: existing rows get an empty object via DEFAULT.
ALTER TABLE "user_lesson_play_progress"
  ADD COLUMN "steps_state" JSONB NOT NULL DEFAULT '{}'::jsonb;
