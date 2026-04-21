# ADR-017: Разнести HTTP-сервисы по субдоменам

**Статус:** Предложено
**Дата:** 2026-04-21
**Задача:** KS-1641
**Связанные ADR:** [ADR-012](./012-api-game-service-split.md)

## Контекст

Текущая боевая топология (факт, а не задумка):

| Приложение                 | Процесс       | Порт | Публичный хост        | Что отдаёт наружу                                 |
| -------------------------- | ------------- | ---- | --------------------- | ------------------------------------------------- |
| `apps/api`                 | NestJS        | 3001 | `kingside.site`       | REST (`/api/*`) + WS `/broadcast`, `/messages`    |
| `apps/game-service`        | NestJS        | 3002 | `game.kingside.site`  | WS `/game`, `/matchmaking`, `/tournament`, `/health` |
| `apps/web`                 | Vite SPA      | —    | `kingside.site`       | Статический фронтенд                              |
| `apps/broadcast-worker`    | Node worker   | —    | —                     | Фоновый импортёр трансляций Lichess (только Redis + Prisma) |
| `apps/archive-importer`    | Node worker   | —    | —                     | Фоновый импортёр партий (только Redis + Prisma)   |

Корневой домен `kingside.site` сейчас одновременно обслуживает и SPA, и REST `apps/api`, и его WS-неймспейсы. На субдомен вынесен только `game-service`. Роутинг между фронтом и API на корне выполняет ALB по префиксу пути (`/api/*` → API target group, остальное → статика).

**Про `apps/matchmaker`, `apps/broadcast-worker`, `apps/archive-importer`.** В постановке KS-1641 `matchmaker` указан как кандидат на субдомен — это неточность: отдельного сервиса `apps/matchmaker` в репо нет, matchmaking живёт внутри `apps/game-service` (namespace `/matchmaking` и `apps/game-service/src/matchmaker-worker`). `broadcast-worker` и `archive-importer` — headless-воркеры, HTTP/WS наружу не экспонируют, субдомен им не нужен.

Фронтенд уже разводит соединения:

- `VITE_API_URL` (по умолчанию — origin страницы) — REST и WS `/broadcast`, `/messages`.
- `VITE_GAME_URL` (`game.kingside.site` в проде) — WS `/game`, `/matchmaking`, `/tournament`.

REST-клиент (`apps/web/src/api.ts`, `apps/web/src/hooks/*`, `apps/web/src/pages/*`) читает `import.meta.env.VITE_API_URL ?? 'http://localhost:3001'` более чем в 10 местах. Fallback `window.location.origin` реализован в `apps/web/src/socket.ts` на случай отсутствия env.

JWT передаётся в `Authorization: Bearer`, `refreshToken` отдаётся в JSON-ответе логина; `res.cookie(...)` в `apps/api/src/auth` не используется (Grep подтверждает). Кросс-доменных cookie сейчас нет — это снимает отдельный блок проблем с `Domain=.kingside.site` и `SameSite=None`.

CORS:

- `apps/api/src/main.ts` читает `CORS_ORIGIN` (список через запятую).
- `apps/game-service/src/main.ts` выставляет `origin: '*'` + `credentials: true` — это ошибка (браузер не пустит `credentials: true` с `*`), но сейчас работает, потому что WS-клиент не шлёт cookie и `credentials: true` игнорируется без Set-Cookie. При включении cookie-based auth это будет ломать клиента.

Сертификат и DNS: `game.kingside.site` уже работает — значит сертификат ACM в регионе ALB покрывает этот хост. Конкретная форма (wildcard `*.kingside.site` или SAN-сертификат) — прерогатива `scripts/deploy-aws.sh`, который лежит вне моего RO-скоупа; дальше он упоминается как артефакт, без редактирования.

## Решение

1. Каждый публично доступный backend-сервис получает собственный третий уровень `*.kingside.site`. Корневой домен оставляем только под фронтенд.
2. Именование — по роли сервиса, не по протоколу. Протокол (REST/WS) меняется со временем, роль — нет.

### Таблица субдоменов

| Хост                   | Назначение                           | Сервис                    | Комментарий                                                    |
| ---------------------- | ------------------------------------ | ------------------------- | -------------------------------------------------------------- |
| `kingside.site`        | SPA (фронтенд)                       | `apps/web` (статика)      | Только статика, всё backend-API уходит. `www.kingside.site` — 301 на apex. |
| `api.kingside.site`    | REST + WS `/broadcast`, `/messages`  | `apps/api`                | Основной API-хост. Пути сохраняются, включая `/api/*` префикс. |
| `game.kingside.site`   | WS `/game`, `/matchmaking`, `/tournament`, `/health` | `apps/game-service` | Уже существует, не трогаем.                                    |

### Варианты, отклонённые на этом шаге

- **`ws.kingside.site` как отдельный хост для WS-неймспейсов `apps/api`.** Отклонено: оба неймспейса (`/broadcast`, `/messages`) обслуживаются тем же процессом, что и REST, разводить их по разным хостам без отдельного процесса — искусственное усложнение. Если в будущем WS выделится в отдельный процесс (как уже произошло с `game-service`) — тогда заведём отдельный хост.
- **`matchmaker.kingside.site`.** Отклонено: отдельного сервиса нет, namespace живёт в `game-service`.
- **Отдельные хосты `broadcast.kingside.site`, `archive.kingside.site` для воркеров.** Отклонено: это headless-процессы без HTTP/WS-серверов.
- **Сохранить всё на `kingside.site` и разводить по path-prefix.** Отклонено: мешает независимому масштабированию ALB target group'ов, не даёт корректно настроить CORS per-service, усложняет миграцию на отдельный CDN для статики.

## Воздействие на `apps/web`

### ENV-переменные (`apps/web/src/vite-env.d.ts`)

- `VITE_API_URL` — сменить значение боевого билда с `https://kingside.site` на `https://api.kingside.site`. Имя переменной не меняем.
- `VITE_GAME_URL` — без изменений (`https://game.kingside.site`).
- Остальные (`VITE_TELEGRAM_BOT_ID`, `VITE_TELEGRAM_BOT_USERNAME`, `VITE_APP_ORIGIN`, `VITE_GA4_ID`, `VITE_DEV_BYPASS_SECRET`, `VITE_TEST_MODE`, `VITE_AI_CHAT_ENABLED`) — не трогаем.

### Места потребления `VITE_API_URL` в коде

Точечной правки кода не требуется — все эти файлы уже читают env, достаточно прокинуть правильное значение через билд:

- `apps/web/src/api.ts`
- `apps/web/src/socket.ts`
- `apps/web/src/utils/clientLogger.ts`
- `apps/web/src/hooks/useArchiveTree.ts`
- `apps/web/src/hooks/useArchiveGamesByPosition.ts`
- `apps/web/src/hooks/useChatStream.ts`
- `apps/web/src/context/ChatContext.tsx`
- `apps/web/src/components/workshop/WorkshopAnalysisList.tsx`
- `apps/web/src/components/workshop/WorkshopPgnList.tsx`
- `apps/web/src/layouts/MainLayout.tsx`
- `apps/web/src/pages/WorkshopPage.tsx`
- `apps/web/src/pages/ArchiveGamesByPositionPage.tsx`
- `apps/web/src/pages/GamePage.tsx`

Fallback `window.location.origin` в `socket.ts` при `isProdOrigin` — сейчас безопасное поведение, после миграции начнёт собирать REST на `https://kingside.site`, где API больше не отвечает. Нужно явно выставлять `VITE_API_URL` в прод-билде (deploy-aws.sh уже это делает для `VITE_GAME_URL`, нужно добавить симметрично для `VITE_API_URL`). Это единственное место кода в `apps/web`, поведение которого мы меняем неявно.

### Server-side статика / SSR

SSR нет, проверять нечего. `robots.txt`, `sitemap.xml` — остаются на корне.

## Воздействие на backend

### CORS

- `apps/api`: `CORS_ORIGIN` должен содержать `https://kingside.site,https://www.kingside.site`. Ничего нового — SPA уже отдаётся с этих хостов.
- `apps/game-service`: заменить `origin: '*'` на список из env (`CORS_ORIGIN`, те же значения), оставить `credentials: true`. Это отдельная задача backend'у, в рамках подготовки к миграции.

### WebSocket handshake

- Socket.IO клиент в `apps/web/src/socket.ts` использует `transports: ['websocket']` (без polling), то есть handshake не требует CORS preflight, только правильный `Origin`. После смены на `api.kingside.site` handshake для `/broadcast` и `/messages` пойдёт на новый хост — нужно, чтобы ALB listener на `api.kingside.site` пропускал Upgrade/Connection заголовки (у существующего listener'а на `game.kingside.site` это уже настроено, копируем параметры).
- Sticky sessions на ALB target group — если сейчас включены на корневом listener'е для WS API, включить и на `api.kingside.site` (по анализу `game-service` target group'а — там уже включены).

### JWT и cookies

- Access/refresh токены передаются в JSON, cookies не используются (`Grep` по `res.cookie` в `apps/api/src` — пусто). Миграция на субдомен безопасна без доработок auth-слоя.
- Если когда-то переведём refresh на cookie — тогда потребуется `Domain=.kingside.site`, `SameSite=None`, `Secure=true`. Пока это вне скоупа.

### Префикс `/api`

`apps/api/src/main.ts` выставляет `app.setGlobalPrefix('api')`. После переезда на `api.kingside.site` префикс становится семантически избыточным (`https://api.kingside.site/api/auth/login`), но снятие префикса — breaking change для всех фронтовых путей. **Оставляем префикс как есть**, дальнейшее упрощение — отдельная задача после стабилизации.

## Деплой / DNS / TLS

Все изменения инфраструктуры — на стороне `scripts/deploy-aws.sh` и конфигурации AWS, исполняет devops. Здесь — требования без редактирования скрипта.

1. **DNS (Route53, `kingside.site` hosted zone).** Добавить A-record `api.kingside.site` → ALB alias (тот же ALB, что обслуживает корень и `game.kingside.site`). `www` остаётся 301 на apex.
2. **ACM сертификат.** Проверить, покрывает ли текущий ACM-сертификат ALB все три FQDN (`kingside.site`, `www.kingside.site`, `api.kingside.site`, `game.kingside.site`). Если текущий сертификат — SAN-лист без `api.kingside.site`, devops выпускает новый wildcard `*.kingside.site` + apex `kingside.site` и подменяет привязку на ALB. Wildcard предпочтительнее — закрывает любые будущие субдомены без повторного выпуска.
3. **ALB listener rules.**
   - На HTTPS:443 listener добавляется правило `Host == api.kingside.site` → forward в существующую target group `kingside-api`.
   - Правило `Host == kingside.site` → пока остаётся forward в ту же `kingside-api` (для обратной совместимости старых фронт-билдов, см. шаги миграции ниже). После завершения миграции меняется на forward в target group статики (S3+CloudFront или текущий SPA target).
4. **Target groups.** Новых не создаём; `api.kingside.site` использует ту же TG, что и корневой backend сейчас. Это ключевое свойство: до и после DNS-переключения трафик идёт в те же контейнеры → нет прогрева, нет рассинхронизации состояний.
5. **Переменные окружения билда.** В CI/CD фронта задать `VITE_API_URL=https://api.kingside.site`, `VITE_GAME_URL=https://game.kingside.site` при прод-билде; локально — без изменений.

## Порядок миграции (без простоя)

Инвариант на всех шагах: никогда нет момента, когда действующий фронт-билд не может дотянуться до API.

1. **Preparation (backend).**
   - В `apps/game-service/src/main.ts` заменить `origin: '*'` на чтение `CORS_ORIGIN` из env (как в `apps/api`). Выкатить. Убедиться, что прод CORS_ORIGIN включает `https://kingside.site` и `https://www.kingside.site`. Отдельная задача на backend.
2. **DNS + ALB.**
   - Devops: расширить ACM-сертификат до `*.kingside.site` (если ещё не wildcard).
   - Завести A-record `api.kingside.site` → ALB.
   - Добавить listener rule `Host == api.kingside.site` → TG `kingside-api`.
   - После этого `https://api.kingside.site/api/health` отвечает тем же, что `https://kingside.site/api/health`.
3. **CORS расширение.**
   - Добавить в `CORS_ORIGIN` оба сервиса: `https://kingside.site,https://www.kingside.site`. Значение не меняется на этом шаге (фронт пока ходит с корня), но фиксируем inventory. Перезапуск ECS services.
4. **Frontend rollout.**
   - В `scripts/deploy-aws.sh` добавить экспорт `VITE_API_URL=https://api.kingside.site` перед `vite build`.
   - Собрать и выкатить новый фронт. Старые клиенты (до hard-refresh) продолжают ходить на корень — это всё ещё работает благодаря шагу 2.
5. **Soak period (1–3 дня).**
   - Наблюдаем метрики target group: хиты на listener rule `api.kingside.site` должны расти, на корневой `/api/*` — падать до нуля (за вычетом старых PWA-клиентов).
   - Метрика для мониторинга: ALB CloudWatch per-rule `RequestCount`.
6. **Cutover корня.**
   - Когда хиты `/api/*` на корневом listener rule стабилизировались около нуля, меняем его на forward в target group статики (SPA-only). Корень перестаёт быть API.
   - Правило порядка правил: сначала более специфичные (`Host == api.kingside.site`, `Host == game.kingside.site`), потом корень.
7. **Cleanup.**
   - Убрать устаревшие правила `PathPrefix /api` с корневого listener'а.
   - Проверить, что `CORS_ORIGIN` не содержит забытых legacy-хостов (например, прошлых preview-доменов).
   - Задокументировать новое состояние в `docs/architecture/system-overview.md`.

## Откат

Каждый шаг обратим независимо.

- Шаги 1–3 (backend CORS, DNS, listener rule): откат — удалить listener rule `api.kingside.site` и (опционально) A-record. Фронт продолжает работать через корень.
- Шаг 4 (фронт на новый VITE_API_URL): откат — пересобрать фронт со старым `VITE_API_URL=https://kingside.site`, задеплоить. Время отката ≈ время билда фронта.
- Шаг 6 (cutover корня на статику): откат — вернуть listener rule корня в forward на `kingside-api`. Одна кнопка в ALB.
- Главный принцип: шаг 6 делаем **только после** того, как соакинг подтвердил нулевой трафик API на корень. Если в соакинге трафик не падает — не идём дальше, разбираемся с залипшими клиентами.

## Риски и подводные камни

Формулирую как чек-лист, на что смотреть перед каждым шагом.

- **Застрявшие PWA/Service Worker клиенты.** Если в SPA где-то регистрировался SW с `fetch` на корень — он продолжит бить по корню даже после выкатки нового фронта. Нужно проверить `apps/web/public/sw.js` / манифест. *Проверить практически* — я факт регистрации SW не верифицировал.
- **Baked-in `VITE_API_URL` в старых бандлах.** Старый `index-*.js` в CDN может ссылаться на корень. Смягчается: корневой listener rule на `/api/*` не отключаем до soak-period'а.
- **CORS preflight и `credentials: true` с `*`.** Текущий `origin: '*'` в game-service — мина, которая взорвётся при любом `fetch(..., {credentials: 'include'})` на этот хост. Переключение на список origin'ов обязательно сделать до того, как что-либо начнёт слать cookies.
- **Socket.IO sticky sessions.** Если на корневом ALB listener rule sticky не включены (а на game.kingside.site включены) — включить и на `api.kingside.site`, иначе `/broadcast`/`/messages` начнут ронять соединения в multi-instance режиме (`ECS_TASK_COUNT > 1`). *Конфигурацию ALB я не видел*, это требование к devops проверить практически.
- **TLS SNI и HTTP/2.** ALB умеет оба; при добавлении SAN в сертификат или замене на wildcard возможен кратковременный сброс TLS-сессий — считаем допустимым, HTTP клиенты переустановят.
- **DNS TTL.** Если A-record'ы на `api.kingside.site` создаём с большим TTL, откат потребует времени. Рекомендация: TTL 60 секунд на время миграции, поднять до 300+ после стабилизации.
- **Аналитика и Referrer.** GA4 (`VITE_GA4_ID`) может регистрировать API-хиты как переходы на `api.kingside.site`, если где-то остался `window.location.href` сбор. Проверить `apps/web/src/utils/analytics.ts` перед выкаткой — факт я не верифицировал.
- **Telegram OAuth redirect URI.** `apps/web/src/utils/telegramOAuth.ts` использует `VITE_APP_ORIGIN`, а не `VITE_API_URL`. Проверить, что боту зарегистрирован правильный origin (корень, не api-хост). *Нужна практическая проверка.*
- **WebSocket handshake через Cloudflare/CDN (если используется).** Если фронт за CloudFront/Cloudflare, а API — нет, убедиться, что на `api.kingside.site` стоит прямой ALB без CDN или что CDN настроен под WS. По видимым файлам фронта CDN не вижу, но сам deploy-aws.sh вне моего скоупа — *проверить devops'у*.
- **Локальное окружение.** В dev оба сервиса на `localhost:3001/3002`, субдомены не нужны. `.env.example` не трогаем. Но тесты `apps/e2e` могут иметь хардкод `kingside.site` — до миграции сгрепать.

## Что вне этого ADR

- Префикс `/api` у REST (оставляем).
- Перенос `apps/web` на CloudFront/S3 (может быть следующим шагом, но не требуется для этой миграции).
- Выделение WS-неймспейсов `apps/api` в отдельный процесс / хост `ws.kingside.site`.
- Переход refresh-токена на cookie (требует domain-wide cookie, отдельный дизайн).
- Разделение `apps/api` на более мелкие сервисы.

## Последствия

- **Backend.** Одна backend-задача: нормализация CORS в `apps/game-service` (читать env, не `*`).
- **Frontend.** Не код, а билд: прокинуть `VITE_API_URL=https://api.kingside.site` в прод-сборке.
- **DevOps.** ACM wildcard, Route53 A-record, ALB listener rule, проверка sticky sessions, CORS_ORIGIN в ECS task definitions обоих сервисов. Обновление `scripts/deploy-aws.sh`.
- **QA.** Smoke-план: логин, открытие игры, подбор, просмотр трансляции, отправка сообщения, SPA навигация — после каждого шага 4 и 6.
- **Документация.** После cutover обновить `docs/architecture/system-overview.md` (упомянут в ADR-012 как устаревший) и `.env.example` backend-сервисов, зафиксировав новый `CORS_ORIGIN`.
