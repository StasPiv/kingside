-- KS-4987: откат Vision-тренажёра (ADR-167 не санкционирован).
-- Удаляем таблицу vision_scores (создана миграцией 20260720100000).
-- DROP TABLE снимает индексы и FK на users автоматически.
DROP TABLE IF EXISTS "vision_scores";
