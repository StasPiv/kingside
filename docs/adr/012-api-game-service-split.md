# ADR-012: Разделение backend на apps/api и apps/game-service

**Статус:** Принято (фиксация фактического положения)
**Дата:** 2026-04-16
**Задача:** KS-1549

## Контекст

В монорепо одновременно работают два NestJS-сервиса с большим объёмом идентичного кода: `apps/api` и `apps/game-service`. Документ `docs/architecture/system-overview.md` описывает backend как «модульный монолит», что более не соответствует реальности.

Фактическая продовая топология:

| Сервис              | Порт | Прод-домен            | Роль                                                         |
| ------------------- | ---- | --------------------- | ------------------------------------------------------------ |
| `apps/api`          | 3001 | `kingside.site`       | REST + WS namespaces `/broadcast`, `/messages`               |
| `apps/game-service` | 3002 | `game.kingside.site`  | WS namespaces `/game`, `/matchmaking`, `/tournament`         |

Фронтенд (`apps/web/src/socket.ts`) разводит соединения:

- `socket` (`/game`), `matchmakingSocket`, `tournamentSocket` → `VITE_GAME_URL` (game-service).
- `broadcastSocket`, `messagesSocket` → `VITE_API_URL` (api).
- Весь REST идёт на `VITE_API_URL`.

Деплой (`scripts/deploy-aws.sh`) оформляет их как независимые ECR-образы / ECS-сервисы (`kingside-api`, `kingside-game-service`). В `docker-compose.yml` game-service отсутствует — локально продовая топология не воспроизводится, namespaces обслуживает apps/api.

Prisma миграции существуют только в `apps/api/prisma/migrations/`. `apps/game-service/prisma/schema.prisma` расходится с api (отсутствуют поля и модели, добавленные недавно; при этом содержит модель `GeneratedPuzzle`, которой нет у api) и не участвует в миграциях.

## Решение

1. **Разделение фиксируется**: остаются два сервиса с разной ответственностью — `apps/api` (stateless REST + вспомогательные WS namespaces) и `apps/game-service` (realtime: игры, подбор, турниры, чат в игре).
2. **Источник правды по Prisma — `apps/api`.** Цель — единая схема в `packages/db`, из которой оба сервиса генерируют клиент. До миграции — `apps/game-service/prisma/schema.prisma` считается зависимой копией и ведётся синхронно с api.
3. **REST-контроллеры живут только в api.** В game-service удалить REST-контроллеры, которые не маршрутизируются фронтом (`game/game.controller.ts`, `arena/arena.controller.ts`) и осиротевшие сервисы после них.
4. **Общий код выносится в packages/** поэтапно (план ниже). Запрещено дублировать изменения в обоих сервисах вручную — это породило рассинхронизации (`game.service.ts`, `arena/*`, `RedisIoAdapter`, `OverloadGuardService`, `ScalingService`).
5. **Версии рантайма выравниваются.** NestJS сейчас 11 в api и 10 в game-service. До выноса кода в shared-пакеты обе версии приводятся к одному major.
6. **Локальная среда воспроизводит прод.** `docker-compose.yml` и `.env.example` обновляются так, чтобы при `npm run dev` поднимались оба сервиса и фронт использовал `VITE_GAME_URL`.

## План выноса общего кода (фазы)

- **Фаза 0 — гигиена:** синхронизировать Prisma schema, удалить мёртвые REST-контроллеры game-service, пустые каркасы api (`src/chat/`, `src/matchmaking/dto/`).
- **Фаза 1 — `packages/nest-common`:** `prisma`, `redis`, `common/*` (фильтры, DTO, guard'ы, rate-limit), `auth/jwt-auth.guard`, `auth/jwt.strategy`, `auth/ws-jwt.guard`, `redis-io.adapter`, `overload-guard`, `scaling.service` (расхождения предварительно свести).
- **Фаза 2 — `packages/game-core`:** `game-clock`, `rating`, `rating-protection`, `eco`, `bot-game`, `bot-move`, `polyglot-reader` + `polyglot-keys.json`.
- **Фаза 3 — `game.service.ts`:** разделить на `GameReadService` (read-часть → shared) и `GameWriteService` (write-часть остаётся в game-service). Предварительно подтянуть api-копию до актуала game-service (поле `botClientSide`, tournament cleanup перед `game:end`, push в `puzzle-gen:queue`, параметр `wasmSupported`).
- **Фаза 4 — arena:** свести расхождения arena.service, read-хелперы в `packages/game-core`, REST в api, Gateway/round-manager/swiss-pairing/scheduler в game-service.
- **Фаза 5 — `user.service`/`block.service`:** read-часть в shared пакет, write-методы остаются в api.
- **Фаза 6 — devops:** game-service в `docker-compose.yml`, `VITE_GAME_URL` в `.env.example`, обновить `docs/architecture/system-overview.md`.

Детальный разбор дубликатов и мёртвого кода — в `docs/architecture/KS-1549-api-game-service-duplication.md`.

## Альтернативы, которые не выбраны

- **Свести всё обратно в монолит apps/api.** Отклонено: game-service уже имеет собственную точку масштабирования и отдельный прод-домен; сведение повышает нагрузку на один процесс и потребует переделки деплоя.
- **Разнести полностью без общих пакетов, с дублированием через codegen.** Отклонено: усложняет поддержку, не решает рассинхронизацию при правках «на горячую».
- **Жить с текущим дублированием.** Отклонено: уже есть тихая расхождение в `game.service.ts`, `arena/*` и `prisma/schema.prisma` — риск багов в игровом тракте и БД-слое.

## Последствия

- Backend: серия задач рефакторинга по фазам (0–6). Каждая — отдельная задача трекера.
- DevOps: обновление docker-compose и окружения; проверка порядка ECS-выкаток (миграции выполняет api, game-service должен стартовать после).
- Frontend: изменений не требуется, топология уже согласована с фактическим разделением.
- Документация: ADR-012 и `KS-1549-api-game-service-duplication.md` становятся источником правды до момента выпуска нового `system-overview.md` в фазе 6.

## Риски

- Общий `@prisma/client` в монорепо исторически капризен — решение с `packages/db` требует практической проверки перед применением.
- Несовпадение Nest 10/11 блокирует фазу 1 — выравнивание обязательно.
- Любой перенос без e2e-покрытия (`apps/e2e`) рискует тихо сломать игровой тракт; перед фазами 3–5 убедиться, что e2e зелёные.
