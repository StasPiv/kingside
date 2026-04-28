-- KS-2104: runtime feature flags. Минимальная таблица: key/value/updatedAt.
-- Дефолты для известных ключей сидятся приложением при bootstrap'е
-- (`FeatureFlagsService.bootstrapDefaults` — UPSERT при отсутствии записи).
-- Это избавляет миграцию от знания о наборе ключей и упрощает
-- добавление новых: достаточно вписать ключ в whitelist в коде.

CREATE TABLE "feature_flags" (
  "key"        TEXT      NOT NULL,
  "value"      BOOLEAN   NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);
