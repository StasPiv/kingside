# tactic-worker

NestJS standalone CLI-сервис для offline-логики тактик (KS-2438 / ADR-042).
Запускается как ECS Fargate Spot RunTask с разными subcommand'ами через
`containerOverrides.command`.

## Subcommand'ы

### `index-tactic-drills` (этап M0, KS-2438)

Drill-индексер: читает партии из archive-RDS (`archive_games`), прогоняет
их через 7 predicate'ов tactical-pattern, вычисляет difficulty и пишет
results в `tactic_drills` основной БД.

**Запуск локально:**
```bash
ARCHIVE_DATABASE_URL=postgresql://... \
DATABASE_URL=postgresql://... \
node dist/main.js index-tactic-drills [--max-games=N] [--cursor=UUID] ...
```

Полный список флагов — в `src/cli/index-tactic-drills.cli.ts` или вывод
`node dist/main.js index-tactic-drills --help` (TODO).

**Запуск через ECS RunTask:**
```bash
aws ecs run-task \
  --cluster kingside --region eu-central-1 \
  --capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=1 \
  --task-definition kingside-tactic-worker \
  --network-configuration 'awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=ENABLED}' \
  --overrides '{
    "containerOverrides": [{
      "name": "kingside-tactic-worker",
      "command": ["node","dist/main.js","index-tactic-drills","--max-games=inf"]
    }]
  }'
```

### `generate-puzzles` (KS-2431, рефакторинг KS-2464 — ADR-044)

Puzzle-генератор в режиме **play-vs-engine**. Алгоритм:

1. На каждом ply ≥ `startPly` — `analyzePositionWdl(fenBefore, multiPV=2)`.
2. Фильтры зевка:
   - `samePv1` — ход партии = первой линии движка → не зевок.
   - `skipDecided` — `|wdlBefore| > skipDecidedWdl` (default 0.95) — партия
     уже решена.
   - `gameOver` — позиция терминальная.
3. Применяем ход → `analyzePositionWdl(fenAfter, multiPV=2)`.
4. Условие зевка: `blunderΔ ≥ blunderDelta` (default 0.6) И
   `wdlAfterForSolver ≥ minWdlAfterBlunder` (default 0.5).
5. **Solvability check**: `halfMovesN` полуходов Stockfish-vs-Stockfish
   из позиции после зевка. Если WDL для решающей упал ниже
   `failThreshold` или не достиг `winThreshold` через `halfMovesN` —
   позиция отбрасывается.
6. Insert в `puzzles` с `solutionMode='play-vs-engine'`, `moves=''`,
   `acceptedMoves=null`, `sourceMetadata` JSON (blunderMove,
   wdlBeforeBlunder, wdlAfterBlunder, halfMovesN, win/fail thresholds,
   engineParams).

**Запуск локально:**
```bash
ARCHIVE_DATABASE_URL=postgresql://... \
DATABASE_URL=postgresql://... \
node dist/main.js generate-puzzles \
  --solution-mode=play-vs-engine \
  --max-games=1000 \
  --time-ms=1000 \
  --blunder-delta=0.6 \
  --half-moves-n=6 \
  --win-threshold=0.5 \
  --fail-threshold=0.0 \
  --skip-decided-wdl=0.95 \
  --min-wdl-after-blunder=0.5 \
  --min-rating=2400
```

Полный список флагов — в шапке `src/cli/generate-puzzles.cli.ts`.

### `validate-etalons`, `dump-puzzles`

См. соответствующие файлы в `src/cli/`.

### `analyze-pgn` — research-инструмент (не production)

CLI subcommand для калибровки порогов на одной партии или маленьком
наборе. Не пишет в БД, не используется в проде. Берёт PGN-файл, для
каждого ply печатает per-position таблицу с WDL, blunderΔ, spread,
геометрическими предикатами и финальным вердиктом. Поддерживает
мульти-game параллелизм и эксперименты с ранним выходом.

```bash
DATABASE_URL=postgresql://... STOCKFISH_POOL_SIZE=16 \
node dist/main.js analyze-pgn \
  --pgn-file=/tmp/game.pgn \
  --time-ms=1000 \
  --blunder-delta=0.3 \
  --spread-delta=0.2 \
  --max-games=100
```

Используется исключительно для подбора порогов перед изменениями в
`puzzle-generator/generator-pipeline.ts`.

### Будущие subcommand'ы (TODO)

| Subcommand | Тикет | ADR-042 |
|---|---|---|
| `sf-validate-drills` | §9.3 | Stockfish-валидатор drill'ов |
| `validate-drill-positions` | §9.3 | one-shot maintenance |
| `backfill-…/prune-…/rescore-…` | §9.3 | maintenance-скрипты |

## ENV-переменные

- `DATABASE_URL` — основная RDS (writer для `tactic_drills`, `puzzles`).
- `ARCHIVE_DATABASE_URL` — archive-RDS (reader для `archive_games`).
- `REDIS_HOST` / `REDIS_PORT` — cursor для incremental режима (TODO).
- `STOCKFISH_PATH` — путь к Stockfish (default `/usr/games/stockfish`).
- `STOCKFISH_POOL_SIZE` — размер пула SF-процессов (default 1).
- `STOCKFISH_THREADS` — потоков на один SF-процесс (default 1; >1 —
  lazy SMP, нерепродуцируемо между запусками).
- `STOCKFISH_LOG_TIMINGS=1` — включает per-position лог в stderr
  (timestamp/worker-id/label) для отладки параллелизма.
- `NODE_EXTRA_CA_CERTS` — путь к AWS RDS CA bundle (`/app/apps/tactic-worker/certs/rds-ca.pem`).
- `ARCHIVE_PG_CA_PATH` — override CA для archive-RDS (опционально).
- `ARCHIVE_PG_NO_VERIFY=1` — hotfix-bypass SSL для archive-RDS (опционально).

## Локальная сборка

```bash
# Из корня монорепо:
docker build -f apps/tactic-worker/Dockerfile -t kingside-tactic-worker:local .

# Smoke с справкой:
docker run --rm kingside-tactic-worker:local
```

## Архитектура

См. [`docs/adr/042-tactic-worker-extraction.md`](../../docs/adr/042-tactic-worker-extraction.md).
Связанные тикеты: KS-2438 (skeleton), KS-2439 (инфра), KS-2440 (sf-validator
перенос), KS-2431 (puzzle-generator).
