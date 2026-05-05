# ADR-042: Выделение tactic-worker из apps/api (drill-индексер + puzzle-генератор + Stockfish-валидатор)

**Статус:** Предложено
**Дата:** 2026-05-05
**Задача:** KS-2432
**Связанные ADR:**
- [ADR-018 archive-service extraction](./018-archive-service-extraction.md) — образец «выделить часть NestJS из api в отдельный сервис».
- [ADR-019 archive-importer merge into service](./019-archive-importer-merge-into-service.md), [ADR-020 EventBridge schedule](./020-archive-importer-eventbridge-schedule.md) — образец «headless CLI worker на ECS RunTask».
- [ADR-021/022 broadcast-service / broadcast-worker](./021-broadcast-service-extraction.md) — ещё один прецедент multi-image.
- [ADR-035 tactical pattern drills](./035-tactical-pattern-drills.md) — описывает drill-предикаты и indexer-pipeline, которые переезжают.
- [ADR-041 tactical puzzle generation](./041-tactical-puzzle-generation.md) — генератор был спроектирован под `apps/api`; этот ADR корректирует место запуска (см. §7).
- KS-2410 / KS-2411 — закрытие инфра-долга (RunTask без env override и TLS-bypass) для api; для tactic-worker нужно повторить.

---

## 1. Структура нового сервиса

### 1.1 Имя

**`apps/tactic-worker`.** Имя выбрано по аналогии с `archive-importer` / `broadcast-worker` (хотя те — другие домены): «worker» сигналит «это headless CLI без HTTP-сервера».

Альтернативы рассмотрены:
- `apps/tactic-generator` — узко (предполагает только генерацию, а сюда едет ещё SF-валидатор и maintenance-скрипты).
- `apps/drill-worker` — узко (ещё и puzzle-gen внутри).
- `apps/stockfish-worker` — слишком про инструмент, не про назначение.

### 1.2 Тип runtime

**NestJS standalone application** (`NestFactory.createApplicationContext()`), не HTTP-сервер.

Обоснование:
- Прецедент в монорепо: api, game-service, archive-service, broadcast-service — все Nest. Один паттерн разработки, общие конвенции DI, ConfigModule, Logger.
- Существующий `StockfishService` (`apps/api/src/engine/stockfish.service.ts`) `@Injectable()` — переиспользуем как есть, не переписываем на bare-Node child-process.
- DI-граф для воркера: `ConfigModule` → `StockfishService` + `PrismaService` (запись в основную БД) + raw `pg.Client` (чтение архивной БД). Через `createApplicationContext` поднимаем без HTTP-listener'а — нет порта, нет CORS, нет middleware.
- CLI-диспатч живёт в `main.ts`:
  ```ts
  const app = await NestFactory.createApplicationContext(AppModule);
  const cmd = process.argv[2];
  switch (cmd) {
    case 'index-drills':       await app.get(DrillIndexerCli).run(process.argv.slice(3)); break;
    case 'generate-puzzles':   await app.get(PuzzleGeneratorCli).run(process.argv.slice(3)); break;
    case 'sf-validate-drills': await app.get(DrillSfValidatorCli).run(process.argv.slice(3)); break;
    case 'maintenance':        await app.get(MaintenanceCli).run(process.argv.slice(3)); break;
    default: throw new Error('unknown command');
  }
  await app.close();
  ```
- ECS RunTask передаёт subcommand через `containerOverrides.command`. Один task-def, разные команды.

Альтернативы рассмотрены и отклонены:
- **Bare Node CLI без Nest** (как было `apps/archive-importer` до ADR-019). Минус: нужно вручную провязывать `StockfishService` (он `@Injectable`), `ConfigService`, логгеры. Получается копипаст конструктор-инициализации. Не выигрываем существенно в RSS / cold-start (Nest standalone-context стартует за ~150 ms, для batch-задачи это шум).
- **Несколько отдельных микро-сервисов** (`drill-indexer`, `puzzle-generator`, `sf-validator`). Минус: тройное переиспользование Dockerfile, ECS task-def, Secrets. Вся offline-логика — один домен.

### 1.3 Что переносится из `apps/api`

Через `git mv` (коммит, который не теряет историю):

| Откуда (apps/api) | Куда (apps/tactic-worker) | Зачем |
|---|---|---|
| `src/tactic-drill/predicates/` (целиком) | `src/predicates/` | Используются индексером и tagging'ом puzzle'ов. **В api на runtime не нужны** — `TacticDrillValidatorService` сравнивает `userAnswer` с эталоном из БД, predicate не запускает. |
| `src/tactic-drill/indexer-pipeline.ts` | `src/drill-indexer/indexer-pipeline.ts` | Reusable pipeline для drill-генерации. |
| `src/tactic-drill/difficulty.ts` | `src/drill-indexer/difficulty.ts` | Используется indexer-pipeline. |
| `src/tactic-drill/pg-ssl.ts` (если выделено) | `src/lib/pg-ssl.ts` | Helper для archive-RDS. |
| `src/tactic-drill/tactic-drill-incremental.scheduler.ts` | удаляется в api, заменяется на CLI-команду + EventBridge schedule | Cron-тик внутри api → external schedule (см. §4 / §5). |
| `src/tactic-drill/tactic-drill-sf-validator.service.ts` | `src/sf-validator/drill-sf-validator.service.ts` | Offline batch SF-валидатор drill'ов (find-hanging-piece). |
| `src/tactic-drill/tactic-drill-sf-validator.scheduler.ts` | удаляется в api, заменяется на CLI + schedule | Аналогично incremental-scheduler. |
| `src/scripts/index-tactic-drills.ts` | `src/scripts/index-drills.ts` (CLI command) | Превращается в `node dist/main.js index-drills …` через CLI-диспатчер. |
| `src/scripts/validate-drill-positions.ts` | `src/scripts/validate-drill-positions.ts` | Offline-инструмент, не нужен в api. |
| `src/scripts/backfill-find-all-checks-meta.ts` | `src/scripts/backfill-find-all-checks-meta.ts` | One-shot maintenance, переезжает. |
| `src/scripts/backfill-count-attackers-meta.ts` | (то же) | (то же) |
| `src/scripts/prune-xray-affected.ts`, `prune-find-pin.ts`, `rescore-count-attackers.ts` | (то же) | (то же) |
| `src/scripts/index-pgn-oneshot.ts` | (то же) | One-shot maintenance. |

**Новое в `apps/tactic-worker`** (после переписывания KS-2431, см. §7):
- `src/puzzle-generator/generator-pipeline.ts` (ADR-041 §3).
- `src/puzzle-generator/tagging.ts` (ADR-041 §4).
- `src/scripts/generate-puzzles.ts` (CLI-команда).

### 1.4 Что НЕ переносится (остаётся в `apps/api`)

| Файл | Почему остаётся |
|---|---|
| `src/tactic-drill/tactic-drill.controller.ts`, `daily-tactic-drill.controller.ts` | REST endpoint'ы — пользовательский runtime. |
| `src/tactic-drill/tactic-drill.service.ts`, `tactic-drill-sprint.service.ts`, `tactic-drill-rating.service.ts`, `tactic-drill-sprint.scheduler.ts` | Runtime: attempt, sprint, rating, lifecycle сессий. |
| `src/tactic-drill/tactic-drill-validator.service.ts` | Сравнение `userAnswer` с эталоном (без predicate'ов). Runtime. |
| `src/tactic-drill/daily-tactic-drill.service.ts`, `daily-tactic-drill-image.service.ts` | Telegram daily — runtime. |
| `src/engine/stockfish.service.ts` | Используется `game/game-report.service.ts` (online анализ партии для пользователя). См. §2.2. |
| `src/engine/opening-book.service.ts`, `polyglot-reader.ts` | Online-фичи, к тактикам не относятся. |
| `src/scripts/seed-screenshot-account.ts`, `import:puzzles`, `seed:lessons`, `scan-chess-results` | Не про тактику. |

---

## 2. Shared-код

Два слоя: **predicate'ы** и **StockfishService**. У них разная судьба.

### 2.1 Drill-predicates: НЕ выделяем в shared-package

**Решение:** `predicates/` переезжают целиком в `apps/tactic-worker/src/predicates/`. Shared-пакет `packages/tactic-predicates` **не создаём**.

Обоснование:
- На `apps/api` runtime predicate'ы не используются. Проверено: `TacticDrillValidatorService` (валидатор attempt) — сравнивает `userAnswer` с `answer` из БД (`tactic_drills.answer`), predicate не вызывает. Tagging при выдаче drill'ов — не делается (DTO формирует `formatPuzzle` без predicate-checks).
- Если predicate понадобится в api в будущем (например, ad-hoc валидация: «проверь, что пользовательский FEN действительно содержит вилку») — оформим extraction в `packages/tactic-predicates` отдельным тикетом. Сейчас — over-engineering: лишний package, build-цикл, версионирование, без потребителей.
- Все потребители predicate'ов сейчас offline:
  - `indexer-pipeline.ts` (drill-индексер) — переезжает в tactic-worker.
  - `puzzle-generator/tagging.ts` (новое из ADR-041) — пишется сразу в tactic-worker.
  - Maintenance-scripts — переезжают.

**Если** нужно будет позже: типы для контракта (`AnswerData`, `TacticDrillType`, `DRILL_TYPE_ANSWER_SHAPE`) уже живут в `packages/shared/src/types/tactic-drill.ts` — это не дубль, и api/web/tactic-worker все импортируют их оттуда. То есть «контракт ↔ реализация predicate'ов» уже разнесены, мы перевозим только реализацию.

### 2.2 StockfishService: выделяем в `packages/stockfish`

**Решение:** `apps/api/src/engine/stockfish.service.ts` → `packages/stockfish/src/stockfish.service.ts`.

Обоснование:
- Двух потребителей сразу: api (game-report online) и tactic-worker (генерация offline). Один источник правды на pool-management, MultiPV, level-config — критично.
- Service не зависит ни от Prisma, ни от Redis. Только `child_process` + `@nestjs/common` + `@nestjs/config`. Минимальный изолированный пакет.
- API не утрачивает Stockfish: импортирует `StockfishModule` из `@kingside/stockfish` в `GameModule`. Бинарь Stockfish остаётся в Dockerfile api (для game-report).

Состав `packages/stockfish`:
- `src/stockfish.service.ts` (текущий код).
- `src/stockfish.module.ts` (`@Module({ providers: [StockfishService], exports: [StockfishService] })`).
- `package.json` `@kingside/stockfish` — зависимости `@nestjs/common`, `@nestjs/config`.
- Tests `stockfish.service.spec.ts` — переезжают.

Обновления потребителей:
- `apps/api/src/game/game.module.ts`: `import { StockfishModule } from '@kingside/stockfish'` (вместо local).
- `apps/api/src/tactic-drill/tactic-drill.module.ts`: `StockfishService` сейчас зарегистрирован для `TacticDrillSfValidatorService`. После выноса валидатора в tactic-worker — этот provider удаляется из api.
- `apps/tactic-worker/src/main.ts`: `imports: [StockfishModule, …]`.

### 2.3 Что ещё кандидат на shared

Возможные будущие выделения, **не делаются сейчас**:
- `packages/tactic-predicates` (см. §2.1) — если api начнёт их использовать.
- `packages/chess-engine-adapter` (если понадобится не-Stockfish движок) — слишком далеко.
- `packages/archive-pg-helper` — `pg-ssl.ts` сейчас живёт в `apps/api/src/tactic-drill/`, после переезда — в `apps/tactic-worker/src/lib/`. Если archive-service / archive-importer / другие воркеры тоже используют такой же helper (вероятно — да, у них тот же `NODE_EXTRA_CA_CERTS` шаблон) — отдельный тикет на extraction. Не блокирует ADR-042.

---

## 3. Dockerfile

`apps/tactic-worker/Dockerfile` — multi-stage по образцу `apps/archive-service/Dockerfile`, но с добавлением Stockfish.

```dockerfile
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    stockfish openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/tactic-worker/package.json apps/tactic-worker/
COPY packages/shared/package.json packages/shared/
COPY packages/stockfish/package.json packages/stockfish/
COPY packages/db/package.json packages/db/
COPY packages/archive-db/package.json packages/archive-db/
RUN npm ci --ignore-scripts
RUN node node_modules/@prisma/engines/scripts/postinstall.js
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/stockfish ./packages/stockfish
COPY packages/db ./packages/db
COPY packages/archive-db ./packages/archive-db
COPY apps/tactic-worker ./apps/tactic-worker
RUN npx tsc --build packages/shared
RUN cd packages/stockfish && npx tsc --build
RUN cd packages/db && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
RUN cd packages/archive-db && ARCHIVE_DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
RUN cd apps/tactic-worker && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx nest build

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/tactic-worker/dist ./apps/tactic-worker/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/stockfish ./packages/stockfish
COPY --from=build /app/packages/db ./packages/db
COPY --from=build /app/packages/archive-db ./packages/archive-db
COPY apps/tactic-worker/package.json ./apps/tactic-worker/
# RDS CA bundle (тот же файл, что в apps/api/certs/rds-ca.pem) —
# для verify-full к archive-RDS и основной RDS из CLI.
COPY apps/tactic-worker/certs ./apps/tactic-worker/certs
RUN rm -rf node_modules/@kingside/shared && ln -s ../../packages/shared node_modules/@kingside/shared
RUN rm -rf node_modules/@kingside/stockfish && ln -s ../../packages/stockfish node_modules/@kingside/stockfish
RUN rm -rf node_modules/@kingside/db && ln -s ../../packages/db node_modules/@kingside/db
RUN rm -rf node_modules/@kingside/archive-db && ln -s ../../packages/archive-db node_modules/@kingside/archive-db

ENV STOCKFISH_PATH=/usr/games/stockfish
ENV STOCKFISH_POOL_SIZE=4
ENV NODE_EXTRA_CA_CERTS=/app/apps/tactic-worker/certs/rds-ca.pem
ENV NODE_ENV=production

WORKDIR /app/apps/tactic-worker
# Default CMD — без аргументов выводит help'у. ECS RunTask переопределяет
# через containerOverrides.command (например ["index-drills","--max-games","500"]).
CMD ["node", "dist/main.js"]
```

Размеры (оценка):
- base + stockfish + node:22-slim ≈ **180–220 MB**.
- + node_modules production ≈ **+150–200 MB**.
- + код ≈ **+5 MB**.
- Итого ≈ **350–420 MB**. Сравнимо с api (api ≈ 500–600 MB по факту, после выноса — упадёт ориентировочно на 50–80 MB за счёт удаления predicate-кода и unused chunks; основной размер у api держит сам Node + Prisma engines).

---

## 4. ECS task-def

### 4.1 Имя и family

**`kingside-tactic-worker`** (family + task-def name). Соответствует имени сервиса (`apps/tactic-worker`).

### 4.2 Размер

Один task-def с двумя профилями через `containerOverrides`:

| Профиль | Use case | CPU | RAM |
|---|---|---|---|
| Light | drill-индексер, maintenance, sf-validator | 1 vCPU (1024) | 2 GB |
| Heavy | puzzle-generator | 4 vCPU (4096) | 8 GB |

Реализация:
- Task-def зарегистрирован с CPU=4096 / RAM=8GB (heavy as default).
- Light-запуски используют `containerOverrides.cpu/memory` с меньшими значениями. AWS ECS поддерживает override на уровне Fargate task'а в момент `RunTask` для Fargate Spot.

Альтернатива «два task-def'а»: проще для observability (метрики разбиваются), но тройная админ-нагрузка (две регистрации, два дашборда). Для MVP — один с overrides; при росте нагрузки разделим.

### 4.3 Spot

**Да, Fargate Spot** для всех команд.

Обоснование:
- Все команды batch, без SLA. Прерывание через 2-минутный warning приемлемо: cursor-based прогресс сохраняется в Redis на каждом N-партий-batch'е (текущая drill-логика), generator аналогично.
- Прецедент: archive-importer уже на Spot (см. ADR-019/020).

Если статистика покажет высокий Spot-eviction rate — оборачиваем критические команды в graceful-shutdown handler (поймать SIGTERM, дождаться текущей партии, сохранить cursor, exit).

### 4.4 CMD по умолчанию

`node dist/main.js` без аргументов — выводит help: список subcommand'ов и их флаги.

ECS RunTask передаёт `containerOverrides.command = ["node", "dist/main.js", "<subcmd>", ...]`. Например:
- `["node", "dist/main.js", "index-drills", "--max-games=500"]`
- `["node", "dist/main.js", "generate-puzzles", "--max-games=100", "--depth=18"]`
- `["node", "dist/main.js", "sf-validate-drills", "--batch=200"]`

### 4.5 Secrets

**Новый namespace `kingside/tactic-worker`** в AWS Secrets Manager (или Parameter Store, что у нас сейчас используется — devops уточнит).

Минимально нужны:
- `DATABASE_URL` — основная RDS (запись в `tactic_drills`, `puzzles`).
- `ARCHIVE_DATABASE_URL` — archive-RDS (чтение `archive_games`).
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` — cursor (`tactic-drill:incremental:cursor`, `puzzle-generator:incremental:cursor`).
- `STOCKFISH_PATH` (опц., default `/usr/games/stockfish`).
- `STOCKFISH_POOL_SIZE` (опц., default 4 — заданo в Dockerfile ENV).

**НЕ берём из `kingside/api`**:
- JWT secrets, OAuth credentials, Telegram tokens, S3 keys — не нужны воркеру и принципом наименьших привилегий не должны быть доступны.

### 4.6 IAM роль

Новая task-execution + task-роль `kingside-tactic-worker-task-role`:
- Доступ к Secrets `kingside/tactic-worker/*`.
- Доступ к RDS (network — security group, не IAM auth).
- CloudWatch Logs `kingside/tactic-worker`.
- Без доступа к S3, SES, Telegram bot tokens.

---

## 5. Миграция текущих RunTask'ов и выключение api-tasks

### 5.1 Что сейчас работает

| Точка | Где живёт | Как запускается |
|---|---|---|
| Drill-индексер manual | `apps/api/src/scripts/index-tactic-drills.ts` (CLI) | `npm run index:tactic-drills` через ECS RunTask на `kingside-api:103` (devops). |
| Drill-индексер incremental | `apps/api/src/tactic-drill/tactic-drill-incremental.scheduler.ts` (NestJS Cron) | Cron `EVERY_HOUR` внутри api-pod, ENV `TACTIC_DRILL_INCREMENTAL_ENABLED=1` (включён в проде, не уверен — devops подтвердит). |
| SF-валидатор | `apps/api/src/tactic-drill/tactic-drill-sf-validator.service.ts` + `…-scheduler.ts` | Cron внутри api, ENV `TACTIC_DRILL_SF_VALIDATOR_ENABLED=1`. |
| Maintenance-скрипты | `apps/api/src/scripts/{backfill-…,prune-…,rescore-…,validate-…}.ts` | Manual RunTask на `kingside-api`. |

### 5.2 Этапы миграции (zero-downtime)

**Этап M0 — параллельный режим (день 1-7).**
1. Backend: выкатить `apps/tactic-worker` (см. §1). Команды работают, тестируются на dev / staging.
2. Devops: зарегистрировать task-def `kingside-tactic-worker`, IAM, Secrets.
3. Прогнать `index-drills` на dev одной партией → проверка cursor-coexistence: tactic-worker и api-scheduler оба читают `tactic-drill:incremental:cursor` — гонка. Чтобы не было дублей: пока **выключен api-scheduler в проде** (`TACTIC_DRILL_INCREMENTAL_ENABLED=0`).
4. Старый `npm run index:tactic-drills` (alias к api task-def) **продолжает работать** — defensive параллель. Но в этот момент его не запускают, новые тики идут через tactic-worker.

**Этап M1 — переключение incremental (день 7).**
1. Devops: настроить EventBridge schedule `kingside-tactic-worker:index-drills` → `RunTask` каждый час (раньше делал api-scheduler).
2. Devops: окончательно убрать `TACTIC_DRILL_INCREMENTAL_ENABLED` из api ENV (проверено — никаких тиков в api нет, только в tactic-worker).

**Этап M2 — переключение SF-валидатора (день 7).**
1. EventBridge schedule `sf-validate-drills` каждые 30 мин.
2. Убрать `TACTIC_DRILL_SF_VALIDATOR_ENABLED` из api ENV.

**Этап M3 — alias для manual scripts (день 7-14).**
1. Devops: alias `npm run index:tactic-drills` (или внутренний tooling) → новый task-def. Архитектурно — алиас в `package.json` корня монорепо или просто документация в runbook.

**Этап M4 — удаление кода из api (день 14+).**
1. Backend: удалить из `apps/api/src/tactic-drill/`:
   - `indexer-pipeline.ts`, `difficulty.ts`, `pg-ssl.ts`,
   - `tactic-drill-incremental.scheduler.ts(.spec.ts)`,
   - `tactic-drill-sf-validator.service.ts(.spec.ts)`, `…-scheduler.ts`,
   - `predicates/` (перемещены git mv'ом — но git mv делает rename, а здесь мы хотим оставить их в tactic-worker; решение — два этапа: сначала **копируем** в tactic-worker (M0), потом **удаляем** из api (M4); commit-хистория сохранится в tactic-worker через `git mv` если делать одной операцией, иначе теряется. Но рискованного для M0 параллеля копия безопаснее).
2. Backend: удалить scripts `index-tactic-drills.ts`, `validate-drill-positions.ts`, и весь backfill/prune/rescore из api.
3. Backend: удалить `StockfishService` provider из `tactic-drill.module.ts` (там он был только для sf-validator'а; для game-report остаётся через `@kingside/stockfish`).
4. Backend: уменьшится `apps/api/Dockerfile` — `apt install stockfish` остаётся (для game-report), но если game-report тоже выносим в воркер в будущем — тогда отдельный ADR убирает Stockfish из api полностью. Сейчас оставляем.

### 5.3 Документация для devops

Runbook `docs/runbooks/tactic-worker.md` (создаётся в этапе M0):
- Как запустить ad-hoc CLI-команду через RunTask.
- Как смотреть CloudWatch логи (`/ecs/kingside-tactic-worker`).
- Cursor-keys в Redis: `tactic-drill:incremental:cursor`, `puzzle-generator:incremental:cursor`.
- Что делать при Spot-eviction (повторный запуск — cursor доберёт остаток).
- Как добавить новую subcommand (CLI-диспатчер).

Не делается этим ADR, но создаётся отдельным devops-тикетом в плане.

### 5.4 Идемпотентность и race-conditions

- **Cursor-locking:** `SET tactic-drill:incremental:cursor:lock <task-id> NX EX 7200` перед началом работы. Если уже залочено — выйти (другой instance работает). Аналогично для puzzle-generator.
- **UNIQUE constraints:** `tactic_drills(type, fen)` уже есть; `puzzles(fen, source) WHERE source='generated'` — миграция в KS-2431 (см. ADR-041 §3.7). На уровне insert — `ON CONFLICT DO NOTHING`.
- Гонка api-scheduler vs tactic-worker (если случайно оба включены) — поймается на UNIQUE; данные не повредятся, но cursor может «прыгать». Поэтому жёстко выключаем api-scheduler в M1/M2.

---

## 6. CI / build

### 6.1 Turbo

- `apps/tactic-worker/package.json` — стандартные scripts: `build` (`nest build`), `dev` (`nest start --watch` — для локальной отладки), `test` (`jest`), `lint` (`eslint src/`).
- `turbo.json` — добавить cache key для `apps/tactic-worker/dist`. В корне он должен подцепиться по существующему glob'у на `apps/*/dist`.

### 6.2 GitHub Actions (или actual CI — devops уточнит)

Текущая инфра (по beobachtению `apps/api/Dockerfile` и наличию `.dockerignore`-логики копирования по требованию) — судя по всему, отдельные образы собираются по path-фильтрам в CI. Аналогично:

- Файл `.github/workflows/build-tactic-worker.yml` (или эквивалент для нашей CI):
  - Trigger: push в main, paths `apps/tactic-worker/**`, `packages/shared/**`, `packages/stockfish/**`, `packages/db/**`, `packages/archive-db/**`.
  - Build: `docker build -f apps/tactic-worker/Dockerfile .` (build-context — корень монорепо для shared-пакетов).
  - Tag: `kingside-tactic-worker:<git-sha>` + `:latest`.
  - Push в ECR.
  - Update task-def revision (новая task-def revision указывает на новый image SHA), `aws ecs register-task-definition`. Не deploy / update-service — task-def не привязан к Service, RunTask использует latest revision.

Точное имя workflow и инструменты CI определяет devops (сейчас архитектор не знает, GHA это или CodeBuild / иное). Тикет на CI в плане.

### 6.3 Версионирование

- Аналогично api: tag `kingside-tactic-worker:<git-sha>`. Latest — для авто-runtime.
- При hotfix: явный SHA в task-def revision'е, чтобы можно было pin'ить.

---

## 7. Влияние на KS-2431 (puzzle gen MVP) и ADR-041

KS-2431 (TODO до текущего ADR) — **переписать** под новое место:

**Было** (по ADR-041 §6, этап 1):
> `apps/api/src/scripts/generate-puzzles.ts` + reusable модуль `apps/api/src/puzzle-generator/generator-pipeline.ts` …

**Стало** после ADR-042:
- `apps/tactic-worker/src/scripts/generate-puzzles.ts` (CLI dispatcher entry).
- `apps/tactic-worker/src/puzzle-generator/generator-pipeline.ts`.
- `apps/tactic-worker/src/puzzle-generator/tagging.ts` (импортирует predicate'ы из `apps/tactic-worker/src/predicates/`).
- StockfishService — из `@kingside/stockfish`.
- Миграция Prisma `puzzles_fen_source_unique` — **остаётся в `apps/api/prisma/`**, потому что Prisma-схема и migration history централизованы в api (это конвенция монорепо, не меняется).

ADR-041 — обновлю одним патчем сразу за этим ADR:
- §3.1 «Где запускается»: убрать «отдельный ECS RunTask по образцу archive-importer» как абстракцию; прямо сказать «команда `tactic-worker:generate-puzzles`, см. ADR-042».
- §6 этап 1: путь к скрипту — `apps/tactic-worker/...`.
- §9 список тикетов: backend (генератор) → ставится **после** базовой extraction (KS-2433 / KS-2434, см. план ниже), потому что зависит от наличия tactic-worker'а.

Цепочка задач (в зависимости от ADR-042):
1. Extraction tactic-worker (drill только). Drill-индексер живёт в новом сервисе. Api ещё содержит `predicates/` копией для соглашения, но удаление — этап M4.
2. Devops: образ + ECS task-def + Secrets + IAM + EventBridge.
3. Удаление кода из api (этап M4) — отдельный backend-тикет.
4. KS-2431 (puzzle-generator) — пишется в новом сервисе.
5. ADR-041 цепочка этапов 2 / 3 — нет архитектурных изменений, расписание EventBridge в task-def уже tactic-worker'а.

---

## 8. Риски и open questions

### 8.1 Дублирование predicate-кода

Решено в §2.1: на runtime api predicate'ы не нужны, поэтому extraction в shared-package не делаем — переезжают целиком в tactic-worker. Если api начнёт их использовать — отдельный тикет на extraction в `packages/tactic-predicates`.

### 8.2 Stockfish в api для game-report

Остаётся (online фича, отчёт по партии для пользователя). После выноса `TacticDrillSfValidatorService` Stockfish в api используется только в `GameReportService`. Если в будущем решим вынести и анализ партий в воркер — отдельный ADR (это меняет UX: пользователь ждёт отчёт асинхронно через очередь).

Промежуточное состояние (game-report в api, drill/puzzle-gen в worker) — нормальное и устойчивое: api-фича синхронна по UX-контракту (ответ ≤ 30 сек), воркер-фичи асинхронны (часы).

### 8.3 Размер api после выноса

Оценка экономии:
- Stockfish бинарь (~50 MB) — **остаётся** в api (для game-report).
- Predicate-код + indexer-pipeline + sf-validator + scheduler'ы + maintenance-scripts: ~25–30 файлов TS, ~3 000–4 000 LOC. После tsc → ~100–200 KB JS. Ничтожно по сравнению с node_modules.
- Реальный выигрыш api-образа — **не размер, а cohesion**: api не будет содержать (после M4) кода, никем из api-runtime не используемого. Это меньше когнитивной нагрузки и меньше поверхности под `npm audit`.

### 8.4 Один монорепо-образ или два

**Два.** Один образ для всего монорепо (в стиле `nx-style` mega-image) рассмотрен и отклонён:
- Текущая инфра уже multi-image (api, archive-service, archive-importer, broadcast-service, broadcast-worker, game-service, matchmaker, synthetic-bot-service). Один общий образ ломает существующую архитектуру.
- Cold-start ECS: запуск 4 GB образа vs 350 MB заметно дольше.
- Изоляция: tactic-worker не должен иметь доступа к JWT/Telegram/SMTP secrets api.

### 8.5 Spot-eviction для долгих задач

Stockfish puzzle-gen — самая длинная задача (CPU часы). Если Spot эвиктится посредине — теряется текущая партия (cursor сохранён до неё). На 1000 партий это до 4 часов работы; eviction вероятен. Меры:
- Сохранять cursor каждые **10 партий**, не на конец batch'а (текущий drill-индексер делает 1 раз в конце — слабо для puzzle-gen).
- SIGTERM-handler: на 2-min warning сохранить текущий cursor и exit с кодом 0 (чтобы EventBridge увидел успех). Следующий запуск доберёт остаток.
- Если eviction-rate > 30% — переключить на on-demand Fargate (стоит дороже, но детерминированно).

Это вопрос реализации, не архитектуры. Фиксируется как TODO в KS-2431.

### 8.6 Stockfish-binary версия и репродуктируемость

`apt install stockfish` тащит версию из debian-репо (на node:22-slim — обычно SF 14 или 15). Для drill-валидатора и puzzle-gen желательно **зафиксировать версию** (особенно для sample-test'а chess-expert'ом из ADR-041 §5.2 — иначе threshold'ы сдвигаются).

Решение: download Stockfish 17.1 NNUE-binary с GitHub releases при build, как раньше делалось для apps/api (комментарий в Dockerfile об этом отсутствует — стоит уточнить у devops). Если сейчас в api `apt install stockfish` — это уже решение, и tactic-worker наследует. Open question, не блокирующий.

### 8.7 Локальная разработка

- `apps/tactic-worker` запускается локально через `npm run dev` (nest start --watch). Stockfish — через `STOCKFISH_PATH=/usr/games/stockfish` (Linux/macOS — `brew install stockfish`).
- На macOS/Win разработка drill-индексера не критична: backend разработчик запускает CLI, проверяет логику. Stockfish для drill-валидатора и puzzle-gen — желателен, иначе тесты unit'ов идут через моки `StockfishService` (как сейчас в `apps/api/src/tactic-drill/tactic-drill-sf-validator.service.spec.ts`).

### 8.8 Доступ к Prisma

Tactic-worker пишет в основную БД через Prisma (`@kingside/db`). Migration history — в api (`apps/api/prisma/migrations/`, `prisma.config.ts`). Воркер migrate **не вызывает** — это делает api при деплое. Воркер только читает Prisma client.

Если кто-то случайно положит `prisma migrate` в tactic-worker — две worker-таски одновременно начнут миграцию → race. Запрет фиксируется в код-стайле (no `prisma migrate` в tactic-worker scripts) и/или CI-проверкой (search for `prisma migrate` в `apps/tactic-worker/**`).

### 8.9 Open question: где тогда лежать миграциям

Сейчас Prisma migrations в `apps/api/prisma/migrations/`. Это нормально, пока api — единственный writer + reader. Tactic-worker — **тоже writer** в `tactic_drills` и `puzzles`. При расширении схемы — миграция всё равно живёт в api (не в worker'е). Это конвенция, не блокер ADR-042.

### 8.10 Open question: оставить ли часть scripts в api на переходный период?

Минимальная вежливость для devops: до этапа M4 (день 14+) можно оставить копию `apps/api/src/scripts/index-tactic-drills.ts` с тонкой оберткой «вызови tactic-worker через RunTask». Это уменьшает риск, что внешние скрипты devops'а сломаются. Реализация — в M3.

---

## 9. План тикетов (для координатора)

Цепочка зависимостей: 9.1 ← 9.2 (и 9.3) ← 9.4 ← 9.5 ← 9.6.

### 9.1 [backend] Extraction skeleton + drill-индексер (этап M0)

Ключевая задача. После неё tactic-worker уже что-то делает.

- Создать воркспейс `apps/tactic-worker` (NestJS standalone CLI, `package.json`, `nest-cli.json`, `tsconfig.json`, `Dockerfile`, `certs/rds-ca.pem` копия).
- Создать `packages/stockfish` (`StockfishModule` + `StockfishService` git mv из `apps/api/src/engine/`); `apps/api` импортирует через `@kingside/stockfish` (обновить `game.module.ts`, `tactic-drill.module.ts`).
- Скопировать (не git-mv пока, чтобы api продолжал работать): `predicates/`, `indexer-pipeline.ts`, `difficulty.ts`, `pg-ssl.ts` из `apps/api/src/tactic-drill/` в `apps/tactic-worker/src/`.
- Реализовать CLI-диспатчер (`main.ts`) с одним subcommand `index-drills`, переиспользующим `runIndexer` из перенесённого `indexer-pipeline.ts`.
- Тесты: smoke-тест запуска `index-drills` локально (10 партий dev-DB).

**Зависимости:** нет.
**Не блокирует api**: api продолжает иметь свой scheduler+скрипт; tactic-worker только параллельный.

### 9.2 [devops] ECS task-def + Secrets + IAM + EventBridge (этап M0/M1)

- Зарегистрировать task-def `kingside-tactic-worker` (CPU/RAM по §4.2, Spot, log group, NETWORK awsvpc).
- Создать namespace `kingside/tactic-worker/*` в Secrets Manager / Param Store, заполнить `DATABASE_URL`, `ARCHIVE_DATABASE_URL`, `REDIS_*`.
- Создать IAM execution + task роль `kingside-tactic-worker-task-role`.
- Создать EventBridge schedule `kingside-tactic-worker-index-drills` каждый час → RunTask с command `["index-drills"]`. **Включить, когда backend подтвердит smoke-test.**
- Runbook `docs/runbooks/tactic-worker.md` (как запустить ad-hoc, как смотреть логи).

**Зависимости:** 9.1 (нужен Dockerfile + образ в ECR).
**Параллельно:** api-scheduler пока работает (выключим в 9.4).

### 9.3 [backend] Перенос остального offline-кода (этап M0)

- SF-валидатор drill'ов: `tactic-drill-sf-validator.service.ts` + `…-scheduler.ts` → CLI-команда `sf-validate-drills`. Schedule в EventBridge каждые 30 мин (после smoke).
- Maintenance-скрипты: `validate-drill-positions.ts`, `backfill-find-all-checks-meta.ts`, `backfill-count-attackers-meta.ts`, `prune-xray-affected.ts`, `prune-find-pin.ts`, `rescore-count-attackers.ts`, `index-pgn-oneshot.ts` → subcommand'ы в CLI-диспатчер.

**Зависимости:** 9.1.

### 9.4 [coordinator + devops] Выключить api-scheduler (этап M1/M2)

- Подтвердить что tactic-worker incremental работает корректно (smoke на проде, первый час).
- Devops: убрать ENV `TACTIC_DRILL_INCREMENTAL_ENABLED` и `TACTIC_DRILL_SF_VALIDATOR_ENABLED` из api task-def.
- Перезапуск api (rolling deploy).

**Зависимости:** 9.1, 9.2, 9.3.

### 9.5 [backend] Удалить мёртвый код из api (этап M4)

После недели стабильной работы tactic-worker:
- Удалить `apps/api/src/tactic-drill/{indexer-pipeline,difficulty,pg-ssl,tactic-drill-incremental.scheduler,tactic-drill-sf-validator.*,…}.ts`.
- Удалить `apps/api/src/tactic-drill/predicates/` (предикаты остаются только в tactic-worker).
- Удалить `apps/api/src/scripts/{index-tactic-drills,validate-drill-positions,backfill-…,prune-…,rescore-…,index-pgn-oneshot}.ts`.
- Удалить provider `StockfishService` из `tactic-drill.module.ts` (для game-report сервис всё равно подтянется через `@kingside/stockfish`).
- Удалить ENV `TACTIC_DRILL_INCREMENTAL_ENABLED`, `TACTIC_DRILL_SF_VALIDATOR_ENABLED` из api ConfigService и `.env.example`.

**Зависимости:** 9.4.

### 9.6 [backend] KS-2431 переписать под tactic-worker

- Скрипт + модуль puzzle-generator кладутся в `apps/tactic-worker/src/`.
- Tagging через `apps/tactic-worker/src/predicates/`.
- ADR-041 — обновить ссылки на путь и job (одним патчем за этот ADR-042; прямо сейчас в этом коммите).

**Зависимости:** 9.1 (минимум). Реально лучше — после 9.5 (чистая api), но не обязательно.

### 9.7 [devops] CI build pipeline (этап M0/M1)

- Path-filtered build для `apps/tactic-worker/**` + `packages/{shared,stockfish,db,archive-db}/**`.
- Push в ECR.
- Tag-based versioning, аналог api.

**Зависимости:** 9.1 (Dockerfile нужен).
**Параллельно** с 9.2.

---

## 10. Резюме

- **`apps/tactic-worker`** — новый NestJS standalone CLI-сервис на ECS Fargate Spot. Headless, без HTTP. Один task-def, переменная subcommand через ECS overrides.
- **Stockfish** выделяется в `packages/stockfish`, потребители — api (game-report) и tactic-worker.
- **Drill-predicates** переезжают целиком в `apps/tactic-worker`, без shared-пакета — на runtime api они не используются.
- **Dockerfile** наследует apps/archive-service шаблон + `apt install stockfish` + RDS CA bundle.
- **Миграция zero-downtime** через 4 этапа M0 → M4: параллель → переключение incremental → переключение валидатора → удаление кода из api.
- **KS-2431 / ADR-041** скорректировать: генератор живёт в tactic-worker. Путь к скрипту обновляется одним патчем за этим ADR.

После M4 `apps/api` перестаёт содержать offline-логику тактик; релизы api не тащат predicate-код, не блокируют его обновление цепочкой rolling-deploy. Stockfish бинарь остаётся в api для game-report — это отдельная online-фича, и её вынос — задача за рамками этого ADR.
