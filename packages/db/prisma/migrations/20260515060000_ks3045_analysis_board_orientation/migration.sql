-- KS-3045: per-user-per-analysis ориентация доски.
--
-- Поправка к KS-3044, где фронт реализовал переключатель через
-- localStorage. Пользователь захотел синк между устройствами —
-- значение должно жить в БД рядом с `current_position`.
--
-- Семантика:
--   - `null`        — не задано, фронт берёт свой дефолт.
--   - `'white'`     — белые внизу.
--   - `'black'`     — чёрные внизу.
--
-- Безопасность: enum-тип создаётся «с нуля», колонка nullable без
-- default. ALTER TABLE ADD COLUMN NULL в Postgres мгновенный, не
-- блокирует runtime, существующие записи получают `NULL`.

CREATE TYPE "BoardOrientation" AS ENUM ('white', 'black');

ALTER TABLE "analyses"
  ADD COLUMN "board_orientation" "BoardOrientation";
