# ADR-131 — Перенос HTTP-эндпоинтов archive-service в apps/api

- Статус: **Proposed** (2026-06-16)
- Задача: KS-4246
- Связанные ADR / задачи:
  - ADR-130 — основа решения (сценарий А, частичное объединение).
  - ADR-018 — изначальное выделение `apps/archive-service` (поддомен
    `archive.kingside.site`, отдельный сервис). После реализации этого
    ADR — частично Superseded (HTTP-часть переезжает, importer/CLI
    остаются).
  - ADR-013 §10.C.4 — repository pattern в archive (Postgres → opt-in
    ClickHouse). Сохраняется без изменений.
  - ADR-020 — `importer-once` на EventBridge Scheduler + ECS RunTask.
    Сохраняется без изменений.
  - ADR-033 — структура архивной модели (tree/games/players/events).
- Авторы: architect (анализ и декомпозиция).

---

## 1. Контекст

По решению пользователя из ADR-130 (сценарий А) запускается перенос
HTTP-эндпоинтов `apps/archive-service` в `apps/api`. Ограничения:

- БД `archive_kingside` **остаётся отдельной** (физически — на
  `kingside-archive-db` instance, не консолидируется на `kingside-db`).
  Это решение пользователя, ADR-130 §6 шаг 5 (RDS-консолидация) не
  выполняется в рамках этого ADR. Экономия от RDS — отдельный вопрос.
- Importer (`start:importer-once` через EventBridge) и CLI остаются в
  `apps/archive-service` без изменений.
- Экономия: **~$18/мес ECS** + ~$3.65/мес Public IPv4 = **~$22/мес**
  (часть экономии сценария А из ADR-130).

Координатор просит ADR с **корректной декомпозицией по scope**:
каждая задача — в зоне одного агента (backend / frontend / devops),
никакого смешения. Прошлые попытки координатора (KS-4242, KS-4245)
смешивали scope в одной задаче и были отменены.

---

## 2. Текущее состояние

### 2.1. HTTP-эндпоинты archive-service

`apps/archive-service/src/main.ts` — БЕЗ `setGlobalPrefix`. Все
публичные пути на корне:

| Метод | Путь | Контроллер | Назначение |
|-------|------|------------|------------|
| GET | `/tree` | `ArchiveController.getTree` | Database tree для `/analyze` (ADR-014) |
| GET | `/games` | `ArchiveController.getGames` | Список партий с фильтрами (keyset) |
| GET | `/games/:id` | `ArchiveController.getGame` | Полная партия (PGN + metadata) |
| GET | `/games/by-position` | `ArchiveController.getGamesByPosition` | Партии достигшие позиции (ADR-014 §4.1) |
| GET | `/players/search` | `ArchiveController.searchPlayers` | Автокомплит игроков (pg_trgm) |
| GET | `/players/:slug` | `ArchiveController.getPlayerProfile` | Профиль игрока (MV `archive_player_stats`) |
| GET | `/players/:slug/games` | `ArchiveController.getPlayerGames` | Партии игрока |
| GET | `/events/search` | `ArchiveController.searchEvents` | Поиск турниров |
| GET | `/_/health` | служебный | Health probe для ALB target group |
| GET | `/_/metrics` | служебный | Prometheus metrics |

Все 8 публичных — `GET`, без auth, заголовок `Cache-Control: revalidate`.
CORS — только GET/HEAD, `credentials: false`, origin'ы из
`CORS_ORIGIN`.

### 2.2. Кто их вызывает

1. **`apps/web`** — через `apps/web/src/api/archive.ts` (функция
   `archiveGet(path)` → `fetch(${ARCHIVE_URL}${path})`).
   - Prod URL: `https://archive.kingside.site` (env
     `VITE_ARCHIVE_URL`, инжектируется в build через
     `scripts/deploy-aws.sh`).
   - Dev: `/__archive` (vite-proxy на `https://archive.kingside.site`,
     `changeOrigin: true` — обходит CORS).
   - Все пути из таблицы выше зовутся фронтом (`/tree`, `/games`,
     `/players/*`, `/events/search`).

2. **`apps/api`** — два HTTP-вызова (через `ARCHIVE_SERVICE_URL`,
   дефолт `https://archive.kingside.site`):
   - `apps/api/src/opening-trainer/archive-position-proxy.service.ts`
     → `GET /games/by-position` (KS-3469, ADR-090 §4.2 B2).
   - `apps/api/src/analysis/analysis.service.ts:297` → `GET /games/:id`
     (полный raw PGN для review-комментариев).

3. **Других потребителей нет.** Поиском по `archive.kingside.site` /
   `ARCHIVE_SERVICE_URL` обнаружены только web и api. Никакой
   cron / SQS / другой backend в archive-service не ходит.

### 2.3. Зависимости пакетов

| Сервис | Использует `@kingside/archive-db` |
|--------|-----------------------------------|
| `apps/archive-service` | ✅ `PrismaService` (`src/prisma/prisma.service.ts`) |
| `apps/api` | ❌ (только упоминание в комментарии `tactic-drill-incremental.scheduler.ts`) |

После переноса `apps/api/package.json` получит зависимость
`@kingside/archive-db`. Это второй Prisma-клиент в одном процессе
рядом с основным `@kingside/db`. Технически — отдельный
`PrismaClient` instance под отдельным `DATABASE_URL`. Connection
pool отдельный.

### 2.4. CloudFront / DNS для `archive.kingside.site`

Точный layout уточняет devops (отдельная distribution или behavior на
основной?). Из кода frontend видно:
- Prod URL — `https://archive.kingside.site` (CDN-фасад).
- Origin сейчас — ECS service `kingside-archive-service` через ALB.
- Cache-Control на запросах — `revalidate` (контент кэшируется CDN, но
  с проверкой ETag).

### 2.5. 🔴 Конфликт путей (критично для §3)

`apps/api` **уже имеет** контроллеры:
- `@Controller('games')` в `apps/api/src/game/game.controller.ts:27`
- `@Controller('players')` в `apps/api/src/player/player.controller.ts:35`

Перенос archive-эндпоинтов на корневые пути (`/games`, `/players`)
**невозможен** — NestJS RouterExplorer бросит ошибку duplicate route.
Из этого следует **обязательное использование префикса** для
архивных контроллеров в `apps/api`: `/archive/games`, `/archive/tree`,
`/archive/players/*`, `/archive/events/search`.

Это меняет вопрос URL'ов для клиента — см. §3.

---

## 3. Целевое состояние

### 3.1. Backend (apps/api)

- Новый модуль `apps/api/src/archive/archive.module.ts` с контроллером
  `@Controller('archive')` и роутами: `tree`, `games`, `games/:id`,
  `games/by-position`, `players/search`, `players/:slug`,
  `players/:slug/games`, `events/search`.
- Сервис `ArchiveService` — копия логики из
  `apps/archive-service/src/archive/archive.service.ts`.
- Repository pattern (`ARCHIVE_STATS_REPOSITORY` →
  `PostgresArchiveStatsRepository`) переносится без изменений
  (ADR-013 §10.C.4).
- Второй PrismaClient: `apps/api/src/archive/archive-prisma.service.ts`
  использует `@kingside/archive-db`, `DATABASE_URL` берёт из новой env
  `ARCHIVE_DATABASE_URL` (отдельная от основной).
- `package.json apps/api` получает зависимость `@kingside/archive-db`.
- HTTP-вызовы `apps/api` → archive-service заменяются in-process на
  прямой вызов `ArchiveService`. Затрагиваются:
  - `analysis.service.ts:297` (`getArchiveGameById` → DI'нем
    `ArchiveService.getGameById`).
  - `opening-trainer/archive-position-proxy.service.ts` → вместо
    HTTP-proxy дёргает `ArchiveService.getGamesByPosition` напрямую.
    Сервис-обёртка остаётся (контракт DTO не меняется), меняется
    только реализация.
  - Env `ARCHIVE_SERVICE_URL` в `apps/api` становится не нужным после
    окончательного переноса.

### 3.2. Маршрутизация — два варианта

**Вариант 1 (рекомендуемый): сохранение поддомена `archive.kingside.site`**

- Frontend **не меняется** — продолжает звать
  `https://archive.kingside.site/games`, `/tree`, etc.
- CloudFront: distribution `archive.kingside.site` оставляет тот же
  поддомен, **меняет origin** с `kingside-archive-service` ALB на
  `kingside-api` ALB. Добавляется **path-rewrite** на CDN или на ALB
  rule: `/{path}` → `/archive/{path}`.
  - Способ 1: CloudFront Function (viewer-request) — `request.uri =
    '/archive' + request.uri`. Просто, быстро.
  - Способ 2: ALB listener rule — host `archive.kingside.site` →
    rewrite path с префиксом `/archive` → forward в api target group.
    Чище, без custom Function.
- Backend контроллеры под `@Controller('archive')` — это
  технически нужно из-за конфликта путей (§2.5), но **снаружи
  пользователь не видит префикса** благодаря rewrite на CDN/ALB.

Плюсы:
- 🟢 Frontend не трогаем — никаких правок в `apps/web` (нет задачи на frontend).
- 🟢 SEO сохраняется (поддомен индексирован, ничего не теряем).
- 🟢 Кэширование CloudFront по существующим path-pattern'ам — не
  ломается (origin меняется, behavior'ы остаются).
- 🟡 Один лишний path-rewrite на CDN — копеечная нагрузка, не
  заметно.

Минусы:
- 🟡 Дополнительная конфигурация на CloudFront/ALB (rewrite).
- 🟡 Контракт URL'ов между фронтом и api становится «непрямым»
  (фронт зовёт `/games`, в api это `/archive/games`) — для
  разработчиков чуть сложнее искать корень при отладке.

**Вариант 2 (альтернатива): фронт переходит на `api.kingside.site/archive/*`**

- Frontend меняется: `ARCHIVE_URL` → `https://api.kingside.site` (или
  тот же общий `VITE_API_URL`), все пути снабжаются префиксом
  `/archive`.
- CloudFront `archive.kingside.site` либо удаляется, либо настраивается
  как 301-redirect на `api.kingside.site/archive/*` (на ≥6 месяцев для
  индексации поисковиков).
- Backend контроллеры под `@Controller('archive')` — без CDN-rewrite.

Плюсы:
- 🟢 «Прямой» контракт URL'ов: код фронта явно показывает префикс
  `/archive`.
- 🟢 Меньше CDN-конфигурации.

Минусы:
- 🔴 Появляется отдельная **задача на frontend** (правка `archiveUrl.ts`,
  `vite.config.ts`, env'ов, тестов).
- 🔴 SEO-переезд поддомена — нужны 301-редиректы минимум 6 месяцев.
- 🔴 Все ссылки в OG-meta, sitemap, внешние линки на
  `archive.kingside.site/*` устаревают.

**Рекомендация:** **Вариант 1.** Меньше задач, меньше рисков, фронт и
SEO не трогаем. Координатор создаёт под вариант 1 → задач 4 (backend +
2× devops + опциональная backend-уборка), без frontend-задачи.

Если пользователь явно скажет «нужен прямой URL» — переключаемся на
вариант 2 (+1 frontend-задача).

### 3.3. Целевая инфраструктура

- ECS service `kingside-archive-service` — **остановлен**
  (`desiredCount=0`), но task-definition сохраняется ещё месяц для
  отката.
- ECS task-definition `kingside-archive-importer-once` (EventBridge
  RunTask) — **остаётся без изменений**.
- ECS service `kingside-api` — `desiredCount=1` (тот же), cpu/memory —
  на текущем уровне (0.5 vCPU + 1 GB). Поскольку archive-нагрузка
  избыточна (avg CPU 1.9% / peak 34.7% по ADR-130), увеличивать api НЕ
  требуется. Мониторинг 2 недели, при необходимости — bump.
- CloudFront `archive.kingside.site` — origin переключён на api-ALB,
  path-rewrite добавлен.
- Public IPv4 archive-сервиса — высвобождается ($3.65/мес).
- RDS `kingside-archive-db` — **остаётся** (importer всё ещё на ней).

---

## 4. Декомпозиция задач (по scope, без смешения)

Каждая задача — внутри scope одного агента. Координатор создаёт задачи
по этому списку. Порядок строгий — каждая следующая блокируется
успехом предыдущей.

### Задача A1 — Backend: перенос HTTP-эндпоинтов в apps/api

**Scope:** только `apps/api/*` + `apps/api/package.json` +
интеграционные тесты. НЕ трогает CloudFront, NE трогает `apps/web`,
NE трогает ECS service archive-service.

**Что сделать:**
1. Добавить в `apps/api/package.json` зависимость
   `"@kingside/archive-db": "*"`.
2. Создать `apps/api/src/archive/`:
   - `archive-prisma.service.ts` — `PrismaClient` из
     `@kingside/archive-db`, env `ARCHIVE_DATABASE_URL`.
   - `archive.service.ts` — копия из archive-service (импорты
     поменять на local-paths).
   - `archive-stats.repository.ts` — копия (паттерн ADR-013).
   - `archive-metrics.service.ts` — копия.
   - `archive.controller.ts` — `@Controller('archive')`, маршруты:
     `tree`, `games`, `games/by-position` (до `games/:id`!),
     `games/:id`, `games`, `players/search`,
     `players/:slug/games` (до `players/:slug`!), `players/:slug`,
     `events/search`. Порядок объявлений критичен — Nest сматчит
     `:id`/`:slug` как литерал, если literal-маршруты не объявлены
     первыми.
   - `archive.module.ts` — провайдеры, импорт в `AppModule`.
3. DTO импортировать из `@kingside/shared` (там же, где они сейчас).
4. Заменить HTTP-вызовы на in-process:
   - `apps/api/src/analysis/analysis.service.ts:297` —
     `getArchiveGameById`: вместо `fetch ARCHIVE_SERVICE_URL/games/:id`
     инжектировать `ArchiveService` и звать `getGameById(id)`.
     Сохранить env-флаг `ARCHIVE_USE_LOCAL` (дефолт `true`) на 1
     неделю — `false` возвращает старое HTTP-поведение для отката.
   - `apps/api/src/opening-trainer/archive-position-proxy.service.ts`
     — аналогично. Имя сервиса сохранить (внешний контракт DTO не
     меняется), внутри переключить на in-process.
5. Env-переменная `ARCHIVE_DATABASE_URL` — пробросить через
   `ConfigService`, добавить в `.env.example` (значение совпадает с
   `apps/archive-service` `DATABASE_URL`).
6. Юнит-тесты для всех 8 endpoint'ов (копировать из
   `apps/archive-service/src/archive/*.spec.ts`).
7. Smoke-тест после деплоя: каждый из 8 endpoint'ов под
   `https://api.kingside.site/archive/...` отвечает 200 с правильным
   payload'ом.

**DoD:**
- `npm test @kingside/api` — зелёный.
- `tsc --build apps/api` — чисто.
- После deploy через `deploy({scope:"api"})`:
  - `curl -s https://api.kingside.site/archive/games?limit=1` → 200.
  - `curl -s https://api.kingside.site/archive/tree?...` → 200.
  - `curl -s https://api.kingside.site/archive/players/search?q=...`
    → 200.
- Старый `archive.kingside.site` ПРОДОЛЖАЕТ работать (фронт не
  заметил).
- analysis.service / opening-trainer работают через in-process путь
  (по логам `ARCHIVE_USE_LOCAL=true`).

**Не входит:**
- CloudFront / DNS изменения — задача A2 (devops).
- Изменения в `apps/web` — НЕ требуются (вариант 1).
- Остановка archive-service — задача A3 (devops).

**Блокирует:** A2.

---

### Задача A2 — DevOps: переключение CloudFront `archive.kingside.site` на api-origin

**Scope:** только CloudFront + ALB. НЕ трогает код, НЕ трогает ECS
service (он пока работает).

**Что сделать:**
1. Дождаться завершения A1 (smoke-тест `api.kingside.site/archive/*`
   проходит).
2. CloudFront distribution `archive.kingside.site`:
   - Сохранить snapshot текущей конфигурации (`describe-distribution`
     → файл) — для отката.
   - Переключить origin: с ALB `kingside-archive-service` на ALB
     `kingside-api`.
   - Добавить path-rewrite: один из двух способов:
     - (a) CloudFront Function (viewer-request) — `request.uri =
       '/archive' + request.uri`. Применить к default behavior `/*`.
     - (b) ALB listener rule на api-ALB: host
       `archive.kingside.site` → action: redirect/forward с
       rewrite path-prefix `/archive`.
   - Рекомендуется (b) — чище, без новой CloudFront Function.
3. Cache invalidation: `/*` на distribution `archive.kingside.site`.
4. `aws cloudfront wait distribution-deployed` — exit 0.
5. Smoke-тест:
   - `curl -s https://archive.kingside.site/games?limit=1` → 200,
     content тот же что раньше.
   - `curl -s https://archive.kingside.site/tree?...` → 200.
   - Все 8 endpoint'ов из §2.1.
   - Сравнить с `api.kingside.site/archive/games?limit=1` —
     payload-байт-в-байт.
6. Мониторинг 1 час: CloudWatch alarms на 5xx error rate, latency
   p95 — без аномалий.

**DoD:**
- `archive.kingside.site/*` отвечает с api-origin.
- Все 8 endpoint'ов работают через старый поддомен.
- `kingside-archive-service` ECS — **продолжает работать** (не
  трогаем в этой задаче), но трафик на него не идёт.
- Snapshot конфигурации сохранён для отката.

**Не входит:**
- Остановка ECS service — задача A3.
- Изменения кода — A1 уже сделана.
- Изменения frontend — НЕ требуются.

**Блокирует:** A3.

**Откат:** вернуть origin distribution на ALB
`kingside-archive-service`, убрать path-rewrite, invalidation.
Snapshot из шага 2 даёт точную конфигурацию.

---

### Задача A3 — DevOps: остановка ECS service `kingside-archive-service`

**Scope:** только ECS service `kingside-archive-service`. НЕ трогает
task-definition `kingside-archive-importer-once`. НЕ трогает код.

**Что сделать:**
1. Дождаться 7 дней после A2 со стабильным трафиком на api-origin
   (CloudWatch metrics: latency, error rate без регрессии vs
   pre-A2 baseline).
2. `aws ecs update-service --cluster kingside --service
   kingside-archive-service --desired-count 0`. Task'и завершаются.
3. Освободить Public IPv4 (auto-release при stop'е task'а, проверить
   через `aws ec2 describe-addresses`).
4. ECS service сам сохраняется в Inactive состоянии — НЕ удалять,
   нужен для возможного отката следующие 30 дней.
5. Через 30 дней (отдельный тикет-напоминание): `aws ecs
   delete-service --cluster kingside --service
   kingside-archive-service`. До этого момента — оставить.
6. Проверить через 1 день после остановки: AWS Cost Explorer ECS
   tagged `Service=kingside-archive-service` падает к $0.

**DoD:**
- `aws ecs describe-services` → `desiredCount=0, runningCount=0`.
- `aws ec2 describe-addresses` — освобождён 1 Public IPv4 ($3.65/мес).
- task-definition `kingside-archive-importer-once` —
  **не тронут**, EventBridge schedule продолжает запускать
  one-shot tick'и (ADR-020).
- Через 24 ч — Cost Explorer показывает падение ECS на ~$18/мес
  (per-service breakdown через тег `Service`, см. KS-4237).

**Не входит:**
- Удаление service / task-definition — отдельный тикет через 30
  дней.
- Очистка кода `apps/archive-service/src/archive/*` — задача A4
  (опциональная).

**Блокирует:** A4 (опциональная) и финализацию ADR.

**Откат:** `aws ecs update-service --desired-count 1`. CloudFront
вернуть origin на archive-service ALB (см. откат A2). 5-10 минут до
полного восстановления.

---

### Задача A4 — Backend (опциональная, не блокирует): очистка кода в apps/archive-service

**Scope:** только `apps/archive-service/src/archive/*` (HTTP-часть).
НЕ трогает `archive-import/*`, `importer-once.ts`, `cli/*`. НЕ
трогает `apps/api`.

**Что сделать:**
1. Дождаться завершения A3 + 7 дней (отсутствие необходимости
   отката).
2. Удалить из `apps/archive-service/src/`:
   - `archive/archive.controller.ts`
   - `archive/archive.service.ts`
   - `archive/archive-stats.repository.ts`
   - `archive/archive-metrics.service.ts`
   - `archive/archive.module.ts`
   - связанные `*.spec.ts` если они только тестировали HTTP-часть.
   - `health/`, `metrics/` контроллеры — оставить, нужны для
     importer-once liveness/metrics.
3. `apps/archive-service/src/main.ts` — превратить в **importer-only
   bootstrap**: убрать `controllers`, оставить только корневой
   `INestApplicationContext` без HTTP-сервера (как в
   `importer-once.ts`). Или удалить `main.ts` целиком, если
   importer-once покрывает все use-case'ы.
4. `apps/archive-service/package.json` — пересмотреть зависимости,
   убрать всё что нужно было только для HTTP (nestjs/platform-express
   если не используется importer'ом).
5. Обновить `apps/archive-service/README.md`: «теперь только
   importer + CLI».

**DoD:**
- `npm test @kingside/archive-service` — зелёный.
- `tsc --build apps/archive-service` — чисто.
- importer-once запускается через EventBridge без регрессий
  (мониторить 1 неделю по логам).

**Не входит:**
- Удаление ECS service / task-definition `kingside-archive-service` —
  через 30 дней после A3.
- Удаление RDS `kingside-archive-db` — НЕ делать, importer пишет
  туда.

**Блокирует:** ничего (опциональная).

---

### Задача A5 — Architect: финализация ADR

**Scope:** только `docs/adr/*`.

**Что сделать:**
1. Дождаться A1-A3 (A4 опционально).
2. ADR-131: Proposed → Accepted, добавить факт-замеры экономии (из
   Cost Explorer через тег `Service`).
3. ADR-130: пометить сценарий А как частично реализованный (HTTP
   archive перенесено, RDS-консолидация отдельно по решению
   пользователя).
4. ADR-018: пометить как **частично Superseded** этим ADR (HTTP-часть
   archive-service переехала в apps/api; importer/CLI остаются).
5. Добавить кросс-ссылки.

**DoD:** ADR-131 в Accepted, экономия по факту зафиксирована.

---

## 5. Риски и план отката

### Риски

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| Прирост нагрузки на api → деградация REST/WS | низкая (archive avg 1.9% CPU per ADR-130) | мониторинг 2 недели после A2, при необходимости bump api на 1 vCPU |
| Connection pool exhaustion (двойной Prisma) | низкая (peak connections archive 14, default max 87) | отдельный Prisma instance с своим пулом, дефолт `connection_limit=10` |
| Path-rewrite CDN/ALB не сработал | средняя (новая конфигурация) | A2 включает smoke-тест каждого из 8 endpoint'ов перед закрытием |
| analysis.service / opening-trainer ломаются после переключения на in-process | средняя | env-флаг `ARCHIVE_USE_LOCAL=true/false` (см. A1 шаг 4), `false` — мгновенный откат |
| Importer (apps/archive-service `start:importer-once`) сломался из-за изменений в схеме `@kingside/archive-db` | низкая (схема не меняется) | A1 не трогает archive-db schema |

### План отката по этапам

- **Откат A1:** redeploy api с предыдущего git SHA.
  `ARCHIVE_USE_LOCAL=false` — мгновенный переключатель если
  in-process путь сломан, при этом контроллеры `/archive/*` на api
  остаются (если они работают), HTTP-вызовы api→archive-service
  возвращаются к старому поведению.
- **Откат A2:** CloudFront вернуть origin на archive-service ALB,
  убрать path-rewrite, invalidation. Snapshot из шага A2.2 даёт
  точную конфигурацию. 5-10 минут.
- **Откат A3:** `aws ecs update-service --desired-count 1`. Если
  откатили A2 — трафик автоматически идёт на archive-service.
  Иначе — сначала откатить A2, потом A3 (трафик возвращается).
- **Откат A4:** `git revert` коммит уборки. Если A4 ещё не делалась —
  ничего откатывать не нужно.

### Окно сохранения отката

- task-definition `kingside-archive-service` — оставить 30 дней после
  A3.
- snapshot CloudFront конфигурации — оставить 30 дней после A2.
- env-флаг `ARCHIVE_USE_LOCAL` — оставить 30 дней после A1, потом
  удалить отдельным тикетом.

---

## 6. Экономия

- ECS service `kingside-archive-service`: -$18/мес (0.5 vCPU + 1 GB).
- Public IPv4: -$3.65/мес.
- **Итог: ~$22/мес** (часть сценария А из ADR-130, который полностью
  даёт ~$70-75/мес с Container Insights и RDS-консолидацией).

Остаток сценария А — Container Insights ($25-30/мес) и
RDS-консолидация ($20/мес) — могут идти параллельно или после, **они
независимы от этого ADR**.

---

## 7. Открытые вопросы

- **Точный layout CloudFront для `archive.kingside.site`** — отдельная
  distribution или behavior на основной? Уточняет devops перед A2.
  Если behavior на основной distribution — задача A2 проще
  (только origin + одна path-pattern).
- **ALB rule vs CloudFront Function для path-rewrite** — devops
  решает в рамках A2 (см. §3.2 вариант 1, рекомендован ALB rule).
- **Удаление `archive_kingside` RDS instance** — НЕ в scope этого
  ADR. Если пользователь захочет — отдельный ADR (это §6 шаг 5
  ADR-130, отдельный путь).
