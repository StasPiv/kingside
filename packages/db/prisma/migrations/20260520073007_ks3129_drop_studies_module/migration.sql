-- KS-3129 / ADR-067 §3.6 — drop модуля Studies.
--
-- Удаляются 5 таблиц студийного модуля. Код, обращавшийся к ним,
-- удалён в KS-3128 (B1+S1). На prod-БД данных нет (см. ADR-067 §1.4),
-- бэкап перед миграцией не требуется.
--
-- Порядок удаления — от листьев FK к корню:
--   study_invites → study_likes → study_members → study_chapters → studies
-- Все FK на студийные таблицы снимаются автоматически вместе с DROP TABLE.
-- FK на users.id (owner, member, like, invite.creator) снимаются как часть
-- студийных таблиц; users остаётся нетронутым.

DROP TABLE IF EXISTS "study_invites";
DROP TABLE IF EXISTS "study_likes";
DROP TABLE IF EXISTS "study_members";
DROP TABLE IF EXISTS "study_chapters";
DROP TABLE IF EXISTS "studies";

-- Чистка устаревшей записи feature-flag (KS-3128 убрал ключ из whitelist).
DELETE FROM "feature_flags" WHERE "key" = 'studiesEnabled';
