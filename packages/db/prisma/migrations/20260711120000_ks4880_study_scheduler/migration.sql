-- KS-4880 / ADR-160 §3. Планирование занятий: расписание, сессии,
-- задания, каналы уведомлений, журнал отправки, снапшоты внешней
-- активности (lichess/chess.com).

-- 1. Расписание — 1:1 с пользователем.
CREATE TABLE "study_schedules" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "days_of_week" INTEGER[],
    "time_local" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "session_minutes" INTEGER NOT NULL DEFAULT 30,
    "focus" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "study_schedules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "study_schedules_user_id_key" ON "study_schedules"("user_id");
CREATE INDEX "study_schedules_active_idx" ON "study_schedules"("active");
ALTER TABLE "study_schedules"
    ADD CONSTRAINT "study_schedules_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Сгенерированные занятия.
CREATE TABLE "study_sessions" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "profile_snapshot" JSONB,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "study_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "study_sessions_status_scheduled_at_idx" ON "study_sessions"("status", "scheduled_at");
CREATE INDEX "study_sessions_user_id_scheduled_at_idx" ON "study_sessions"("user_id", "scheduled_at" DESC);
CREATE INDEX "study_sessions_schedule_id_scheduled_at_idx" ON "study_sessions"("schedule_id", "scheduled_at");
ALTER TABLE "study_sessions"
    ADD CONSTRAINT "study_sessions_schedule_id_fkey" FOREIGN KEY ("schedule_id")
    REFERENCES "study_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "study_sessions"
    ADD CONSTRAINT "study_sessions_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Задания занятия.
CREATE TABLE "study_tasks" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "params" JSONB,
    "target_count" INTEGER NOT NULL DEFAULT 1,
    "done_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verified_at" TIMESTAMPTZ(3),
    CONSTRAINT "study_tasks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "study_tasks_session_id_position_idx" ON "study_tasks"("session_id", "position");
ALTER TABLE "study_tasks"
    ADD CONSTRAINT "study_tasks_session_id_fkey" FOREIGN KEY ("session_id")
    REFERENCES "study_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Каналы уведомлений (telegram|email|onsite), один каждого типа
--    на пользователя. verified_at NULL = не подтверждён.
CREATE TABLE "notification_channels" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "address" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notification_channels_user_id_type_key" ON "notification_channels"("user_id", "type");
ALTER TABLE "notification_channels"
    ADD CONSTRAINT "notification_channels_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Журнал отправки уведомлений о занятии.
CREATE TABLE "study_notifications" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "study_notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "study_notifications_session_id_idx" ON "study_notifications"("session_id");
ALTER TABLE "study_notifications"
    ADD CONSTRAINT "study_notifications_session_id_fkey" FOREIGN KEY ("session_id")
    REFERENCES "study_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "study_notifications"
    ADD CONSTRAINT "study_notifications_channel_id_fkey" FOREIGN KEY ("channel_id")
    REFERENCES "notification_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. Ежедневные снапшоты внешней активности (§5.2).
CREATE TABLE "external_activity_snapshots" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "games_played" INTEGER NOT NULL DEFAULT 0,
    "ratings" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "external_activity_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "external_activity_snapshots_user_id_provider_date_key"
    ON "external_activity_snapshots"("user_id", "provider", "date");
ALTER TABLE "external_activity_snapshots"
    ADD CONSTRAINT "external_activity_snapshots_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
