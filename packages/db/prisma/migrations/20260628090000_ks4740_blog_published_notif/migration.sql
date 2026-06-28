-- KS-4740. Метка «broadcast Notification разослано подписчикам
-- колокольчика на эту публикацию». Используется для идемпотентности
-- в BlogAdminService — повторная публикация / обновление статуса
-- (`status='published'` второй раз) не плодит дубли в `notifications`.
-- Nullable: NULL — broadcast ещё не сделан; timestamp — сделан и
-- помечен моментом.

ALTER TABLE "blog_posts"
  ADD COLUMN "published_notification_sent_at" TIMESTAMPTZ(3);
