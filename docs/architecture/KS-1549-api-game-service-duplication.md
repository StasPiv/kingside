# KS-1549: Дублирование apps/api ↔ apps/game-service — отчёт и план рефакторинга

**Задача:** KS-1549
**Дата:** 2026-04-16
**Связанный ADR:** [ADR-012](../adr/012-api-game-service-split.md)

## 1. Фактическая топология

| Сервис              | Порт | Прод-домен            | Роль                                                         |
| ------------------- | ---- | --------------------- | ------------------------------------------------------------ |
| `apps/api`          | 3001 | `kingside.site`       | REST + WS namespaces `/broadcast`, `/messages`               |
| `apps/game-service` | 3002 | `game.kingside.site`  | WS namespaces `/game`, `/matchmaking`, `/tournament`         |

Распределение трафика (из `apps/web/src/socket.ts`):

- `socket` (`/game`), `matchmakingSocket`, `tournamentSocket` → `VITE_GAME_URL`.
- `broadcastSocket`, `messagesSocket` → `VITE_API_URL`.
- Весь REST — `VITE_API_URL`.

В game-service ходит **только WS-трафик** трёх namespaces; REST-контроллеры, объявленные в game-service, внешнему клиенту недоступны (см. раздел «Мёртвый код»).

`scripts/deploy-aws.sh` деплоит оба сервиса как независимые ECR/ECS (`kingside-api`, `kingside-game-service`). В `docker-compose.yml` game-service **не прописан** — локально без `VITE_GAME_URL` все namespaces обслуживает api, и продовая топология локально не воспроизводится.

## 2. Дубликаты файлов

### 2.1 Идентичные 1-в-1

- `src/prisma/*`
- `src/redis/redis.service.ts`
- `src/user/user.service.ts` (≈481 стр.)
- `src/user/block.service.ts`
- `src/auth/jwt-auth.guard.ts`
- `src/auth/jwt.strategy.ts`
- `src/common/all-exceptions.filter.ts`
- `src/common/authenticated-request.ts`
- `src/common/cache.service.ts`
- `src/common/pagination.dto.ts`
- `src/common/redis-rate-limit.guard.ts`
- `src/game/game-clock.service.ts`
- `src/game/rating.service.ts`
- `src/game/rating-protection.service.ts`
- `src/game/live-game.service.ts`
- `src/game/eco.service.ts`
- `src/game/bot-game.service.ts`
- `src/engine/polyglot-keys.json`
- `src/engine/polyglot-reader.ts`
- `src/i18n/*`

### 2.2 Дубликаты с расхождениями

| Файл                                          | Что разошлось                                                                                                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/redis/redis.module.ts`                   | В game-service добавлено `imports: [ConfigModule]`.                                                                                                                                                                                                   |
| `src/common/overload-guard.service.ts`        | Разошлись по порогам/логам.                                                                                                                                                                                                                           |
| `src/common/redis-io.adapter.ts`              | Разошлись по конфигурации адаптера.                                                                                                                                                                                                                   |
| `src/common/scaling.service.ts`               | Разошлись.                                                                                                                                                                                                                                            |
| `src/game/game.service.ts`                    | **game-service новее:** поле `botClientSide`, tournament cleanup перед `game:end`, push в `puzzle-gen:queue`, параметр `wasmSupported` в `createBotGame`. apps/api отстаёт.                                                                           |
| `src/game/game.controller.ts`                 | Разошлись.                                                                                                                                                                                                                                             |
| `src/game/game.module.ts`                     | Разошлись по набору провайдеров.                                                                                                                                                                                                                      |
| `src/game/game-report.service.ts`             | Разошлись.                                                                                                                                                                                                                                             |
| `src/game/bot-move.service.ts`                | Разошлись.                                                                                                                                                                                                                                             |
| `src/game/dto/game.dto.ts`                    | Разошлись по полям DTO.                                                                                                                                                                                                                               |
| `src/arena/arena.service.ts`                  | apps/api: visibility/invite-коды. game-service: `getParticipantIds`, зависимость от `matchmaker-worker`.                                                                                                                                              |
| `src/arena/arena.controller.ts`               | Расходится с api-версией.                                                                                                                                                                                                                             |
| `src/arena/arena.module.ts`                   | Разный набор провайдеров.                                                                                                                                                                                                                             |
| `src/arena/arena.gateway.ts`                  | Разошлись.                                                                                                                                                                                                                                             |
| `src/arena/arena-scheduler.ts`                | Разошлись.                                                                                                                                                                                                                                             |
| `src/arena/round-manager.ts`                  | Разошлись.                                                                                                                                                                                                                                             |
| `src/arena/swiss-pairing.ts`                  | Разошлись.                                                                                                                                                                                                                                             |
| `prisma/schema.prisma`                        | **Критичное расхождение**: см. раздел «Мёртвый код».                                                                                                                                                                                                  |

### 2.3 Только в apps/api

`admin`, `ai-chat`, `analysis`, `broadcast`, `client-logs`, `dgt`, `feedback`, `friend`, `message`, `notification`, `player`, `puzzle`, `puzzle-generator`, `puzzle-rush`, `tournament`, `workshop`, полноценный `auth` (OAuth / last-seen / telegram / optional-jwt), `engine/stockfish.service`, `engine/opening-book.service`, `user/user-time-control.*`, `user.controller.ts`, связанные DTO.

### 2.4 Только в apps/game-service

`game/game.gateway`, `game/bot-cleanup.service`, `game/timeout-checker.service`, `game/guards/ws-jwt.guard`, полные `matchmaking/*` (gateway + service + module + dto), `chat/*` (in-game чат из game gateway), `matchmaker-worker/*` (внутренний слушатель Redis pub/sub очереди подбора; ранее слушал события от выделенного `apps/matchmaker`, сейчас подбор выполняется внутри самого `game-service`), `instance-logger.ts`.

## 3. Мёртвый / подозрительный код

| Путь                                                 | Причина                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/game-service/src/game/game.controller.ts`      | `main.ts` в game-service **не ставит** `setGlobalPrefix('api')`. `@Controller('games')` даёт путь `/games/*`, а фронт шлёт REST только на `API_URL/api/games/*`. Клиентов на `game.kingside.site/games/*` в репозитории нет.                                                                                  |
| `apps/game-service/src/arena/arena.controller.ts`    | То же самое: `/arena/*` на game-сервисе, фронт шлёт на `/api/arena/*`.                                                                                                                                                                                                                                          |
| `apps/game-service/src/game/game-report.service.ts`  | Единственный внешний потребитель — мёртвый `GameController` (`GET /games/:id/report`). Требуется `grep -rn 'GameReportService'` перед удалением.                                                                                                                                                                 |
| `apps/game-service/src/game/live-game.service.ts`    | Используется только мёртвым `GameController` (`/games/live`, `/games/live/count`). Проверить отсутствие других импортов перед удалением.                                                                                                                                                                         |
| `apps/game-service/prisma/schema.prisma`             | **Устарел и расходится**: нет `ratingPuzzleDev`, `puzzleStreak`, generated-puzzle полей (`sourceType`, `createdBy`, `isPublic`, `acceptedMoves`, …), моделей `PuzzleRatingSnapshot`, `ChatConversation`, `Feedback`, `FeedbackComment`. Присутствует `GeneratedPuzzle`, которой нет в api. Миграции живут только в `apps/api/prisma/migrations/` — БД идёт за api, game-service видит неполную/искажённую картину. Риск рантайм-ошибок и тихой потери данных. |
| `apps/api/src/chat/`                                 | Пустая директория.                                                                                                                                                                                                                                                                                              |
| `apps/api/src/matchmaking/dto/`                      | `MatchmakingModule` в api не регистрируется, dto никто не импортирует. Перед удалением — `grep -rn 'matchmaking/dto'`.                                                                                                                                                                                           |
| `docs/architecture/system-overview.md`               | Описывает «модульный монолит» — не соответствует текущему разделению api / game-service.                                                                                                                                                                                                                        |

## 4. План устранения дублирования

План разбит на фазы; каждая — отдельная задача трекера.

### Фаза 0 — гигиена (низкий риск, срочно)

1. Синхронизировать Prisma schema: **рекомендация** — вынести в `packages/db` общий `schema.prisma` + generated client. Минимальный вариант — удалить `apps/game-service/prisma/schema.prisma` как самостоятельный файл и генерировать клиент в game-service из api-схемы.
2. Удалить мёртвые REST-контроллеры в game-service:
   - `src/game/game.controller.ts` и ссылки в `game.module.ts`.
   - `src/arena/arena.controller.ts` и ссылки в `arena.module.ts`.
   - После этого удалить осиротевшие `game-report.service.ts`, `live-game.service.ts` — с предварительной проверкой `grep` на импорт.
3. Удалить пустые каркасы в api: `src/chat/`, `src/matchmaking/dto/` (после `grep -rn 'matchmaking/dto'`).
4. Записать ADR-012 и этот отчёт в `docs/` (выполнено в рамках KS-1549).

### Фаза 1 — `packages/nest-common`

Кандидаты на вынос:

- `prisma/*`
- `redis/*`
- `common/cache.service`
- `common/all-exceptions.filter`
- `common/authenticated-request`
- `common/pagination.dto`
- `common/redis-rate-limit.guard`
- `auth/jwt-auth.guard`
- `auth/jwt.strategy`
- `auth/ws-jwt.guard`
- `common/redis-io.adapter`, `common/overload-guard.service`, `common/scaling.service` — предварительно свести расхождения в одну версию.

**Предусловие:** выровнять NestJS до одной мажорной версии (сейчас api — 11, game-service — 10).

### Фаза 2 — `packages/game-core`

Кандидаты на вынос:

- `game/game-clock.service`
- `game/rating.service`
- `game/rating-protection.service`
- `game/eco.service`
- `game/bot-game.service`
- `game/bot-move.service` (предварительно свести расхождения)
- `engine/polyglot-reader.ts` + `polyglot-keys.json`.

### Фаза 3 — `game.service.ts`

1. Подтянуть api-копию до актуала из game-service: поле `botClientSide`, tournament cleanup перед `game:end`, push в `puzzle-gen:queue`, параметр `wasmSupported` в `createBotGame`.
2. Разделить на две роли:
   - `GameReadService` — read: `getGameState`, `getMoves`, analysis-хуки → shared.
   - `GameWriteService` — `makeMove`, `endGame`, tournament cleanup, puzzle-gen push, bot lifecycle → остаётся в game-service.
3. Убрать зависимость apps/api от Write-части.

### Фаза 4 — arena

1. Свести `arena.service` api и game-service к одному виду (решить судьбу visibility/invite-кодов: сохранить только в api, где REST, если это единственный потребитель).
2. Вынести read-хелперы (standings/crosstable/participants) в `packages/game-core`.
3. REST остаётся в api. Gateway, `round-manager`, `swiss-pairing`, `arena-scheduler` — в game-service.
4. Перед рефакторингом убедиться, что e2e для arena зелёные.

### Фаза 5 — `user.service.ts` / `block.service.ts`

- Read-часть — в shared пакет.
- Write-методы (edit profile и т.п.) остаются в api.

### Фаза 6 — devops (параллельно)

- Добавить `game-service` в `docker-compose.yml`.
- Добавить `VITE_GAME_URL=ws://localhost:3002` в `.env.example`.
- Обновить `docs/architecture/system-overview.md` под текущую топологию.

## 5. Риски

- NestJS 10 (game-service) vs 11 (api) — до фазы 1 обязательно выровнять.
- Общий `@prisma/client` в монорепо исторически капризен; решение с `packages/db` требует практической проверки.
- `RedisIoAdapter` разошёлся — сверить фактическое поведение до объединения, иначе тихая потеря функциональности.
- Prisma миграции в деплое делает только api. После фазы 0 нужно гарантировать, что game-service стартует после миграций — проверить порядок ECS-выкаток.
- Все фазы 3–5 требуют рабочего e2e-покрытия (`apps/e2e`) — иначе риск тихо сломать игровой тракт.

## 6. Вне рамок KS-1549

Сам рефакторинг — отдельные задачи, которые координатор создаёт по разделу 4. KS-1549 ограничена инвентаризацией и планом.
