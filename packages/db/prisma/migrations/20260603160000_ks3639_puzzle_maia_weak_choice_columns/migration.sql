-- KS-3639 / ADR-106 §2.5 (Precision-Maia v2, B1). Переименование
-- старой top-1 метрики в новую weak-choice + версия алгоритма.
--
-- Старая семантика (ADR-104, отменено): `maia_top1_prob` — вероятность
-- Maia top-1 угадать SF-best. На практике провалилась (KS-3630),
-- метрика заменена на `maia_weak_choice_prob` — суммарная вероятность
-- Maia по слабым ходам (loss_E > 0.02) из своего же top-K.
--
-- Семантика после миграции:
--   - `maia_weak_choice_prob` (REAL, nullable) — вероятность сыграть
--     плохо. Фронт пропускает пазл, если значение >= порога
--     (`PRECISION_MAIA_DEFAULT_THRESHOLD = 0.3`); NULL → safe pass.
--   - `maia_metric_version` (INT4, nullable) — версия алгоритма
--     (`1` = алгоритм из ADR-106 §2.1). Инкрементируется при смене
--     формулы (K_max, порог policy, порог loss_E). NULL означает «не
--     размечен новой формулой» — фронт такие строки трактует через
--     fallback (см. ADR-106 §5).
--   - `maia_top1_elo` (INT4, nullable) — без изменений: audit-поле под
--     ENV `PRECISION_MAIA_ANNOTATION_ELO`.
--
-- ВНИМАНИЕ: значения `maia_top1_prob` (uint, 0..1) переезжают физически
-- в `maia_weak_choice_prob`, но семантически НЕвалидны под новой
-- формулой (см. ADR-106 §5). T1 admin-CLI с `--force` обязан полностью
-- перезаписать значения сразу после применения миграции. До этого
-- фильтр на фронте использует порог 0 либо отключается флагом — иначе
-- старые значения top-1 будут интерпретироваться как weak-choice prob,
-- что даст массовый ошибочный отсев. См. ADR-106 §6 (декомпозиция:
-- T1 «обязательный --force сразу после миграции»).
--
-- RENAME COLUMN/INDEX в Postgres — fast DDL (catalog-only, без
-- переписывания страниц). На 6M строк выполняется мгновенно.

ALTER TABLE "puzzles"
  RENAME COLUMN "maia_top1_prob" TO "maia_weak_choice_prob";

ALTER TABLE "puzzles"
  ADD COLUMN "maia_metric_version" INT4;

ALTER INDEX "puzzles_solution_mode_maia_top1_prob_idx"
  RENAME TO "puzzles_solution_mode_maia_weak_choice_prob_idx";
