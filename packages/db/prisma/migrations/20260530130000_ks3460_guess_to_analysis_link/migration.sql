-- KS-3460 / ADR-089 §6.3. Soft-ссылка из Analysis на GuessSession +
-- partial-unique для идемпотентности POST /guess/sessions/:id/to-analysis.
-- Без FK — guess-сессии могут удаляться, анализ должен выживать.

ALTER TABLE "analyses"
  ADD COLUMN "guess_session_id" UUID;

CREATE UNIQUE INDEX "analyses_user_guess_session_uniq"
  ON "analyses"("user_id", "guess_session_id");
