-- KS-4691 / ADR-147 §2.3 + §2.4. Инициализация таблицы `events.actor_events`
-- (native partitioned by RANGE created_at, weekly через pg_partman,
-- retention 90 дней) и трёх matviews-счётчиков `actor_event_counts_*`.
--
-- Предусловия (T1a / KS-4690 — отдельная devops-миграция):
--   * Extension `pg_partman` (>=5.2) и `pg_cron` в `kingside-db`.
--   * Схема `events` существует.
--   * Роль `events_writer` (LOGIN, USAGE на schema events,
--     INSERT/SELECT через default privileges).
--   * Cron-задача `events-partman-maintenance` зарегистрирована и
--     вызывает `partman.run_maintenance_proc()` ежечасно
--     (см. scripts/sql/events-schema-init.sql).
--
-- На локали без pg_partman/pg_cron миграция делает defensive-skip
-- partman-блоков (см. DO/IF EXISTS). Таблица и matviews создаются
-- всегда — этого хватает для unit/integration smoke на одной
-- начальной партиции.

-- ─── 1. Создание partitioned-таблицы ────────────────────────────────
--
-- Композитный PK (id, created_at) — обязательное требование native
-- partitioning: partition-key должен входить в каждый UNIQUE/PK.
-- BigSerial идёт глобальной последовательностью `events.actor_events_id_seq`
-- (не per-partition), монотонность id сохраняется.

CREATE TABLE IF NOT EXISTS "events"."actor_events" (
  "id"          BIGSERIAL  NOT NULL,
  "actor_id"    UUID       NOT NULL,
  "actor_type"  VARCHAR(8) NOT NULL,
  "type"        VARCHAR(64) NOT NULL,
  "payload"     JSONB      NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("id", "created_at")
)
PARTITION BY RANGE ("created_at");

COMMENT ON TABLE "events"."actor_events"
  IS 'KS-4691 / ADR-147 §2.3. Append-only лог событий actor (user|guest). '
     'Native partitioned по created_at, weekly через pg_partman, retention 90 дней.';

-- ─── 2. Template-таблица для индексов partman ───────────────────────
--
-- pg_partman copy'ит структуру template-таблицы (включая индексы) при
-- создании каждой новой партиции — это единственный способ получить
-- одинаковые индексы на всех будущих партициях без ручного DDL.
-- Сам template-таблица не используется для данных.
--
-- Имя `actor_events_template` — конвенция (default `<parent>_template`).
-- Колонки должны полностью совпадать с parent (включая типы и DEFAULT).

CREATE TABLE IF NOT EXISTS "events"."actor_events_template" (
  LIKE "events"."actor_events" INCLUDING ALL
);

-- Основной «рабочий» индекс DSL §2.3 — ходим по `(actor_id, type)`
-- с убывающей сортировкой `created_at` (свежие сверху).
-- На template создаём один раз — наследуется каждой партицией.
CREATE INDEX IF NOT EXISTS "actor_events_template_actor_id_type_created_at_idx"
  ON "events"."actor_events_template" ("actor_id", "type", "created_at" DESC);

-- Вторичный индекс по created_at — для retention/diagnostic-запросов
-- (партиционирование уже делает большую часть работы, но индекс
-- остаётся стандартным паттерном Prisma `@@index([createdAt])`).
CREATE INDEX IF NOT EXISTS "actor_events_template_created_at_idx"
  ON "events"."actor_events_template" ("created_at");

-- ─── 3. pg_partman: parent registration + retention ─────────────────
--
-- Defensive: если extension не доступен (локаль без pg_partman) —
-- блок пропускается, таблица остаётся просто partitioned без авто-
-- управления. Прод (T1a) гарантирует наличие pg_partman 5.2+.

DO $$
DECLARE
  v_partman_present boolean;
  v_already_managed boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_partman'
  ) INTO v_partman_present;

  IF NOT v_partman_present THEN
    RAISE NOTICE '[events-db] pg_partman не установлен — partition-management не настраивается. Дев-режим без партиций ОК для smoke-тестов.';
    RETURN;
  END IF;

  -- Уже зарегистрировано? Идемпотентность миграции (повторный накат).
  SELECT EXISTS (
    SELECT 1 FROM partman.part_config WHERE parent_table = 'events.actor_events'
  ) INTO v_already_managed;

  IF v_already_managed THEN
    RAISE NOTICE '[events-db] events.actor_events уже зарегистрирована в partman.part_config — skip create_parent.';
  ELSE
    -- weekly партиции, native, премэйк 4 будущих окна, template
    -- с нашими индексами выше.
    PERFORM partman.create_parent(
      p_parent_table        => 'events.actor_events',
      p_control             => 'created_at',
      p_interval            => '1 week',
      p_premake             => 4,
      p_template_table      => 'events.actor_events_template'
    );
    RAISE NOTICE '[events-db] partman.create_parent OK (weekly, premake=4).';
  END IF;

  -- Retention 90 дней. retention_keep_table=false → партиции
  -- ДРОПАЮТСЯ целиком (мгновенно vs многочасовой DELETE+VACUUM).
  UPDATE partman.part_config
     SET retention            = '90 days',
         retention_keep_table = false
   WHERE parent_table = 'events.actor_events';

  RAISE NOTICE '[events-db] retention=90 days, retention_keep_table=false применены.';
END$$;

-- ─── 4. Materialized views агрегатов (ADR-147 §2.4) ─────────────────
--
-- Три счётчика по окнам 24h/7d/30d. Уникальный индекс `(actor_id, type)`
-- обязателен для `REFRESH MATERIALIZED VIEW CONCURRENTLY` (Postgres
-- требование, см. docs §SQL-REFRESHMATERIALIZEDVIEW).
--
-- В фильтре по `created_at > now() - interval ...` — `now()` стабильно
-- в рамках одного REFRESH (один snapshot), что даёт детерминированный
-- результат для consumer'ов внутри тика. Между тиками — eventually
-- consistent (это и требуется для UI-подсказок, см. §2.4).

CREATE MATERIALIZED VIEW IF NOT EXISTS "events"."actor_event_counts_24h" AS
SELECT
  actor_id,
  actor_type,
  type,
  count(*)::bigint     AS cnt,
  max(created_at)      AS last_at
FROM "events"."actor_events"
WHERE created_at > now() - interval '24 hours'
GROUP BY actor_id, actor_type, type
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS "actor_event_counts_24h_actor_type_idx"
  ON "events"."actor_event_counts_24h" ("actor_id", "type");

CREATE MATERIALIZED VIEW IF NOT EXISTS "events"."actor_event_counts_7d" AS
SELECT
  actor_id,
  actor_type,
  type,
  count(*)::bigint     AS cnt,
  max(created_at)      AS last_at
FROM "events"."actor_events"
WHERE created_at > now() - interval '7 days'
GROUP BY actor_id, actor_type, type
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS "actor_event_counts_7d_actor_type_idx"
  ON "events"."actor_event_counts_7d" ("actor_id", "type");

CREATE MATERIALIZED VIEW IF NOT EXISTS "events"."actor_event_counts_30d" AS
SELECT
  actor_id,
  actor_type,
  type,
  count(*)::bigint     AS cnt,
  max(created_at)      AS last_at
FROM "events"."actor_events"
WHERE created_at > now() - interval '30 days'
GROUP BY actor_id, actor_type, type
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS "actor_event_counts_30d_actor_type_idx"
  ON "events"."actor_event_counts_30d" ("actor_id", "type");

-- ─── 5. Permissions для events_writer ───────────────────────────────
--
-- KS-4690 уже выставил DEFAULT PRIVILEGES для events_writer на TABLES
-- в schema events. Для УЖЕ созданных только что объектов default
-- privileges не применяются — нужно явно GRANT'ить.
--
-- Защитно (роли может не быть на локали без bootstrap-скрипта):

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'events_writer') THEN
    EXECUTE 'GRANT INSERT, SELECT ON "events"."actor_events" TO events_writer';
    EXECUTE 'GRANT SELECT ON "events"."actor_event_counts_24h" TO events_writer';
    EXECUTE 'GRANT SELECT ON "events"."actor_event_counts_7d" TO events_writer';
    EXECUTE 'GRANT SELECT ON "events"."actor_event_counts_30d" TO events_writer';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE "events"."actor_events_id_seq" TO events_writer';
  ELSE
    RAISE NOTICE '[events-db] роль events_writer отсутствует — GRANT пропущены (локальный dev). Создаётся в scripts/sql/events-schema-init.sql.';
  END IF;
END$$;
