-- KS-4982 / ADR-167 §5.1: модель VisionScore — итог Sprint-сессии
-- Vision-тренажёра (зрение доски). Генерация/подсчёт на клиенте, сервер
-- хранит только агрегат. userId nullable (гость не сохраняется).
CREATE TABLE "vision_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "mode" TEXT NOT NULL,
    "time_mode" TEXT NOT NULL,
    "difficulty" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "max_streak" INTEGER NOT NULL,
    "avg_response_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vision_scores_pkey" PRIMARY KEY ("id")
);

-- Индекс лидерборда: топ по (mode, timeMode, score).
CREATE INDEX "vision_scores_mode_time_mode_score_idx" ON "vision_scores"("mode", "time_mode", "score");

-- Индекс истории/статистики пользователя.
CREATE INDEX "vision_scores_user_id_created_at_idx" ON "vision_scores"("user_id", "created_at");

ALTER TABLE "vision_scores" ADD CONSTRAINT "vision_scores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
