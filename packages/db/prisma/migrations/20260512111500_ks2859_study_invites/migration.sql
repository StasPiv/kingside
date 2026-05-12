-- KS-2856 / ADR-060 §3.2 / KS-2859 (Wave A B3). Mini-table для
-- одноразовых приглашений в студию. Token — nanoid 32 симв., TTL
-- 7 дней. Используется для contributor-flow:
--   POST /api/studies/:slug/invite-link → возвращает {token, expiresAt}.
--   POST /api/studies/invites/:token/accept → текущий user становится
--     contributor, токен помечается acceptedAt.
--
-- Cleanup истёкших токенов — лениво в сервисе при попытке accept
-- (отказ → 404 «invite expired»). Жёсткий cron-cleaner — не нужен
-- в MVP, объёмы скромные (десятки приглашений на студию).

CREATE TABLE "study_invites" (
    "token"            VARCHAR(32) NOT NULL,
    "study_id"         UUID NOT NULL,
    "created_by_id"    UUID NOT NULL,
    "expires_at"       TIMESTAMP(3) NOT NULL,
    "accepted_at"      TIMESTAMP(3),
    "accepted_by_id"   UUID,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_invites_pkey" PRIMARY KEY ("token")
);

CREATE INDEX "study_invites_study_id_idx" ON "study_invites"("study_id");
CREATE INDEX "study_invites_expires_at_idx" ON "study_invites"("expires_at");

ALTER TABLE "study_invites"
  ADD CONSTRAINT "study_invites_study_id_fkey"
  FOREIGN KEY ("study_id") REFERENCES "studies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "study_invites"
  ADD CONSTRAINT "study_invites_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
