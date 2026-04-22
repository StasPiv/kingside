# ADR-021: Вынос broadcasts в отдельный сервис `broadcasts.kingside.site` и отдельную БД

**Статус:** Предложено
**Дата:** 2026-04-22
**Задача:** KS-1695
**Связанные ADR:** [ADR-017](./017-service-subdomains.md), [ADR-018](./018-archive-service-extraction.md), [ADR-019](./019-archive-importer-merge-into-service.md), [ADR-020](./020-archive-importer-eventbridge-schedule.md)

## 1. Контекст

### Что есть сейчас (факт)

1. **HTTP API трансляций** живёт в `apps/api/src/broadcast/`:
   - `broadcast.controller.ts` — `@Controller('broadcasts')`, эндпоинты:
     - `GET /broadcasts` — список активных трансляций + pagination + признак `isPinned` + `avgElo` (вычисляются raw-SQL на `broadcasts`/`broadcast_rounds`/`broadcast_games`).
     - `GET /broadcasts/:id` — метаданные трансляции.
     - `GET /broadcasts/:id/standings` — crosstable + Sonneborn-Berger, считается в памяти по всем партиям трансляции.
     - `GET /broadcasts/:id/rounds` — список туров.
     - `GET /broadcasts/:id/rounds/:roundId/games` — партии в туре.
   - `broadcast.gateway.ts` — `@WebSocketGateway({ namespace: '/broadcast', cors: { origin: '*' }, transports: ['websocket'] })`:
     - Клиентские события: `broadcast:subscribe` (join room `broadcast:<roundId>`, получает SYNC-снапшот из БД), `broadcast:unsubscribe`.
     - Серверные события: `broadcast:move`, `broadcast:sync`.
     - Источник данных — Redis pub/sub каналы `broadcast:move`, `broadcast:sync`, которые публикует `apps/broadcast-worker`. Gateway подписывается на них в `onModuleInit`.
     - `@UseGuards(...)`/`@Public()` отсутствуют — эндпоинты публичные (Grep подтверждает).
   - `broadcast.module.ts` — `BroadcastController`, `BroadcastGateway`, + `ChessResultsService`, `LivechesscloudService` (см. §1.5 ниже).
   - DTO: `SubscribeRoundDto { roundId }`, `UnsubscribeRoundDto { roundId }` — `class-validator`.
   - Глобальный префикс `/api` в `apps/api/src/main.ts` **уже снят** (ADR-018 §2.5, верифицировано `grep setGlobalPrefix` — нет совпадений). Фронт ходит на `${VITE_API_URL}/broadcasts/*` напрямую.

2. **Фоновый воркер `apps/broadcast-worker`** (один процесс, headless):
   - Берёт `PrismaClient from '@kingside/db'` + два `ioredis`-клиента (`redis` — общий, `pubRedis` — publish-only).
   - Два таймера:
     - `syncBroadcasts` (каждые 5 минут) — тянет `/api/broadcast?nb=20` у Lichess, делает `fetchBroadcastById` для закреплённых ID из `LICHESS_BROADCAST_IDS`, `upsert` в `broadcasts`/`broadcast_rounds`, стартует SSE-стримы `LICHESS_API/stream/broadcast/round/:id.pgn` для всех активных раундов (до `MAX_CONCURRENT_STREAMS=50`), при finished — `fetchFinishedRoundGamesIfEmpty`.
     - `syncPinnedBroadcasts` (каждую минуту) — опрос PGN по ongoing-раундам (не через стрим), приоритет pinned-трансляций, ротация остальных, до `MAX_PGN_POLLS_PER_CYCLE=5` запросов/цикл.
   - `processPgnUpdate` парсит PGN через `chess.js`, пишет в `broadcast_games` (создать/обновить по `lichessGameId`), публикует `broadcast:move` (при новом ходе) и `broadcast:sync` (при sanity-refresh) в Redis.
   - Redis locks: `broadcast:sync:lock` (TTL 4 мин), `broadcast:pinned:lock` (TTL 50с), `broadcast:pgn-hash:<roundId>` (md5-кеш входящего PGN, TTL 5 мин), `broadcast:pgn-fetch-cooldown:<roundId>`, `broadcast:fen:<roundId>:<idx>`.
   - Env: `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `LICHESS_BROADCAST_IDS` (список через запятую).
   - Размещён на том же ECS-кластере, что и archive-importer.

3. **Таблицы** в общей Prisma-схеме `packages/db/prisma/schema.prisma:413-471` — **три** модели, замкнутый FK-граф:

| Модель | Таблица | FK-связи |
| ------ | ------- | -------- |
| `Broadcast` | `broadcasts` | — (корень) |
| `BroadcastRound` | `broadcast_rounds` | `broadcastId → broadcasts.id` |
| `BroadcastGame` | `broadcast_games` | `roundId → broadcast_rounds.id` |

   **Из других моделей (`User`, `Game`, `Puzzle`, `Tournament`, `Archive*`) ссылок на эти три таблицы нет** — проверено `Grep "broadcast" packages/db/prisma/schema.prisma`, найдено только три `@@map("broadcast_*")` блока. Auth/пользователь на broadcasts не завязан (эндпоинты публичные, WS-подписка без JWT).

4. **Фронтенд-потребители** (`Grep "/broadcasts"` по `apps/web/src`):
   - REST через `api.get('/broadcasts...')` (т.е. `${VITE_API_URL}/broadcasts/*`):
     - `apps/web/src/pages/BroadcastsPage.tsx:88` — `GET /broadcasts?limit=100`.
     - `apps/web/src/pages/BroadcastTournamentPage.tsx:92,96,110,131,398` — `/broadcasts/:id`, `/broadcasts/:id/rounds`, `/broadcasts/:id/rounds/:roundId/games`, `/broadcasts/:id/standings`.
     - `apps/web/src/pages/BroadcastRoundPage.tsx:264,272,273,363` — `/broadcasts/:id`, `/broadcasts/:id/rounds`, `/broadcasts/:id/rounds/:roundId/games`.
     - `apps/web/src/pages/BroadcastGamePage.tsx` — только React Router ссылки, fetch нет.
   - WS:
     - `apps/web/src/socket.ts:110` экспортирует `broadcastSocket = io(`${API_URL}/broadcast`)`.
     - **Но `broadcastSocket` и события `broadcast:move/sync/subscribe` нигде в `apps/web/src` не импортируются и не используются** — проверено `Grep "broadcastSocket"` (только определение) и `Grep "broadcast:subscribe|broadcast:move|broadcast:sync"` (нуль совпадений).
     - Вывод: WS-канал поддерживается на сервере и на воркере, но **фронтенд сейчас не подписывается**. Все BroadcastRoundPage/BroadcastTournamentPage обновления — через polling REST (`useEffect` с `setInterval`). Это меняет риск-профиль миграции WS (см. §2.4).

5. **`apps/api/src/broadcast/chess-results/`** — отдельный сабдомен:
   - `ChessResultsService` + `LivechesscloudService` парсят `chess-results.com` и `view.livechesscloud.com`, пишут в модель `LiveTournament` (`live_tournaments`). Это **не Lichess broadcasts**, а отдельный тип «лайв-турниры с chess-results».
   - Фронт читает их на `LiveTournamentsPage.tsx`, код сервисов импортируется в `tournament.service.ts` (`apps/api/src/tournament/tournament.service.ts`).
   - `LiveTournament` в `packages/db/prisma/schema.prisma:489` — отдельная таблица, FK с другими моделями нет.
   - **Решение:** не переезжают в broadcast-service (см. §2.1.1). Это отдельный product-домен с совсем другим жизненным циклом; смешивать их с Lichess-broadcasts в первой extraction — расширение scope'а без выгоды. Если в будущем понадобится слить — отдельный ADR.

6. **Текущий публичный host фронт↔бек** (ADR-017):
   - `kingside.site` — SPA.
   - `api.kingside.site` — REST + WS `/broadcast`, `/messages` у `apps/api`.
   - `game.kingside.site` — WS `/game`, `/matchmaking`, `/tournament` у `apps/game-service`.
   - `archive.kingside.site` — REST у `apps/archive-service` (ADR-018, катится).

### Что просит KS-1695

1. Перенести HTTP-API трансляций на отдельный хост `broadcasts.kingside.site`.
2. Выделить БД `broadcasts_kingside` на том же RDS-кластере (отдельная PostgreSQL database).
3. Новый `apps/broadcast-service` по образцу `apps/archive-service`.
4. `apps/broadcast-worker` должен писать в новую БД.
5. Без downtime для основного API. Для самого трансляционного потока — минимальный, желательно нулевой простой (публичный UX: «трансляция не грузится» — заметен).
6. Фронт адаптировать под новый URL.

### Что НЕ в скоупе ADR-021

- Перенос `live_tournaments` + `ChessResultsService`/`LivechesscloudService` (см. §1.5).
- Перенос namespace `/messages` из `apps/api` (отдельная тема, не связана).
- Введение JWT-валидации на broadcast-service (эндпоинты публичные, см. §2.4).
- Выделение broadcast-worker в EventBridge schedule (по аналогии с ADR-020 для archive-importer). Обсуждается в §2.9.3 как follow-up.
- Расширение WS-протокола трансляций (SSE вместо Socket.IO, HTTP/2 push и т.п.).

## 2. Решение

### 2.1 Структура нового воркспейса

**Имя:** `apps/broadcast-service`.

**Runtime:** NestJS, версия как в `apps/api` и `apps/archive-service` (`@nestjs/common@^11`). Причины те же, что в ADR-018 §2.1 — DI, class-validator, WebSocket-адаптер уже инкапсулированы, переписывать на bare-Node нецелесообразно.

**Способ переноса кода:** `git mv` целиком, без копирования в `packages/`:

```
apps/api/src/broadcast/broadcast.controller.ts  → apps/broadcast-service/src/broadcast/broadcast.controller.ts
apps/api/src/broadcast/broadcast.gateway.ts     → apps/broadcast-service/src/broadcast/broadcast.gateway.ts
apps/api/src/broadcast/broadcast.module.ts      → apps/broadcast-service/src/broadcast/broadcast.module.ts  (БЕЗ ChessResultsService, LivechesscloudService)
apps/api/src/broadcast/dto/broadcast.dto.ts     → apps/broadcast-service/src/broadcast/dto/broadcast.dto.ts

apps/api/src/prisma/prisma.service.ts           → apps/broadcast-service/src/prisma/prisma.service.ts      (копия, клиент из @kingside/broadcasts-db)
apps/api/src/redis/redis.service.ts             → apps/broadcast-service/src/redis/redis.service.ts        (копия)
apps/api/src/metrics/*                          → apps/broadcast-service/src/metrics/*                     (копия, если нужны broadcast-метрики; см. §2.9.6)
apps/api/src/common/all-exceptions.filter.ts    → apps/broadcast-service/src/common/all-exceptions.filter.ts (копия)
apps/api/src/common/redis-io.adapter.ts         → apps/broadcast-service/src/common/redis-io.adapter.ts    (копия, нужна для multi-instance WS)
```

**ChessResultsService/LivechesscloudService остаются в `apps/api`** — их уже потребляет `TournamentService` на стороне основного API. Вместе с `BroadcastModule` они **не переезжают**, а переносятся в другой (новый) модуль основного API — например, `apps/api/src/live-tournament/live-tournament.module.ts`. Это отдельная под-задача backend в рамках KS-1697, так как после удаления `BroadcastModule` они остаются «висящими». Альтернатива: оставить `BroadcastModule` в `apps/api` только с этими двумя сервисами — хуже, так как имя модуля теряет смысл.

**package.json `apps/broadcast-service`** (инвариант):
- Имя: `@kingside/broadcast-service`.
- Зависимости: `@nestjs/*` (включая `@nestjs/websockets`, `@nestjs/platform-socket.io`), `socket.io`, `@kingside/shared`, `@kingside/broadcasts-db` (новый пакет, §2.2), `ioredis`, `prom-client`, `chess.js` (для standings — не обязательно, там только 1-0/0-1/=; но `chess.js` уже в worker'е, берём явно), `class-validator`, `class-transformer`.
- Скрипты: `dev` (`nest start --watch`), `build` (`nest build`), `start` (`node dist/main.js`), `test` (`jest`), `lint`.
- Dockerfile — копия `apps/archive-service/Dockerfile` (multi-stage Node 22), путь Prisma-клиента подменить на `@kingside/broadcasts-db`.

**main.ts `apps/broadcast-service`:**
- **Без** `setGlobalPrefix`. Контроллер остаётся `@Controller('broadcasts')` → пути `/broadcasts`, `/broadcasts/:id`, `/broadcasts/:id/rounds` и т.д. Прод-URL: `https://broadcasts.kingside.site/broadcasts/...`.
  - Постановка KS-1695 просит URL-ы вида `https://broadcasts.kingside.site/:id/rounds` (без префикса `/broadcasts/`). **Рекомендация: оставить `@Controller('broadcasts')`**, по тем же мотивам, что в ADR-018 §2.1: хост семантичен, но путь `/broadcasts/:id` явно указывает тип ресурса и оставляет свободные `/health`, `/metrics`, `/ready`. Финальное решение — в backend-тикет, оба варианта работоспособны.
- CORS: `CORS_ORIGIN=https://kingside.site,https://www.kingside.site`. `credentials: false` для REST, методы `GET,HEAD`.
- CORS для Socket.IO: в `@WebSocketGateway` заменить `cors: { origin: '*' }` на чтение `CORS_ORIGIN` из env (по паттерну `apps/game-service` после ADR-017 §2.1). `credentials: true` — безопасно только со списком origin'ов.
- Health endpoint: `/health` — `SELECT 1` к БД через `@nestjs/terminus` (или ручной `prisma.$queryRaw`), timeout 500мс, 200 при ok. ALB target group использует его.
- `/metrics` — Prometheus scrape. См. §2.9.6.
- Redis pub/sub (`broadcast:move`, `broadcast:sync`) — подписка в `BroadcastGateway.onModuleInit`, как сейчас. В новом сервисе Redis **тот же**, что у broadcast-worker (см. §2.3).
- Socket.IO адаптер — `RedisIoAdapter` при `ECS_TASK_COUNT > 1` (копия из `apps/api/src/main.ts`). На старте сервис — один инстанс; но если когда-то масштабируется до N>1, без Redis-адаптера `broadcast:<roundId>` rooms не синхронизируются между инстансами.
- WS-транспорт: только `websocket` (как сейчас в gateway). Без long-polling fallback.

**Что удаляется из `apps/api`** (после M1 + soak):
- `apps/api/src/broadcast/broadcast.controller.ts`, `broadcast.gateway.ts`, `broadcast.module.ts`, `dto/broadcast.dto.ts` — целиком.
- Импорт `BroadcastModule` в `apps/api/src/app.module.ts` (строки 19, 62).
- Импорт `ChessResultsService`, `LivechesscloudService` **переносится в новый модуль `LiveTournamentModule`** или их потребитель `tournament.service.ts` (решение — за backend в рамках задачи KS-1697).
- Типизации `PrismaClient.broadcast/.broadcastRound/.broadcastGame` пропадут автоматически после удаления моделей из `@kingside/db` (§2.2).

### 2.1.1 Что остаётся в `apps/api`

- `live_tournaments` модель.
- `ChessResultsService`, `LivechesscloudService`.
- Их потребитель `tournament.service.ts`.
- `LiveTournamentsPage.tsx` на фронте обслуживается основным API (сейчас без отдельного endpoint'а, через `tournaments`).

### 2.2 Схема БД `broadcasts_kingside`

**Вариант-победитель:** отдельный пакет `packages/broadcasts-db` с собственным `schema.prisma`, отдельным клиентом и отдельной PostgreSQL database на существующем RDS-кластере — **полная симметрия с `packages/archive-db`** (см. ADR-018 §2.2, `packages/archive-db/prisma/schema.prisma`).

Структура:

```
packages/broadcasts-db/
  package.json                 # name: "@kingside/broadcasts-db"
  prisma/schema.prisma         # ТОЛЬКО 3 broadcast-модели + generator + datasource (env("BROADCASTS_DATABASE_URL"))
  prisma/migrations/           # новая migrations-история, начинается с baseline
  src/index.ts                 # export { PrismaClient } from './generated/prisma'
  src/generated/prisma/        # prisma generate output
  tsconfig.json
```

**Модели, переезжающие в `packages/broadcasts-db/prisma/schema.prisma`:**

| Модель | Таблица | Источник |
| ------ | ------- | -------- |
| `Broadcast` | `broadcasts` | `packages/db/prisma/schema.prisma:413` |
| `BroadcastRound` | `broadcast_rounds` | `:439` |
| `BroadcastGame` | `broadcast_games` | `:454` |

FK-граф замкнут внутри группы. Индексы и `@@map` — копируются ровно.

**Отдельная база vs отдельный RDS-инстанс — выбор devops.**

- **A. Отдельный RDS-инстанс `kingside-broadcasts-db`.** Плюс: полная изоляция IOPS. Минус: ещё один billing.
- **B. Отдельная Postgres database на текущем RDS-кластере (`CREATE DATABASE broadcasts_kingside`).** Плюс: один инстанс. Минус: общий storage-IOPS.

**Рекомендация ADR:** B — отдельная database в существующем кластере. Аргументы те же, что в ADR-018 §2.2: на текущем масштабе physical isolation даёт marginal profit. Объём broadcasts-данных существенно меньше архива (десятки-сотни MB, см. §2.5), нагрузка на write — ограниченная (5-мин sync + 1-мин poll + SSE-стримы до 50 параллельных раундов, каждый генерирует ~1 апдейт/ход/10-30с). Переход B→A делается pg_dump/restore при росте.

**Имя database:** `broadcasts_kingside` (с `s`, как и хост). Пользователь (role) — отдельный, `broadcasts_rw` (read-write) с `GRANT` только на эту database. Readonly-роль не заводим до появления use-case.

**Отклонено — оставить в `packages/db` (Prisma multi-schema):** требует единой физической БД, противоречит §2.2 (пункт 2 постановки).

**Отклонено — `CREATE SCHEMA broadcasts` в той же database:** не даёт физической изоляции connection pool.

### 2.3 Impact на `apps/broadcast-worker`

**Текущее состояние:** `PrismaClient from '@kingside/db'` + `ioredis` pub/sub + один общий Redis + publisher. `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `LICHESS_BROADCAST_IDS`.

**Что меняется:**

1. **Зависимость.** В `apps/broadcast-worker/package.json` замена `@kingside/db` → `@kingside/broadcasts-db`. Код worker'а использует только 3 broadcast-модели (`prisma.broadcast.*`, `prisma.broadcastRound.*`, `prisma.broadcastGame.*`) — ничего не ломается, все они есть в новом пакете. `raw SQL` в worker'е — только `$queryRaw<[{count: bigint}]>` на `broadcast_games` (`worker.ts:308-312`) — работает как есть.
2. **ENV.** `DATABASE_URL` заменяется на `BROADCASTS_DATABASE_URL` (явное имя). Рекомендация — ровно по паттерну archive (ARCHIVE_DATABASE_URL): worker перестаёт читать `DATABASE_URL` вовсе, чтобы не было риска «кто-то задеплоил worker со старым env из общей task definition».
3. **Redis.** Канал `broadcast:move`, `broadcast:sync` — **один и тот же Redis-инстанс**, что и `broadcast-service`. Это критично: без shared-Redis подписка в gateway не получит publish из worker'а. REDIS_HOST/PORT — те же, что и раньше.
4. **Double-write vs single-write.** Single-write:
   - Worker — единственный писатель в broadcast-таблицы (Grep по `prisma.broadcast(Round|Game)?.(create|update|upsert|delete)` — все совпадения в `apps/broadcast-worker/src/worker.ts` и нигде больше). `broadcast-service` — read-only.
   - Достаточно остановить worker на время переключения, затем поднять его на новом `BROADCASTS_DATABASE_URL`.
   - Double-write дал бы zero-downtime для импорта, но overhead (две транзакции, rollback policy) неоправдан — источник данных Lichess, worker переиграет пропущенный 5-мин цикл без потерь (см. §2.5 — «rebuild-from-source» стратегия).
5. **Redis locks.** `broadcast:sync:lock`, `broadcast:pinned:lock` — один Redis, остаются как есть, ничего не меняем.

### 2.4 Auth, CORS, Cross-subdomain

**Эндпоинты broadcasts публичны.** `@UseGuards(...)` в `broadcast.controller.ts` и `broadcast.gateway.ts` отсутствуют (Grep подтверждает). WS-подписка `broadcast:subscribe` принимает `roundId` без аутентификации. Переносим такими же на `broadcasts.kingside.site`.

**Следствие:**
- В `broadcast-service` **не переносится** `apps/api/src/auth/`, зависимости `@nestjs/jwt`, `passport-jwt`, `bcrypt` — не нужны. Образ компактнее.
- Если в будущем потребуется JWT (например, rate-limit per-user, premium-фичи для pinned-трансляций) — применимы варианты из ADR-018 §2.4: JWKS / shared-secret через ECS Secrets / header-introspection. Решение — отдельный ADR, когда появится бизнес-повод.

**CORS (REST):**
- `CORS_ORIGIN=https://kingside.site,https://www.kingside.site` в env broadcast-service.
- `credentials: false`. `methods: ['GET', 'HEAD']` — все 5 эндпоинтов `@Get`, write-путь только у worker'а (через БД, не через HTTP).
- OPTIONS preflight не требуется для простых GET без Authorization-заголовка. Nest включает CORS автоматически на `app.enableCors(...)`.

**CORS (WebSocket):**
- Socket.IO handshake использует `Origin: https://kingside.site`, шлёт на `wss://broadcasts.kingside.site/broadcast`. В `@WebSocketGateway({ cors: {...} })` — заменить `origin: '*'` на список (по шаблону ADR-017 §2.1 — `CORS_ORIGIN` из env).
- `credentials: true` — **без cookie всё равно ничего не даёт**, но корректно настраивать вместе со списком origin'ов, если потом решим включить cookie-auth.
- Transports: только `websocket` (уже так). Без long-polling → CORS preflight на HTTP-layer не нужен.

**JWT между доменами.**
- Сейчас фронт хранит `token` / `refreshToken` в `localStorage` (проверено `apps/web/src/api.ts:8,24`, `socket.ts` JWT в handshake не шлёт на `/broadcast` — gateway без guard). Это origin-local storage, `kingside.site` читает свой, субдомены не шарят localStorage.
- Для publicly-readable broadcasts этого достаточно: фронт на `kingside.site` читает `token`, но на `broadcasts.kingside.site` его не шлёт (и не нужно).
- Если потом понадобится authenticated broadcast-эндпоинт (например, «мои закреплённые трансляции») — JWT шлётся в `Authorization: Bearer` в CORS-запросе, `broadcasts.kingside.site` валидирует `JWT_SECRET` shared через ECS Secrets (тот же пакет, что у `apps/api`). Пока — вне scope.
- **Cookie-based auth (refresh в cookie) — НЕ применимо**, пока `apps/api` не переедет на cookie. Это ортогональная тема.

**`Content-Security-Policy: connect-src`.**
- Если на фронте (в `apps/web/public/index.html` или заголовках CloudFront/ALB) выставлен CSP `connect-src`, новый хост `https://broadcasts.kingside.site` и `wss://broadcasts.kingside.site` должны быть туда добавлены. *Проверить практически до cutover* — я конфиг CSP не видел (см. §2.9.1).

### 2.5 План миграции данных

В отличие от архива, где источник истины — наша БД, **для трансляций источник истины — Lichess API**. `broadcasts`/`broadcast_rounds`/`broadcast_games` — это рабочий кеш/индекс поверх Lichess. Полный rebuild происходит за один цикл `syncBroadcasts` (5 минут), с pinned-трансляциями — за следующий `syncPinnedBroadcasts` (1 минута). Это радикально упрощает миграцию.

**Три варианта, как в KS-1695:**

- **(a) Shadow-write.** Worker пишет в обе БД одновременно, потом переключение. Плюсы: zero-downtime read. Минусы: транзакция через 2 БД → частичный fail, двойная нагрузка на Lichess (или общий кеш на фронте воркера?), сложность отката.
- **(b) Full dump+restore.** `pg_dump` трёх таблиц → `pg_restore` в новую. Плюсы: идентичность данных. Минусы: окно даунтайма архивного пути (5–20 минут в зависимости от объёма), оверкилл для данных, которые регенерируются из Lichess за 5 минут.
- **(c) Rebuild-from-source.** Новый `broadcasts_kingside` создаётся пустой, broadcast-service и broadcast-worker стартуют на нём. Lichess-worker за 1 цикл (5 минут) наполняет `broadcasts`+`broadcast_rounds`, PGN-poller за ещё 1–2 цикла заполняет `broadcast_games`.

**Оценка объёмов.** *Числа — грубый порядок, практическую проверку провести перед cutover:*
- `broadcasts` — десятки строк (top-20 активных Lichess-трансляций + pinned). Размер — KB.
- `broadcast_rounds` — сотни строк (по 5–20 раундов на турнир). Размер — KB.
- `broadcast_games` — тысячи строк (по 4–40 партий на раунд, десятки активных раундов). Размер — единицы MB (PGN хранится в `@db.Text`). На пике с сильно закреплёнными турнирами (Candidates, World Championship) — порядка 10 MB.
- Итого данных — **единицы десятков MB**, существенно меньше `archive_games` (сотни MB до GB).

**Рекомендация: вариант (c) rebuild-from-source.**

Обоснование:
1. Источник истины — Lichess, наш data — ephemeral-кеш. `pg_dump` воспроизводит то, что worker заполнит за 5 минут сам.
2. Окно «5 минут неполных данных» равносильно окну `SYNC_INTERVAL_MS` в обычном рабочем режиме. UX-хит: в BroadcastsPage увидят сокращённый список (только pinned, которые подтягиваются в первом цикле), в BroadcastRoundPage — пустые games до первого PGN-poll. Это приемлемо как окно, если фронт показывает «загружается».
3. Сложность реализации — минимальна (одна dev-час: поменять env, рестарт task-definition). Dump/restore занимает столько же времени на подготовку скрипта, плюс разовая проверка consistency.
4. **Zero-downtime read возможен даже в этом варианте**, если cutover фронта делать после того, как первый sync-цикл на новой БД прошёл. Последовательность описана в §2.8.

**Когда стоит предпочесть (b) dump+restore** — только если worker на момент cutover в downtime по внешней причине (Lichess rate limit, мы в 429-бэкоффе), и нет уверенности, что он наполнит данные за разумное время. Тогда dump из `apps/api`-старых таблиц даёт гарантированный снапшот. Держим (b) как **план B для M1** — скрипт готов, но по умолчанию не запускаем.

**Оценка downtime для пользователей:**
- REST `/broadcasts*` — read from `broadcast-service`. Если на момент cutover (DNS + listener rule) новая БД ещё пуста, `GET /broadcasts` вернёт `{data: [], total: 0}`. UI-состояние: «нет активных трансляций». Это **окно до 5 минут**, пока worker не отработает первый `syncBroadcasts`. Стратегия митигации — §2.8.P0: запустить worker **до** cutover фронта на `broadcasts.kingside.site`, чтобы к моменту переключения DNS в новой БД уже были данные.
- WS `/broadcast` — сейчас фронт не подписан (§1.4). **WS-миграция безопаснее REST-миграции**, т.к. нет живых клиентов, которые надо мигрировать синхронно.

### 2.6 DNS, TLS, ALB, ECS

Инфраструктура — зона devops. В ADR — требования-контракты.

1. **DNS.** Новый A-record `broadcasts.kingside.site` → тот же ALB. TTL 60с на миграцию, 300+ после.
2. **TLS.** Wildcard `*.kingside.site` (ADR-017 §3.2) покрывает `broadcasts.kingside.site`. Если всё ещё SAN — devops добавляет в лист или мигрирует на wildcard.
3. **ALB listener rule.** HTTPS:443, `Host == broadcasts.kingside.site` → target group `kingside-broadcasts-api`. **Listener-правило должно пропускать `Upgrade: websocket`** (стандартное поведение ALB, нужно просто не запрещать). Sticky sessions target group — **ВКЛЮЧИТЬ**, потому что в отличие от archive, у broadcast есть WS (`broadcast:<roundId>` rooms). При `ECS_TASK_COUNT=1` sticky не нужны, но включать сразу для forward-compat.
4. **Target group `kingside-broadcasts-api`.** Health check: `GET /health`, 200, threshold 2/3. Deregistration delay — 60с (достаточно для закрытия активных WS).
5. **ECS.**
   - Cluster: **тот же**, где archive-service и archive-importer.
   - Новая Task Definition `broadcast-service` (Fargate/EC2 — как остальные).
   - Service desired count: 1 (min=1, max=2). WS-трафик от top-20 broadcasts с несколькими сотнями зрителей на пике — один task-инстанс держит легко. При масштабировании до N>1 — RedisIoAdapter обязателен (см. §2.1).
   - Environment: `BROADCASTS_DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `CORS_ORIGIN`, `WS_USE_REDIS_ADAPTER=auto`, `ECS_TASK_COUNT` (из infra), `NODE_ENV=production`.
   - Resources: 512 CPU / 1024 MiB на старте. Контроль метриками, при необходимости — вверх.
6. **broadcast-worker Task Definition.**
   - Меняется только env: `DATABASE_URL` удаляется, добавляется `BROADCASTS_DATABASE_URL`. Остальное — как есть. Service scale — 1 (одиночный таймерный worker, multi-instance с текущими Redis locks работает, но без выгоды).
7. **Network.** broadcast-service + broadcast-worker в той же security group, outbound на RDS (5432) и Redis (6379). broadcast-worker дополнительно outbound на Lichess (`lichess.org:443`).
8. **CloudWatch Logs.** Группы `/ecs/broadcast-service` и `/ecs/broadcast-worker` (последняя уже есть).

### 2.7 Воздействие на `apps/web`

**ENV (в `apps/web/src/vite-env.d.ts` добавить):**
- `VITE_BROADCAST_URL` — новая переменная. Прод: `https://broadcasts.kingside.site`. Dev: `http://localhost:3004` (или порт, который назначит backend для broadcast-service в docker-compose). Без fallback на prod-домен — при отсутствии переменной билд/рантайм должны падать громко, по паттерну `apps/web/src/config/archiveUrl.ts` (см. код, 22 строки).

**Новый файл — источник истины для URL:**
```
apps/web/src/config/broadcastUrl.ts  (по образцу archiveUrl.ts)
```

**Точки кода для правки (frontend):**

REST (заменить `api.get('/broadcasts*')` на `fetch(\`${BROADCAST_URL}/broadcasts*\`)` с ручным `Authorization` если потребуется — сейчас не требуется, эндпоинты публичные):
- `apps/web/src/pages/BroadcastsPage.tsx:88` — `api.get<BroadcastListResponse>('/broadcasts?limit=100')`.
- `apps/web/src/pages/BroadcastTournamentPage.tsx:92,96,110,131,398` — четыре точки.
- `apps/web/src/pages/BroadcastRoundPage.tsx:264,272,273,363` — четыре точки.

**Вариант A (рекомендация):** создать `apps/web/src/api/broadcastApi.ts` — обёртка вроде `api.ts`, но с `BROADCAST_URL` базой. Публичные эндпоинты, `Authorization` не шлём. Меньше шанс «случайно отправить JWT на чужой домен».

**Вариант B:** расширить `api.ts` на два instance'а (`api`, `broadcastApi`) через фабрику. Хуже — более хрупкий shared state refresh-token (а refresh-token вообще не нужен на broadcasts.kingside.site).

WS:
- `apps/web/src/socket.ts:110` — `broadcastSocket = io(\`${API_URL}/broadcast\`)` → `io(\`${BROADCAST_URL}/broadcast\`)`.
- **Пока `broadcastSocket` не используется** (Grep), поправка чисто защитная на случай, если фронт когда-нибудь подпишется на live-обновления.

**Тесты `apps/web`:**
- Прогрепать `apps/web/src/**/*broadcast*.spec.tsx` и `**/*.test.tsx` на моки `/broadcasts`. Если моки через MSW/fetch-mock на полный URL — обновить на `BROADCAST_URL`. Если на path-only — не трогать (но проверить).

**SSR / robots / sitemap:** не затронуто.

### 2.8 Последовательность задач

Обозначения: **B** backend, **D** devops, **F** frontend. Зависимости — после названия.

#### Фаза 0 — подготовка, параллельно, без точек невозврата

- **B1.** Создать `packages/broadcasts-db`: 3 модели + общий header + baseline migration. Prisma generate, unit-smoke. Независимо.
- **B2.** Создать `apps/broadcast-service`: перенос кода `apps/api/src/broadcast/*` (кроме `chess-results/`) + копии инфра-сервисов (Prisma, Redis, Metrics, Exception filter, RedisIoAdapter). Dockerfile. package.json. Зависит от B1. Локально поднимается и отдаёт `/health`, `/broadcasts` (пусто, пока БД пуста).
- **B2'.** В `apps/api` — перенести `ChessResultsService`, `LivechesscloudService` из `broadcast/chess-results/` в новый модуль `live-tournament/` (или оставить под тем же `broadcast`-модулем, но без controller/gateway — backend на своё усмотрение). Зависит от: ничего, можно параллельно B2. **Но не мержить до B3**, иначе останется dangling module.
- **D1.** Новая database в RDS: `CREATE DATABASE broadcasts_kingside`, role `broadcasts_rw`, права. Применить миграции `@kingside/broadcasts-db` (пустые таблицы). Зависит от B1.
- **D2.** ACM (если не wildcard), Route53 A-record `broadcasts.kingside.site` → ALB. Listener rule `Host == broadcasts.kingside.site` → **временная** TG (503) или заранее-`kingside-broadcasts-api` с нулём task'ов.

#### Фаза 1 — deploy broadcast-service (обратимо)

- **D3.** ECS Task Definition + Service для `broadcast-service`. `BROADCASTS_DATABASE_URL` → новая (пустая) БД. Зависит от B2+D1+D2. `broadcasts.kingside.site/broadcasts` → `{data: [], total: 0}`, health=200.
- **QA-smoke.** Прогнать на dev/stage: все 5 REST-эндпоинтов отвечают, CORS с `kingside.site` работает, WS handshake на `/broadcast` проходит (без событий, пока нет данных).

#### Фаза 2 — переключение worker'а (основная точка неопределённости)

**Ключевое решение — стратегия M1.**

**M1 (rebuild-from-source, рекомендация):**
1. Создать новый Task Definition `broadcast-worker` с `BROADCASTS_DATABASE_URL` (вместо `DATABASE_URL`).
2. Scale **старый** worker-service к 0 (stop writes в старую БД).
3. Scale **новый** worker-service к 1. Первый `syncBroadcasts` запустится сразу (см. `worker.ts:93`: `await this.syncBroadcasts()` в `start()`). Через ~30–60с в новой БД есть данные для top-20 трансляций + pinned.
4. Sanity: `SELECT COUNT(*) FROM broadcasts` > 0, `SELECT COUNT(*) FROM broadcast_games WHERE round_id IN (SELECT id FROM broadcast_rounds WHERE status='ongoing') > 0` (после первого PGN-poll, ~2 минуты).
5. Теперь `broadcasts.kingside.site/broadcasts` возвращает живые данные.

**Важно:** между шагом 2 и шагом 4 — окно в 2–5 минут, когда старый API на `api.kingside.site/broadcasts` **всё ещё работает** (данные там живые, worker перестал их обновлять). То есть актуальность на старом API начинает отставать, но не отваливается. На новом — пусто/догоняет. Cutover фронта делается **после** шага 4.

**M1-alternative (dump+restore) — fallback если rebuild-from-source не устраивает:**
1. Scale старый worker к 0.
2. `pg_dump --data-only --table=broadcasts --table=broadcast_rounds --table=broadcast_games` из старой БД → S3.
3. `pg_restore --data-only` в новую БД.
4. Поднять worker на `BROADCASTS_DATABASE_URL`.

Разница в M1-времени: rebuild ≈ 2–5 мин, dump+restore ≈ 1–3 мин + время подготовки скрипта. Rebuild ещё и «самотестирует» worker на новой БД.

- **Точка частичной невозвратности:** после M1 старая БД — устаревающий снапшот. Rollback возможен (вернуть старый worker к 1, он догонит за 5 мин), но потребует повторного cutover.

#### Фаза 3 — rollout фронта (обратимо)

- **F1.** В `apps/web`:
   - Создать `apps/web/src/config/broadcastUrl.ts` (копия `archiveUrl.ts`).
   - Создать `apps/web/src/api/broadcastApi.ts` (обёртка fetch c `BROADCAST_URL`).
   - Заменить `api.get('/broadcasts...')` на `broadcastApi.get('/broadcasts...')` в 3-х pages (11 точек суммарно).
   - В `socket.ts` заменить `${API_URL}/broadcast` → `${BROADCAST_URL}/broadcast`.
   - В `scripts/deploy-aws.sh` — добавить `VITE_BROADCAST_URL=https://broadcasts.kingside.site` в билд.
   - Обновить моки тестов.
   Зависит от D3+M1. Deploy → soak 3–7 дней. Метрики на `/broadcasts*` endpoint'ах `apps/api` должны упасть до нуля.
- **B3.** После soak'а — удалить `apps/api/src/broadcast/broadcast.{controller,gateway,module}.ts`, `dto/broadcast.dto.ts`. В `apps/api/src/app.module.ts` убрать импорт `BroadcastModule` (предварительно убедившись, что `ChessResultsService`/`LivechesscloudService` переехали в новый модуль — B2'). Удалить 3 broadcast-модели из `packages/db/prisma/schema.prisma`, накатить миграцию `drop_broadcast_tables`. Зависит от: метрик на `/broadcasts*` в `apps/api` ≈ 0.
- **D4.** Зачистка: old `CORS_ORIGIN` не содержит legacy-хостов, health check на `apps/api` не ссылается на broadcasts.

#### Фаза 4 — финальная зачистка (точка невозврата)

- **M2.** `DROP TABLE broadcast_games CASCADE; DROP TABLE broadcast_rounds CASCADE; DROP TABLE broadcasts CASCADE;` в старой БД. **Точка окончательной невозвратности.** Делать не раньше 14 дней после B3. S3-дампы (если был fallback M1-alternative) хранить ещё +30 дней.

#### Карта параллелизма

- B1 + D1 + D2 + B2' — параллельно.
- B2 — после B1.
- D3 — после B2 + D1 + D2.
- M1 — после D3 + QA-smoke.
- F1 — после M1.
- B3 — после F1 + soak 3–7 дней.
- M2 — после B3 + soak 14 дней.

### 2.9 Риски и подводные камни

Чек-лист — не эмоциональный, на что смотреть перед каждым шагом. Сомнения помечены *[проверить практически]*.

1. **CSP `connect-src`.** Если на `apps/web/public` или ALB/CloudFront выставлен CSP, `https://broadcasts.kingside.site` и `wss://broadcasts.kingside.site` должны быть добавлены. *[я конфиг CSP не видел; проверить до cutover]*.

2. **WebSocket namespace mismatch.** Gateway сейчас `namespace: '/broadcast'` (единственное число). Socket.IO-клиент на фронте (после миграции) должен шлёт на `${BROADCAST_URL}/broadcast` (тот же path). Не `/broadcasts`! В имени namespace сохраняем текущее поведение — рефакторинг пути — отдельная задача, ломает код. Внимание backend'у при review.

3. **broadcast-worker как EventBridge schedule (по аналогии с ADR-020).** Worker — это `setInterval`-процесс (`SYNC_INTERVAL_MS=5min`, `PINNED_POLL_INTERVAL_MS=60s`). В отличие от archive-importer (cron раз в неделю) — broadcast-worker должен работать **непрерывно**, иначе SSE-стримы Lichess рвутся и переподключения генерируют 429. EventBridge schedule здесь **не подходит**. Оставляем ECS service с scale=1. **Заблокировать для будущих follow-up'ов** — нельзя автоматически применить подход ADR-020.

4. **SSE-стримы Lichess на cutover.** При остановке старого worker'а `MAX_CONCURRENT_STREAMS=50` stream'ов разрываются. При старте нового — восстанавливаются через ~30с (первый `syncBroadcasts` в `start()`). В этом окне (30–60с) живые ongoing-раунды **не получают новых ходов**. UX: трансляция «не обновляется», прошлые ходы видны. Митигация: окно минимальное (секунды), всё ещё в рамках обычного поведения Lichess (429-бэкофф бывает таким же).

5. **Rate limit Lichess при rebuild-from-source.** Первый `syncBroadcasts` на новой БД шлёт 1 запрос `/api/broadcast?nb=20` + до N запросов `/api/broadcast/:id` для pinned. На рестарте — то же самое, что worker уже делает раз в 5 мин. Новой нагрузки нет. *[исключить случай «worker был в 429-бэкоффе, рестарт не сбрасывает backoff»: `rateLimitBackoffUntil` — memory-field, сбрасывается при рестарте процесса, значит бэкофф теряется. Это плюс для migrate — minus для prod-stability. Не делаем рестарт в окне после 429.]*

6. **Prometheus / метрики.** В `apps/api/src/broadcast/` сейчас нет собственных метрик (Grep по `metricsService.*` в этом каталоге — нуль). После переезда broadcast-service может добавить свои метрики (подключения WS, broadcast_list_requests_total) — но это follow-up, не блокирующий. `/metrics` endpoint включать с пустым набором, чтобы Prometheus scrape не падал.

7. **Health check vs ещё-пустая БД.** `/health` на broadcast-service проверяет `SELECT 1` — проходит всегда. Но если `GET /broadcasts` возвращает `[]`, фронт видит «нет трансляций». Для cutover в §2.8.M1 это приемлемо (до 5 минут окна). *Не делать cutover фронта до подтверждения, что в новой БД есть data (sanity-counts).* Этот шаг явно в §2.8.M1.4.

8. **Redis pub/sub двойная доставка.** Сейчас gateway в `apps/api` и worker в `apps/broadcast-worker` используют **один Redis**. После переезда — broadcast-service, worker и `apps/api` (`/messages` namespace там остаётся) — тоже все на один Redis. Нет проблемы. **Но** если на cutover-окне старый gateway в `apps/api` ещё жив, а новый worker уже публикует — старый gateway получит сообщение и попытается отправить в `broadcast:<roundId>` room (которых у него нет после рестарта) — no-op. Нет двойной доставки клиентам.

9. **Zombie-WS-клиенты после cutover F1.** Старый клиент (hard-refresh не сделал) держит WS с `api.kingside.site/broadcast`. Пока не снесён `BroadcastGateway` в `apps/api` (шаг B3) — клиент продолжает получать события из Redis (общий инстанс). Это хорошо: не отвалится на период soak'а. После B3 — WS клиент получит disconnect, переподключится и (если он с новым фронт-билдом) пойдёт на `broadcasts.kingside.site`. В старом billд'е — уйдёт в connect_error. Это допустимая деградация для соак-периода в 3–7 дней.

10. **broadcast-worker Redis keyspace collision.** `broadcast:sync:lock`, `broadcast:pinned:lock`, `broadcast:pgn-hash:*`, `broadcast:pgn-fetch-cooldown:*`, `broadcast:fen:*` — все на одном Redis, имя ключа не включает URL БД. Если в cutover-окне одновременно работают два worker'а (старый и новый) — они **поделят lock'и**. Один получит SYNC_LOCK, второй пропустит цикл. Это защита от race, работает. Но по факту оба пишут в **разные БД** (по env). Поэтому старый worker должен быть scale=0 ДО старта нового. Инвариант §2.8.M1.2 + M1.3.

11. **Snake-case inconsistency в API contracts.** Response-типы BroadcastSummary / BroadcastRoundItem / BroadcastGameItem — camelCase (см. `broadcast.controller.ts:10-49`). Ничего не меняется, типы переезжают с контроллером. Shared-types в `@kingside/shared` на broadcast не заведены (Grep по `BroadcastSummary` в `packages/shared`). Это допустимый технический долг — каждый подписанный контракт дублирует типы.

12. **Сравнение с archive (что отличается, на что смотреть):**
    - Archive — read/write только writer-worker, broadcasts — то же самое.
    - Archive — WS нет, broadcasts — WS критический (хотя сейчас неиспользуемый).
    - Archive — источник truth в нашей БД (dump обязателен), broadcasts — в Lichess (rebuild возможен).
    - Archive — объёмы сотни MB, broadcasts — единицы MB.
    - Archive — `SELECT COUNT` работает быстро, broadcasts — тоже.
    - Archive — stream писателя один (archive-importer), broadcasts — один (broadcast-worker).

13. **Stage vs Prod.** В постановке не оговорено. Если stage есть — прогнать миграцию там целиком (B1+B2+D1+D2+D3+M1+QA-smoke+F1). Если нет — dev docker-compose + ручной smoke на prod в maintenance-окне. *[уточнить у devops]*.

14. **Migration collisions в `packages/db`.** Пока B3 не выполнен, миграции `packages/db` не должны трогать `broadcasts`/`broadcast_rounds`/`broadcast_games` (иначе два владельца одних таблиц). Зафиксировать в PR-чеклисте backend на соответствующий период.

15. **Тесты `apps/api/src/broadcast/`.** `chess-results.service.spec.ts`, `livechesscloud.service.spec.ts` — **остаются в `apps/api`** вместе со своими сервисами (B2'). `broadcast.controller.spec.ts`, `broadcast.gateway.spec.ts` (если есть) — *[проверить Glob]* — переезжают в `apps/broadcast-service`. Конфиг jest — копия из `apps/api`.

16. **Тесты `apps/web` на broadcasts.** Прогрепать `apps/web/src/**/*Broadcast*.spec.tsx` + `*.test.tsx` — обновить mock URL / MSW-хендлеры на `BROADCAST_URL`.

17. **CI `turbo.json`.** После B1+B2 — добавить `packages/broadcasts-db` и `apps/broadcast-service` в `workspaces` (`package.json` root). Убедиться, что `turbo run build` поднимает `@kingside/broadcasts-db` перед `@kingside/broadcast-service` (pipeline `build` с `dependsOn: ["^build"]`).

18. **Socket.IO sticky sessions.** В отличие от archive, broadcasts держит `broadcast:<roundId>` rooms per-instance. При ECS_TASK_COUNT>1 и отсутствии sticky **клиент может попасть на инстанс без его room** — subscribe-сообщение уйдёт на gateway B, а `broadcast:move` publish из Redis доставит на оба инстанса, каждый emit в room — но room существует только на том инстансе, куда clientId подключён. **Без RedisIoAdapter это ломается.** **Обязательно включить RedisIoAdapter при масштабировании > 1 task.** (В `apps/api/src/main.ts` логика `WS_USE_REDIS_ADAPTER=auto + ECS_TASK_COUNT>1 → Redis adapter` уже есть — перенести в broadcast-service.)

19. **mixed-content / HTTPS-only.** HTML с `kingside.site` (HTTPS), XHR/WS на `broadcasts.kingside.site` (HTTPS) — браузер не блокирует. Обязательно проверить, что фронт НЕ собирается без `VITE_BROADCAST_URL` — `broadcastUrl.ts` throw'ит по паттерну `archiveUrl.ts`.

20. **Roles & owners (см. §3).** Smoke-chain: backend создаёт B1+B2+B2'+B3, devops делает D1-D4+M1+M2, frontend — F1. QA-smoke после каждого из D3, M1, F1, B3.

## 3. Последствия

- **Backend.** Новый воркспейс `apps/broadcast-service`, новый пакет `packages/broadcasts-db`. `BroadcastModule` удаляется из `apps/api`. `ChessResultsService`+`LivechesscloudService` остаются в `apps/api`, перенос в отдельный модуль. `broadcast-worker` меняет зависимость на `@kingside/broadcasts-db` + env на `BROADCASTS_DATABASE_URL`. Response-types broadcasts не меняются (локальные в `broadcast.controller.ts`, переезжают как есть).

- **DevOps.** Новая database `broadcasts_kingside` (вариант B из §2.2) на существующем RDS. Route53 A-record `broadcasts.kingside.site`, ALB listener rule, ACM (wildcard если не было), ECS Task Definition + Service для broadcast-service, переконфиг Task Definition broadcast-worker. CloudWatch Logs group `/ecs/broadcast-service`. Секреты `BROADCASTS_DATABASE_URL` в ECS Parameter Store / Secrets Manager. Prometheus scrape target.

- **Frontend.** Новая ENV `VITE_BROADCAST_URL`. Новый модуль `src/config/broadcastUrl.ts` и `src/api/broadcastApi.ts`. 11 точек замены REST-URL (3 pages). 1 точка WS. Обновление моков тестов. Добавление `VITE_BROADCAST_URL` в `scripts/deploy-aws.sh`.

- **QA.** Smoke-план после каждого из D3, M1, F1, B3:
  - `GET /broadcasts` возвращает список.
  - `GET /broadcasts/:id/rounds` — туры.
  - `GET /broadcasts/:id/rounds/:roundId/games` — партии, валидные PGN.
  - `GET /broadcasts/:id/standings` — crosstable не пустой для турнира с ≥4 партиями.
  - WS handshake на `wss://broadcasts.kingside.site/broadcast` успешен, `broadcast:subscribe` возвращает `broadcast:sync` в течение 1с.
  - BroadcastsPage, BroadcastTournamentPage, BroadcastRoundPage на `kingside.site` показывают данные без console-ошибок на `Mixed-Content` / `CORS` / `Refused to connect`.

- **Документация.** После M2 обновить `docs/architecture/system-overview.md` — добавить `broadcasts.kingside.site` в таблицу субдоменов (по паттерну ADR-017).

## 4. Предлагаемые тикеты

- **KS-N01 [backend]** — создать `packages/broadcasts-db` с 3 broadcast-моделями + baseline migration.
- **KS-N02 [backend]** — создать `apps/broadcast-service` (NestJS), перенести `apps/api/src/broadcast/broadcast.{controller,gateway,module}.ts` + `dto/` + инфра-сервисы (Prisma, Redis, Metrics, Exception filter, RedisIoAdapter, Health `/health`). Dockerfile, package.json.
- **KS-N02b [backend]** — перенести `ChessResultsService`, `LivechesscloudService` из `apps/api/src/broadcast/chess-results/` в новый модуль (`apps/api/src/live-tournament/` или аналогичный). Обновить импорт в `TournamentService`. Оставить тесты.
- **KS-N03 [devops]** — поднять БД `broadcasts_kingside` в RDS (вариант B), применить миграции `@kingside/broadcasts-db`, завести секрет `BROADCASTS_DATABASE_URL`.
- **KS-N04 [devops]** — Route53 A-record `broadcasts.kingside.site`, ALB listener rule, target group `kingside-broadcasts-api` (sticky sessions ON), ACM (wildcard если не было), ECS Task Definition + Service для `broadcast-service`.
- **KS-N05 [devops]** — переключение `broadcast-worker`: Task Definition с `BROADCASTS_DATABASE_URL`, scale old → 0, scale new → 1. Sanity-counts по broadcasts/broadcast_rounds/broadcast_games.
- **KS-N06 [frontend]** — добавить `VITE_BROADCAST_URL`, создать `src/config/broadcastUrl.ts` + `src/api/broadcastApi.ts`, заменить URL в 3-х pages, поправить `socket.ts`. Обновить моки тестов. Добавить `VITE_BROADCAST_URL` в `scripts/deploy-aws.sh`.
- **KS-N07 [backend]** — после soak'а: удалить `apps/api/src/broadcast/broadcast.{controller,gateway,module}.ts` + dto. Удалить `BroadcastModule` из `app.module.ts`. Удалить 3 broadcast-модели из `packages/db/prisma/schema.prisma`, миграция `drop_broadcast_tables`.
- **KS-N08 [devops]** — финальная зачистка: `DROP TABLE broadcast_games, broadcast_rounds, broadcasts` в старой БД через 14+ дней после KS-N07. Удалить legacy CORS_ORIGIN / old secrets.
- **KS-N09 [qa]** — smoke-план по фазам (D3, M1, F1, B3); контракт по 5 REST-эндпоинтам + 2 WS-событиям (`broadcast:subscribe` → `broadcast:sync`).

## 5. Связь с соседними ADR (чтобы не было противоречий)

- **ADR-017 §1.** Явно отклоняет `broadcast.kingside.site` (мотивировка: broadcast-worker headless, HTTP не отдаёт). **ADR-021 отменяет этот отказ** в части broadcasts, ровно как ADR-018 отменил его для archive: теперь HTTP/WS broadcast-сервер переезжает из `apps/api` в отдельный `apps/broadcast-service`. Хост — `broadcasts.kingside.site` (множественное число, по запросу KS-1695), не `broadcast.kingside.site`, как было изначально в ADR-017.
- **ADR-018.** Структурный образец — `apps/archive-service` + `packages/archive-db` + `archive.kingside.site` + отдельная database. `apps/broadcast-service` + `packages/broadcasts-db` + `broadcasts.kingside.site` + `broadcasts_kingside` database — ровно та же форма. Различия — в наличии WS (ADR-021 §2.4, §2.9.18) и в стратегии миграции данных (ADR-021 §2.5 — rebuild-from-source вместо pg_dump/restore).
- **ADR-019, ADR-020.** Эти ADR касаются archive-importer (merge into service, EventBridge schedule). К broadcast-worker **не применяются** (§2.9.3): broadcast-worker работает непрерывно, SSE-стрим с Lichess нельзя поднимать раз в 5 минут — rate limit и потеря данных. Поэтому broadcast-worker остаётся отдельным ECS service с scale=1.
