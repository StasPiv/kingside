-- KS-2226 (ADR-035 §4, Drills E2).
-- Три таблицы для тактических drill'ов:
--   1. tactic_drills            — каталог drill-задач (генератор + куратор).
--   2. tactic_drill_attempts    — попытки авторизованных пользователей.
--      user_id nullable: на v1 записываем только зарегистрированных; поле
--      зарезервировано на случай анонимного логирования (v2).
--   3. tactic_drill_sprint_scores — итоги 3-/5-минутных sprint-сессий.
--
-- Индексы покрывают типичные хот-запросы:
--   - tactic_drills (type, difficulty)         — выборка следующего drill.
--   - tactic_drill_attempts (user_id, created_at) — история попыток юзера.
--   - tactic_drill_attempts (drill_id)         — статистика по конкретному drill.
--   - tactic_drill_sprint_scores (mode, score) — лидерборд по mode.
--   - tactic_drill_sprint_scores (user_id, created_at) — личный таймлайн.

BEGIN;

-- ── tactic_drills ───────────────────────────────────────────────────
CREATE TABLE "tactic_drills" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "type"       TEXT         NOT NULL,
  "fen"        TEXT         NOT NULL,
  "answer"     JSONB        NOT NULL,
  "difficulty" INTEGER      NOT NULL,
  "source"     TEXT         NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tactic_drills_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tactic_drills_type_difficulty_idx"
  ON "tactic_drills" ("type", "difficulty");

-- ── tactic_drill_attempts ───────────────────────────────────────────
CREATE TABLE "tactic_drill_attempts" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "user_id"      UUID,
  "drill_id"     UUID         NOT NULL,
  "correct"      BOOLEAN      NOT NULL,
  "time_ms"      INTEGER      NOT NULL,
  "answer_given" JSONB        NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tactic_drill_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tactic_drill_attempts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "tactic_drill_attempts_drill_id_fkey"
    FOREIGN KEY ("drill_id") REFERENCES "tactic_drills"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "tactic_drill_attempts_user_id_created_at_idx"
  ON "tactic_drill_attempts" ("user_id", "created_at");
CREATE INDEX "tactic_drill_attempts_drill_id_idx"
  ON "tactic_drill_attempts" ("drill_id");

-- ── tactic_drill_sprint_scores ──────────────────────────────────────
CREATE TABLE "tactic_drill_sprint_scores" (
  "id"           UUID             NOT NULL DEFAULT gen_random_uuid(),
  "user_id"      UUID             NOT NULL,
  "score"        INTEGER          NOT NULL,
  "drills_count" INTEGER          NOT NULL,
  "accuracy"     DOUBLE PRECISION NOT NULL,
  "mode"         TEXT             NOT NULL,
  "created_at"   TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tactic_drill_sprint_scores_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tactic_drill_sprint_scores_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "tactic_drill_sprint_scores_mode_score_idx"
  ON "tactic_drill_sprint_scores" ("mode", "score");
CREATE INDEX "tactic_drill_sprint_scores_user_id_created_at_idx"
  ON "tactic_drill_sprint_scores" ("user_id", "created_at");

COMMIT;
