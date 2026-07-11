-- KS-4881 / ADR-160 §4. Идемпотентность генератора: один слот — одно
-- занятие. Обычный индекс (schedule_id, scheduled_at) заменяется на
-- UNIQUE: повторный тик крона при гонке упрётся в constraint, а не
-- создаст дубль.
DROP INDEX "study_sessions_schedule_id_scheduled_at_idx";
CREATE UNIQUE INDEX "study_sessions_schedule_id_scheduled_at_key"
    ON "study_sessions"("schedule_id", "scheduled_at");
