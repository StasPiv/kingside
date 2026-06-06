# ADR-110: Трансляция анализа партии (live analysis broadcast)

**Статус:** Предложено
**Дата:** 2026-06-06
**Задача:** KS-3729

## 1. Контекст

### Что хочется

Автор открывает окно анализа (`apps/web/src/pages/analysis/AnalysisPage.tsx`), двигает фигуры на доске. Любой по публичной ссылке подключается и видит ходы автора в реальном времени. Зритель может двигать фигуры локально (своя ветка), но это не влияет на доску автора и на других зрителей.

### Вводные от пользователя (зафиксировано в KS-3729)

- Доступ — публичный, по ссылке.
- Зрители смотрят, локально экспериментируют, но друг друга и автора не «видят».
- Архитектура — отдельный модуль/сервис. **НЕ** в существующем `apps/broadcast-service`: там Lichess broadcasts с pull-моделью из внешних источников (PGN-стримы, см. ADR-021), модель данных и поток обновлений принципиально иные.

### Что уже есть в проекте

1. `apps/api/src/analysis/` — приватный CRUD анализов (модель `Analysis` в `packages/db/prisma/schema.prisma:772`). Есть `isPublic` + публичный read-only `AnalysisPublicController` (`GET /analyses/public/:id`) — это статический shareable snapshot, без live-обновлений.
2. `apps/api/src/message/message.gateway.ts` — namespace `/messages`, JWT-auth в handshake. Образец gateway с auth в `apps/api`.
3. `apps/game-service/src/game/game.gateway.ts` — namespace `/game` на отдельном `game.kingside.site`, образец gateway без auth + комнаты по id игры.
4. `apps/broadcast-service` (ADR-021) — `broadcasts.kingside.site`, Redis pub/sub, gateway без namespace. Архитектурный референс по pub/sub, но **не точка интеграции**.
5. `apps/api/src/redis/redis.service.ts` — общий Redis (тот же, что у других сервисов). Pub/sub доступен.

### Что НЕ в скоупе ADR-110

- Сохранение трансляции как `Analysis` после её завершения (потенциальное «Сохранить разбор» автором — отдельный follow-up; в KS-3729 нет требования).
- Голосовая/текстовая коммуникация автор↔зрители.
- Совместное редактирование (collaborative editing): зрители — read-only.
- Stockfish/Maia на стороне сервера: автор ведёт анализ сам, движок крутится у него в браузере (как сейчас в `AnalysisPage`). Зрителю движок доступен локально, но не пушится по WS.
- Запись (replay) трансляции в архив для просмотра задним числом. История ходов в Redis нужна только для «зритель подключился в середине» — после закрытия трансляции стирается.
- Интеграция с существующими `Analysis` (создать live-трансляцию из существующего анализа). MVP — отдельная сущность.

## 2. Решение

### 2.1 Где живёт состояние трансляции

**Гибрид PG + Redis.**

| Что | Где | TTL / lifecycle |
| --- | --- | --- |
| Метаданные трансляции (id, slug, ownerId, title, status, createdAt, closedAt, lastActivityAt) | PostgreSQL, таблица `live_analyses` | Persistent. Запись остаётся после закрытия для аудита («автор X провёл стрим Y минут»). |
| Текущее состояние доски (currentFen, currentPly, startingFen, orientation) | Redis hash `live_analysis:<id>:state` | TTL 24ч, продлевается на каждый ход. |
| История ходов (UCI + optional comment) | Redis List `live_analysis:<id>:moves` | TTL 24ч, общий с state. Нужен для «подключился поздно — догоняй с самого начала». |
| Список комнат активных зрителей | Socket.IO room `live-analysis:<id>` | Ephemeral, в памяти gateway. Для multi-instance — RedisIoAdapter (см. §2.6). |
| Pub/sub события | Redis channels `live-analysis:move`, `live-analysis:sync`, `live-analysis:closed` | Ephemeral. |

**Почему не только PG.** Каждый ход автора → INSERT в PG — это десятки записей в минуту на трансляцию. При 10 параллельных стримах с обычной скоростью разбора — порядка 200 INSERT/мин. PG выдержит, но смысла нет: ходы нужны только для двух use-case'ов (broadcast в момент эмита + догон при позднем подключении), оба решаются Redis-ом нативно.

**Почему не только in-memory в процессе.** При рестарте `apps/api` (деплой, OOM) активная трансляция теряет состояние, автор обязан переподключиться и начать заново. Это плохой UX. Redis переживает рестарт API.

**Почему не только Redis.** Метаданные нужны для:
- Защиты slug от коллизий (`UNIQUE` индекс).
- Аутентификации эмита: «кто owner у этой трансляции» — после рестарта API процесс должен уметь это узнать без обращения к автору.
- Будущего «мои трансляции» в профиле.

### 2.2 Транспорт

**Namespace:** новый `/live-analysis` в `apps/api`. Не расширение `/messages` (там user-bound события — статус друзей, нотификации) и не `/game` (тот живёт в `apps/game-service`, у него другой деплой-юнит и нет публичного анонимного read-only намерения).

**Почему `apps/api`, а не отдельный сервис — см. §2.4.**

**Аутентификация WS handshake:**
- `auth.token` (JWT) присутствует → валидируем, ставим `client.data.user`.
- Токена нет → подключение допускается, `client.data.user = null` (анонимный зритель).
- В отличие от `/messages` (где `client.disconnect()` без токена) — здесь читают анонимы, это by design.

**События (имена в `packages/shared`):**

Клиент → сервер:
- `live-analysis:subscribe { slug }` — зритель/автор присоединяется к комнате. В ответ — `live-analysis:sync` (полное состояние + история ходов).
- `live-analysis:unsubscribe { slug }` — выйти.
- `live-analysis:move { slug, uci }` — **только автор**. Сервер валидирует: JWT, ownerId матч, UCI легален в `currentFen` через `chess.js`. Если ok — обновляет state в Redis, публикует в pub/sub.
- `live-analysis:reset { slug, fen?, pgn? }` — **только автор**. Полный reset позиции (например, автор переключился на другую партию для разбора). Публикует `live-analysis:sync` всем подписанным.
- `live-analysis:close { slug }` — **только автор**. Помечает трансляцию closed, эмитит `live-analysis:closed` всем, выгоняет из комнаты.

Сервер → клиент:
- `live-analysis:sync { slug, startingFen, currentFen, currentPly, moves: UCI[], orientation }` — полное состояние. На subscribe или reset.
- `live-analysis:move { slug, uci, fen, ply }` — дельта по ходу. `fen` шлём для устойчивости к рассинхронизации (зритель проверяет, что после применения uci к своему current совпадает; иначе перезапрашивает sync). `ply` — порядковый номер хода для idempotent применения.
- `live-analysis:viewers { slug, count }` — изменение числа зрителей (для UI «X смотрят»). Кидаем дросселированно (раз в 2с при изменениях), не на каждый join/leave.
- `live-analysis:closed { slug }` — трансляция завершена автором или таймаутом.
- `live-analysis:error { code, message }` — ошибки (slug not found, not owner, illegal move, rate limit).

**Дельта UCI, а не полный FEN на каждый ход.**
- UCI — 4–5 байт (`e2e4`, `e7e8q`), FEN — 50–80 байт. На зрителя × ходы × трансляции экономия трафика заметна на масштабе.
- Зритель пересчитывает FEN локально через `chess.js` (он уже в `apps/web` в `package.json`).
- **Но** в `live-analysis:move` шлём ещё и `fen` — как self-check: если применение UCI у зрителя дало другой FEN, значит он пропустил предыдущий ход или у него поломан state → автоматический re-subscribe и получение `sync`. Это страховка, а не основной канал данных.

**Транспорт socket.io:** только `websocket` (без long-polling), как в существующих gateway. CORS — из env `CORS_ORIGIN`, не `'*'`.

### 2.3 Жизненный цикл трансляции

**Создание (REST):**
- `POST /live-analyses` (JwtAuthGuard). Body опционально: `{ title?, startingFen?, startingPgn? }`. Без body — стартует с initial position.
- Сервер:
  1. Генерит slug — `nanoid(10)`, alphabet URL-safe. Проверка коллизии в `UNIQUE` индексе, при collision — повторная генерация (вероятность < 10⁻¹² при 10⁴ активных).
  2. INSERT в `live_analyses` (status=`active`).
  3. INIT Redis state (`currentFen` = startingFen или standard initial, empty moves list, TTL 24h).
  4. Response: `{ id, slug, url: "https://kingside.site/live/<slug>", ownerId, createdAt }`.

**Ссылка:** публичный URL вида `kingside.site/live/<slug>`. Фронт-роут резолвит slug → подгружает метаданные через `GET /live-analyses/<slug>`, открывает WS.

**Подключение зрителя:**
- HTTP `GET /live-analyses/<slug>` — публичный, возвращает `{ id, slug, title, ownerId, status, currentFen, currentPly, orientation, viewerCount }`. Если status=`closed` или slug не найден — 404.
- Если active — фронт открывает WS, эмитит `subscribe { slug }`. Сервер кладёт socket в room `live-analysis:<id>`, отдаёт `sync` со всем `moves` array из Redis (зритель догоняет с 1 хода).

**Эмит хода автором:** см. §2.2. После успешной валидации:
1. `RPUSH live_analysis:<id>:moves <uci>` + `HSET ...:state currentFen <new_fen>, currentPly <new_ply>`.
2. `EXPIRE` обоих ключей на 24ч (продление TTL).
3. UPDATE `live_analyses SET last_activity_at = NOW() WHERE id = ?`. На каждый ход — это полезно для cleanup-job'а (§2.7), но «дёшево», т.к. одна запись.
4. `PUBLISH live-analysis:move {slug, uci, fen, ply}` → gateway получает в `onMessage` (как в `apps/broadcast-service/src/http/broadcast.gateway.ts:93`), эмитит в room.

**Закрытие:**

A. **Явно автором.** `live-analysis:close { slug }` через WS либо `DELETE /live-analyses/<id>` через REST. Сервер: UPDATE status=`closed`, closedAt=NOW(). `PUBLISH live-analysis:closed`. Redis-ключи — оставляем до TTL (зрители могут хотеть досмотреть последний момент; через 24ч сами протухнут).

B. **Таймаут неактивности.** Cleanup-job в `apps/api` (`@nestjs/schedule` cron каждые 5 минут): `SELECT id FROM live_analyses WHERE status='active' AND last_activity_at < NOW() - INTERVAL '30 minutes'` → закрыть как в (A). Порог 30 минут — компромисс: автор может прерваться выпить чая, не хочется обрывать; но забытая открытая вкладка не должна висеть сутки.

C. **Авто-закрытие при disconnect автора.** При WS disconnect socket'а с `ownerId === <тот же, что в live_analyses>` — НЕ закрываем сразу (автор перезагрузил вкладку — переподключится за секунды). Ставим таймер на 2 минуты; если за это время автор не подключился обратно — закрываем как (A). Реализация: Redis ключ `live_analysis:<id>:owner_disconnect_at` с TTL 120с; при reconnect автора удаляется, при истечении срабатывает на keyspace-notification ИЛИ проверяется тем же cleanup-job'ом.

**Я голосую за упрощение (B+C объединить):** не делать отдельный таймер на disconnect, а полагаться только на 30-минутный cleanup. Этого хватает для MVP. Disconnect-таймер усложняет логику без явной выгоды (всё равно зрители у потерявшего связь автора видят последнюю позицию и могут её исследовать локально).

### 2.4 В каком приложении живёт логика

**Решение: `apps/api/src/live-analysis/` — новый модуль внутри `apps/api`.**

Аргументы:

1. **Auth-инфраструктура уже там.** JWT-валидация для POST/DELETE (создатель — авторизованный), JwtAuthGuard, JwtService — все живут в `apps/api/src/auth/`. В `broadcast-service` их нет (ADR-021 §2.4: «образ компактнее» без auth). Тащить JwtService в broadcast-service — копировать секреты в ещё один Task Definition.
2. **Запрет пользователя.** «НЕ смешивать с существующим broadcast-service» — однозначен.
3. **Объём трафика на старте.** Гипотеза §2.7: десятки трансляций × сотни зрителей × десятки сообщений/минуту. Это меньше, чем уже идёт через `/messages` (нотификации + статусы друзей всех онлайн-пользователей). `apps/api` один инстанс держит, отдельный сервис не нужен.
4. **Один разработчик, ограниченные ресурсы.** Каждый новый ECS service — это +Task Definition, +CloudWatch group, +ALB target, +CI pipeline. Цена создания не окупается, пока нагрузка не вырастет.
5. **Лёгкая миграция в отдельный сервис позже.** Модуль самодостаточный (своя таблица, свой namespace, свой Redis-keyspace), при росте — выносится по образцу ADR-021 за неделю.

**Что отвергли:**
- `apps/game-service`. Там домен `game.kingside.site` без auth для зрителей, но `/live-analysis` — другая модель данных (нет clock'а, нет ratings, нет matchmaking). Затаскивать аналитический модуль в игровой сервис — путаница ответственности.
- `apps/broadcast-service`. Запрет пользователя + другие потоки данных (PGN-poll Lichess vs WS-эмит автора).
- Новый `apps/live-analysis-service`. См. п. 4 выше.

### 2.5 Модель данных

**PostgreSQL — модель `LiveAnalysis` в `packages/db/prisma/schema.prisma`:**

```prisma
model LiveAnalysis {
  id              String    @id @default(uuid()) @db.Uuid
  slug            String    @unique               // nanoid(10), URL-safe
  ownerId         String    @map("owner_id") @db.Uuid
  owner           User      @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  title           String?
  startingFen     String?   @map("starting_fen")   // null → standard initial
  status          LiveAnalysisStatus @default(active)   // active | closed
  createdAt       DateTime  @default(now()) @map("created_at")
  closedAt        DateTime? @map("closed_at")
  lastActivityAt  DateTime  @default(now()) @map("last_activity_at")
  viewerPeak      Int       @default(0) @map("viewer_peak")    // аналитика

  @@index([ownerId, status])    // «мои активные трансляции» в профиле
  @@index([status, lastActivityAt])   // cleanup-job отбирает по этому
  @@map("live_analyses")
}

enum LiveAnalysisStatus {
  active
  closed

  @@map("live_analysis_status")
}
```

**FK:** `ownerId → users.id`, cascade delete (удалили пользователя — снесли его трансляции; они эфемерные, audit не нужен).

**Что хранится в Redis (см. §2.1 таблицу):**

| Ключ | Тип | Содержимое |
| --- | --- | --- |
| `live_analysis:<id>:state` | Hash | `currentFen`, `currentPly`, `startingFen`, `orientation` (white/black) |
| `live_analysis:<id>:moves` | List | UCI ходов по порядку (`RPUSH` на каждый ход) |
| `live_analysis:<id>:viewers` | Integer (через `INCR`/`DECR`) | счётчик активных WS-подключений |

**Чего сознательно НЕ храним:**
- Полный PGN с аннотациями. Автор в `AnalysisPage` может ставить стрелки/комментарии — это локальный state у автора. Если фича расширится «зрители видят и аннотации» — добавим поле `annotations` в Redis Hash, отдельный event `live-analysis:annotation`. Вне MVP.
- Per-viewer state (его локальная альтернативная ветка). Это чисто клиентский state у зрителя, серверу про него знать не нужно.

### 2.6 Авторизация и публичный доступ

| Действие | Кто | Как проверяется |
| --- | --- | --- |
| `POST /live-analyses` (создать) | Аутентифицированный | `JwtAuthGuard` на контроллере. |
| `GET /live-analyses/:slug` (получить snapshot) | Любой | Без guard. 404 если slug нет или status=closed. |
| `DELETE /live-analyses/:id` (закрыть) | Только owner | `JwtAuthGuard` + проверка `ownerId === req.user.id` в сервисе. 403 иначе. |
| WS `subscribe` | Любой | Без проверок (анонимы по ссылке = зрители). |
| WS `move` / `reset` / `close` | Только owner | В handshake JWT валидирован → `client.data.user.id`. Сервис достаёт `live_analyses.ownerId` (по slug→id, кешируется in-memory на 30с чтобы не дергать PG на каждый ход) и сверяет с user.id. Mismatch → `live-analysis:error { code: 'forbidden' }`. |

**Анонимы по ссылке:** UX компромисс. Плюс — нулевой барьер для зрителя (поделился в Telegram, открыли, смотрят). Минус — спам/абуз: кто-то находит слаги перебором или scraping'ом, открывает 1000 подключений. Митигация:
- Rate limit на subscribe (по IP): N WS-подключений в минуту через nginx/ALB или серверный counter в Redis.
- Slug 10 символов alphabet ≈ 60 бит — против перебора достаточно.
- Жёсткий лимит viewers на трансляцию (например, 1000) — настройка, при превышении новые получают 429.

**JWT на cross-subdomain:** не применимо. `apps/api` живёт на `api.kingside.site`, фронт на `kingside.site`, JWT в `localStorage` origin-local. POST/DELETE отправляются с фронта на api с `Authorization: Bearer` — это уже работает (см. `apps/web/src/api.ts`). Для WS — JWT в `auth.token` handshake (паттерн как у `/messages`).

### 2.7 Масштаб

Оценка на 6 месяцев вперёд (грубая, цифры — потолок ожиданий, не цель):

| Параметр | Старт | Через 3 мес | Через 6 мес |
| --- | --- | --- | --- |
| Одновременных активных трансляций | 1–5 | 10–20 | 50–100 |
| Зрителей на трансляции (медиана) | 1–5 | 5–20 | 10–50 |
| Зрителей на пике (1 топ-трансляция) | 10 | 50 | 300 |
| Ходов от автора в минуту | 5–20 | 5–20 | 5–20 |

**Один инстанс `apps/api` держит легко.**
- Socket.IO + websocket: тысячи параллельных подключений на один процесс — стандарт.
- Redis pub/sub: 100 публикаций/секунду — копейки.
- PG writes: `UPDATE last_activity_at` на каждый ход × 20 одновременных трансляций = 400 UPDATE/мин — несущественно.

**Когда выносить в отдельный сервис:**
- Зрителей суммарно >2000 одновременно → надо горизонтально масштабировать. Тогда нужен RedisIoAdapter (он уже есть в `apps/api/src/common/redis-io.adapter.ts`, нужно убедиться, что включён).
- ИЛИ когда `/live-analysis` начнёт мешать другим эндпоинтам api (рост latency на REST). Метрики: p95 латентность REST, RSS памяти процесса.

**RedisIoAdapter на старте.** В `apps/api/src/main.ts` уже есть логика подключения адаптера при `ECS_TASK_COUNT>1` (см. ADR-017). Для `/live-analysis` это нужно сразу как только число task'ов > 1, иначе зритель попадёт на инстанс A, а publish прилетит на B — событие потеряется. На старте инстанс = 1, но архитектурно поддерживать N>1 надо обязательно.

### 2.8 Discoverability и UX

- В профиле автора (`apps/web/src/pages/ProfilePage.tsx` или аналог) — секция «Мои live-трансляции» с активной/историей. MVP — необязательно, можно ограничиться кнопкой «Транслировать» на AnalysisPage.
- В AnalysisPage добавить кнопку «Транслировать». При нажатии — `POST /live-analyses` со текущим FEN/PGN страницы, в ответ slug → копирование URL в clipboard + индикатор «Идёт трансляция, X смотрят».
- Зрительская страница `/live/:slug`:
  - Реюзает компоненты `AnalysisBoard` и его обвязку из `apps/web/src/pages/analysis/`.
  - Поверх — баннер «Транслирует Имя_автора · X смотрят». При закрытии — баннер «Трансляция завершена», доска остаётся в read-only финального состояния.
  - Локальная альтернативная ветка делается через тот же механизм, что у автора в анализе — `chess.js` instance, UI «вы экспериментируете локально, кнопка "вернуться к автору"».

### 2.9 Риски и подводные камни

1. **Гонка эмитов автора.** Автор быстро двигает фигуры (5 ходов/сек при разборе таб-таб-таб). Между receive→validate→update Redis→publish может прийти следующий эмит. Решение: на сервере — обработка эмитов от одного `slug` последовательно через mutex/queue (in-memory `Map<slug, Promise>`). Очередь короткая, легче, чем Redis-lock.

2. **Illegal move от автора.** UCI не парсится / не легален в текущем FEN → `live-analysis:error { code: 'illegal-move' }` отправляем только автору, не зрителям. State не обновляется.

3. **Coup переподключения зрителя.** Сеть мигнула, socket.io переподключился — клиент эмитит `subscribe` снова, получает свежий `sync`, ничего не теряется. Никакой ручной resync-логики со стороны сервера.

4. **Author session resumption.** Автор перезагрузил вкладку. Он же owner — POST /live-analyses делать заново нельзя, slug не должен меняться. Решение: фронт сохраняет `slug` в `localStorage` под ключом `current-live-analysis`, при загрузке AnalysisPage проверяет — если есть и `GET /live-analyses/<slug>` отвечает active+ownerId=я, то восстанавливает «режим трансляции» (кнопка «Перейти к моей трансляции») вместо создания новой.

5. **Slug collision.** Nanoid(10) с дефолтным alphabet (64 символа) → 64¹⁰ ≈ 10¹⁸ комбинаций. При 10⁴ активных trans коллизия ~10⁻¹⁴. UNIQUE-индекс гарантирует. Re-try при коллизии: до 3 попыток, потом 500 (заведомо не случится в обозримом будущем).

6. **Анонимный зритель = anti-abuse.** Боты подключаются по слагу и держат тысячу socket'ов чтобы повесить нам сервер. Митигация:
   - Лимит viewers на трансляцию (1000, см. §2.6).
   - Лимит подключений с одного IP (например, 10 параллельных). Через `socket.handshake.address` + Redis counter. Не идеально (NAT), но отсекает грубый абуз.
   - На L7 — связанный rate limit на handshake.
   Это backend-задача в follow-up, не блокирует MVP.

7. **PG drift.** `last_activity_at` обновляется на каждый ход — UPDATE с WHERE по PK = fast. Но если автор гонит 60 ходов в минуту × 100 трансляций → 6000 UPDATE/мин. Митигация: дросселим update'ы до раз в 10 секунд per-trans (in-memory `Map<id, last_update_at>` в сервисе). Cleanup-job отбирает по `lastActivityAt < NOW() - 30min`, отставание в 10с не влияет.

8. **Cleanup-job vs multi-instance.** Если в будущем `apps/api` пойдёт на N>1 — два job'а будут отбирать одни и те же кандидаты и пытаться их закрыть. Митигация: Redis lock `live_analysis:cleanup:lock` TTL 60с, один инстанс работает за тик. На старте инстанс = 1, проблема не материализуется, но lock делаем сразу.

9. **`/live/:slug` SSR / SEO.** Live-страница меняется ежесекундно, индексировать смысла нет. В `robots.txt` (если есть) или meta `noindex` — путь `/live/*`. Уточняется в задаче frontend.

10. **CSP `connect-src`.** Если ALB/CloudFront пушит CSP, `wss://api.kingside.site` уже разрешён (там же `/messages`). Дополнительных правок не нужно.

11. **Запись (replay) трансляции.** Не в MVP. Но если потом понадобится — Redis-история ходов протухает за 24ч, ничего не сохранено. Решение в будущем: при закрытии — `INSERT INTO live_analysis_history (id, pgn_built_from_moves)` либо явный экспорт в `Analysis`. Не делать сейчас, чтобы не таскать PGN-builder в сервис.

12. **chess.js на сервере.** Для валидации UCI авторских ходов нужен `chess.js` в `apps/api` (он уже подтянут как peer в `packages/shared` — проверить). Если нет — добавить в `apps/api/package.json`. Не использовать «отдать всё на доверие фронта» (автор может нажать F12 и подсунуть illegal UCI — целостность state в Redis сломается, все зрители увидят кашу).

13. **shared events.** Тип-имена событий и payload'ов кладём в `packages/shared/events/` (по образцу `MessageEvents`, `BroadcastEvents`). Чтобы backend и frontend импортировали одно и то же.

14. **Метрики.** `live_analysis_active_total` (gauge), `live_analysis_viewers_total` (gauge), `live_analysis_moves_emitted_total` (counter), `live_analysis_subscribes_total` (counter). Через существующий `MetricsService` в `apps/api`. Follow-up, не блокирует MVP.

15. **Rate limit на `live-analysis:move`.** Защита от автора-бота: не больше X ходов в секунду (например, 20). Это всё равно очень быстро для человека, но отсекает заведомо машинный поток. Реализация: token-bucket per-slug in-memory.

## 3. Последствия

- **Backend.** Новая таблица `live_analyses` + enum. Новый модуль `apps/api/src/live-analysis/` (controller, service, gateway). Cleanup-job. Pub/sub каналы в Redis. Возможно — добавление `chess.js` в `apps/api` если не подтянут транзитивно.
- **Frontend.** Новая страница `/live/:slug` (зритель), новая кнопка «Транслировать» на `AnalysisPage`, socket-обвязка для namespace `/live-analysis` через существующий `apps/web/src/socket.ts` (по образцу `messagesSocket`).
- **Shared types.** Новый файл с константами событий и типами payload'ов.
- **DevOps.** Ничего нового. Тот же `api.kingside.site`, тот же Redis, тот же RDS. Cleanup-job — на тех же ECS task'ах, что и `apps/api`, через `@nestjs/schedule`.
- **QA.** Smoke-чеклист после релиза:
  - POST `/live-analyses` от авторизованного → 201, slug возвращён.
  - GET `/live-analyses/<slug>` от анонима → 200, snapshot.
  - WS subscribe анонимом → получен sync.
  - WS move от автора → пришёл move всем подписанным; от не-автора → error.
  - DELETE owner'ом → closed; не-owner'ом → 403.
  - Cleanup при `last_activity_at < NOW() - 30min` → status closed.
  - Зритель подключился в середине → получил все накопленные ходы в `sync.moves`.
- **Документация.** Этот ADR. В `docs/architecture/system-overview.md` — упомянуть `/live-analysis` рядом с `/messages` для namespace api. Не обязательно блокирующий шаг.

## 4. Предлагаемая разбивка на тикеты

### Backend
- **KS-N01 [backend]** — Prisma-миграция: модель `LiveAnalysis` + enum `LiveAnalysisStatus`, индексы. `prisma migrate dev`.
- **KS-N02 [backend]** — shared types в `packages/shared`: `LiveAnalysisEvents`, payload-типы для всех сообщений (subscribe/sync/move/reset/close/viewers/closed/error).
- **KS-N03 [backend]** — модуль `apps/api/src/live-analysis/`:
  - `live-analysis.controller.ts`: `POST /live-analyses`, `GET /live-analyses/:slug`, `DELETE /live-analyses/:id`.
  - `live-analysis.service.ts`: бизнес-логика, slug generation, Redis state операции, валидация UCI через `chess.js`, mutex per-slug.
  - `live-analysis.gateway.ts`: namespace `/live-analysis`, опциональная JWT-валидация в handshake, room management, Redis pub/sub подписка.
  - DTO с class-validator.
  - Юнит-тесты на сервис (валидация UCI, slug-uniqueness, ownerId check).
- **KS-N04 [backend]** — cleanup-job через `@nestjs/schedule` (cron каждые 5 минут): закрытие трансляций с `lastActivityAt > 30min`, Redis lock для multi-instance безопасности. e2e-тест с фейковым clock.
- **KS-N05 [backend]** — `last_activity_at` throttling (не чаще раза в 10с per-slug), rate limit на `move` (token-bucket), метрики через `MetricsService`. Можно одной задачей или разбить дальше — решит координатор.

### Frontend
- **KS-N06 [frontend]** — добавление `liveAnalysisSocket` в `apps/web/src/socket.ts` (namespace `/live-analysis`, auth.token из localStorage если есть).
- **KS-N07 [frontend]** — кнопка «Транслировать» на `AnalysisPage`:
  - POST `/live-analyses` с текущим startingFen.
  - Хранение `slug` в localStorage под `current-live-analysis`.
  - Индикатор «Идёт трансляция · X смотрят · ссылка». Кнопка «Завершить».
  - Эмит `live-analysis:move` на каждый ход автора + `reset` на смену партии.
  - Восстановление режима на reload (см. §2.9.4).
- **KS-N08 [frontend]** — страница зрителя `/live/:slug`:
  - Роут в React Router.
  - Компонент-обёртка над `AnalysisBoard`, подписка на socket.
  - Sync на mount, применение move-дельт, ререндер.
  - Локальная альтернативная ветка («вы экспериментируете локально / вернуться к автору»).
  - Баннер «Трансляция завершена».
  - `<meta name="robots" content="noindex">` для страницы.
- **KS-N09 [frontend]** — секция «Мои live-трансляции» в профиле (опционально, после ядра). Может уйти в backlog.

### QA / Документация
- **KS-N10 [qa]** — smoke-сценарии по чеклисту из §3.
- **KS-N11 [architect]** — после релиза: обновление `docs/architecture/system-overview.md`, добавление `/live-analysis` в перечень namespace'ов.

## 5. Связь с соседними ADR

- **ADR-021** (broadcast-service extraction) — Lichess broadcasts. Архитектурный референс по WS gateway + Redis pub/sub, но точка ответственности отдельная: ADR-021 живёт на `broadcasts.kingside.site`, ADR-110 — внутри `apps/api`/`api.kingside.site`. Слияние не планируется.
- **ADR-017** (service subdomains) — `/live-analysis` остаётся под `api.kingside.site`. Если в будущем выносим — добавим A-запись `analysis-live.kingside.site` (или аналог) отдельным ADR.
- **ADR-051** (publishing анализов) — `Analysis.isPublic` решает шаринг статического snapshot'а. Live-трансляция — динамический канал, ортогональная фича. После завершения трансляции потенциальный «Сохранить как анализ» — отдельный follow-up (не в этом ADR).
- **ADR-008** (game-analysis persistence) — про сохранение комментариев/PGN/аннотаций в `Analysis`. Не пересекается: live-трансляция эфемерна, ничего в `Analysis` не пишет.
