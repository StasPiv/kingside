-- KS-4028. Удаление колонок cp_before / cp_after из precision_attempt_moves.
--
-- Контекст: precision-snapshot всегда содержит WDL (UCI_ShowWDL у Stockfish 18
-- WASM включён по умолчанию для всех PVE-пазлов). Резервный расчёт через
-- сантипешки в precision-расчёте не используется и удалён из shared/api по
-- запросу пользователя. Колонки в БД больше не пишутся — дропаем.
--
-- Архивные значения cp по уже сыгранным precision-попыткам теряются
-- безвозвратно (сознательное решение пользователя).

ALTER TABLE "precision_attempt_moves" DROP COLUMN IF EXISTS "cp_before";
ALTER TABLE "precision_attempt_moves" DROP COLUMN IF EXISTS "cp_after";
