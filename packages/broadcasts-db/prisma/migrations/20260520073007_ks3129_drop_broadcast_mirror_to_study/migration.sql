-- KS-3129 / ADR-067 §3.6 — снять поля broadcast → study mirror.
--
-- Модуль Studies удалён (KS-3128 B1+S1); broadcast-service больше не
-- использует поля `mirror_to_study` / `mirrored_study_slug` и индекс
-- по `mirror_to_study`. Колонки и индекс удаляются.

DROP INDEX IF EXISTS "broadcast_rounds_mirror_to_study_idx";
ALTER TABLE "broadcast_rounds" DROP COLUMN IF EXISTS "mirrored_study_slug";
ALTER TABLE "broadcast_rounds" DROP COLUMN IF EXISTS "mirror_to_study";
