# ADR-019: Объединение `apps/archive-importer` в `apps/archive-service`

**Статус:** Предложено
**Дата:** 2026-04-21
**Задача:** KS-1672
**Связанные ADR:** [ADR-013](./013-game-archive-and-tree.md), [ADR-014](./014-archive-games-by-position.md), [ADR-015](./015-archive-classical-only-filter.md), [ADR-018](./018-archive-service-extraction.md)

## 1. Контекст

### Что есть сейчас (факт)

1. Два воркспейса в монорепо работают с одной archive-БД (`@kingside/archive-db`):

   - **`apps/archive-importer`** — headless TS-воркер (`node:20-slim`, запуск `npx tsx src/index.ts`). Содержит:
     - `src/index.ts` — bootstrap с SIGINT/SIGTERM handlers.
     - `src/importer.ts` — главный цикл `setInterval(60_000)` + Redis-lock `archive:import:lock:{code}` + выбор импортёра по `kind`.
     - `src/sources/twic.ts` — единственный реализованный источник TWIC.
     - `src/archive-position-writer.ts` — собственный `pg.Pool` + `COPY FROM STDIN` с staging TEMP-таблицей для `archive_game_positions`.
     - `src/position-indexer.ts` — инкрементальный UPSERT в `position_stats` из партий.
     - `src/backfill.ts` — CLI backfill `archive_game_positions` (два режима).
     - `src/classify-existing.ts` — CLI дозаполнения `time_control / category / is_classical`.
     - `src/cleanup-positions.ts` — CLI удаления позиций не-классических партий.
     - `src/rebuild-position-stats.ts` — CLI полной переиндексации + PUBLISH `archive:imported`.
     - `src/dedup.ts`, `src/classify.ts`, `src/pgn-utils.ts`, `src/position-row-builder.ts` — чистые утилиты.
     - `src/metrics.ts` — самописный in-memory реестр Counter/Histogram/Gauge (не `prom-client`). `snapshot()` наружу не подключён, метрики видны только через внутренние объекты.
     - Dockerfile на `node:20-slim`, `CMD ["npx","tsx","src/index.ts"]`, билд `tsc` (артефакты в `dist/`, но в проде не используются).
   - **`apps/archive-service`** — NestJS (`node:22-slim`) HTTP-сервис (ADR-018). Содержит:
     - `src/main.ts` — bootstrap без `setGlobalPrefix`, CORS GET/HEAD, ValidationPipe, AllExceptionsFilter.
     - `src/archive/` — ArchiveModule + Controller + Service + Stats Repository (DI по `ARCHIVE_STATS_IMPL`) + ArchiveMetricsService + prewarm.
     - `src/prisma/` — `PrismaService extends PrismaClient` (`@kingside/archive-db`).
     - `src/redis/` — `RedisService extends Redis` (ioredis), `duplicate()` для sub-канала.
     - `src/metrics/` — `MetricsService` (prom-client Registry + `collectDefaultMetrics`), `/_/metrics` endpoint.
     - `src/health/` — `/_/health` с `SELECT 1` таймаут 500 мс.
     - `src/common/all-exceptions.filter.ts`.
     - Dockerfile на `node:22-slim`, `CMD ["node","dist/main.js"]`, билд `nest build`.
2. Оба воркспейса зависят от `@kingside/archive-db` и `@kingside/shared`, читают одну archive-БД, один Redis (`REDIS_HOST/PORT`). `archive-importer` `PUBLISH archive:imported` только в `rebuild-position-stats.ts`; importer.ts штатный tick публикаций не делает (см. ADR-018 §2.3). `archive-service.ArchiveService.onModuleInit` подписан на этот же канал.
3. Продакшн-дефолт: `archive-importer` и `archive-service` — две отдельные ECS task definitions; `archive-importer` запускается одной репликой (scheduler — singleton), `archive-service` — min=1 / max=2 (GET-only API, §2.6 ADR-018).

### Что просит KS-1672

Объединить код `apps/archive-importer` внутрь `apps/archive-service` — один пакет, общий DI/билд/зависимости, один ECR-образ. Ответить на 9 конкретных пунктов (план-schedule, процессы, модульный маппинг, CLI, ENV, docker-compose, порядок миграции, метрики, риски двойного scheduler'а при масштабировании).

### Что НЕ в скоупе ADR-019

- Миграция данных (уже сделана ADR-018 §2.8 Фаза 2).
- Переход с раздельного `pg.Pool` (COPY) на prisma-стримы.
- Замена самописного cron-parser'а на `croner` / `node-cron` (можно отдельной задачей; Nest's `@Cron` достаточно).
- Вынос `sources/twic.ts` в плагинную архитектуру (сейчас один kind=`twic`, overhead не окупается).
- Новые источники архивов (lichess, chess.com) — появятся отдельными тикетами.
- ClickHouse для `position_stats` (открытое из ADR-013 §10.C.4).

## 2. Решение

### 2.1 Структура пакета после мёрджа

**Имя:** `@kingside/archive-service` (существующее, не переименовываем).
**Runtime:** Node 22 (берём от archive-service, importer съезжает с Node 20 — незначительный пин).
**Компилятор:** `nest build` (через `nest-cli.json`). Importer-скрипты перестают запускаться через `tsx` — билд идёт в единый `dist/`.

**Физический layout `apps/archive-service/src/` после объединения:**

```
src/
  main.ts                       # HTTP bootstrap (без изменений, ADR-018)
  importer-main.ts              # NEW — standalone entrypoint воркера
  cli/
    backfill.ts                 # NEW — CLI shim, создаёт NestApplicationContext
    classify-existing.ts        # NEW
    cleanup-positions.ts        # NEW
    rebuild-position-stats.ts   # NEW
  app.module.ts                 # + ImporterModule условно (см. 2.2)
  importer.module.ts            # NEW — DI для importer-процесса
  archive/                      # без изменений
  archive-import/               # NEW — перенос importer-кода
    importer.service.ts         # ← apps/archive-importer/src/importer.ts (scheduler + dispatcher)
    position-indexer.service.ts # ← apps/archive-importer/src/position-indexer.ts
    archive-position-writer.service.ts # ← apps/archive-importer/src/archive-position-writer.ts
    dedup.ts                    # ← apps/archive-importer/src/dedup.ts (pure utility, без DI)
    classify.ts                 # ← apps/archive-importer/src/classify.ts (pure)
    pgn-utils.ts                # ← apps/archive-importer/src/pgn-utils.ts (pure)
    position-row-builder.ts     # ← apps/archive-importer/src/position-row-builder.ts (pure)
    sources/
      twic.importer.ts          # ← apps/archive-importer/src/sources/twic.ts
    *.spec.ts                   # все текущие vitest-тесты (конвертируются в jest, см. 2.10)
  archive-import-metrics/       # NEW — importer-metrics интегрированы в общий Registry
    archive-import-metrics.service.ts  # заменяет самописный src/metrics.ts (importer)
  prisma/                       # без изменений
  redis/                        # без изменений
  metrics/                      # MetricsService + /_/metrics controller (ADR-018)
  health/                       # без изменений
  common/                       # без изменений
```

**Почему `archive-import/` отдельным каталогом, а не внутри `archive/`:**
- `archive/` — read path (HTTP контроллер + репозиторий + кеш). `archive-import/` — write path (периодический scheduler + COPY + position index). Пересекаются только через общий `@kingside/archive-db` клиент и канал `archive:imported`.
- Разделение каталогов упрощает lint-правило: read-path не импортит write-path (обратное — можно, через public интерфейсы). Это фиксируется eslint-rule `no-restricted-imports` в `apps/archive-service/.eslintrc.cjs` (задача backend, не архитектора).

### 2.2 Развёртывание: один процесс vs два процесса

**Вариант A — один NestApp, HTTP + scheduler в одном процессе.**
- `main.ts` поднимает `AppModule` со всеми модулями, включая `ImporterModule`. Scheduler тикает в `@Injectable() OnModuleInit`.
- Плюсы: одна task definition, одна реплика, минимум инфры.
- Минусы:
  - При auto-scale HTTP до N>1 реплик **scheduler тикает N раз**. Redis-lock (`archive:import:lock:*`) сейчас защищает от двойного импорта одного источника (`SET NX EX 1800`), так что **корректности нет угрозы** — но:
    - Prewarm-cron в `ArchiveService.onModuleInit` **не защищён** lock'ом и тикает N раз параллельно (см. ADR-018 §2.9 п.5, там же помечено как follow-up). Любое масштабирование HTTP заодно множит prewarm-нагрузку на Redis/БД.
    - Тяжёлый TWIC-тик (`COPY` десятки тысяч строк позиций + UPSERT в `position_stats`) выполняется внутри event-loop'а HTTP-реплики. В этот момент latency `/archive/tree` на этой же реплике деградирует. Сейчас публичный архив — 15–30 RPS; для MVP приемлемо, но видимо в метриках.
  - Smoke-отказ scheduler'а (исключение в tick) может уронить весь HTTP-процесс, если не ловить `catch` — у текущего `importer.ts` уже есть `.catch` на setInterval, сохранить контракт.

**Вариант B — один пакет, два entrypoint'а: `dist/main.js` (HTTP) и `dist/importer-main.js` (scheduler).**
- Общий `dist/`, общий Dockerfile, общий image tag. В runtime разделение через разные `CMD` / ECS `command` / docker-compose `command:`.
- `importer-main.ts`:
  ```ts
  // schematic
  import { NestFactory } from '@nestjs/core';
  import { ImporterModule } from './importer.module';
  const app = await NestFactory.create(ImporterModule);
  app.enableShutdownHooks();
  await app.listen(process.env.ARCHIVE_IMPORTER_PORT ?? 3004, '0.0.0.0');
  ```
  Nest-контекст нужен, чтобы:
  - `MetricsService` и `/_/metrics` отдавались Prometheus (иначе impoter-метрики потеряются). Importer-процесс слушает HTTP **только** на `/_/metrics` + `/_/health` — публичного API не даёт.
  - `OnModuleInit/Destroy` lifecycle работал для ArchivePositionWriter (pg.Pool), Redis-клиента, Prisma.
- Плюсы:
  - **Scheduler ровно один** по определению (одна реплика importer-сервиса — как сейчас).
  - HTTP-реплики масштабируются независимо и без overhead импорт-тиков.
  - Один CI-билд, один образ, один набор deps — цель KS-1672 выполнена.
  - Separation of concerns по `CMD`, а не по пакетам — самое лёгкое разделение, которое вообще возможно.
- Минусы:
  - Две task definitions в ECS (как сейчас) / два сервиса в docker-compose.
  - `importer-main` поднимает минимальный HTTP (только `/_/metrics`, `/_/health`) — "лишние" 30–50 Mb RSS на поднятый Nest. Для фактов: текущий `archive-importer` ~80 Mb RSS голый tsx; Nest app ~120–150 Mb RSS. Дельта ~40–70 Mb — приемлема.

**Вариант C — один процесс, но `ARCHIVE_IMPORTER_ENABLED=true/false` через env, scheduler регистрируется только в одной ECS-реплике (pinned).**
- Решает scheduler-singleton вручную через "какой-то один контейнер — с включённым scheduler'ом, остальные — без".
- Плюсы: одна task definition базово.
- Минусы: хрупко. Рулится через вручную-выбранный `ECS Service` instance attribute; любой рестарт этой реплики — пропуск тика. Фактически это тот же вариант B, но с худшей эргономикой.

**Рекомендация — Вариант B.** Один пакет, один образ, два CMD. Обоснование:
- Сохраняет текущий прод-паттерн (importer — singleton, API — auto-scale), не требует доработки prewarm-lock'а в рамках этого ADR.
- Единственная "дополнительная сложность" — второй entrypoint в том же пакете, тривиально для `nest build` (он строит весь `src/`).
- Rollback прозрачен: в любой момент можно откатить image tag ECS-сервисов на предыдущий без смены command.
- Это решение **не блокирует** вариант A в будущем — достаточно будет добавить `ARCHIVE_IMPORTER_ENABLED` и зарегистрировать `ImporterModule` в `AppModule`, ничего из перенесённого кода не трогая.

### 2.3 Планировщик внутри NestJS

**Выбор реализации:**

| Вариант | Оценка |
| --- | --- |
| **`@nestjs/schedule`** (`@Interval`, `@Cron`, `SchedulerRegistry`) | Рекомендуется. Идиоматично для NestJS, lifecycle-aware (`SchedulerRegistry.deleteInterval` на shutdown), интегрируется с логированием. Поддерживает `cron`-строки из `archive_sources.schedule` через `@Cron(cronExpr)` — но динамическая регистрация per-source потребует ручного `SchedulerRegistry.addCronJob` в `onModuleInit`. Для MVP оставляем `@Interval(60_000)` tick-проверку и оставляем intra-tick парсер `intervalFromSchedule` (как сейчас). Так же упрощает KS-158x (полноценный cron-парсер). |
| **BullMQ** (Redis очередь) | Избыточно. 1 задача/неделя, нет множественных workers, не нужна ретрай-стратегия на уровне очереди (есть Redis-lock). Дополнительная зависимость. Отклонено. |
| **Отдельный воркер-процесс того же пакета** | Это вариант B из §2.2 — выбран уже. Планировщик **внутри** этого процесса — `@nestjs/schedule`. |
| **Сохранить `setInterval(60_000)` как есть** | Допустимо, минимальная миграция. Но тогда нет SchedulerRegistry integration, а это — 2 строки кода. |

**Рекомендация:** `@nestjs/schedule` + `@Interval('archiveImporterTick', 60_000)` в `ImporterService.onModuleInit` (или декоратором — зависит от того, нужен ли тест-доступ через `SchedulerRegistry`). Парсер `intervalFromSchedule` из `importer.ts` остаётся как есть — MVP cron (ADR-013 §5).

**Зависимость:** `"@nestjs/schedule": "^4.x"` добавляется в `apps/archive-service/package.json`. Полезно иметь сразу: в будущем можно `@Cron` для prewarm-lock, cleanup-метрик и т.п.

### 2.4 Маппинг `apps/archive-importer/src/*` → модули NestJS

Таблица перехода один-в-один, пути относительно `apps/archive-service/src/`:

| Исходный файл | Новое местоположение | Изменение |
| --- | --- | --- |
| `src/index.ts` | — (удаляется) | bootstrap заменяет `importer-main.ts`. |
| `src/importer.ts` (класс `ArchiveImporter`) | `archive-import/importer.service.ts` | Становится `@Injectable()`, зависимости `PrismaService`, `RedisService`, `ArchivePositionWriterService` инжектятся. `start()` вызывается из `onModuleInit()`, `stop()` — из `onModuleDestroy()`. `setInterval` заменяется `@Interval('archive-importer-tick', 60_000)` либо `SchedulerRegistry.addInterval`. `intervalFromSchedule` остаётся экспортом рядом, как есть. |
| `src/sources/twic.ts` | `archive-import/sources/twic.importer.ts` | Становится `@Injectable()`. `ArchiveImporter.runSource` получает `TwicImporter` через dispatcher-map по `kind`. Constructor injection: `PrismaService`, `PositionIndexerService`, `ArchivePositionWriterService`, `ArchiveImportMetricsService`. Метод `run()` без изменений. |
| `src/position-indexer.ts` | `archive-import/position-indexer.service.ts` | `@Injectable()`, зависимости `PrismaService`, `ArchiveImportMetricsService`. `sourceCode` теперь передаётся аргументом `index(games, { sourceCode })`, а не в constructor — чтобы один singleton обслуживал любой source. |
| `src/archive-position-writer.ts` | `archive-import/archive-position-writer.service.ts` | `@Injectable()` с `onModuleInit()` (create `pg.Pool`) / `onModuleDestroy()` (`pool.end()`). Connection string берётся из `ConfigService.get('ARCHIVE_DATABASE_URL')`. `resolveSslConfig` остаётся чистой exported-функцией рядом. |
| `src/backfill.ts` | `cli/backfill.ts` | Становится тонким shim: `const app = await NestFactory.createApplicationContext(ImporterModule); const svc = app.get(BackfillService); await svc.run(parseArgs(argv)); await app.close()`. Ядро (`backfillLoop`) переезжает в `archive-import/backfill.service.ts` как `@Injectable()`. Аргументы CLI парсятся как сейчас (`parseArgs`). |
| `src/classify-existing.ts` | `cli/classify-existing.ts` + `archive-import/classify-existing.service.ts` | Такой же pattern: тонкий CLI, логика в сервисе. Полезно в будущем — можно триггерить через HTTP-endpoint (не сейчас). |
| `src/cleanup-positions.ts` | `cli/cleanup-positions.ts` + `archive-import/cleanup-positions.service.ts` | Аналогично. |
| `src/rebuild-position-stats.ts` | `cli/rebuild-position-stats.ts` + `archive-import/rebuild-position-stats.service.ts` | Аналогично. Publish `archive:imported` использует общий `RedisService`, а не свой `new Redis(...)` — убирает дубль конфигурации. |
| `src/dedup.ts`, `src/classify.ts`, `src/pgn-utils.ts`, `src/position-row-builder.ts` | `archive-import/*.ts` | Чистые функции, DI не нужен, переезжают как есть. |
| `src/metrics.ts` (importer) | — (удаляется) | Счётчики/гистограммы/gauge заменяются на `prom-client` эквиваленты в `archive-import-metrics/archive-import-metrics.service.ts`, регистрируются в том же `MetricsService.registry` (см. §2.8). |
| `src/*.test.ts` (vitest) | `archive-import/**/*.spec.ts` (jest) | См. §2.10. |
| `src/ply-limit-invariant.test.ts` | `archive-import/ply-limit-invariant.spec.ts` | Контрактный тест, переезжает как есть. |

**Модуль `ImporterModule` (новый):**

```ts
@Module({
  imports: [
    PrismaModule,          // уже существует
    RedisModule,           // уже существует
    MetricsModule,         // уже существует, @Global() — доступен MetricsService
    ScheduleModule.forRoot(),  // NEW, из @nestjs/schedule
  ],
  providers: [
    ImporterService,
    TwicImporter,
    PositionIndexerService,
    ArchivePositionWriterService,
    ArchiveImportMetricsService,
    BackfillService,
    ClassifyExistingService,
    CleanupPositionsService,
    RebuildPositionStatsService,
  ],
  exports: [
    BackfillService,
    ClassifyExistingService,
    CleanupPositionsService,
    RebuildPositionStatsService,
  ],
})
export class ImporterModule {}
```

**Новый `importer.main.module.ts` (для варианта B из §2.2)** — минимальный корень для importer-процесса:

```ts
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'] }),
    PrismaModule, RedisModule, MetricsModule,
    HealthModule,         // /_/health
    ImporterModule,       // scheduler + services
  ],
  // controllers: только MetricsController (через MetricsModule) и HealthController
})
export class ImporterMainModule {}
```

В `AppModule` (HTTP) `ImporterModule` **не импортится** — importer-код не загружается в HTTP-процессе. Это важно: код всё равно в образе, но scheduler и pg.Pool не инициализируются в HTTP-реплике, там только `ArchiveModule`. Сборка `nest build` тащит всё в `dist/`, бэнд-сайз не задействует runtime'а, оверхеда нет.

### 2.5 CLI-утилиты

**Рекомендация:** остаются npm-скриптами пакета `@kingside/archive-service`, но их thin-shim в `cli/*.ts` создаёт `NestApplicationContext` от `ImporterModule`. Это переиспользует DI (Prisma, Redis, Metrics) и конфигурацию.

Скрипты в `package.json` (переезжают из `archive-importer/package.json`):

```json
"archive:backfill":                "node dist/cli/backfill.js",
"archive:backfill:extend":         "node dist/cli/backfill.js --mode=extend",
"archive:classify-existing":       "node dist/cli/classify-existing.js",
"archive:cleanup-positions":       "node dist/cli/cleanup-positions.js",
"archive:rebuild-position-stats":  "node dist/cli/rebuild-position-stats.js"
```

Запуск:
```bash
# из корня
npm run archive:backfill --workspace=@kingside/archive-service
# или в контейнере
node dist/cli/backfill.js --mode=extend --batch-size=5000
```

**Альтернатива — оставить `tsx src/cli/*.ts`** (как сейчас в importer). Отклонено:
- После `nest build` билд единый, нет смысла иметь параллельный `tsx`-путь.
- Dockerfile не обязан ставить `tsx` в production-слой — меньше deps.
- CLI-скрипты, исполняющиеся один раз в месяц/квартал, могут подождать 2–5 с `NestFactory.createApplicationContext` bootstrap.

**Альтернатива — вынести в отдельный маленький пакет `@kingside/archive-cli`.** Отклонено:
- Один потребитель кода (сам archive-service). Extraction не окупается.
- Увеличивает число build-целей Turbo.

### 2.6 ENV-переменные

**Остаются (архив-контур):**

| Имя | Где | Источник |
| --- | --- | --- |
| `ARCHIVE_DATABASE_URL` | оба процесса (HTTP + importer) | существующая (ADR-018 §2.3) |
| `REDIS_HOST`, `REDIS_PORT` | оба процесса | существующая |
| `REDIS_PASSWORD` | оба (сейчас читается только importer'ом в `rebuild-position-stats.ts` при создании своего `new Redis`; после мёрджа — читается в `RedisService`) | существующая |
| `CORS_ORIGIN` | HTTP | существующая (ADR-018 §2.4) |
| `ARCHIVE_STATS_IMPL` | HTTP (DI в ArchiveModule) | существующая |
| `ARCHIVE_PREWARM_DISABLE` | HTTP | существующая |
| `ARCHIVE_SERVICE_PORT` (default 3003) | HTTP | существующая |
| `PGSSLMODE` / `ARCHIVE_IMPORTER_PG_SSL` | importer (в `archive-position-writer`) | существующая (KS-1640) |
| `NODE_ENV` | оба | стандартная |

**Добавляются:**

| Имя | Назначение | Значение по умолчанию |
| --- | --- | --- |
| `ARCHIVE_IMPORTER_PORT` | HTTP-порт минимального сервера importer-процесса (`/_/metrics`, `/_/health`) | `3004` |
| `ARCHIVE_IMPORTER_TICK_MS` | (опционально) override интервала scheduler'а, удобно в dev-локальных прогонах | `60000` |

**Удаляются:**

| Имя | Где было | Почему удалить |
| --- | --- | --- |
| `DATABASE_URL` (из importer-контекста) | был в старом importer'е до KS-1640; сейчас в `apps/archive-importer` уже используется `ARCHIVE_DATABASE_URL` | Проверить, что в ECS task definition `archive-importer` переменная `DATABASE_URL` не продублирована случайно (см. ADR-018 §2.3 рекомендация). Если есть — убирается при миграции task-def. |

**Важно:** `REDIS_PORT` в текущем `archive-importer/src/importer.ts:46` по умолчанию `6380`, в `archive-service/src/redis/redis.service.ts:16` — тоже `6380`. В `rebuild-position-stats.ts:196` — тоже `6380`. Инвариант сохраняется, default не меняется.

### 2.7 docker-compose.yml и Dockerfile (контракт для devops)

Сам `docker-compose.yml` — в root проекта, вне scope архитектора. Контракт:

**Dockerfile.** Один Dockerfile в `apps/archive-service/Dockerfile` (существующий) — **без изменений**: `nest build` уже строит весь `src/`, включая новые `importer.main.ts`, `cli/*.ts`. `CMD ["node","dist/main.js"]` в Dockerfile остаётся как default (HTTP). Importer-сервис в compose **переопределяет** команду:

```yaml
# ориентировочно, детали — devops-тикет
services:
  archive-service:
    build:
      context: .
      dockerfile: apps/archive-service/Dockerfile
    command: node dist/main.js                   # default, можно опустить
    environment:
      ARCHIVE_DATABASE_URL: ...
      REDIS_HOST: redis
      CORS_ORIGIN: ...
    ports: ["3003:3003"]

  archive-importer:
    # ТОТ ЖЕ образ — реюз build из archive-service
    build:
      context: .
      dockerfile: apps/archive-service/Dockerfile
    command: node dist/importer-main.js
    environment:
      ARCHIVE_DATABASE_URL: ...
      REDIS_HOST: redis
      ARCHIVE_IMPORTER_PORT: 3004
    ports: ["3004:3004"]                          # для Prometheus scrape
```

**Что удаляется из docker-compose:**
- Сервис `archive-importer`, который билдил `apps/archive-importer/Dockerfile`.
- Volume/network ссылки именно на старый контейнер — перенацеливаются на новый.

**ECS task definitions (прод) — аналогично:**
- `archive-service` task def — `command: ["node","dist/main.js"]`, HTTP-порт `3003`, target group `kingside-archive-api` (как в ADR-018 §2.6).
- `archive-importer` task def — **тот же image URI**, `command: ["node","dist/importer-main.js"]`, HTTP-порт `3004`, отдельная target group `kingside-archive-importer-metrics` (только для Prometheus) либо scrape по внутреннему IP без ALB. **Рекомендация:** scrape напрямую по IP/port Cloud Map service discovery — ALB для importer'а избыточен (не public HTTP).

**Билд-пайплайн:**
- Turbo task `build` строит один `apps/archive-service/dist/`.
- `apps/archive-importer/dist/` — удаляется вместе с воркспейсом (см. §2.8).
- ECR push — один образ `kingside-archive-service:<sha>`, обе task definitions ссылаются на него.

### 2.8 Метрики

**Текущее состояние:**
- `archive-service`: `prom-client`, собственный `Registry`, `collectDefaultMetrics`, 4 архивных метрики (`archive_tree_list_mismatch_total`, `archive_games_list_position_not_indexed_total`, `archive_tree_query_duration_seconds`, `archive_tree_cache_hit_ratio`). Отдаётся на `/_/metrics`.
- `archive-importer`: самописный in-memory реестр (`Counter`/`Histogram`/`Gauge` классы в `metrics.ts`), 7 метрик (`archive_import_duration_seconds`, `archive_import_games_total`, `position_stats_upsert_duration_seconds`, `archive_importer_position_rows_copy_duration_seconds`, `archive_games_by_category_total`, `archive_imported_non_classical_total`, `archive_rejected_unknown_reason_total`, `archive_classical_ratio`). **`/metrics` endpoint не поднят** — `snapshot()` есть, но никуда не подключён.

**Решение: единый реестр в `MetricsService`.**

- Importer-метрики переносятся на `prom-client` Counter/Histogram/Gauge и регистрируются в `MetricsService.registry`.
- Выделяется новый `ArchiveImportMetricsService` (по аналогии с `ArchiveMetricsService` в `archive/`). Держит сами `Counter`/`Histogram`/`Gauge` и методы-обёртки (`incImportGames`, `observeImportDuration`, etc.).
- `MetricsService.registry` остаётся единственным Registry в процессе.
- `/_/metrics` отдаёт **и** HTTP-метрики архива, **и** импорт-метрики. Prometheus scrape target — один на HTTP-процесс, один на importer-процесс (разные endpoint'ы из-за физического разделения, см. §2.7). Метрики не дублируются: HTTP видит counter'ы `archive_tree_*`, importer — counter'ы `archive_import_*`.

**Имена метрик НЕ меняются.** Prometheus scrape-конфиг devops'а ссылается по именам — задаётся инвариант стабильности. `archive_import_duration_seconds{source="twic"}` остаётся, просто теперь собирается библиотекой `prom-client`.

**Почему не отдельный `Registry` для importer'а.** Единый Registry:
- Позволяет на одном `/_/metrics` увидеть и process-метрики (event loop, RSS, GC) от `collectDefaultMetrics`, и все доменные. Одна Prometheus job конфигурация — одна цель на HTTP-процесс, одна цель на importer-процесс.
- Упрощает тестирование — `getMetric(name)` работает на одном Registry.
- Минус: если в тестах важен изолированный snapshot — тест создаёт новый `Registry` локально (как сейчас в `metrics.service.spec.ts` паттерн допускает).

**Самописный `src/metrics.ts` importer'а удаляется** — `snapshot()` никто не потребляет, API у него нестандартный, разработчик, читающий `ArchiveImportMetricsService`, получает знакомую `prom-client` семантику.

### 2.9 Порядок миграции без простоя

**Инвариант:** в любой момент прод `archive-importer` (старый контейнер) либо `archive-importer` (новый контейнер) — ровно один запущен, ни ноль, ни два.

**Шаг 0. Подготовка (backend, один PR, обратимо).**
Содержит в **одном коммите**:
1. Перенос `apps/archive-importer/src/*` → `apps/archive-service/src/archive-import/*` + `cli/*` + `importer-main.ts` + `importer.module.ts`.
2. Конвертация vitest → jest (см. §2.10), метрик samописных → prom-client.
3. Добавление зависимости `@nestjs/schedule` в `apps/archive-service/package.json`.
4. Удаление `apps/archive-importer/` **пока НЕТ**. Старый воркспейс продолжает жить и исполняться в проде. Это критично для обратимости.
5. Обновление `apps/archive-service/package.json` скриптами `archive:backfill` etc.
6. Обновление `apps/archive-service/README.md` с разделом "Importer" + описание `importer-main.ts`.

Deploy этого коммита **не** меняет прод-поведение: HTTP всё тот же, importer — старый контейнер на старом образе.

**Шаг 1. Dev/stage smoke (backend + qa).**
- Локально: `docker compose up archive-service archive-importer` (оба из нового образа, старый archive-importer в compose-файле remove). Проверить:
  - `curl localhost:3003/_/health` → ok.
  - `curl localhost:3004/_/health` → ok.
  - `curl localhost:3003/_/metrics` — видно `archive_tree_*`, нет `archive_import_*`.
  - `curl localhost:3004/_/metrics` — видно `archive_import_*` + `collectDefaultMetrics`, нет `archive_tree_*`.
  - Логи importer'а: `[archive-importer] DB reachable`, tick'и каждые 60 сек.
  - В БД: при ручном INSERT `archive_sources (code, kind, schedule, enabled) VALUES ('twic-test', 'twic', '*/2 * * * *', true)` — tick запускает импорт.
- CLI: `node dist/cli/backfill.js --mode=extend --batch-size=100` на dev-БД — один батч отрабатывает, `archive_game_positions` растёт.

**Шаг 2. Стейджинг / canary (devops).** Если есть stage-окружение:
- Поднять новую task definition `archive-importer` (новый образ, `command: node dist/importer-main.js`) со **scale=0**.
- Убедиться, что образ build-ится в CI.
- Поменять scale=1, scale старого importer'а=0, засечь логи.
- Sanity-check: `archive_sources.last_success_at` двигается после следующего tick-window.

**Шаг 3. Prod cutover (devops, обратимо).** Окно cutover'а короткое (десятки секунд):
1. Обновить ECR: image `kingside-archive-service:<new-sha>` с включённым importer-кодом.
2. ECS service `archive-service` update (rolling) — HTTP-реплики переезжают на новый образ. Поведение HTTP не меняется.
3. Создать новую ECS task definition `archive-importer-v2` (тот же image URI, `command: node dist/importer-main.js`, env как в старом, добавить `ARCHIVE_IMPORTER_PORT=3004`).
4. `archive-importer` service: rolling replace task-def → v2. scale=1 поддерживается. Старый контейнер останавливается, новый поднимается. Redis lock защищает от двойного тика на переходе.
5. Логи: `[archive-importer] DB reachable` → tick. Sanity: `SELECT last_run_at FROM archive_sources ORDER BY last_run_at DESC LIMIT 5` — двигается.
6. Prometheus: добавить scrape target `archive-importer:3004/_/metrics` (devops).
7. Rollback при отказе — ECS service update на старую task-def. Изменений в БД нет (код тот же), контракт не меняется.

**Шаг 4. Soak (7–14 дней).** Метрики:
- `archive_import_games_total` растёт при каждом tick'е (ожидаемо для TWIC — раз в неделю).
- `archive_importer_position_rows_copy_duration_seconds_sum` — для одного TWIC-пакета порядка 2–10 с. Сравнить с prod-baseline до миграции.
- Нет аварийных рестартов importer-контейнера (ECS event log).

**Шаг 5. Cleanup (backend, точка невозврата по файлам, не по БД).** После успешного soak'а:
1. Удалить `apps/archive-importer/` целиком.
2. Убрать `apps/archive-importer` из workspaces в корневом `package.json`.
3. Убрать из `turbo.json` (если есть явные цели).
4. Убрать README ссылки в `CLAUDE.md`.
5. Удалить старую ECR task-def `archive-importer` (историческую версию не-v2) — *можно подождать ещё 14 дней для гарантии rollback*.
6. Удалить `apps/archive-importer/Dockerfile` — его CI больше не собирает. Если в `scripts/deploy-aws.sh` / CI workflow есть шаги `build archive-importer image` — devops чистит (задача).

**Обратимость:**
- До шага 5 — любой откат == ECS rollback task-def на старый image + revert коммита шага 0.
- После шага 5 — откат требует `git revert` + recompute importer Dockerfile. Возможно, но дороже. Поэтому шаг 5 **делается только после** 7–14 дней soak'а.

**Что идёт одним коммитом, что — отдельно:**
- Шаг 0 — один коммит (большой, но один).
- Шаги 1–2 — без коммитов (dev/stage smoke).
- Шаг 3 — devops-изменения в `scripts/deploy-aws.sh` / ECS конфигах (отдельный коммит в инфре; может быть runbook без коммита в git).
- Шаг 5 — один коммит удаления пакета и правок workspaces/turbo.json/CLAUDE.md.

**Обязательно **не** делать одним коммитом:** "удалить apps/archive-importer + добавить новый код в archive-service". Это лишает отката без ре-писания кода. Старый пакет остаётся в дереве, пока новый не отрабатывает в проде 1–2 недели.

### 2.10 Тесты

`archive-importer` использует **vitest**, `archive-service` — **jest**. Объединение требует унификации.

**Решение:** все переезжающие тесты конвертируются в jest (API почти идентичны: `describe/it/expect`, моки через `jest.fn()` вместо `vi.fn()`). Файлы `*.test.ts` → `*.spec.ts` (паттерн archive-service).

**Объём:** 8 тестов в archive-importer/src/*.test.ts + 1 tsest-like на module boundary (ply-limit-invariant.test.ts) — итого ~90 KB тестового кода. Автоматическая конвертация `sed 's/\bvi\./jest./g; s/from "vitest"/from "@jest\/globals"/g'` покроет большинство случаев, редкие — вручную (`vi.useFakeTimers()` ↔ `jest.useFakeTimers()`).

**Риск:** Vitest supports ESM-first, jest — CJS by default. В archive-service `tsconfig.json: module: CommonJS`, `ts-jest` в `jest.config.ts` — совместимо. Тесты с `.js`-import-extensions (ESM-style) потребуют правок — но их в tsconfig.json archive-service нет.

**Не берём vitest в archive-service**: jest — стандарт для NestJS-проектов, `@nestjs/testing` работает с jest нативно. Обратная миграция — лишняя работа.

### 2.11 Риски и подводные камни

1. **Двойной тик scheduler'а при масштабировании.** При варианте B (рекомендация) нет — importer одна реплика по определению. Если в будущем перейти к варианту A — Redis-lock `archive:import:lock:{code}` защитит `runSource`, но **prewarm-cron не защищён**: нужен `archive:prewarm:lock` (30 минут TTL, SET NX). Это отдельный тикет follow-up, не блокирует KS-1672.
2. **ESM vs CJS разница в moduleResolution.** `archive-importer` — `"module": "ESNext"` + `"moduleResolution": "bundler"`, `archive-service` — `"module": "CommonJS"` + `"moduleResolution": "Node"`. После мёрджа код пишется в CommonJS-стиле (без `.js` extensions в import'ах). Большинство переезжающих файлов уже написаны через ESM-syntax (`from './foo.js'`) — в CJS-сетапе `.js`-суффиксы **не нужны** и должны быть удалены sed'ом. Иначе ts-node/jest не найдёт модули.
3. **`pg-copy-streams` в `node_modules` archive-service.** Добавится как dep. Версия `^6.x` совпадает с той, что в importer'е. **Проверить `npm ls`** на случай неожиданного дубля транзитивной `pg`.
4. **`adm-zip` для TWIC.** Переезжает в deps archive-service. Добавляет ~200 kb в `node_modules`, на runtime не активно.
5. **`iconv-lite` для TWIC (декодинг windows-1251 PGN).** Переезжает в deps.
6. **Scheduler startup race.** При rolling deploy старый importer-контейнер и новый — могут пересечься 30–60 сек. Redis-lock уже защищает от двойного импорта одного source. Но **логи** покажут "`lock held, skipping`" — ожидаемо, не ошибка.
7. **Graceful shutdown importer-процесса.** `ImporterService.onModuleDestroy` должен:
   - Остановить setInterval (`clearInterval`).
   - Дождаться завершения текущего `runSource` (сейчас `running` флаг есть, но нет ожидания в `stop()`). Добавить `await this.currentTickPromise` в `stop()` — тогда SIGTERM не обрывает COPY в середине транзакции. **Это микроулучшение по сравнению с текущим кодом** — указать backend'у в задаче.
8. **`new Redis(...)` в `rebuild-position-stats.ts`.** Сейчас скрипт создаёт **свой** Redis-клиент (чтобы PUBLISH после disconnect Prisma). После мёрджа использует общий `RedisService`. При `NestApplicationContext.close()` клиент закроется автоматически.
9. **`ArchivePositionWriter` pg.Pool lifecycle.** Сейчас writer создаётся в `new ArchiveImporter()` (constructor). В Nest-режиме — `onModuleInit`. Тесты, проверяющие DI и порядок init, могут потребовать корректировки.
10. **Сжатие образа.** Новый образ тянет **всё** (deps HTTP + deps importer). Сейчас два образа по ~200 МБ, станет один ~280 МБ. В сумме экономия (один pull в ECR), но каждый task-pull будет грузить полный образ.
11. **Environment drift между HTTP и importer-task-def.** У них теперь общий образ и большая часть env. Риск: забыть указать `ARCHIVE_IMPORTER_PORT` — importer упадёт при bootstrap, т.к. Nest попытается слушать 3003 и получит `EADDRINUSE` если HTTP рядом (в compose — получит, в ECS — нет, разные containers). Mitigation: Dockerfile не задаёт default порта, `importer-main.ts` требует `ARCHIVE_IMPORTER_PORT` либо fallback'ит на 3004; при `===3003` — warn в логах.
12. **`@nestjs/schedule` singleton.** `ScheduleModule.forRoot()` можно инициализировать один раз. В `ImporterModule` — ок. В `AppModule` (HTTP) — не импортируем `ScheduleModule`, иначе в будущем при варианте A возникнет конфликт. Если `ScheduleModule.forRoot()` есть только в `ImporterModule`, а `ImporterModule` импортится только в `ImporterMainModule` — всё чисто.
13. **Graceful shutdown `app.enableShutdownHooks()`.** В `importer-main.ts` обязательно. Иначе SIGTERM от ECS не триггерит `onModuleDestroy`, pg.Pool не успевает `end()`, Redis-lock остаётся активным ещё 30 минут (до TTL). В текущем `archive-importer/src/index.ts` это сделано через ручной `process.on('SIGTERM')` + `worker.stop()`. Nest decorators заменяют это one-liner'ом.
14. **Тесты на scheduler.** Нужен способ в тесте вызвать `tick()` напрямую, минуя `@Interval`. Решение: оставить `tick()` public method, тест импортирует сервис через `Test.createTestingModule`, вызывает `svc.tick()`. `@Interval` в тесте отключён через `ScheduleModule.forRoot({})` + не запускать `app.init()` в unit-тестах.
15. **Turbo cache.** После удаления `apps/archive-importer` из workspaces turbo может сконфузиться на hash'ах. Прогон `turbo build --force` после Шаг 5 — на случай. Это работа devops'а, не блокирующая архитектуру.
16. **CLAUDE.md упоминания `archive-importer`.** При шаге 5 — пройти grep'ом по `CLAUDE.md`, ADR-013 / ADR-014 / ADR-018 / README и убрать/обновить. Но: архитектор `CLAUDE.md` **не редактирует** (инфра-файл, меняет пользователь). Отдать задачу координатору.
17. **Backfill race c scheduler'ом.** `archive:backfill` CLI может запуститься вручную во время tick'а importer'а. Оба пишут в `archive_game_positions` через `ON CONFLICT DO NOTHING` — дублей не будет. Но если backfill активно COPY'ит и держит long-lived транзакцию, tick importer'а может упереться в ожидание lock'а на `archive_games`. Сейчас это и так возможно; не ухудшается. Mitigation (follow-up): flag `archive:backfill:running` в Redis; importer пропускает tick при занятости.
18. **CI job для `apps/archive-importer`.** После удаления — devops правит `.github/workflows/*.yml` (или аналог). До тех пор CI будет пытаться билдить пустой пакет → падение. Шаг 5 включает и этот чек — задача devops.
19. **Миграция `last_run_at` / `cursor` БД.** После cutover — никакой миграции данных нет, новый importer читает те же `archive_sources.cursor`, `archive_sources.last_run_at` и продолжает с TWIC issue = `cursor + 1`.
20. **Метрики — исторический ряд.** Prometheus хранит имя метрики как идентификатор series. Имена **не меняются** (§2.8), grafana-дэшборды выживают. Историчность `collectDefaultMetrics` (process-метрики) у двух процессов теперь разная (`job="archive-service"` vs `job="archive-importer"`) — в Prometheus это new series, но старые series по job=`archive-importer` продолжают жить со своей ретенцией, не ломают дашборды.

## 3. Последствия

- **Backend.** Один большой PR на Шаг 0 (перенос кода, `@nestjs/schedule`, CLI shims, unit-тесты в jest, удаление самописного metrics). Один маленький PR на Шаг 5 (удаление `apps/archive-importer`, workspaces, README-правки). Нет изменений в `packages/archive-db`, нет миграций БД, нет изменений публичного API archive-service.
- **DevOps.** Обновление docker-compose (один Dockerfile, два сервиса на общем образе). Новая task definition `archive-importer-v2` c тем же image URI, но другим `command`. Prometheus scrape добавляет `archive-importer:3004/_/metrics`. CI pipeline убирает build старого `apps/archive-importer/Dockerfile`. Rollback — смена image tag.
- **Frontend.** Не затрагивается. HTTP-контракт archive-service не меняется.
- **QA.** Smoke после Шаг 3: 4 endpoint'а archive-service (ADR-018 контракт) + метрики impoter'а не застряли на нуле. Regression TWIC tick'а на stage: форсировать через SQL `UPDATE archive_sources SET schedule='*/2 * * * *' WHERE code='twic'` + wait 2 min + `SELECT last_run_at, cursor FROM archive_sources WHERE code='twic'`.
- **Документация.** Обновить ADR-018 §2.3 (добавить примечание "объединено в archive-service per ADR-019"), `apps/archive-service/README.md` (новый раздел "Importer CLI"). Удалить `apps/archive-importer/README.md` при Шаг 5. `CLAUDE.md` и ADR-013 §5 — грепнуть, скорректировать упоминания "standalone worker" → "importer entry of archive-service".

## 4. Предлагаемые тикеты

- **KS-M01 [backend]** — Шаг 0. Перенести `apps/archive-importer/src/*` в `apps/archive-service/src/archive-import/` + `cli/` + `importer-main.ts` + `importer.module.ts`. Конвертировать vitest в jest. Заменить самописный `metrics.ts` importer'а на `prom-client` Counter/Histogram/Gauge в `ArchiveImportMetricsService`. Добавить `@nestjs/schedule`. Добавить npm-скрипты `archive:backfill` etc. Обновить README. **НЕ удалять** `apps/archive-importer`.
- **KS-M02 [devops]** — Шаг 3. Обновить `docker-compose.yml`: сервис `archive-importer` собирается из `apps/archive-service/Dockerfile` с `command: node dist/importer-main.js`, ECR один образ, две task definitions. Обновить prod-ECS: новая task-def `archive-importer-v2` с тем же image URI, rolling replace. Добавить Prometheus scrape target `archive-importer:3004/_/metrics`. Подготовить runbook rollback'а.
- **KS-M03 [qa]** — Smoke-план: HTTP-4-endpoint regression + TWIC tick forced trigger на stage + prod-sanity через 24 ч после cutover.
- **KS-M04 [backend]** — Шаг 5. После 7–14 дней soak'а: удалить `apps/archive-importer/` целиком, убрать из `workspaces` в корневом `package.json` и из `turbo.json`. Grep по репозиторию на упоминания и удаление/правка, кроме `CLAUDE.md` (отдать координатору).
- **KS-M05 [devops]** — После KS-M04: удалить `apps/archive-importer/Dockerfile` references из CI/deploy-скриптов. Удалить старую task-def `archive-importer` из ECS (после soak'а).
- **KS-M06 [backend / follow-up]** — Улучшить `ImporterService.onModuleDestroy`: дождаться завершения текущего tick'а перед закрытием Redis/pg.Pool. Сейчас `stop()` не ждёт, что может обрывать COPY в середине транзакции. Необязательно для KS-1672, но качественное улучшение.
- **KS-M07 [backend / follow-up]** — Защита `prewarmTopPositions` от параллельных тиков через Redis lock (см. §2.11 п.1 и ADR-018 §2.9 п.5). Нужно **только** если в будущем возвращаться к варианту A объединения процессов.
