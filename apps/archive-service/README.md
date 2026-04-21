# @kingside/archive-service

Standalone NestJS service extracted from `apps/api` (ADR-018) and merged with
the former `apps/archive-importer` worker (ADR-019, KS-1676). One codebase,
two entrypoints:

- `main.ts` — public HTTP explorer endpoints on `ARCHIVE_SERVICE_PORT` (3003).
- `importer-main.ts` — standalone importer process on `ARCHIVE_IMPORTER_PORT`
  (3004), hosts `@Interval(60_000)` TWIC scheduler + `/_/health` + `/_/metrics`.

Both processes share `PrismaService` (`@kingside/archive-db`) and
`RedisService`.

## Endpoints

HTTP process (`main.ts`, port 3003) — archive explorer, **no path prefix**:

- `GET /tree` — opening tree for a FEN (cached via Redis).
- `GET /games` — filtered game listing.
- `GET /games/:id` — single game detail (includes PGN).
- `GET /games/by-position` — keyset-paginated list of games reaching a FEN.

Service endpoints — under the `/_` prefix to avoid collision with archive
paths (exposed by both HTTP and importer processes):

- `GET /_/health` — executes `SELECT 1` against the archive database with a
  500 ms timeout and returns `{ status: 'ok' | 'degraded' }`.
- `GET /_/metrics` — Prometheus scrape endpoint (prom-client default + archive
  counters / histogram / gauge; importer process additionally registers
  `archive_import_*` / `archive_games_by_category_total` / etc.).

## CLI utilities

```bash
npm run cli:backfill                  # fill archive_game_positions from archive_games
npm run cli:classify-existing         # recompute time_control/category/is_classical
npm run cli:cleanup-positions         # drop positions of non-classical games
npm run cli:rebuild-position-stats    # TRUNCATE + rebuild position_stats
```

All CLIs pull deps from DI via `NestFactory.createApplicationContext(ImporterModule)`.

## Env

| Name | Description | Default |
| --- | --- | --- |
| `ARCHIVE_DATABASE_URL` | Postgres DSN for archive DB | required |
| `REDIS_HOST` | Redis host (shared HTTP + importer) | `localhost` |
| `REDIS_PORT` | Redis port | `6380` |
| `ARCHIVE_SERVICE_PORT` | HTTP explorer port | `3003` |
| `ARCHIVE_IMPORTER_PORT` | Importer health/metrics port | `3004` |
| `CORS_ORIGIN` | Comma-separated list of allowed origins | unset (dev: any localhost) |
| `ARCHIVE_STATS_IMPL` | Stats backend (`postgres` only today) | `postgres` |
| `ARCHIVE_PREWARM_DISABLE` | Set to `1` to disable top-position pre-warm | unset |

## Scripts

```bash
npm run build           # nest build (produces main.js + importer-main.js)
npm run dev             # nest start --watch (HTTP)
npm run start           # node dist/main.js
npm run start:importer  # node dist/importer-main.js
npm run test            # jest
```

## Notes

- CORS: `GET`/`HEAD` only, `credentials: false`.
- Auth: none — endpoints are public (ADR-018 §2.4).
- Redis pub/sub: HTTP process subscribes to `archive:imported` to invalidate
  cached opening trees and games-by-position pages after each importer tick.
- Scheduler runs **only** in importer-main process. HTTP process must never
  pull in `ArchiveImportModule` / `ScheduleModule` (ADR-019 §2.2).
