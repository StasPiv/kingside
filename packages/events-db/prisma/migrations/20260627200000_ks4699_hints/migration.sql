-- KS-4699 / ADR-147 §3.1. Таблицы hints + actor_hint_states в schema
-- events. Hint — декларативное правило (i18n, anchor, DSL rule,
-- targetActorTypes), ActorHintState — состояние подсказки per actor.
--
-- Permissions: events_writer уже имеет default INSERT/SELECT на
-- schema events (см. KS-4690 § scripts/sql/events-schema-init.sql).
-- HintsEngine читает Hint + читает/пишет ActorHintState — права
-- покрываются default-privileges, доп. GRANT'ы не нужны.

CREATE TABLE IF NOT EXISTS "events"."hints" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "key"                 VARCHAR(64)  NOT NULL,
  "i18n"                JSONB        NOT NULL,
  "cta"                 JSONB        NULL,
  "anchor"              VARCHAR(64)  NOT NULL,
  "placement"           VARCHAR(16)  NOT NULL,
  "rule"                JSONB        NOT NULL,
  "priority"            INTEGER      NOT NULL DEFAULT 0,
  "enabled"             BOOLEAN      NOT NULL DEFAULT true,
  "accepted_by"         VARCHAR(64)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(64)[],
  "target_actor_types"  VARCHAR(8)[]  NOT NULL DEFAULT ARRAY['user','guest']::VARCHAR(8)[],
  "cooldown_sec"        INTEGER      NOT NULL DEFAULT 86400,
  "ttl_sec"             INTEGER      NOT NULL DEFAULT 0,
  "max_shows"           INTEGER      NOT NULL DEFAULT 3,
  "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "deleted_at"          TIMESTAMPTZ  NULL,
  CONSTRAINT "hints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "hints_key_key" ON "events"."hints" ("key");
CREATE INDEX IF NOT EXISTS "hints_enabled_deleted_at_idx"
  ON "events"."hints" ("enabled", "deleted_at");

CREATE TABLE IF NOT EXISTS "events"."actor_hint_states" (
  "actor_id"         UUID         NOT NULL,
  "actor_type"       VARCHAR(8)   NOT NULL,
  "hint_id"          UUID         NOT NULL,
  "shown_count"      INTEGER      NOT NULL DEFAULT 0,
  "last_shown_at"    TIMESTAMPTZ  NULL,
  "dismissed_at"     TIMESTAMPTZ  NULL,
  "acted_at"         TIMESTAMPTZ  NULL,
  "suppressed_until" TIMESTAMPTZ  NULL,
  CONSTRAINT "actor_hint_states_pkey" PRIMARY KEY ("actor_id", "hint_id"),
  CONSTRAINT "actor_hint_states_hint_id_fkey"
    FOREIGN KEY ("hint_id") REFERENCES "events"."hints"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "actor_hint_states_actor_id_suppressed_until_idx"
  ON "events"."actor_hint_states" ("actor_id", "suppressed_until");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'events_writer') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "events"."hints" TO events_writer';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "events"."actor_hint_states" TO events_writer';
  END IF;
END$$;
