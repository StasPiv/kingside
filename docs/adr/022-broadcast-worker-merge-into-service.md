# ADR-022: Объединение `apps/broadcast-worker` в `apps/broadcast-service`

**Статус:** Предложено
**Дата:** 2026-04-22
**Задача:** KS-1703
**Связанные ADR:** [ADR-019](./019-archive-importer-merge-into-service.md), [ADR-021](./021-broadcast-service-extraction.md)

> **Прецедент.** Идейно ADR-022 повторяет ADR-019 (archive-importer → archive-service): тот же паттерн «два сервиса под общую БД, объединяем в один пакет». Главное отличие — здесь нагрузка trafficка ниже и желаемый результат ещё проще: **один процесс**, а не «два entrypoint`а в одном пакете», как в ADR-019. Причины — §2.2.

## 1. Контекст

### Что есть сейчас (факт, на 2026-04-22)

1. Два воркспейса работают с одной broadcasts-БД (`@kingside/broadcasts-db`) и одним Redis:

   - **`apps/broadcast-service`** — NestJS (`node:22-slim`), `nest build`, `node dist/main.js`, порт 3004.
     - `src/main.ts` — bootstrap: ConfigModule, ValidationPipe, AllExceptionsFilter, RedisIoAdapter (для multi-instance WS rooms).
     - `src/app.module.ts` — `PrismaModule` + `RedisModule(@Global)` + `MetricsModule(@Global)` + `HealthModule` + `BroadcastModule`.
     - `src/broadcast/broadcast.controller.ts` — `@Controller()` без префикса (хост `broadcasts.kingside.site` уже выражает домен): `GET /` (list + lifecycle), `GET /:id`, `GET /:id/standings`, `GET /:id/rounds`, `GET /:id/rounds/:roundId/games`. Read-only, без auth.
     - `src/broadcast/broadcast.gateway.ts` — Socket.IO default namespace `/`, `transports=['websocket']`. Подписан на Redis-каналы `broadcast:move` / `broadcast:sync` через **dedicated subscriber** (`new Redis(...)` в `onModuleInit`, не общий `RedisService`, потому что `subscribe` блокирует client).
     - `src/health/health.controller.ts` — `GET /_/health` (`SELECT 1` с timeout 500мс).
     - `src/metrics/metrics.controller.ts` + `metrics.service.ts` — `GET /_/metrics`, `prom-client` `Registry`, `collectDefaultMetrics`. Метрики: `broadcast_ws_connections`, `broadcast_ws_subscribe_total`, `broadcast_redis_message_total`, `broadcast_http_query_duration_seconds`.
     - `src/prisma/prisma.service.ts` — `PrismaClient from '@kingside/broadcasts-db'`, `OnModuleInit/Destroy`.
     - `src/redis/redis.service.ts` — `extends Redis`, `host=REDIS_HOST`, `port=REDIS_PORT (default 6380)`, `OnModuleDestroy`.
     - `src/redis/redis-io.adapter.ts` — `IoAdapter` с `@socket.io/redis-adapter`, отдельные `pub/sub` Redis-клиенты.
     - `tsconfig.json` — `module: CommonJS`, `moduleResolution: Node`, `outDir: dist`.
     - Тесты — jest, `ts-jest`, паттерн `*.spec.ts`. `__mocks__/prisma-broadcasts-client.mock.ts` для unit-тестов контроллера.
   - **`apps/broadcast-worker`** — bare-Node TS воркер (`node:20-slim`), запускается через `npx tsx src/index.ts` (билда нет, в проде интерпретируется).
     - `src/index.ts` — 20 строк: `new BroadcastWorker()`, ручные `process.on('SIGINT'|'SIGTERM')` → `worker.stop()`.
     - `src/worker.ts` (~770 строк) — класс `BroadcastWorker`:
       - Constructor: `prisma = new PrismaClient({ datasourceUrl: BROADCASTS_DATABASE_URL ?? DATABASE_URL })` (см. §3 п.6 риска про fallback), `redis` + `pubRedis` (`new Redis({host, port})`).
       - `start()` — DB ping, Lichess ping, очистка stale Redis-локов, `syncBroadcasts()`, `setInterval(syncBroadcasts, 5min)`, `syncPinnedBroadcasts()`, `setInterval(syncPinnedBroadcasts, 1min)`.
       - `stop()` — clearInterval, abort всех `activeStreams` (до 50 SSE параллельно), `redis.del(SYNC_LOCK, PINNED_LOCK)`, `redis.quit()`, `pubRedis.quit()`, `prisma.$disconnect()`.
       - Бизнес-логика: fetch Lichess `/api/broadcast?nb=20`, upsert broadcasts/rounds, стримы `/stream/broadcast/round/:id.pgn`, polling PGN, парсинг через `chess.js`, upsert games, `publish('broadcast:move'|'broadcast:sync', ...)` в Redis.
       - Защита: Redis-локи `broadcast:sync:lock` (TTL 4 мин), `broadcast:pinned:lock` (TTL 50с), `broadcast:pgn-hash:*` (TTL 5 мин), `broadcast:pgn-fetch-cooldown:*` (TTL 1ч), `broadcast:fen:*` (TTL 12ч), `broadcast:miss-count:*` (KS-1700, TTL = staleCycles × syncInterval × 2).
       - Stale-check (KS-1700 Part A): экспортирована **чистая функция** `runStaleCheck(...)` — не привязана к классу, тестируема без TCP.
     - `src/stale-check.test.ts` — `node:test` (`tsx --test`), 6 тестов на `runStaleCheck`.
     - `tsconfig.json` — `module: ESNext`, `moduleResolution: bundler`, `outDir: dist` (но в Dockerfile проде используется `tsx`, билд не нужен; в монорепо `npm run build` всё равно идёт через `tsc`).
     - `package.json` — `"type": "module"` (ESM), `"dev": "tsx watch"`, `"start": "node dist/index.js"`, `"test": "tsx --test src/stale-check.test.ts"`.
     - Dockerfile — `node:20-slim`, копирует `src/`, в production-stage **удаляет `"type": "module"` из package.json** (хак), запуск `CMD ["npx","tsx","src/index.ts"]`.

2. Деплой (см. ADR-021 §2.6 пп.5–6): два ECS task definitions на одном кластере.
   - `broadcast-service` — desired=1, min=1, max=2 (sticky sessions ALB включены для WS).
   - `broadcast-worker` — desired=1, scale=1 (singleton: два конкурирующих worker'а будут дёргать Lichess вдвойне → 429).
   - CloudWatch: `/ecs/broadcast-service`, `/ecs/broadcast-worker`.

3. Контрактная стыковка между ними — **только Redis pub/sub**:
   - Worker `PUBLISH broadcast:move` / `broadcast:sync` → Service `subRedis.subscribe(...)` в `BroadcastGateway.onModuleInit`.
   - Worker пишет в БД, Service читает БД (Single-write по Grep — все `prisma.broadcast(Round|Game)?.(create|update|upsert|delete)` только в `worker.ts`).
   - Не обмениваются HTTP-вызовами, не читают переменные друг друга, не имеют shared in-memory state.

### Что просит KS-1703

Два отдельных контейнера ради одного домена с общей БД, общим Redis и единственным каналом контракта (Redis pub/sub) — перерасход. Объединить в один процесс. План-документ, ответы на 5 пунктов задачи. Код **не пишем**.

### Что НЕ в скоупе ADR-022

- Логика sync/lifecycle (KS-1700 Part A/B) — переезжает «как есть», без правок поведения.
- API-контракты broadcast-service (пути, схемы ответа, WS-события) — не меняются.
- Схема БД `broadcasts_kingside` — не меняется, миграций нет.
- WS-протокол (Socket.IO → SSE и т.п.) — не трогаем.
- Перевод worker-цикла на EventBridge schedule (как в ADR-020 для archive-importer) — отдельная тема, не блокирует слияние.
- Замена `tsx` на `nest build` для worker-кода — в этой задаче делается **частично** (worker съезжает на единый `nest build`), но это побочный эффект слияния, а не самоцель.
- Введение JWT/auth на broadcast-service.

## 2. Решение

### 2.1 Целевая архитектура (ответ на пункт 1 задачи)

**Один Node.js-процесс**, поднимающий:

1. HTTP-сервер NestJS на порту `3004` — текущие 5 контроллер-эндпоинтов + `/_/health` + `/_/metrics` + WS-gateway, всё без изменений в API-контракте.
2. **В том же процессе** — `BroadcastSyncService implements OnModuleInit, OnModuleDestroy`, который через `@nestjs/schedule` (или ручной `setInterval`, см. §2.3) запускает два таймера:
   - `syncBroadcasts` каждые `SYNC_INTERVAL_MS` (5 мин).
   - `syncPinnedBroadcasts` каждые `PINNED_POLL_INTERVAL_MS` (1 мин).
3. Один Prisma-клиент (`PrismaService` от `@kingside/broadcasts-db`), один общий `RedisService` + два **dedicated** Redis-клиента (один для `subscribe` в gateway, один для `publish` в sync-service — см. §2.4 п.2).
4. Один health-check `GET /_/health` обслуживает оба домена (HTTP жив + DB живёт). Worker'у отдельный health не нужен — если sync падает, метрика `broadcast_sync_last_success_seconds_ago` (NEW, см. §2.5) растёт и алертится; контейнер останавливать не нужно — авто-recovery через следующий тик.

**Имя итогового приложения: `broadcast-service` (втягиваем worker, имя не меняем).**

Обоснование:
- Минимум переименований: путь `apps/broadcast-service/`, имя `@kingside/broadcast-service`, ECS-сервис `broadcast-service`, Docker image, CloudWatch group, ALB target group `kingside-broadcasts-api` — всё уже зарегистрировано в DNS, IaC, мониторинге. Переименование в нейтральное `broadcast` потянет правки в десятке мест без выгоды.
- Прецедент ADR-019: `archive-importer` втянули в `archive-service`, имя сохранили — паттерн уже принят командой, согласованность важнее «семантической чистоты».
- Альтернатива «новое имя `broadcast`» — отклонена. Выгода: имя не дезориентирует читателя («service» ≠ только-HTTP). Цена: переименование во всех IaC/dashboards/runbooks. Не окупается.

**Подробнее про "один процесс vs два entrypoint`а" (важное расхождение с ADR-019):**

ADR-019 выбрал вариант B (один пакет, два entrypoint`а — `dist/main.js` и `dist/importer-main.js`, две task definitions с разными `command`). Мотивация: `archive-service` HTTP реально масштабируется до N≥1 (max=2), а importer обязан остаться singleton — два процесса разделяют отвественности.

Здесь **выбираем вариант A — один процесс, всё в нём.** Обоснование:
- `broadcast-service` фактически работает с desired=1 (max=2 заявлено в ADR-021 §2.6 как «forward-compat», но `RedisIoAdapter` запущен впрок, реальный traffic один-инстансный). Бенефита от разделения процессов нет.
- Экономия — главное требование KS-1703. Один процесс ~= 130–180 МБ RSS вместо 2× (~80 МБ worker tsx + ~150 МБ service Nest). Минус один контейнер, минус одна task definition, минус Prometheus scrape target, минус CloudWatch log group.
- Если в будущем потребуется горизонтально масштабировать HTTP (`max>1`), миграция на вариант B (два entrypoint`а) обратима: добавить `worker-main.ts`, отделить `SyncModule` в `WorkerMainModule`, не загружать `SyncModule` в `AppModule`. Архитектурно мы это **не закрываем**, только откладываем.
- Защита от случайного N>1 — Redis-локи (`broadcast:sync:lock`, `broadcast:pinned:lock`) уже работают, новых писателей не появляется. Если кто-то задеплоит desired=2, два таймера будут конкурировать за лок: один тикнет, второй пропустит цикл с логом «lock not acquired, skipping». Корректность не страдает. Lichess получит **двойной** выхлоп `/api/broadcast?nb=20` и `/stream/broadcast/round/:id.pgn` — это уже плохо (429), но не катастрофа на короткий период. Документируется в README как известное ограничение «`broadcast-service` запускать с `desired=1`».

**Альтернатива «вариант C из ADR-019» (feature-flag `BROADCAST_SYNC_ENABLED=true` только на одной реплике)** — отклонена. Хрупко (рестарт «той самой» реплики = пропуск цикла), и не нужно: ALB-replica мы не масштабируем.

### 2.2 Границы модулей внутри одного процесса (ответ на пункт 2)

Целевой layout `apps/broadcast-service/src/`:

```
src/
  main.ts                          # bootstrap (без существенных изменений, +enableShutdownHooks)
  app.module.ts                    # PrismaModule + RedisModule + MetricsModule + HealthModule + HttpModule + SyncModule
  http/                            # ← переименование текущей папки broadcast/, без изменений в коде
    broadcast.controller.ts
    broadcast.controller.spec.ts
    broadcast.gateway.ts
    broadcast.module.ts            # @Module({ controllers: [BroadcastController], providers: [BroadcastGateway] })
    dto/
      broadcast.dto.ts
  sync/                            # NEW — перенос worker-логики
    broadcast-sync.service.ts      # ← apps/broadcast-worker/src/worker.ts (класс BroadcastWorker, без index.ts)
    broadcast-sync.module.ts       # @Module({ providers: [BroadcastSyncService] })
    stale-check.ts                 # ← runStaleCheck pure-функция, без изменений
    stale-check.spec.ts            # ← apps/broadcast-worker/src/stale-check.test.ts, конвертация node:test → jest (см. §2.7)
    sync-metrics.service.ts        # NEW — обёртка над MetricsService для sync-метрик (см. §2.5)
  prisma/                          # без изменений (PrismaModule + PrismaService от broadcasts-db)
  redis/                           # без изменений (RedisModule, RedisService, redis-io.adapter)
  metrics/                         # без изменений + добавляются sync-метрики
  health/                          # без изменений
  common/                          # без изменений
  __mocks__/                       # без изменений
```

**Решения по разделению:**

1. **Папка `http/` вместо текущего `broadcast/`** — read-path (контроллер + WS gateway), write-path (sync) — разные зоны ответственности. Имя `broadcast/` после слияния станет двусмысленным («там же sync лежит?»). Переименование внутрипакетное, импорты обновляются автоматически IDE. Если backend откажется от переименования ради меньшего диффа — допустимо, но тогда внутренний модуль остаётся `BroadcastModule` и название теряет точность. Оставляем решение на backend по итогу review (не блокирующее).

2. **Папка `sync/`** — write-path. Содержит:
   - `BroadcastSyncService` — `@Injectable()` с DI: `PrismaService`, `RedisService` (для acquire/release локов), отдельный `pubRedisClient` (создаётся в `onModuleInit`, см. §2.4 п.2), `SyncMetricsService`. `start()` логика переезжает в `onModuleInit()`, `stop()` — в `onModuleDestroy()`. `setInterval` сохраняется как есть либо заменяется на `@Interval('broadcast-sync', SYNC_INTERVAL_MS)` из `@nestjs/schedule` — выбор §2.3.
   - `stale-check.ts` — pure-функция `runStaleCheck`, без DI. Файл переезжает 1-в-1, изменений в коде не требует.
   - `broadcast-sync.module.ts` — провайдер только `BroadcastSyncService` + `SyncMetricsService`. Импортирует `PrismaModule`, `RedisModule`, `MetricsModule` (все три уже `@Global()` в текущем `app.module.ts`, явно их импортить не обязательно, но для читаемости — стоит).

3. **Тесты, где какие.**
   - `http/broadcast.controller.spec.ts` — остаётся как есть. Тестирует HTTP-handler без БД (через `__mocks__/prisma-broadcasts-client.mock.ts`).
   - `sync/stale-check.spec.ts` — конвертированный `stale-check.test.ts`. Тестирует чистую функцию, моки prisma/redis локальные. **Жест-стиль**: `describe`, `it`, `expect`, `jest.fn()` вместо node:assert.
   - `sync/broadcast-sync.service.spec.ts` — НЕ обязателен в шаге 0 (KS-1703 не требует увеличения покрытия). Опциональная follow-up задача backend: unit-тест на `syncBroadcasts()` с моком `fetch` (Lichess) и моками PrismaService/RedisService. Сейчас покрытия нет ни в worker'е, ни нигде — статус-кво сохраняем.

4. **Lint-граница (опционально, follow-up):** `http/` не должен импортить `sync/` (write не должен звать read). Обратное (`sync/` → `http/`) тоже бесполезно. Можно зафиксировать через `eslint-plugin-boundaries` или `no-restricted-imports`. Не блокирует слияние, отдельный тикет KS-M0X.

5. **Constants и shared types.** В `worker.ts` экспортируются `BROADCAST_MOVE_CHANNEL`, `BROADCAST_SYNC_CHANNEL`. В `broadcast.gateway.ts` те же значения дублированы как литералы. После слияния — единственное место объявления в `sync/broadcast-channels.ts` (или прямо в sync.service), gateway импортирует. Это микро-правка, разумно сделать в шаге 0 заодно.

### 2.3 Планировщик: setInterval vs @nestjs/schedule

| Вариант | Оценка |
|---|---|
| **Сохранить `setInterval`** (как сейчас в worker'е) | Минимум кода, никакой новой зависимости. Минус: при `OnModuleDestroy` нужно вручную clearInterval (это и так делается). Поведение идентично. |
| **`@nestjs/schedule` + `@Interval('broadcast-sync', 300000)`** | Идиоматично NestJS, lifecycle-aware (`SchedulerRegistry.deleteInterval` на shutdown автоматом). Тест-доступ через `SchedulerRegistry.getInterval(name).fn()` (в спеке можно вызвать «тик» вручную). Цена: новая зависимость `@nestjs/schedule@^4.x`. Уже добавлена в archive-service по ADR-019, согласованно. |

**Рекомендация — `@nestjs/schedule`**, по тем же мотивам, что и в ADR-019 §2.3: согласованность с archive-service, lifecycle-hooks без ручной обвязки, тестируемость через `SchedulerRegistry`. Зависимость уже стоит в монорепо. Но **если backend сочтёт, что миграция scheduler`а добавляет лишний риск в пределах одной задачи** — допустимо оставить `setInterval` 1-в-1, добавив `clearInterval` в `onModuleDestroy()`. Не блокирующее.

### 2.4 Риски и подводные камни (ответ на пункт 3)

#### 2.4.1 Блокирующий sync влияет на HTTP latency

**Реальность:** Node.js — однопоточный event loop. После слияния sync-цикл и HTTP-обработчики делят один и тот же loop. Что в sync-цикле может блокировать:

1. `parsePgnGames(pgn)` — синхронный split строк + regex matching. На раунде с 10 партиями + средний PGN в 50–200 ходов → 5–30 мс на тик. Не критично.
2. `computeFenAndLastUci(pgnText)` — `new Chess(); chess.loadPgn(cleaned)` — синхронный, **CPU-bound**. На партии в 80 полуходов — около 5–15 мс. Для 5 раундов × 10 партий за тик `syncPinnedBroadcasts` — до 250–750 мс блокировки event loop **раз в минуту** в худшем случае.
3. `JSON.parse(line)` для NDJSON Lichess — sub-ms, игнорируем.
4. `await this.prisma.*` — асинхронные I/O, event loop не блокируют.
5. `await fetch(...)` к Lichess — асинхронные, не блокируют.
6. Stale-check — преимущественно I/O (Redis incr, prisma update), event loop не блокирует.

**Оценка влияния на HTTP:** в моменте «парсинг 5 раундов» новые HTTP-запросы к `/`, `/:id` ждут ~250–750 мс прежде чем начнут обрабатываться. Текущий нагрузочный профиль `broadcast-service` — десятки RPS в пиках, секундные стопы event loop пользователь увидит как «задержка загрузки страницы тура». Раз в минуту — для read-only публичного UI приемлемо, но **в метрике `broadcast_http_query_duration_seconds` появится двух-горбая гистограмма** (баг репорт от QA очевиден).

**Mitigation:**
- **Не делаем сейчас.** Текущая нагрузка не оправдывает усложнение. Метрику смотрим после cutover'а: если p99 HTTP-latency растёт > 500 мс — возвращаемся к плану «вариант B из ADR-019» (отдельный entrypoint для sync).
- **Возможный future-fix без слияния обратно:** `worker_threads` для парсинга PGN. Парсер чистый, сериализуем (PGN-строка → JSON ParsedGame[]), хорошо ложится на pool из 1–2 воркеров. Это не часть KS-1703, но открытый вектор оптимизации.
- **Не используем `setImmediate()`-batching** — даёт прирост только если в parsePgnGames встроить «yield event loop». Сейчас функция чистая и компактная, переписывать не стоит.

**Промежуточный вывод:** для текущего трафика — **приемлемо**. Документируем как известный риск. Метрика-индикатор: `broadcast_http_query_duration_seconds` p99, baseline снимаем до cutover'а (Шаг 1) и сравниваем после Шаг 4.

#### 2.4.2 Redis-ключи — инварианты

**Все имена ключей сохраняются 1-в-1.** После слияния они продолжают писаться в **тот же** Redis-инстанс, теми же командами:

| Ключ | TTL | Кто пишет до слияния | Кто пишет после |
|---|---|---|---|
| `broadcast:sync:lock` | 4 мин | worker (acquireLock в syncBroadcasts) | sync-service внутри broadcast-service |
| `broadcast:pinned:lock` | 50 с | worker | sync-service |
| `broadcast:pgn-hash:<roundId>` | 5 мин | worker | sync-service |
| `broadcast:pgn-fetch-cooldown:<roundId>` | 1 ч | worker | sync-service |
| `broadcast:fen:<roundId>:<idx>` | 12 ч | worker | sync-service |
| `broadcast:miss-count:<lichessId>` | staleCycles × syncInterval × 2 | worker (runStaleCheck) | sync-service (runStaleCheck) |
| `broadcast:move` (channel) | — pub/sub | worker.publishMove() | sync-service.publishMove() |
| `broadcast:sync` (channel) | — pub/sub | worker.publishSync() | sync-service.publishSync() |

**Что подтвердил Grep** (по `apps/broadcast-worker` и `apps/broadcast-service`): все обращения к Redis-ключам именно с этими литералами, дубликатов префикса нет, никакая внешняя система (game-service, api, web) не читает и не пишет в `broadcast:*` (Grep `"broadcast:" --not-in apps/broadcast-*` → ноль результатов в код-базе).

**Действие при cutover:** ничего. Переходный период (Шаг 3 §2.6) допускает короткое окно, когда оба процесса (старый worker + новый объединённый service) одновременно держат локи; выигрывает первый, второй пропускает цикл — это штатная защита от dual-write.

#### 2.4.3 Полный список ENV-переменных и проверка конфликтов

**broadcast-service (текущее):**

| Имя | Default | Где читается | Обязательная? |
|---|---|---|---|
| `BROADCASTS_DATABASE_URL` | — | `prisma.service.ts` (через `@kingside/broadcasts-db`) | Да в проде |
| `REDIS_HOST` | `localhost` | `redis.service.ts`, `redis-io.adapter.ts`, `broadcast.gateway.ts` (subscriber) | Нет (default ок в dev) |
| `REDIS_PORT` | `6380` | те же три файла | Нет |
| `CORS_ORIGIN` | (dev fallback `localhost:*`) | `main.ts` | Да в `NODE_ENV=production` |
| `NODE_ENV` | — | `main.ts` (для проверки CORS) | Стандартная |
| `PORT` или `BROADCAST_SERVICE_PORT` | `3004` | `main.ts` | Нет |
| `BROADCAST_PINNED_MIN_ELO` | `2600` | `broadcast.controller.ts` | Нет |
| `BROADCAST_PINNED_MIN_GAMES` | `4` | `broadcast.controller.ts` | Нет |
| `BROADCAST_PINNED_UPCOMING_HOURS` | `48` | `broadcast.controller.ts` | Нет |

**broadcast-worker (текущее):**

| Имя | Default | Где читается | Обязательная? |
|---|---|---|---|
| `BROADCASTS_DATABASE_URL` | fallback на `DATABASE_URL` | `worker.ts` (constructor) | Да в проде (одна из двух) |
| `DATABASE_URL` | — | `worker.ts` (fallback, **технический долг**) | Нет, если `BROADCASTS_DATABASE_URL` есть |
| `REDIS_HOST` | `localhost` | `worker.ts` (constructor + start log) | Нет |
| `REDIS_PORT` | `6380` | те же | Нет |
| `BROADCAST_STALE_CYCLES` | `72` | `worker.ts` (checkStaleBroadcasts) | Нет |

**Объединённый набор после слияния (полный):**

| Имя | Default | Кто использует |
|---|---|---|
| `BROADCASTS_DATABASE_URL` | — (required в проде) | PrismaService (общий клиент HTTP+sync) |
| `REDIS_HOST` | `localhost` | RedisService, RedisIoAdapter, sub-Redis в gateway, pub-Redis в sync-service |
| `REDIS_PORT` | `6380` | те же |
| `CORS_ORIGIN` | (dev fallback) | main.ts |
| `NODE_ENV` | — | main.ts |
| `PORT` или `BROADCAST_SERVICE_PORT` | `3004` | main.ts |
| `BROADCAST_PINNED_MIN_ELO` | `2600` | controller |
| `BROADCAST_PINNED_MIN_GAMES` | `4` | controller |
| `BROADCAST_PINNED_UPCOMING_HOURS` | `48` | controller |
| `BROADCAST_STALE_CYCLES` | `72` | sync-service |

**Конфликтов имён нет.** Префиксы `BROADCAST_*` (controller config) и `BROADCAST_STALE_*` (sync) не пересекаются. `REDIS_*` уже используются обоими, общие. `BROADCASTS_DATABASE_URL` — единый.

**Удаляется:**
- `DATABASE_URL` fallback в worker.ts (строки 49 и 77). После слияния Prisma-клиент **только один** (`PrismaService` от `@kingside/broadcasts-db` без fallback). Если в проде кто-то всё ещё деплоил worker со старым `DATABASE_URL` — этот вариант перестаёт работать. Devops должен убедиться, что в task definition объединённого сервиса задана `BROADCASTS_DATABASE_URL` (а не `DATABASE_URL`).

**Не удаляется, но требует внимания:** `WS_USE_REDIS_ADAPTER=auto` упоминалась в ADR-021 §2.6 как опциональная env. В коде `RedisIoAdapter` запускается безусловно (`main.ts` всегда вызывает `connectToRedis`). Эта env существует только в IaC, в коде её нет — игнорируем, пусть остаётся (не мешает). Ничьего поведения слияние тут не меняет.

#### 2.4.4 Graceful shutdown

**До слияния:**
- worker `index.ts` ловит `SIGINT/SIGTERM` ручками, вызывает `worker.stop()`, `process.exit(0)`. `stop()`: clearInterval, abort streams, redis.del(локи), redis.quit(), pubRedis.quit(), prisma.$disconnect.
- service: bootstrap NestJS не вызывает `app.enableShutdownHooks()` (грепнул `main.ts` — строки 1–69, нет). Это означает, что `OnModuleDestroy` не триггерится на SIGTERM, лежащие соединения rg.Pool и Redis закрываются самим Node на exit (быстрый, но не graceful).

**После слияния — обязательное изменение:**

1. В `main.ts` добавить `app.enableShutdownHooks()` перед `await app.listen(...)`. Без этого Nest не вызовет `OnModuleDestroy` на SIGTERM от ECS, и:
   - `BroadcastSyncService.onModuleDestroy()` не выполнит `clearInterval` (таймеры умрут с процессом — ок), не выполнит `abort` для активных Lichess-стримов (TCP-соединения зависнут до timeout), не освободит Redis-локи (TTL подождёт), не вызовет `redis.quit()`/`prisma.$disconnect()` (соединения оборвутся, в логах сервера будет «client closed connection» — для прода терпимо, но грязно).
   - `BroadcastGateway.onModuleDestroy()` не закроет subRedis (тоже грязно).
   - `RedisService.onModuleDestroy()` не вызовется.

2. `BroadcastSyncService.onModuleDestroy()` должен делать всё то же, что текущий `worker.stop()`:
   ```ts
   async onModuleDestroy() {
     this.stopped = true;
     clearInterval(this.syncTimer);
     clearInterval(this.pinnedPollTimer);
     for (const ctrl of this.activeStreams.values()) ctrl.abort();
     this.activeStreams.clear();
     await this.redis.del(SYNC_LOCK_KEY, PINNED_LOCK_KEY).catch(() => {});
     await this.pubRedis.quit().catch(() => {});
     // PrismaService и RedisService закрываются самостоятельно через свои OnModuleDestroy
   }
   ```
   Замечание: `redis.quit()` для **общего** `RedisService` НЕ вызываем здесь — у него собственный `OnModuleDestroy` в `redis.service.ts:30`. Только `pubRedis` (свой dedicated) — наш.

3. **Гонка SIGTERM ↔ текущий тик.** Текущий `worker.stop()` НЕ ждёт завершения активного `syncBroadcasts()`/`syncPinnedBroadcasts()` — флаг `stopped=true` ставится, но `await syncBroadcasts()` уже выполняется. На SIGTERM это означает: ECS даёт `stopTimeout` (default 30 с), активный prisma.upsert завершается, fetch к Lichess может оборваться по abort. Поведение допустимое — при следующем старте лок отпустится по TTL (4 мин) и тик повторится.

   **Микро-улучшение, не блокирующее KS-1703:** в `BroadcastSyncService` хранить `currentTickPromise: Promise<void> | null`, в `onModuleDestroy()` `await currentTickPromise` с timeout 25 с (меньше ECS stopTimeout), потом форс-выход. Аналогично рекомендации в ADR-019 §2.11 п.7. Backend оценит, в шаге 0 или follow-up.

4. **WS-сессии на shutdown.** `BroadcastGateway` сейчас НЕ ловит shutdown — Socket.IO server закроется одновременно с HTTP listener'ом, активные клиенты получат `disconnect`. Это OK (фронт делает auto-reconnect), не меняем.

#### 2.4.5 Health-check

**Не меняется.** Текущий `GET /_/health` в broadcast-service:
- `SELECT 1 AS ok` против `broadcasts_kingside` БД с timeout 500 мс.
- Возвращает `{ status: 'ok'|'degraded' }` всегда HTTP 200 (см. комментарий в `health.controller.ts`).

**Worker'у отдельный endpoint не нужен** — sync-loop живёт в том же процессе, что HTTP. Если процесс отвечает на `/_/health`, sync-loop тоже работает (за исключением ситуации, когда sync застрял в неосвобождённом lock'е или в бесконечном retry — но это уже не «процесс мёртв», это бизнес-сбой).

**Опциональное улучшение (follow-up, не KS-1703):**
- Метрика `broadcast_sync_last_success_seconds_ago` (gauge), увеличивается монотонно, сбрасывается в 0 после успешного `syncBroadcasts()`. Если > 30 мин (6 циклов подряд) — алерт в Prometheus.
- Метрика `broadcast_sync_runs_total{result="ok|err|skipped"}` (counter).
- Эти метрики — задача §2.5, **базовый набор должен войти в шаг 0**, чтобы у нас был baseline после cutover.

### 2.5 Метрики (минимальное расширение)

Текущий `MetricsService` имеет 4 метрики, все про HTTP/WS read-path. После слияния добавить **минимальный** набор для sync — иначе мы потеряем видимость, когда worker перестанет логироваться отдельной CloudWatch-группой.

**Новые метрики (регистрировать в общем `MetricsService.registry`, имя prefix `broadcast_sync_*`):**

| Имя | Тип | Labels | Что измеряет |
|---|---|---|---|
| `broadcast_sync_runs_total` | Counter | `kind` ('full'\|'pinned'), `result` ('ok'\|'err'\|'skipped') | счётчик тиков sync/pinned-poll |
| `broadcast_sync_duration_seconds` | Histogram | `kind` | длительность тика (excl. lock acquisition) |
| `broadcast_sync_last_success_timestamp_seconds` | Gauge | `kind` | UNIX-секунды последнего успешного тика |
| `broadcast_sync_lichess_fetch_total` | Counter | `endpoint` ('list'\|'pgn'\|'stream'), `status` ('200'\|'429'\|'5xx'\|'timeout') | внешние запросы |
| `broadcast_sync_active_streams` | Gauge | — | размер `activeStreams` map |

`SyncMetricsService` — обёртка с методами `recordSyncRun(kind, result)`, `observeSyncDuration(kind, sec)`, `markLastSuccess(kind)`, `incLichessFetch(endpoint, status)`, `setActiveStreams(n)`. Внутри — `Counter`/`Histogram`/`Gauge` объекты, регистрируются в **существующем** `MetricsService.registry`. Один Registry на процесс, `/_/metrics` отдаёт всё.

Самописных метрик в worker.ts сейчас НЕТ (worker логирует в stdout console.log, метрик нет — это пробел, который слияние закрывает).

### 2.6 План миграции по шагам (ответ на пункт 4)

**Инвариант:** в любой момент в проде ровно один процесс активно пишет в `broadcast_*` таблицы. Допускается короткое окно «два процесса» при rolling deploy (защищено Redis-локами), не допускается «ноль процессов» дольше 5 мин (один цикл sync).

#### Шаг 0 — backend, один большой PR, обратимо

Контент шага в одном коммите:

1. **Перенос файлов:**
   - `apps/broadcast-worker/src/worker.ts` → `apps/broadcast-service/src/sync/broadcast-sync.service.ts`. Класс `BroadcastWorker` → `BroadcastSyncService`. Декорируется `@Injectable()`. Constructor с DI (`PrismaService`, `RedisService`). `start()` → `onModuleInit()`, `stop()` → `onModuleDestroy()`. Прямой `new Redis(...)` для `pubRedis` остаётся (отдельный клиент только под `publish`, по ADR-021 §2.3 п.3) — создаётся в `onModuleInit`, закрывается в `onModuleDestroy`.
   - `apps/broadcast-worker/src/stale-check.test.ts` → `apps/broadcast-service/src/sync/stale-check.spec.ts`. Конвертация node:test → jest (sed: `node:test` → `@jest/globals`, `assert.equal` → `expect(...).toBe(...)`, `assert.deepEqual` → `expect(...).toEqual(...)`, `assert.ok` → `expect(...).toBeTruthy()`, описание `beforeEach` совместимо). Файл небольшой (~230 строк), ручной review после sed обязателен.
   - `runStaleCheck` функция — выносится из `worker.ts` в отдельный файл `apps/broadcast-service/src/sync/stale-check.ts` (она там уже логически отдельная, экспортируемая — просто физически разделить, тест на неё переезжает рядом).
   - `apps/broadcast-worker/src/index.ts` — **не переезжает** (его роль выполняет `main.ts` объединённого процесса).

2. **Изменения в существующих файлах:**
   - `apps/broadcast-service/src/main.ts` — добавить `app.enableShutdownHooks()` перед `app.listen()`.
   - `apps/broadcast-service/src/app.module.ts` — добавить `BroadcastSyncModule` в `imports`. Если решено переименовать `broadcast/` → `http/`, обновить импорт `BroadcastModule`.
   - `apps/broadcast-service/src/broadcast/broadcast.gateway.ts` — заменить дублированные литералы `BROADCAST_MOVE_CHANNEL`/`BROADCAST_SYNC_CHANNEL` на импорт из `sync/broadcast-channels.ts` (новый общий файл).
   - `apps/broadcast-service/src/metrics/metrics.service.ts` — добавить новые `broadcast_sync_*` метрики (или вынести в `sync/sync-metrics.service.ts` — выбор по стилю backend).
   - `apps/broadcast-service/package.json`:
     - `dependencies`: добавить `chess.js@^1.0.0-beta.8` (worker'овая, не было в service).
     - `dependencies`: добавить `@nestjs/schedule@^4.x` если выбран этот вариант (§2.3).
     - `devDependencies`: убрать ничего не нужно — jest/ts-jest уже стоят.
   - `apps/broadcast-service/tsconfig.json` — без изменений (CommonJS, NodeNext).
   - `apps/broadcast-service/jest.config.ts` — без изменений (ts-jest подхватит новые `*.spec.ts` в `sync/`).

3. **`apps/broadcast-worker/`** — **не удаляем в этом коммите**. Старый воркспейс остаётся в дереве, в проде продолжает крутиться старый контейнер. Это ключ к обратимости — в случае проблем после деплоя возвращаемся к scale=0/scale=1 без `git revert`.

4. **Документация:** в `apps/broadcast-service/README.md` — раздел «Sync-loop» (что делает, как тестировать локально, что в логах ожидать). README у `apps/broadcast-worker` — пометка «deprecated, см. broadcast-service/README.md sync-loop». Markdown ADR-021 §2.3 — добавить примечание-ссылку на ADR-022 (sleep deferred to actual ADR-021 update task — backend в шаге 0 правит только новый README).

5. **`CLAUDE.md`** — упоминания `broadcast-worker` в таблице «Зона ответственности» оставляются как есть (архитектор `CLAUDE.md` не редактирует, по правилу). Координатор проводит обновление отдельной задачей пользователю.

**Деплой коммита шага 0** в прод: образ `broadcast-service` пересобирается (теперь содержит sync-код), но прод-task definition по-прежнему запускает только HTTP. **Sync-loop в новом образе НЕ активируется**, пока IaC шага 2 не переключит. Это достигается фича-флагом `BROADCAST_SYNC_ENABLED=true` (NEW env, default `false` в коде) — `BroadcastSyncService.onModuleInit()` начинается с `if (process.env.BROADCAST_SYNC_ENABLED !== 'true') return;`. Без флага модуль зарегистрирован, но idle.

**Логика флага явно прописывается в коде шага 0**, чтобы:
- Один и тот же образ можно поднять как «service-only» (current behaviour, pristine) и как «service+sync» (после cutover).
- Шаг 2 cutover'а — простое изменение env в task definition, без пересборки образа.
- Откат cutover'а — снять флаг, без пересборки.

#### Шаг 1 — dev/stage smoke (backend + qa, без коммита в прод)

Локально (`docker compose up`):
- Поднять объединённый `broadcast-service` с `BROADCAST_SYNC_ENABLED=true`. Старый `broadcast-worker` в compose **выключить** (закомментировать).
- Проверить:
  - `curl localhost:3004/_/health` → `{ status: 'ok', db: 'ok' }`.
  - `curl localhost:3004/_/metrics` → видны `broadcast_ws_*`, `broadcast_http_*`, `broadcast_sync_*` (свежие).
  - Логи: `[broadcast-sync] Cleared stale locks`, через 5 мин `[broadcast-sync] Syncing broadcasts from Lichess...`, `[broadcast-sync] Fetched N broadcasts from Lichess`.
  - В БД `broadcasts_kingside`: `SELECT updated_at FROM broadcasts ORDER BY updated_at DESC LIMIT 5` — двигается после первого тика.
  - WS: подключиться через `wscat -c ws://localhost:3004/socket.io/?EIO=4&transport=websocket`, отправить `42["broadcast:subscribe",{"roundId":"<uuid>"}]` — получить `broadcast:sync` snapshot. Через 1–5 мин, при наличии активной partii в Lichess, прилететь `broadcast:move`.

Если есть stage-окружение с реальной prod-схожей БД — повторить там (devops оп. — не блокирующее, при отсутствии stage пропускаем).

#### Шаг 2 — prod cutover (devops, обратимо за 1 минуту)

**Окно cutover'а:** ~30 секунд (время одного rolling-update task definition).

1. Загрузить новый image `broadcast-service:<sha-step0>` в ECR (если ещё не загружен — CI после merge шага 0 сделает автоматически).
2. **Не меняя** `broadcast-service` task definition, обновить service на новый image — rolling. Поведение прода неизменно (флаг ещё не выставлен).
3. Подготовить **новую** task definition `broadcast-service-v2` с:
   - тот же image,
   - **добавлена env** `BROADCAST_SYNC_ENABLED=true`,
   - **добавлены env** `BROADCAST_STALE_CYCLES=72` (если в task def `broadcast-worker` стояло переопределение — перенести),
   - desired остаётся 1.
4. **Сначала** масштабировать `broadcast-worker` service в `desired=0`. Подождать 30 секунд (старый worker отпускает Redis-локи через TTL 4 мин — но ничто в этом промежутке не пишет в БД, что нормально для одного пропущенного цикла).
5. **Потом** обновить `broadcast-service` на task-def v2 (rolling) — новый процесс просыпается с активным sync-loop. Логи: `[broadcast-sync] Cleared stale locks`, через 5 мин — sync.
6. Sanity check 5–10 мин: `SELECT MAX(updated_at) FROM broadcasts` двигается; `broadcast_sync_runs_total{result="ok"}` инкрементится в `/_/metrics`.
7. **Не удалять** `broadcast-worker` ECS service — оставить scale=0 на 7–14 дней для быстрого rollback.

**Rollback (если что-то пошло не так):**
- Откатить `broadcast-service` task-def на v1 (без sync env) — sync выключается через 1 секунду (модуль ставит флаг и не тикает).
- Поднять `broadcast-worker` service в desired=1 — старый контейнер просыпается с тем же `BROADCASTS_DATABASE_URL`/`REDIS_*`, продолжает синхронизацию с Lichess. Окно простоя: ~30 с (время поднятия старого worker'а).
- Метрика проверки rollback'а: `SELECT MAX(updated_at) FROM broadcasts WHERE updated_at > NOW() - INTERVAL '10 min'` — должно быть > 0 строк.

**Почему именно «сначала worker scale=0, потом service v2»**, а не одновременно:
- Если поднять оба одновременно — два writer'а на 1–2 минуты, Redis-лок защищает, но Lichess получает двойной запрос. Терпимо, но грязно.
- Если сначала service v2, потом worker scale=0 — то же двойное окно. Хуже, чем «короткий пропуск одного цикла» в обратной последовательности.
- Минута простоя sync — пользователь не заметит, broadcasts на странице обновляются с задержкой sync × 1 цикл.

#### Шаг 3 — soak (7–14 дней, никто ничего не делает)

Метрики, на которые смотрим:
- `broadcast_sync_runs_total{kind="full",result="ok"}` — растёт ~12/час (раз в 5 мин).
- `broadcast_sync_runs_total{kind="pinned",result="ok"}` — растёт ~60/час.
- `broadcast_sync_lichess_fetch_total{status="429"}` — нулевой или близкий. Если растёт — Lichess нас ratelimit'ит, повод проверить.
- `broadcast_http_query_duration_seconds` p99 — сравнение с baseline шага 1. Если p99 вырос > 500 мс — пометка для §2.4.1 (откат к варианту B).
- `broadcast_sync_last_success_timestamp_seconds` — `now() - value < 600` (10 мин). Алерт если > 1800 (30 мин).

#### Шаг 4 — cleanup (backend + devops, после успешного soak'а)

1. **Backend (один коммит):**
   - Удалить `apps/broadcast-worker/` целиком (включая Dockerfile, package.json, src/, dist/).
   - Удалить `apps/broadcast-worker` из `workspaces` в корневом `package.json`.
   - Удалить из `turbo.json` если есть явные цели.
   - Снять флаг `BROADCAST_SYNC_ENABLED` — sync должен работать **по умолчанию** в объединённом сервисе. Удалить `if (env !== 'true') return;` из `onModuleInit`.
   - **Альтернатива** — оставить флаг как «kill switch» для аварийного отключения sync без redeploy. Это хорошая практика, рекомендую оставить, но дефолт перевернуть: `default true`, `BROADCAST_SYNC_ENABLED=false` отключает (как «pause»). Backend выбирает по итогу.
   - Грепнуть остальные упоминания `broadcast-worker` в кодовой базе (NOT в `CLAUDE.md` и `.claude/agents/`, по правилу архитектора). Кандидаты для правки:
     - `apps/broadcast-service/src/main.ts` — комментарий «и broadcast-worker публикует ...» в шапке.
     - `apps/broadcast-service/src/redis/redis-io.adapter.ts` — комментарий аналогично.
     - `apps/broadcast-service/src/broadcast/broadcast.gateway.ts` — `@deprecated Используй Redis pub/sub из broadcast-worker'а` → `... из BroadcastSyncService`.
     - `docs/adr/021-broadcast-service-extraction.md` — добавить пометку «§2.3 объединено в broadcast-service per ADR-022».

2. **Devops (отдельный тикет, IaC):**
   - Удалить ECS service `broadcast-worker` (не только scale=0).
   - Удалить старые task-def revision `broadcast-worker:*` (можно подождать ещё 14 дней).
   - Удалить CloudWatch log group `/ecs/broadcast-worker`.
   - Удалить из CI workflow / `scripts/deploy-aws.sh` (если есть) шаги «build broadcast-worker image».
   - Удалить ECR repository `kingside-broadcast-worker`.

**Точка невозврата:** до шага 4 — откат через ECS task-def revert + scale=1 broadcast-worker (сохранённый старый image в ECR). После шага 4 — откат требует `git revert` + воссоздание task-def + воссоздание image. Поэтому шаг 4 делается **только** после 7–14 дней soak'а.

### 2.7 Что НЕ трогать в рамках задачи (ответ на пункт 5)

Жёстко зафиксированные инварианты:

1. **Логика sync/lifecycle (KS-1700 Part A/B).** `runStaleCheck`, `checkStaleBroadcasts`, обработка `currentLichessIds`, TTL-формула `staleCycles × syncInterval × 2`, защита «empty Lichess response → skip stale check» — переезжают **строка-в-строку**.
2. **API-контракты broadcast-service.** Пути (`/`, `/:id`, `/:id/standings`, `/:id/rounds`, `/:id/rounds/:roundId/games`, `/_/health`, `/_/metrics`), HTTP-методы, query-параметры (`limit`, `offset`, `lifecycle`), shape JSON-ответов, lifecycleStatus values, isPinned логика — без изменений.
3. **WS-протокол.** Default namespace `/`, события `broadcast:subscribe`, `broadcast:unsubscribe`, `broadcast:move`, `broadcast:sync`, payload shapes — без изменений. Redis pub/sub каналы `broadcast:move` и `broadcast:sync` — те же литералы.
4. **Схема БД `broadcasts_kingside`.** Никаких миграций, новых колонок, индексов, переименований. Все три таблицы (`broadcasts`, `broadcast_rounds`, `broadcast_games`) и `@kingside/broadcasts-db` Prisma-клиент — без изменений.
5. **Redis-ключи и TTL.** Все 6 ключей (`broadcast:sync:lock`, `broadcast:pinned:lock`, `broadcast:pgn-hash:*`, `broadcast:pgn-fetch-cooldown:*`, `broadcast:fen:*`, `broadcast:miss-count:*`) — те же имена, те же TTL.
6. **Поведение Lichess-fetch.** `LICHESS_API` URL, retries (3 попытки, exponential backoff 5/10/15 с), `User-Agent`, `RATE_LIMIT_DELAY_MS` (1500 мс), `RATE_LIMIT_429_BACKOFF_TTL` (60 с), `MAX_CONCURRENT_STREAMS` (50), `MAX_PGN_POLLS_PER_CYCLE` (5) — все константы переезжают как есть.
7. **Defaults env-переменных.** `SYNC_INTERVAL_MS=5min`, `PINNED_POLL_INTERVAL_MS=1min`, `BROADCAST_STALE_CYCLES=72`, `BROADCAST_PINNED_MIN_ELO=2600`, `BROADCAST_PINNED_MIN_GAMES=4`, `BROADCAST_PINNED_UPCOMING_HOURS=48` — без изменений.
8. **Frontend.** `apps/web` ничего не меняет — он ходит в `https://broadcasts.kingside.site` (хост остался), ничего про слияние не знает.
9. **Auth/CORS.** Нет авторизации (broadcasts public), CORS_ORIGIN не меняется.

## 3. Последствия

- **Backend:**
  - Один большой PR на шаг 0 (~+800 LOC перенесённого кода в новые места, +150 LOC обвязки DI/lifecycle/metrics, ~-770 LOC из удаляемого worker.ts — но удаление в шаге 4). Один маленький PR на шаг 4.
  - Новые зависимости: `chess.js`, опционально `@nestjs/schedule`. Уже стоят в монорепо.
  - Тесты: +1 переписанный (`stale-check.spec.ts` jest вместо node:test), 0 удалённых, 0 ломающихся (broadcast.controller.spec.ts не затрагивается).
- **DevOps:**
  - Шаг 2: одна новая task-def, одно изменение env-переменной, одно scale=0. Без новой инфры (DNS/ALB/Redis/RDS не меняются).
  - Шаг 4: удаление ECS service, ECR repo, CloudWatch group, CI step. Прозрачная очистка.
  - Образ становится чуть больше (объединённый): сейчас broadcast-service ~280 МБ, broadcast-worker ~250 МБ. Объединённый ожидаемо ~290–310 МБ (chess.js + общие deps дедуп). Минус один ECR pull при деплое.
  - Рантайм: один контейнер вместо двух. RSS объединённого — ~150–200 МБ (вместо 80 + 150 = 230). CPU — суммарный, но разнесён во времени (HTTP постоянно низкий, sync-всплески раз в минуту).
- **Frontend:** не затрагивается.
- **QA:**
  - Шаг 1: smoke-проверка по чек-листу из §2.6 шаг 1.
  - Шаг 2 (после cutover): regression на 5 HTTP-эндпоинтов + WS subscribe-flow + проверка `SELECT COUNT(*) FROM broadcasts WHERE updated_at > NOW() - INTERVAL '15 min'` > 0 (свежий sync прошёл).
  - Шаг 3 (soak): мониторинг метрик `broadcast_sync_*`, `broadcast_http_query_duration_seconds`.
- **Документация:**
  - Новый ADR-022 (этот документ).
  - Обновление `apps/broadcast-service/README.md` (раздел Sync) — шаг 0 backend.
  - Пометка в ADR-021 §2.3 — шаг 4 backend.
  - `CLAUDE.md` — обновление таблицы «Agent Roles & Ownership» (убрать `apps/broadcast-worker` из owned by backend) — задача координатору, **не архитектору** (правило).

## 4. Предлагаемые тикеты (для координатора)

- **KS-M01 [backend]** — Шаг 0. Перенести `apps/broadcast-worker/src/worker.ts` в `apps/broadcast-service/src/sync/broadcast-sync.service.ts` с DI и lifecycle-hooks. Перенести `runStaleCheck` в `sync/stale-check.ts`. Конвертировать тест в `sync/stale-check.spec.ts` (jest). Добавить `BROADCAST_SYNC_ENABLED` flag (default `false`). Добавить `app.enableShutdownHooks()` в main.ts. Добавить sync-метрики в MetricsService (или отдельный SyncMetricsService). Расшарить константы `BROADCAST_*_CHANNEL`. Обновить `broadcast-service/package.json` (chess.js, опц. @nestjs/schedule), README. **НЕ удалять** `apps/broadcast-worker/`. **Не менять** API/WS-контракты, схему БД, Redis-ключи, defaults.
- **KS-M02 [qa]** — Шаг 1. Smoke-чек-лист dev (compose) + опционально stage. См. §2.6 шаг 1. Зафиксировать baseline `broadcast_http_query_duration_seconds` p50/p95/p99 до cutover'а.
- **KS-M03 [devops]** — Шаг 2. Обновить ECS: новая task-def `broadcast-service` с `BROADCAST_SYNC_ENABLED=true` + `BROADCAST_STALE_CYCLES`. Сценарий cutover: scale=0 у `broadcast-worker` сначала, потом rolling update `broadcast-service` на новую task-def. Подготовить runbook rollback'а (1-минутное окно). Не удалять старый ECS service `broadcast-worker` (оставить scale=0).
- **KS-M04 [qa]** — Sanity-смок после cutover: 5 HTTP-эндпоинтов + WS subscribe + 24-часовой мониторинг `broadcast_sync_*` и HTTP latency.
- **KS-M05 [backend]** — Шаг 4. После 7–14 дней soak'а: удалить `apps/broadcast-worker/` целиком, убрать из `workspaces`. Снять `BROADCAST_SYNC_ENABLED` флаг (или поменять default на `true`, оставить как kill switch — выбор backend). Обновить комментарии в коде про «broadcast-worker». Добавить пометку в ADR-021 §2.3 со ссылкой на ADR-022.
- **KS-M06 [devops]** — После KS-M05: удалить ECS service `broadcast-worker`, ECR repo, CloudWatch log group, CI build step.
- **KS-M07 [backend / follow-up, опционально]** — Подождать завершения текущего тика sync в `BroadcastSyncService.onModuleDestroy()` через `await currentTickPromise` с timeout 25 с. Микро-улучшение graceful shutdown (см. §2.4.4 п.3). Не блокирует KS-1703.
- **KS-M08 [backend / follow-up, опционально]** — При росте `broadcast_http_query_duration_seconds` p99 > 500 мс после cutover: вынести `parsePgnGames` в `worker_threads` pool либо мигрировать на вариант B (отдельный entrypoint sync). Триггер — реальные метрики, не превентивно.

## 5. Связь с соседними ADR (чтобы не было противоречий)

- **ADR-019** (archive-importer → archive-service) — прямой прецедент. Главное расхождение: ADR-019 выбрал «один пакет, два entrypoint`а», ADR-022 — «один процесс». Причина — у broadcast реальный max=1 на HTTP, у archive max=2; разделение процессов нужно только при `max>1` HTTP-реплик.
- **ADR-020** (archive-importer EventBridge schedule) — open question, делать ли EventBridge для broadcast-sync вместо in-process scheduler. ADR-022 решает: **нет**, in-process. Причина: broadcast-sync тикает каждые 5 мин (288 раз/сутки) против archive-importer'а (раз/неделю); EventBridge invocation cost не оправдан, плюс sync держит долгоживущие SSE-стримы (`activeStreams`), которые в lambda-модели не работают. Это явно фиксируется как «не делаем», чтобы не открывать тему повторно.
- **ADR-021** (extract broadcast в отдельный сервис) — фундамент. ADR-021 §2.3 описывает `broadcast-worker` как отдельный процесс; ADR-022 это переписывает. После шага 4 в ADR-021 §2.3 добавляется пометка-ссылка на ADR-022.
- **ADR-017** (subdomains) — не затрагивается, `broadcasts.kingside.site` сохраняется как HTTP/WS-хост.
