-- KS-4695 / ADR-147 §6.2. Согласие пользователя на трекинг analytics-
-- событий. Default false — все существующие записи получают «нет
-- согласия», analytics events для них отбрасываются на входе
-- (EventsService.track). Восстановление согласия — через банер +
-- PATCH /me/consent (Этап 2 ADR-147, отдельная задача).

ALTER TABLE "users"
  ADD COLUMN "analytics_consent" BOOLEAN NOT NULL DEFAULT false;
