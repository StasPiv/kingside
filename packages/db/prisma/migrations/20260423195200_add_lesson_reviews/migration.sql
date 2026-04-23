-- L-21 (KS-1798): SM-2 повторения уроков (ADR-025).
-- Одна запись на пару (userId, lessonId). Создаётся при первом прохождении
-- урока со score ≥ 80, обновляется при каждом последующем повторе.
-- Выборка «к повторению сегодня» идёт on-demand через индекс (user_id, due_at).

CREATE TABLE "lesson_reviews" (
    "id"                UUID             NOT NULL,
    "user_id"           UUID             NOT NULL,
    "lesson_id"         UUID             NOT NULL,
    "easiness"          DOUBLE PRECISION NOT NULL DEFAULT 2.5,
    "interval"          INTEGER          NOT NULL DEFAULT 1,
    "repetitions"       INTEGER          NOT NULL DEFAULT 0,
    "due_at"            TIMESTAMP(3)     NOT NULL,
    "last_reviewed_at"  TIMESTAMP(3),
    "last_quality"      INTEGER,
    "created_at"        TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "lesson_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lesson_reviews_user_id_lesson_id_key" ON "lesson_reviews"("user_id", "lesson_id");
CREATE INDEX        "lesson_reviews_user_id_due_at_idx"    ON "lesson_reviews"("user_id", "due_at");

ALTER TABLE "lesson_reviews"
    ADD CONSTRAINT "lesson_reviews_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lesson_reviews"
    ADD CONSTRAINT "lesson_reviews_lesson_id_fkey"
    FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
