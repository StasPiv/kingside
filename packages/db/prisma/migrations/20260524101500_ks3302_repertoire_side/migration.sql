-- KS-3302. Сторона тренировки фиксируется на репертуаре, не выбирается
-- при каждом старте сессии. Default 'white' для существующих записей.
ALTER TABLE "opening_repertoires"
  ADD COLUMN "side" TEXT NOT NULL DEFAULT 'white';
