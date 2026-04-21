# ADR-018: Вынос API архива в отдельный сервис `archive.kingside.site` и снятие префикса `/api`

**Статус:** Предложено
**Дата:** 2026-04-21
**Задача:** KS-1654
**Связанные ADR:** [ADR-013](./013-game-archive-and-tree.md), [ADR-014](./014-archive-games-by-position.md), [ADR-017](./017-service-subdomains.md), [ADR-012](./012-api-game-service-split.md)

## 1. Контекст

### Что есть сейчас (факт)

1. HTTP API архива живёт в `apps/api/src/archive/` (NestJS-модуль, ~2000 строк кода + тесты):
   - `archive.controller.ts` — префикс `@Controller('archive')`, endpoints:
     - `GET /api/archive/tree`
     - `GET /api/archive/games/by-position`
     - `GET /api/archive/games/:id`
     - `GET /api/archive/games`
   - Глобальный префикс `/api` выставлен в `apps/api/src/main.ts` через `app.setGlobalPrefix('api')`.
   - Эндпоинты **публичные** — `@UseGuards(JwtAuthGuard)` в `apps/api/src/archive/` отсутствует (`Grep` подтверждает).
   - Метрики пробрасываются в `prom-client` через `MetricsService` (`@Optional()`), а сам `/api/metrics` отдаётся в том же процессе.
2. Таблицы архива в общей Prisma-схеме `packages/db/prisma/schema.prisma` (строки 780–883):
   - `ArchiveSource` (`archive_sources`)
   - `ArchiveImport` (`archive_imports`, FK → `ArchiveSource`)
   - `ArchiveGame` (`archive_games`, FK → `ArchiveSource`, `ArchiveImport`)
   - `PositionStats` (`position_stats`)
   - `ArchiveGamePosition` (`archive_game_positions`)
   - Все FK замкнуты внутри архивной группы; ссылок из других доменных моделей (User, Game, Puzzle) на эти таблицы нет.
3. `apps/archive-importer` — headless-воркер:
   - Пишет в ту же БД через `@kingside/db` (Prisma) + собственный `pg.Pool` с `COPY FROM STDIN` для `archive_game_positions`.
   - Берёт `DATABASE_URL`, `REDIS_HOST`/`REDIS_PORT` из env.
   - Использует Redis для locks (`archive:import:lock*`) и публикует `archive:imported` в `rebuild-position-stats.ts` (importer.ts публикаций не делает, `importer.ts:150` — только `redis.del(lockKey)`).
   - Запускается на **существующем ECS-инстансе** отдельной задачей; импорт TWIC — раз в неделю.
4. Фронтенд (`apps/web`) ходит к архиву исключительно через `${API_URL}/api/archive/...`:
   - `apps/web/src/hooks/useArchiveTree.ts:91` — `GET /api/archive/tree`
   - `apps/web/src/hooks/useArchiveGamesByPosition.ts:152, :206` — `GET /api/archive/games/by-position`
   - `apps/web/src/pages/ArchiveGamesByPositionPage.tsx:174` — `GET /api/archive/games/:id`
   - Других потребителей архива (WS, SSR) нет.
5. Public domain topology (по ADR-017, предложено, не факт): `kingside.site` (SPA), `api.kingside.site` (REST `apps/api`), `game.kingside.site` (WS `apps/game-service`). На `apps/api` префикс `/api` сохраняется.

### Что просит KS-1654

1. Перенести весь HTTP-API архива на отдельный хост `archive.kingside.site` **без** префикса `/api`.
2. Выделить БД архива отдельно от основной (не пересекается).
3. Поднять сервис на том же ECS-инстансе, где уже работает `archive-importer`.
4. Параллельно — снять префикс `/api` с основного API (`api.kingside.site`).
5. Фронт адаптировать под новые URL.

### Что это меняет по отношению к ADR-017

ADR-017 ранее отклонил `archive.kingside.site` мотивировкой «archive-importer headless, HTTP наружу не отдаёт». Эта мотивировка становится неверной в момент, когда HTTP-API архива переезжает из `apps/api` в отдельный HTTP-сервис. ADR-018 не отменяет ADR-017 в целом — только его пункт про архив. Решения по `api.kingside.site` и `game.kingside.site` остаются.

### Что НЕ в скоупе ADR-018

- Переход на ClickHouse для `position_stats` (открытый follow-up из ADR-013 §10.C.4).
- Выделение WS из `apps/api` в отдельный процесс `ws.kingside.site`.
- Смена API Gateway / переход на CloudFront.
- Реорганизация `packages/db` в сторону multi-schema generator (обсуждается в §2.2 как отклонённый вариант).
- Перевод refresh-токена на cookie.

## 2. Решение

### 2.1 Структура нового воркспейса

**Имя:** `apps/archive-service`.

**Runtime:** NestJS — та же версия, что в `apps/api` (`@nestjs/common@^11`).

**Способ переноса кода:** `git mv` целиком, без копирования и без extraction в `packages/`:

```
apps/api/src/archive/*                 → apps/archive-service/src/archive/*
apps/api/src/prisma/prisma.service.ts  → apps/archive-service/src/prisma/prisma.service.ts  (копия, см. ниже)
apps/api/src/redis/redis.service.ts    → apps/archive-service/src/redis/redis.service.ts    (копия)
apps/api/src/metrics/*                 → apps/archive-service/src/metrics/*                 (копия, MetricsService + /metrics controller)
apps/api/src/common/all-exceptions.filter.ts → apps/archive-service/src/common/...          (копия)
```

**Почему NestJS, а не Fastify/Hono/bare express:**
- 99% кода (сервис, репозиторий с raw SQL, cursor-codec, position-key, prewarm, metrics) не зависит от HTTP-слоя и переносится как есть.
- DI уже описан через `@Inject(ARCHIVE_STATS_REPOSITORY)`, `@Optional() MetricsService`, `@OnModuleInit/Destroy` lifecycle (Redis pub/sub). Переписывание этого на вручную-собранные контейнеры — чистая работа без пользы.
- Controller + DTO (class-validator) переносятся одной строкой импорта.
- Jest/unit-тесты (`archive.service.spec.ts`, `archive-metrics-di.e2e.spec.ts` и др.) переносятся без изменений.
- Риск «NestJS тяжёлый» — на данных объёмах трафика архива (публичный GET-only API на десятки RPS) cold-start и RSS overhead не узкое место. Если в будущем потребуется выжать latency — это отдельная задача замены runtime.

**Почему НЕ extraction в `packages/archive-core`:**
- Единственный потребитель архивного кода — сам archive-service. Worker (`apps/archive-importer`) пишет **в БД**, а не через API-слой; он не нуждается в `ArchiveService`.
- Extraction создаёт package только ради одного app — overhead сборки и циклов зависимостей (`@kingside/shared` уже и так общий; `@kingside/archive-db` появится, см. §2.2).

**Почему НЕ inline monorepo app со всем контекстом NestApp (как у `apps/game-service`):** именно так и предлагается, это и есть inline monorepo app. Пункт добавлен для ясности — копируем паттерн `apps/game-service` (отдельный `AppModule`, свой `main.ts`, свой `package.json`, свой `Dockerfile`).

**package.json нового воркспейса** (инвариант, конкретику оформляет backend):
- Имя: `@kingside/archive-service`.
- Зависимости: `@nestjs/*`, `@kingside/shared`, `@kingside/archive-db` (новый, см. §2.2), `ioredis`, `prom-client`, `chess.js`, `class-validator`, `class-transformer`, `pg` (для прямого `$queryRawUnsafe` в репозитории — уже используется).
- Скрипты: `dev` (`nest start --watch`), `build` (`nest build`), `start` (`node dist/main.js`), `test` (`jest`), `lint`.
- Dockerfile — по образцу `apps/archive-importer/Dockerfile` (multi-stage Node 22).

**main.ts archive-service:**
- **Без** `setGlobalPrefix`. Контроллер остаётся с путём `@Controller('archive')` → итоговые пути `/archive/tree`, `/archive/games/...`. URL на проде: `https://archive.kingside.site/archive/tree`, `/archive/games/by-position`.
- **Внимание на расхождение с формулировкой задачи.** Постановка KS-1654 просит URL `archive.kingside.site/tree`, `/games/by-position` (без контроллерного префикса `archive`). Чтобы прийти к этому виду, нужно дополнительно убрать `@Controller('archive')` → `@Controller()`. Это тривиально, но ломает ментальную модель (именование ресурсов на корне). Рекомендация: **оставить `@Controller('archive')`** — хост уже несёт семантику «архив», лишний сегмент `/archive/` в пути явно показывает, к какому домену относится ресурс, и снижает коллизии при расширении сервиса (например, `/health`, `/metrics`, `/ready` не зажаты в ту же плоскость, что `/tree`/`/games`). Финальное решение по префиксу — вопрос в backend-тикет, один из двух вариантов, оба работоспособны.
- CORS: `CORS_ORIGIN` из env; список — `https://kingside.site,https://www.kingside.site`. **НЕ** добавляем `api.kingside.site` (архив зовёт фронт, не API).
- Health endpoint: `/health` — простой контроллер, возвращающий 200 + `{ok: true}`. Используется ALB health check target group.
- `/metrics` endpoint — переносится вместе с metrics-модулем. Prometheus scrape идёт на archive-service отдельно от `apps/api`.
- Redis pub/sub subscribe на `archive:imported` — остаётся в `ArchiveService.onModuleInit` как сейчас.

**Что удаляется из `apps/api`** (после переноса):
- `apps/api/src/archive/` — целиком.
- `ArchiveModule` в `apps/api/src/app.module.ts` (строки 30, 73 — импорт и регистрация).
- Ссылки на archive-таблицы в `PrismaClient` типизации — пропадут автоматически после удаления моделей из `@kingside/db` (§2.2).

### 2.2 Схема БД архива

**Вариант-победитель: отдельный пакет `packages/archive-db` с собственным `schema.prisma`, отдельным клиентом и отдельной базой PostgreSQL.**

Структура:

```
packages/archive-db/
  package.json               # name: "@kingside/archive-db"
  prisma/schema.prisma       # ТОЛЬКО архивные модели + generator + datasource
  prisma/migrations/         # новая migrations-история, начинается с baseline
  src/index.ts               # export { PrismaClient } from './generated/prisma'
```

**Модели, переезжающие в `packages/archive-db/prisma/schema.prisma`:**

| Модель | Таблица | Источник |
| ------ | ------- | -------- |
| `ArchiveSource` | `archive_sources` | `packages/db/prisma/schema.prisma:780` |
| `ArchiveImport` | `archive_imports` | `:791` |
| `ArchiveGame` | `archive_games` | `:813` |
| `PositionStats` | `position_stats` | `:850` |
| `ArchiveGamePosition` | `archive_game_positions` | `:868` |

FK-граф: `ArchiveImport.sourceId → ArchiveSource.id`, `ArchiveGame.sourceId → ArchiveSource.id`, `ArchiveGame.importId → ArchiveImport.id`. Все рёбра внутри группы. `position_stats` и `archive_game_positions` — без FK на `archive_games` по конструкции (ADR-013/014, аггрегатные таблицы, обновляются воркером и пересчитываются `archive:rebuild-position-stats`).

**Отдельная база или схема в той же?** Две опции, на выбор devops:

- **A. Отдельный RDS-инстанс `kingside-archive-db`.** Плюс: полная изоляция IOPS, пулов, лимитов коннектов, dump/restore. Минус: отдельный денежный ценник + ещё одно подключение к поддержке.
- **B. Отдельная Postgres database на текущем RDS-кластере (`CREATE DATABASE archive`).** Плюс: один инстанс, один billing. Минус: общий storage-IOPS с основной базой; на больших импортах `COPY` в archive упирается в ту же шину, что и OLTP apps/api.

**Рекомендация ADR:** B (отдельная database в существующем кластере). Разделение БД для архива — **логическое** (разный Prisma-клиент, разный connection string), physical isolation даёт marginal profit на текущем масштабе. Если в будущем TWIC-импорт начнёт влиять на latency основной БД — вынести на отдельный RDS. Перевод B → A делается одним pg_dump/restore + сменой `ARCHIVE_DATABASE_URL`, не ломает контракт.

**Отклонено: оставить обе схемы в `packages/db`** (через Prisma multi-schema):
- Prisma multi-schema требует единого `datasource`, что означает **одну физическую БД**. Это противоречит пункту 2 постановки KS-1654.

**Отклонено: вынести archive в отдельный schema PostgreSQL (`CREATE SCHEMA archive`) в той же database:**
- Логически аккуратно, но всё ещё делит connection pool и `pg_hba.conf` с OLTP. Физического разделения не даёт.

**Миграция данных с прода.**

Объёмы (нужно уточнить практически перед миграцией; я их не верифицировал — *факт проверить у backend/devops до cutover*):
- `archive_games` — миллионы строк (TWIC накапливает ~2k партий/неделю; за 10+ лет истории — ~1M партий).
- `archive_game_positions` — десятки миллионов строк (1 партия → ~40 позиций, уменьшается ply-фильтром ADR-015).
- `position_stats` — на порядок меньше, аггрегат.

Стратегия миграции — **снапшот + pg_dump/pg_restore с даунтаймом archive API**, не логическая репликация:

1. **Подготовка (без даунтайма).** Новый RDS database поднят, Prisma migrations на нём применены, схема пустая.
2. **Начало cutover window** (выбирается между недельными TWIC-тиками, длительность ~1–4 часа в зависимости от объёма):
   - Stop `archive-importer` ECS task (чтобы прекратить запись в старые таблицы).
   - Подтвердить отсутствие активных INSERT в архивные таблицы (`pg_stat_activity` check).
3. **Dump-ступень.** `pg_dump --data-only --table=archive_sources --table=archive_imports --table=archive_games --table=position_stats --table=archive_game_positions` из старой БД → S3.
4. **Restore-ступень.** `pg_restore --data-only` в новую database. Прогрев индексов (если нужно — `ANALYZE`).
5. **Sanity-checks:** `SELECT COUNT(*)` по каждой таблице, сравнение со старой.
6. **Переключения:**
   - `archive-importer` стартует с новым `DATABASE_URL` (→ новая archive DB).
   - `archive-service` стартует с `ARCHIVE_DATABASE_URL` (новая archive DB).
   - DNS `archive.kingside.site` уже указывает на ALB listener rule → archive-service target group (настроено заранее, см. §2.6, до cutover отвечает 503/placeholder).
7. **End of window.** Фронт получает новый билд с `VITE_ARCHIVE_URL=https://archive.kingside.site` (см. §2.7).
8. **Soak period (7–14 дней).** Старые таблицы в основной БД не трогаем — страховка для роллбэка.
9. **Cleanup.** `DROP TABLE archive_* CASCADE; DROP TABLE position_stats CASCADE;` в основной БД. **Точка невозврата.** Удалить модели из `packages/db/prisma/schema.prisma` и накатить миграцию `drop_archive_tables`.

**Альтернатива — rebuild-from-scratch:**
- `archive_games` и `archive_imports` не восстанавливаются без dump'а (TWIC-источник ≠ source of truth, потому что порядок импорта и `content_hash` deduplication уже выполнены).
- `position_stats` и `archive_game_positions` **могут** быть пересчитаны из `archive_games.pgn` через `archive-importer/src/rebuild-position-stats.ts` и `position-indexer.ts`. Но это займёт часы–дни и создаст своё окно.
- Рекомендация: рассматривать rebuild-from-scratch как **план B для rollback**, если dump/restore упадёт по какой-либо причине. Dump `archive_games` + `archive_sources` + `archive_imports` — обязательно. `position_stats` и `archive_game_positions` можно пересчитать после restore (это ускорит dump/restore за счёт пропуска самых больших таблиц).

**Downtime-окно для пользователей:**
- Архивные страницы фронта (`/archive/games`, `ArchiveTreePanel` в `AnalysisPage`) на время миграции показывают fallback «архив недоступен» / пустой tree. Это **приемлемо** — архив вторичный для большинства пользователей.
- Основной API (логин, игры, puzzles, tournaments) в процессе миграции **не трогается**, пользователи продолжают работу.

### 2.3 Impact на `apps/archive-importer`

**Текущее состояние:** Prisma-клиент `PrismaClient` из `@kingside/db` + отдельный `pg.Pool` в `ArchivePositionWriter` — оба читают `DATABASE_URL`. Publish в Redis канал `archive:imported` (только в `rebuild-position-stats.ts:210`). Redis locks `archive:import:lock*`.

**Что меняется:**

1. **Зависимость.** В `apps/archive-importer/package.json` замена `@kingside/db` → `@kingside/archive-db`. Код importer использует только архивные модели Prisma (`prisma.archiveSource.*`, `prisma.archiveImport.*`, `prisma.archiveGame.*`) — ничего не ломается, потому что все эти модели живут в новом пакете.
2. **ENV.** `DATABASE_URL` для importer'а меняется на новый connection string архивной БД. Переменная не переименовывается (переиспользуется именно в этом воркспейсе), но значение указывает на archive DB. Альтернатива: завести `ARCHIVE_DATABASE_URL` и читать его — снижает риск ошибочной конфигурации (например, если кто-то задеплоит importer со старым `DATABASE_URL` из общей таск-дефиниции ECS). **Рекомендация:** новая переменная `ARCHIVE_DATABASE_URL` и в archive-service, и в archive-importer; importer перестаёт читать `DATABASE_URL` вовсе.
3. **Redis.** Канал `archive:imported` остаётся тот же Redis. Значит archive-service подписывается на тот же Redis-инстанс, что и основной API. Важно: archive-service должен использовать **тот же `REDIS_HOST/PORT`**, что и importer, иначе кеш-инвалидация не дойдёт.
4. **Double-write или single-write?** Single-write, без параллельной записи в обе БД:
   - Причина: importer — единственный писатель архивных таблиц (за исключением cron'а `rebuild-position-stats.ts`, который тоже в importer). Конкурирующих писателей нет.
   - Значит достаточно остановить importer на время `pg_dump → pg_restore`, затем поднять его на новой БД.
   - Double-write дал бы zero-downtime для **импорта**, но пользователи всё равно видят старый/новый API-срез в зависимости от DNS; сложность double-write (две транзакции, откат одной из них) не окупается.

**Коннект к Redis importer'а и archive-service.** Сейчас один Redis в VPC. Остаётся. В тестовых scenarios (`vitest`) используются отдельные mocked-ioredis — не трогаем.

**Alternative consider.** Завести отдельный **`ARCHIVE_REDIS_URL`** (отдельный Redis namespace или отдельный инстанс). **Отклонено:** сейчас два Redis для одного поток событий (import → invalidate cache) создаёт риск расхождения и цепочку передачи. Если в будущем archive-сервис увеличит трафик — Redis уровень shard'ится раньше, чем разделяется по сервисам.

### 2.4 Auth и CORS

**Эндпоинты архива публичны.** В `apps/api/src/archive/` нет `@UseGuards(...)`, `@Public()`, `@Roles(...)` — это проверено grep'ом. Все четыре эндпоинта (`/tree`, `/games/by-position`, `/games/:id`, `/games`) отдают данные без JWT-валидации и должны оставаться публичными на `archive.kingside.site`.

**Следствие:** в archive-service **не переносится** `apps/api/src/auth/` и зависимости `@nestjs/jwt`, `passport-jwt`, `bcrypt`. Это сокращает образ и уменьшает поверхность атаки.

**Если в будущем потребуется JWT-валидация** (например, rate-limit per-user, premium-доступ к расширенному архиву):
- **JWKS**-подход: `apps/api` выставляет `/jwks.json`, archive-service кеширует и проверяет подпись. Требует настройки key rotation. Overkill для MVP.
- **Shared secret**-подход: `JWT_SECRET` синхронно распространён через ECS Secrets Manager в обе задачи. Минус — утечка в одной задаче компрометирует весь кластер. Приемлем для single-team deploy.
- **Header-based introspection**: archive-service делает internal HTTP-call на `api.kingside.site/auth/introspect` с `Authorization: Bearer <x>`, основной API возвращает claims. Плюс — логика auth остаётся в одном месте. Минус — лишний hop на каждый запрос к архиву.
- **Рекомендация:** shared-secret через ECS Secrets + `passport-jwt` (копируется `apps/api/src/auth/strategies/jwt.strategy.ts` без auth-контроллеров). Решение фиксируется отдельным ADR, когда возникнет бизнес-потребность.

**CORS:**
- `CORS_ORIGIN=https://kingside.site,https://www.kingside.site` в environment archive-service.
- `credentials: false` (публичный API без cookies). В main.ts archive-service: `app.enableCors({ origin, credentials: false, methods: ['GET', 'HEAD'] })`. Только GET/HEAD — все архивные эндпоинты `@Get`, write-путь только у importer'а.
- `OPTIONS` preflight не требуется для простых GET без custom headers. Фронт не шлёт `Authorization`, `Content-Type: application/json` не требуется для GET. Но безопаснее включить CORS как есть — Nest это делает автоматически.

### 2.5 Снятие префикса `/api` с основного API

**Сложность:** префикс `/api` нельзя удалить одновременно с deploy'ем, не создав окна рассинхронизации фронт⇄бек.

**Схема без downtime — dual-prefix режим через поддержку двух путей на стороне бекенда + последующий cleanup:**

1. **Шаг A (backend, обратно-совместимо).** В `apps/api/src/main.ts` заменить `app.setGlobalPrefix('api')` на middleware, который пропускает запросы под обоими путями:
   ```ts
   // псевдокод, конкретная реализация — задача backend
   app.use((req, _res, next) => {
     if (req.url.startsWith('/api/')) {
       req.url = req.url.slice(4); // обрезаем "/api"
     }
     next();
   });
   ```
   Контроллеры регистрируются **без** глобального префикса, ловят URL и с `/api/*`, и без него. Deploy этого шага не ломает старый фронт (`/api/*` продолжает работать) и открывает новый путь (`/*`).
   **Альтернатива:** зарегистрировать все контроллеры с `@Controller('api/xyz')` вручную + дубли без префикса — более многословно и error-prone.
2. **Шаг B (frontend).** В `apps/web` убрать `/api` из всех fetch-URL:
   - `apps/web/src/api.ts`, `apps/web/src/hooks/*`, `apps/web/src/pages/*` — замена `${API_URL}/api/foo` → `${API_URL}/foo`.
   - **Архивные хуки** (`useArchiveTree.ts`, `useArchiveGamesByPosition.ts`, `ArchiveGamesByPositionPage.tsx`) идут дальше — меняют базовый URL на новый `VITE_ARCHIVE_URL` (см. §2.7). Это **два независимых изменения** во фронте, которые деплоятся одним фронт-билдом.
   - Deploy фронта: старые клиенты (до hard-refresh) продолжают ходить `/api/*` — шаг A гарантирует их работу.
3. **Шаг C (soak 7–14 дней).** Наблюдаем метрики: хиты `/api/*` на `api.kingside.site` должны падать, хиты `/*` — расти. ALB CloudWatch per-target-group `RequestCount` по path-patterns (если path-rules заведены, см. §2.6).
4. **Шаг D (backend cleanup).** Убрать middleware-rewrite из `apps/api/src/main.ts`. Регистрация контроллеров остаётся как на шаге A. Все запросы теперь идут по `/*`. **Точка невозврата** — старые PWA-клиенты, не обновившиеся за soak, перестают работать.
5. **Шаг E (WS-неймспейсы).** Socket.IO namespaces `/broadcast`, `/messages` **не затрагиваются** — `app.setGlobalPrefix` на них не действует. Поверх `/api` они никогда и не работали.

**Отклонённые варианты:**
- **ALB URL rewrite.** ALB умеет redirect, но **не умеет rewrite path без редиректа**. Через rule action `forward` путь не модифицируется. 301/302 redirect делает лишний round-trip и ломает POST-запросы (если они когда-то появятся). → не подходит.
- **Второй процесс apps/api с префиксом.** Дубликат инстанса только ради префикса — бессмысленно.
- **Одновременная выкатка frontend+backend без переходного моста.** Между deploy бекенда и деплоем/hard-refresh фронта неизбежно 30+ секунд окна «старый фронт шлёт на `/api/`, новый бек 404'ит». Это НЕ даунтайм сайта, но это ошибки у живых пользователей. Неприемлемо.

**Инвариант всех шагов:** в любой момент действующий фронт-билд имеет путь до API, а действующий бек отвечает хотя бы на один известный префикс.

### 2.6 DNS, TLS, ALB, ECS

Инфраструктура — зона devops. В ADR фиксируются требования-контракты.

1. **DNS.** Новый A-record `archive.kingside.site` → тот же ALB, что обслуживает `kingside.site`/`api.kingside.site`/`game.kingside.site`. TTL 60с на время миграции, 300+ после стабилизации.
2. **TLS.** Wildcard-сертификат `*.kingside.site` (см. ADR-017 §3.2) покрывает `archive.kingside.site`. Если в проде всё ещё SAN-сертификат — devops расширяет (или мигрирует на wildcard, что предпочтительнее).
3. **ALB listener rule.** HTTPS:443, приоритет выше корня и ниже других `Host`-правил (порядок: archive, api, game, root). `Host == archive.kingside.site` → forward в новую target group `kingside-archive-api`.
4. **Target group `kingside-archive-api`.** Health check: `GET /health`, 200 OK, threshold 2/3. Sticky sessions: **не нужны** (нет WS, stateless).
5. **ECS.**
   - Cluster: **тот же**, что обслуживает `archive-importer` (по постановке KS-1654 пункт 6).
   - Новая Task Definition `archive-service` (Fargate или EC2 — в соответствии с тем, как размещены остальные task'и).
   - Service desired count: 1 на старте, auto-scaling min=1, max=2 (можно один инстанс на GET-only API; горизонталка появится при нагрузке).
   - Environment: `ARCHIVE_DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `CORS_ORIGIN`, `ARCHIVE_STATS_IMPL=postgres`, `ARCHIVE_PREWARM_DISABLE` (unset = prewarm on).
   - Resources: 512 CPU / 1024 MiB memory (оценка; прогресс окнами CloudWatch).
6. **Импорт-задача.** Та же Task Definition `archive-importer` продолжает жить, меняется только `ARCHIVE_DATABASE_URL` (ранее `DATABASE_URL`).
7. **Network.** Archive-service и archive-importer — в одной security group (как сейчас archive-importer), SG разрешает outbound на RDS (порт 5432) и Redis (порт 6379).
8. **Logs.** CloudWatch Logs group `/ecs/archive-service`.

**Контракт деплоя фиксируется в ADR, изменения в `scripts/deploy-aws.sh` делает devops.** Из `apps/archive-service` выкладывается образ, архив — частью `turbo build`, но Dockerfile у каждого apps/* свой (по паттерну `apps/game-service`, `apps/archive-importer`).

### 2.7 Воздействие на `apps/web`

**ENV (в `apps/web/src/vite-env.d.ts` добавить):**
- `VITE_ARCHIVE_URL` — новая переменная. Прод-значение: `https://archive.kingside.site`. Локально — `http://localhost:3003` (или порт, который занимает archive-service в dev; согласовать с backend).
- `VITE_API_URL` — значение меняется позже (при снятии `/api`) на `https://api.kingside.site` (без `/api` в базе). Имя переменной сохраняется.

**Точки кода для правки:**

Архивные:
- `apps/web/src/hooks/useArchiveTree.ts:91` — `${API_URL}/api/archive/tree` → `${ARCHIVE_URL}/archive/tree`.
- `apps/web/src/hooks/useArchiveGamesByPosition.ts:152, :206` — `${API_URL}/api/archive/games/by-position` → `${ARCHIVE_URL}/archive/games/by-position`.
- `apps/web/src/pages/ArchiveGamesByPositionPage.tsx:174` — `${API_URL}/api/archive/games/${id}` → `${ARCHIVE_URL}/archive/games/${id}`.

Остальные (часть снятия `/api`, см. §2.5 шаг B):
- Все `${API_URL}/api/*` → `${API_URL}/*` во всех хуках/страницах/утилитах.

Точечный список файлов с `/api/*` (потребует точечный grep перед задачей) — включает как минимум `apps/web/src/api.ts`, `apps/web/src/hooks/*.ts`, `apps/web/src/pages/*.tsx`, `apps/web/src/context/ChatContext.tsx`, `apps/web/src/utils/clientLogger.ts`.

**Fallback в `apps/web/src/socket.ts`.** После миграции `VITE_API_URL` указывает на `api.kingside.site`, WS-неймспейсы `/broadcast`/`/messages` идут туда же (не на archive). Архив WS не использует → fallback не меняется.

**Dev-окружение.** `apps/web` в dev читает `VITE_ARCHIVE_URL` из `.env.local`. Если переменная не задана — default `http://localhost:3003` (или текущий dev-порт archive-service). Fallback в код **не добавляем** — на проде должна быть жёстко задана, иначе архив ломается молча (это хуже явной 500 при старте).

### 2.8 Последовательность задач

Обозначения: **B** backend, **D** devops, **F** frontend. Зависимости указаны после названия.

#### Фаза 0 — параллельно, без точек невозврата

- **B1.** Создать `packages/archive-db`: скопировать 5 архивных моделей + общий header schema.prisma, сгенерировать baseline migration. Prisma generate, unit-smoke. Зависимостей нет.
- **B2.** Создать `apps/archive-service`: перенос кода `apps/api/src/archive/` + копии инфраструктурных сервисов (Prisma, Redis, Metrics, Exception filter, Health). Dockerfile. package.json. Зависит от **B1** (archive-service импортирует `@kingside/archive-db`). Локально поднимается и отдаёт `/health`, `/metrics`, `/archive/tree` на старые dev-данные (пока БД общая).
- **D1.** Подготовить новую archive database в существующем RDS: `CREATE DATABASE archive_kingside`, пользователь, права. Применить миграции `@kingside/archive-db` (пустые таблицы). Зависит от B1 (нужны migrations). Параллельно с B2.
- **D2.** Завести ACM wildcard (если ещё нет), Route53 A-record `archive.kingside.site` → ALB. ALB listener rule `Host == archive.kingside.site` → **временная** target group, отдающая 503 (или forward в `kingside-archive-api` с нулём target'ов, получается 503). Зависит от: ничего — делается заранее.

#### Фаза 1 — deploy archive-service (обратимо)

- **D3.** ECS Task Definition + Service для `archive-service`. Запуск с `ARCHIVE_DATABASE_URL` = **новая** (пустая) база. Зависит от **B2, D1, D2**. На этом этапе `archive.kingside.site/archive/tree` отдаёт пустые результаты (база пуста), но health=200.
- **QA-smoke.** Прогнать e2e на dev/stage, убедиться что archive-service отвечает на всех 4 endpoint'ах, считает метрики, CORS работает с `kingside.site`. Зависит от **D3**.

#### Фаза 2 — миграция данных (точка невозврата-частичная)

- **M1.** Cutover window (1–4 часа):
  1. Stop `archive-importer` ECS service (scale to 0).
  2. `pg_dump --data-only` архивных таблиц из старой БД → S3.
  3. `pg_restore --data-only` в новую archive DB.
  4. Sanity-counts.
  5. Update `archive-importer` ECS Task Definition: `ARCHIVE_DATABASE_URL` = новая БД, убрать `DATABASE_URL`. Scale archive-importer к 1.
  6. Smoke — archive-importer лог `DB reachable`; archive-service возвращает данные.
- **Точка частичной невозвратности:** после M1 старая БД имеет устаревающий снапшот. Rollback возможен (pg_dump/restore обратно + понижение фронта), но требует повторного cutover window.

#### Фаза 3 — rollout фронта (обратимо)

- **F1.** В `apps/web` — точечная замена архивных URL на `VITE_ARCHIVE_URL`. **Без** снятия `/api` в остальных местах (это отдельный шаг). В `scripts/deploy-aws.sh` добавить `VITE_ARCHIVE_URL=https://archive.kingside.site` к билду. Зависит от **D3, M1**. Deploy → soak 3–7 дней, метрики на `/api/archive/*` на `apps/api` должны падать до нуля.
- **B3.** После soak'а — удалить `apps/api/src/archive/`, `ArchiveModule` из `app.module.ts`. Удалить архивные модели из `packages/db/prisma/schema.prisma`, накатить миграцию `drop_archive_tables`. Зависит от: метрик на `/api/archive/*` ≈ 0 в течение soak'а.
- **D4.** После B3 — можно убрать старые `/api/archive/*` path-rules с ALB (если они были отдельно отведены — в путях это только prefix rule `/api/*`, поэтому ALB-конфиг не трогаем).

#### Фаза 4 — снятие `/api` на `apps/api` (отдельный мини-релиз, обратимо до шага D'3)

- **B'1.** В `apps/api/src/main.ts` заменить `setGlobalPrefix('api')` на dual-path middleware (см. §2.5 шаг A). Deploy.
- **F'1.** В `apps/web` заменить `${API_URL}/api/*` на `${API_URL}/*` во всех оставшихся местах. Зависит от **B'1**. Deploy.
- **Soak 7–14 дней.** Метрики `/api/*` на `api.kingside.site` → 0.
- **B'2.** Удалить middleware из `apps/api/src/main.ts`. Deploy. Точка невозврата.
- **D'3.** Зачистка ALB: path-pattern `/api/*` удалить, если был явный rule. Зависит от **B'2**.

#### Фаза 5 — финальная зачистка (точка невозврата)

- **M2.** `DROP TABLE archive_*, position_stats` в старой БД. Сделать после 14 дней soak'а фазы 3 (F1 + B3). **Точка окончательной невозвратности** (старые dump'ы с S3 удалять не раньше +30 дней).

#### Карта параллелизма

Параллельно (независимые):
- B1 + D1 + D2.
- B2 начинается после B1.
- D3 после B2 + D1 + D2.

Последовательно (нельзя параллелить):
- M1 после D3 и QA-smoke.
- F1 после M1.
- B3 после F1 + soak.
- Фаза 4 (B'1 → F'1 → B'2) — полностью своя последовательность, можно параллельно с фазой 3 начинать, но B'2 делать **не раньше** фазы 3 B3 (меньше одновременно меняющихся систем).

### 2.9 Риски и подводные камни

Чек-лист — не эмоциональный, а на что смотреть перед каждым шагом. Сомнения помечены *[проверить практически]*.

1. **Объём `archive_game_positions`.** Таблица самая большая из переезжающих. `pg_dump` в раздельные chunks или с `--jobs=N` ускоряет, но требует дисковой ёмкости под dump + прозрачное S3-хранение. *[замерить размер `pg_total_relation_size` перед M1]*.
2. **Redis pub/sub.** Канал `archive:imported` слушается и archive-service, и, возможно, где-то ещё. `Grep` дал единственного подписчика (`apps/api/src/archive/archive.service.ts:81`) и единственного publisher (`apps/archive-importer/src/rebuild-position-stats.ts:210`). После миграции archive-service подписывается на тот же Redis — работает. Но если в `apps/api` появится новый потребитель этого канала (например, для инвалидации какой-то ещё кеша), **он останется без source** после удаления `ArchiveService`. → на этапе B3 grep'нуть весь репо на `archive:imported` ещё раз.
3. **Public API контракт.** Пути `/archive/tree`, `/archive/games/by-position`, `/archive/games/:id`, `/archive/games` не должны изменить сигнатуры query-params, response body. DTO и `@kingside/shared` types переезжают вместе с сервисом — контракт гарантирован на уровне типов.
4. **Seed/fixture-данные.** Если в `apps/api` есть seed-скрипты, наполняющие `archive_sources` (например, дефолтный TWIC source), — они переезжают в `packages/archive-db/prisma/seed.ts`. *[проверить `packages/db/prisma/migrations/*.sql`, `apps/api/src/**/seed*.ts`]*.
5. **Prewarm-cron.** `ArchiveService.prewarmTopPositions` стартует через `setInterval` в `onModuleInit`. После переноса archive-service — один прогретый кеш на один процесс. Если ECS масштабирует до N>1 instances, prewarm тикает N раз параллельно. Это не проблема для корректности, но нагружает Redis и БД. *[при переходе на auto-scaling поставить лидер-выбор через Redis lock, уже есть паттерн `archive:import:lock`]*.
6. **Metrics relaying.** `apps/api/metrics` сейчас экспонирует и архивные counter'ы. После переноса они уедут на `archive.kingside.site/metrics`. Prometheus scrape-конфиг должен **добавить** новый target. *[проверить `scripts/` / Grafana datasources]*.
7. **ALB sticky sessions и WS.** Архив **без WS**, sticky не нужны. Проверка только формальна.
8. **Health check false-positive.** Archive-service `/health` — простой ok. Если БД упала, health продолжает возвращать 200. → рекомендация: `/health` проверяет `SELECT 1` в БД с таймаутом 500мс. Стандартный паттерн NestJS `@nestjs/terminus`.
9. **Cold-start archive-service.** После scale-in на 0 task'ов (при экономии) первый запрос поднимает контейнер + Prisma generate client → пауза 5–15с. На GET-only API с low-traffic риск минимальный, но *[решить: держать min=1 всегда, да]*.
10. **Ошибка конфигурации: importer пишет в старую БД, archive-service читает из новой.** Все данные новых TWIC-тиков тогда уходят в мусор. **Превентивно:** CI-джоб, который проверяет, что `ARCHIVE_DATABASE_URL` **одинаков** в обеих ECS task definitions (archive-service + archive-importer). Или task definitions шарят одну secret-переменную из ECS Parameter Store.
11. **Zombie-коннекты старой БД.** После остановки `apps/api` archive-части часть пулов может держаться — не проблема, Prisma закроет. Но если архив-модуль на `apps/api` остаётся в коде до soak'а (B3), он продолжает коннектиться к старой БД и возвращать **устаревающие** данные. Пользователи, чей кеш / PWA ещё ходит на `/api/archive/*`, видят стагнирующий архив. Это и есть мотив ограничить soak 3–7 днями и иметь метрики hit-rate.
12. **Роллбэк после M1.** Возможен до момента M2 (drop таблиц). Rollback-процедура:
    - Scale archive-service к 0.
    - archive-importer: вернуть старый `DATABASE_URL`, scale к 1 (старая БД продолжит заполняться с лагом в 1 неделю).
    - Фронт: hotfix-билд, возвращающий архивные URL на `${API_URL}/api/archive/*`. Вернуть `apps/api/src/archive/` (revert B3 — но B3 ещё не было, если rollback до фазы 3).
    - DNS archive.kingside.site оставить — отдаёт 503 через пустой target group.
13. **Stage vs Prod.** В постановке не указано, есть ли stage для архива. *[выяснить у devops]*. Если stage есть — всю последовательность прогнать там сначала; если нет — прогон в dev docker-compose + ручной smoke на prod в maintenance-окне.
14. **Конкурирующие миграции в `packages/db`.** Пока B3 не выполнен, миграции Prisma в `packages/db` не должны трогать архивные таблицы (иначе два владельца одних таблиц). Запретить правку этих моделей до фазы 5 — зафиксировать в PR-чеклисте backend.
15. **Mixed-content и sub-resource CORS.** Если на странице открыт `/analysis` с встроенным `ArchiveTreePanel`, HTML отдан с `kingside.site`, XHR идут на `archive.kingside.site` — браузер делает CORS preflight при первом запросе. Протокол обязателен HTTPS (HTTPS-only), иначе mixed-content блокировка. Сертификат wildcard покрывает. *[проверить строгость `Content-Security-Policy: connect-src`, если он есть в `apps/web/public` или middleware на проде; его могут забыть расширить]*.
16. **Тесты `apps/api`.** После удаления archive из `apps/api` тесты `archive.service.spec.ts`, `archive-metrics.service.spec.ts`, `archive-metrics-di.e2e.spec.ts`, `archive.service.mismatch.spec.ts`, `cursor-codec.spec.ts`, `result-format.spec.ts`, `position-key.spec.ts` переезжают в `apps/archive-service`. Конфиг jest — ровно как в `apps/api`, один в один.
17. **Frontend тесты.** Архивные тесты (`apps/web/src/**/*archive*.spec.tsx`) мокают `fetch` на URL. После замены URL на `ARCHIVE_URL` моки нужно обновлять. *[пройтись grep'ом по тестовым файлам]*.
18. **CI pipeline.** `turbo build` должен включить `apps/archive-service` — проверить `turbo.json`, `package.json` workspaces. После B1 добавить `packages/archive-db` в `workspaces`. Linter, eslint-конфиги копируются из `apps/api`.
19. **`ARCHIVE_STATS_IMPL`.** Env-переменная управляет DI в `archive.module.ts`. Переезжает как есть. В archive-service она, опять же, читается при старте. *[убедиться, что в ECS task definition задана `ARCHIVE_STATS_IMPL=postgres`, иначе default 'postgres' — но прописать явно]*.
20. **Snake_case inconsistency в API.** Конвенция shared-type'ов — camelCase. `@kingside/shared` уже обеспечивает. Проверка не нужна, фиксируется тестами контрактов.

## 3. Последствия

- **Backend.** Новый воркспейс `apps/archive-service`, новый пакет `packages/archive-db`. Архив-модуль удаляется из `apps/api`. Snake-case API контракты неизменны (через `@kingside/shared`). Два мини-релиза бекенда: один — перенос архива, второй — снятие префикса `/api`.
- **DevOps.** Новый RDS database (или отдельная database на существующем кластере), Route53 A-record, ALB listener rule, ECS task definition + service, ACM wildcard, CloudWatch logs group, Prometheus scrape-target. Новые переменные в ECS secrets/parameters.
- **Frontend.** Новая ENV `VITE_ARCHIVE_URL`, замены URL в 4 архивных местах + массовая замена `/api/*` → `/*` в основном API (в фазе 4).
- **QA.** Smoke по четырём endpoint'ам архива после каждого из: D3, M1, F1, B3. После фазы 4 — полный regression основного API (логин, puzzles, игры, турниры).
- **Документация.** После M2 — обновить `docs/architecture/system-overview.md`, добавить `archive.kingside.site` в список сервисов (ADR-017 + этот).

## 4. Предлагаемые тикеты

- **KS-N01 [backend]** — создать `packages/archive-db` с 5 архивными моделями и baseline-миграцией.
- **KS-N02 [backend]** — создать `apps/archive-service` (NestJS), перенести `apps/api/src/archive/` + необходимые инфраструктурные сервисы (Prisma, Redis, Metrics, Exception filter, Health `/health`), Dockerfile, package.json.
- **KS-N03 [devops]** — поднять новую archive database в RDS (вариант B из §2.2), применить миграции `@kingside/archive-db`, завести секреты `ARCHIVE_DATABASE_URL` в ECS.
- **KS-N04 [devops]** — Route53 A-record `archive.kingside.site`, ALB listener rule `Host == archive.kingside.site`, target group `kingside-archive-api`, ACM wildcard (если ещё SAN), ECS Task Definition + Service для archive-service.
- **KS-N05 [devops]** — миграция данных (M1): cutover-window, `pg_dump`/`pg_restore` архивных таблиц в новую БД, перенастройка `archive-importer` на `ARCHIVE_DATABASE_URL`.
- **KS-N06 [backend]** — перевести `apps/archive-importer` на `@kingside/archive-db`, заменить `DATABASE_URL` → `ARCHIVE_DATABASE_URL`.
- **KS-N07 [frontend]** — добавить `VITE_ARCHIVE_URL`, заменить архивные URL в `useArchiveTree.ts`, `useArchiveGamesByPosition.ts`, `ArchiveGamesByPositionPage.tsx`. Обновить моки тестов.
- **KS-N08 [backend]** — после soak'а: удалить `apps/api/src/archive/` и `ArchiveModule` из `app.module.ts`; удалить архивные модели из `packages/db/prisma/schema.prisma`, миграция `drop_archive_tables`.
- **KS-N09 [backend]** — dual-prefix middleware в `apps/api/src/main.ts` (принимает `/api/*` и `/*`). Снять `setGlobalPrefix('api')`.
- **KS-N10 [frontend]** — массовая замена `${API_URL}/api/*` → `${API_URL}/*` во всех оставшихся местах (кроме архивных, выполненных в KS-N07).
- **KS-N11 [backend]** — после soak'а фазы 4: удалить dual-prefix middleware.
- **KS-N12 [devops]** — финальная зачистка: `DROP TABLE archive_*, position_stats` в старой БД через 14+ дней после KS-N08.
- **KS-N13 [qa]** — smoke-план для каждой фазы: dev → stage → prod; контракт по 4 архивным endpoint'ам + полный regression основного API после фазы 4.
