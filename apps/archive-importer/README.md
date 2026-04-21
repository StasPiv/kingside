# @kingside/archive-importer

Воркер для автоматического импорта партий из открытых архивов (TWIC и др.) и индексации позиций по ADR-013 §5.

## Что делает

- Периодически (по расписанию) опрашивает источники архивов, зарегистрированные в таблице `archive_sources`.
- Скачивает новые архивы (ZIP/PGN), парсит партии и сохраняет их в БД.
- Прогресс импортов фиксирует в таблице `archive_imports`.
- После импорта запускает position indexer — индексирует позиции партий (FEN → game_id) для поиска по позиции.

## Запуск локально

```bash
# из корня монорепо
npm run dev -w @kingside/archive-importer
```

Воркер подхватит `ARCHIVE_DATABASE_URL` (подключение к archive-БД, см. `packages/archive-db`), `REDIS_HOST` и `REDIS_PORT` из переменных окружения (см. `.env` в корне). До ADR-018 использовался общий `DATABASE_URL` — больше не читается.

## Запуск в docker-compose

```bash
docker compose up archive-importer
# или билд отдельно
docker compose build archive-importer
```

Сервис описан в корневом `docker-compose.yml`, зависит от `postgres` и `redis`.

## Проверка работы

1. В логах при старте должна появиться запись о запуске планировщика (`scheduler started` / `[archive-importer] ...`).
2. Проверка в БД:

   ```sql
   SELECT id, name, url, last_checked_at FROM archive_sources;
   SELECT source_id, status, games_imported, started_at, finished_at
     FROM archive_imports
     ORDER BY started_at DESC
     LIMIT 10;
   ```

3. Метрики (если включены) — см. `src/metrics.ts`.

## Сборка

```bash
npm run build -w @kingside/archive-importer
```

Артефакты в `apps/archive-importer/dist/`. В production-образе запуск через `npx tsx src/index.ts` (без отдельного build-шага, см. `Dockerfile`).
