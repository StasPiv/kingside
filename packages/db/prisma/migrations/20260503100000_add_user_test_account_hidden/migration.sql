-- KS-2255 (ADR-036 §3, screenshot tooling E1).
-- Добавляем два флага в users для будущей фильтрации в публичных
-- endpoint'ах (KS-2256) и seed-скрипта screenshot tooling.
--
-- Backward-compatible: оба поля NOT NULL DEFAULT FALSE — существующие
-- строки получают `false`, никаких runtime-эффектов до KS-2256.

BEGIN;

ALTER TABLE "users"
  ADD COLUMN "is_test_account" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "is_hidden"       BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
