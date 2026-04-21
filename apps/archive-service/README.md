# @kingside/archive-service

Standalone NestJS HTTP service extracted from `apps/api` (ADR-018). Serves the
public archive explorer endpoints backed by the dedicated archive database
(`packages/archive-db`).

## Endpoints

Archive endpoints — **no path prefix**, controllers declared with `@Controller()`:

- `GET /tree` — opening tree for a FEN (cached via Redis).
- `GET /games` — filtered game listing.
- `GET /games/:id` — single game detail (includes PGN).
- `GET /games/by-position` — keyset-paginated list of games reaching a FEN.

Service endpoints — under the `/_` prefix to avoid collision with archive
paths:

- `GET /_/health` — executes `SELECT 1` against the archive database with a
  500 ms timeout and returns `{ status: 'ok' | 'degraded' }`.
- `GET /_/metrics` — Prometheus scrape endpoint (prom-client default + archive
  counters / histogram / gauge).

## Env

| Name | Description | Default |
| --- | --- | --- |
| `ARCHIVE_DATABASE_URL` | Postgres DSN for archive DB | required |
| `REDIS_HOST` | Redis host (same Redis as archive-importer) | `localhost` |
| `REDIS_PORT` | Redis port | `6380` |
| `ARCHIVE_SERVICE_PORT` | HTTP port | `3003` |
| `CORS_ORIGIN` | Comma-separated list of allowed origins | unset (dev: any localhost) |
| `ARCHIVE_STATS_IMPL` | Stats backend (`postgres` only today) | `postgres` |
| `ARCHIVE_PREWARM_DISABLE` | Set to `1` to disable top-position pre-warm | unset |

## Scripts

```bash
npm run build   # nest build
npm run dev     # nest start --watch
npm run start   # node dist/main.js
npm run test    # jest
```

## Notes

- CORS: `GET`/`HEAD` only, `credentials: false`.
- Auth: none — endpoints are public (ADR-018 §2.4).
- Redis pub/sub: subscribes to `archive:imported` to invalidate cached
  opening trees and games-by-position pages after each import run.
