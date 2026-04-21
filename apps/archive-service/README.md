# @kingside/archive-service

Standalone NestJS service extracted from `apps/api` (ADR-018) and merged with
the former `apps/archive-importer` worker (ADR-019, KS-1676). One codebase,
three entrypoints:

- `main.ts` — public HTTP explorer endpoints on `ARCHIVE_SERVICE_PORT` (3003).
- `importer-main.ts` — standalone importer process on `ARCHIVE_IMPORTER_PORT`
  (3004), hosts `@Interval(60_000)` TWIC scheduler + `/_/health` + `/_/metrics`.
- `importer-once.ts` — short-lived one-shot entrypoint for AWS EventBridge
  Scheduler + ECS RunTask (ADR-020). Runs one `ArchiveImportService.tickOnce()`,
  publishes CloudWatch EMF metrics, and exits. See "One-shot importer mode"
  below.

All three processes share `PrismaService` (`@kingside/archive-db`) and
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
npm run build               # nest build (produces main.js + importer-main.js + importer-once.js)
npm run dev                 # nest start --watch (HTTP)
npm run start               # node dist/main.js
npm run start:importer      # node dist/importer-main.js (long-lived, @Interval)
npm run start:importer-once # node dist/importer-once.js (one-shot, EventBridge)
npm run test                # jest
```

## One-shot importer mode (EventBridge + ECS RunTask)

`importer-once.ts` is the short-lived entrypoint designed for AWS EventBridge
Scheduler calling ECS RunTask — see ADR-020 for the full design. Differences
from `importer-main.ts`:

- **No `ScheduleModule`** — no background `@Interval` cron. `tickOnce()` is
  invoked explicitly, once, and the process exits.
- **No `HealthModule`** — no HTTP server. ECS task lifecycle replaces the
  `/_/health` probe; CloudWatch Alarms replace `/_/metrics` scrape.
- **CloudWatch EMF metrics** — `EmfMetricsPublisher` (namespace
  `Kingside/ArchiveImporter`) writes one EMF JSON record to stdout per
  enabled source plus one tick-summary record. `awslogs` driver on Fargate
  parses EMF automatically and creates CloudWatch Metrics.
- **Hard timeout 8 min inside `tickOnce()`** (via `Promise.race`) plus a
  10-min process-level backstop. On timeout, partial EMF is still flushed
  before `process.exit(124)`.

### Exit codes

| Code | Meaning |
| ---: | --- |
|    0 | Success — all due sources imported OK, or no sources were due (no-op). |
|    1 | Bootstrap failure — DI / `createApplicationContext` threw before `tickOnce`. |
|    2 | `tickOnce` completed, but at least one source failed (`run.error` set, or `ImportResult.status==='failed'`). |
|  124 | Hard timeout — either `Promise.race` inside `tickOnce` or the 10-min process-level backstop. |

### EMF metrics (published to CloudWatch via stdout)

Per-source (dimension `source`):

- `GamesAdded` (Count), `GamesSkipped` (Count), `GamesParsed` (Count)
- `ImportDurationSeconds` (Seconds)
- `SourcesFailed` (Count, 0/1) — per-source failure flag for CloudWatch Alarm
  A3 (`SourcesFailed > 0 over 1h`, differentiated by `source` dimension).
- `LastSuccessAgeSeconds` (Seconds) — seconds since `archive_sources.last_success_at`;
  always published (even for not-due sources) so the 14-day alarm triggers
  independently of the due-window. Sentinel `10 years` if `last_success_at=null`.
- `ClassicalRatio` (None, 0..1) — fraction of classical games among added;
  published **only** for runs with `ImportResult.classicalRatio !== undefined`
  (i.e. `status in 'ok'|'partial'` and `gamesAdded > 0`).

Tick-level aggregates (no dimensions, one EMF record per process):

- `SourcesChecked` (Count) — enabled sources examined.
- `SourcesProcessed` (Count) — sources where `runSource` was invoked (`due && !lockHeld`).
- `SourcesFailed` (Count) — aggregate failure count.
- `TotalGamesAdded` (Count) — sum of `gamesAdded` across all runs.
- `ExitCode` (None) — process exit code, for CloudWatch alarms without an
  `ECS Task State Change` EventBridge rule.

### Local smoke

```bash
cd apps/archive-service
npm run build
ARCHIVE_DATABASE_URL=postgresql://kingside:kingside@localhost:5432/kingside_archive \
  REDIS_HOST=localhost REDIS_PORT=6380 \
  node dist/importer-once.js
# exit 0  — success / no-op
# exit 2  — at least one source failed
# exit 124 — timeout (> 8 min inside tickOnce, or 10 min backstop)
# EMF JSON lines appear on stdout; in ECS Fargate, CloudWatch Logs extracts them into metrics.
```

## Notes

- CORS: `GET`/`HEAD` only, `credentials: false`.
- Auth: none — endpoints are public (ADR-018 §2.4).
- Redis pub/sub: HTTP process subscribes to `archive:imported` to invalidate
  cached opening trees and games-by-position pages after each importer tick.
- Scheduler runs **only** in importer-main process. HTTP process must never
  pull in `ArchiveImportModule` / `ScheduleModule` (ADR-019 §2.2).
