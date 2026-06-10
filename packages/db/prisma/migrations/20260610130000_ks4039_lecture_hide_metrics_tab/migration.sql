-- KS-4039. Поле `hide_metrics_tab` для `Lecture` — флажок «скрыть блок
-- "Метрики" у зрителей-учеников» в режиме лекции. Default false — все
-- существующие лекции получают видимый блок без явного backfill.

ALTER TABLE "lectures"
  ADD COLUMN "hide_metrics_tab" BOOLEAN NOT NULL DEFAULT FALSE;
