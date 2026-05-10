-- KS-2698: засеять archive_sources в локальной kingside_archive.
-- Аналог того, что делает ArchiveSourcesSeedService.ensureDefaults() при
-- запуске importer-once (KS-1716, см. apps/archive-service). Здесь
-- хардкодим один источник TWIC, потому что демон `importer-main.js`
-- (которым крутится локальный compose) seed НЕ вызывает — это делает
-- только one-shot entrypoint.
--
-- Для dev-окружения cron укорочён до `*/2 * * * *` (каждые 2 минуты),
-- чтобы tick подхватил источник сразу, а не через неделю как в проде.
--
-- cursor = '1640' — TWIC issues нумеруются с 1; на маe 2026 публикуется
-- около 1640-1650. Без cursor importer пытается issue 1 (1994 год),
-- получает 404 и зависает в noop. Со стартовым курсором 1640 первый
-- tick пойдёт на issue 1641 (cursor+1) — он гарантированно
-- опубликован, что начнёт реальную скачку PGN'ов.

INSERT INTO archive_sources (id, code, name, kind, url, enabled, schedule, cursor, total_games, created_at, updated_at)
VALUES (
  gen_random_uuid(),
  'twic',
  'The Week in Chess',
  'twic',
  'https://theweekinchess.com/',
  true,
  '*/2 * * * *',
  '1640',
  0,
  NOW(),
  NOW()
)
ON CONFLICT (code) DO UPDATE SET cursor = EXCLUDED.cursor;
