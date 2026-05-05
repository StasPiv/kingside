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

### Будущие subcommand'ы (TODO)

| Subcommand | Тикет | ADR-042 |
|---|---|---|
| `sf-validate-drills` | §9.3 | Stockfish-валидатор drill'ов |
| `generate-puzzles` | KS-2431 | puzzle-генератор |
| `validate-drill-positions` | §9.3 | one-shot maintenance |
| `backfill-…/prune-…/rescore-…` | §9.3 | maintenance-скрипты |

## ENV-переменные

- `DATABASE_URL` — основная RDS (writer для `tactic_drills`, `puzzles`).
- `ARCHIVE_DATABASE_URL` — archive-RDS (reader для `archive_games`).
- `REDIS_HOST` / `REDIS_PORT` — cursor для incremental режима (TODO).
- `STOCKFISH_PATH` — путь к Stockfish (default `/usr/games/stockfish`).
- `STOCKFISH_POOL_SIZE` — размер пула SF-процессов (default 1).
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
