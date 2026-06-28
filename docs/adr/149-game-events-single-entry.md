# ADR-149 — Единая точка эмиссии game-событий: apps/api и apps/game-service пишут идентично

- Статус: **Proposed** (2026-06-28)
- Дата: 2026-06-28
- Связанные задачи: KS-4746 (этот ADR), KS-4696 (self-emit в apps/api game.service), KS-4745 (правило hints `analyze-after-loss`)
- Связанные ADR: ADR-012 (api ↔ game-service split), ADR-147 (контекстные подсказки), ADR-148 (data-driven hints)
- Автор: architect

---

## 0. TL;DR

В проекте сейчас **два процесса с одинаковой игровой логикой** — `apps/api` и `apps/game-service` (ADR-012). Self-emit `actor_events` сделан **только в первом** (KS-4696). Это разрывает поведение хинтов: бот-партии и live-WS-партии завершаются в `apps/game-service`, их `game_end`/`resign`/`draw_offered` не попадают в `actor_events`, поэтому правила вида `analyze-after-loss` не срабатывают для игр против бота — а это самый частый случай у нового пользователя.

Рассмотрены 5 вариантов унификации. **Рекомендуется гибрид B+E** — `packages/events-client` с чистой функцией `emit(actor, type, payload, deps)` (без Nest-DI) + внутренний HTTP-канал `POST /internal/events` от `apps/game-service` к `apps/api`. apps/api остаётся единственным владельцем consent-гейта, in-memory HintsEngine-listener'ов и метрик; game-service шлёт события через тонкий клиент. Это удовлетворяет букве «точка входа одна» (consent + listeners живут только в apps/api), минимизирует дублирование кода и не нарушает ADR-012.

План — 4 тикета на ~3–4 дня. Также включает фикс контракта `game_end.payload.result: 'win'|'loss'|'draw'` per-actor (а не `'white'|'black'|'draw'` per-game), без чего правило `analyze-after-loss` не выразимо в DSL.

---

## 1. Текущее состояние и архитектурный разрыв

### 1.1. Где живёт код

| Файл | Назначение | Self-emit actor_events |
|------|-----------|------------------------|
| `apps/api/src/game/game.service.ts` | Игровые операции для **REST-flow** (бот-партии создаются через REST POST, частично — старые партии в архиве) | **Есть** (KS-4696, цитаты ниже) |
| `apps/game-service/src/game/game.service.ts` | Игровые операции для **WS-flow** (live-партии после matchmaking, бот-партии в новом потоке) | **Нет** |

ADR-012 «api ↔ game-service split» разнёс их по двум ECS-task для изоляции WS-нагрузки от HTTP. Но **бизнес-логика игры дублирована** (clock, rating, endGame, resign, draw — есть в обоих).

### 1.2. Что эмитит apps/api сейчас

`apps/api/src/game/game.service.ts`:

- **L67–99**: `trackBoth(whiteId, blackId, type, payload)` — приватный helper, пишет событие в `actor_events:stream` обоим игрокам, исключая `STOCKFISH_BOT_ID` (KS-4696 §75–79: бот не имеет user_id).
- **L137–141**: `game_start` через `trackBoth` после создания партии.
- **L516–523**: `resign` — отдельный event только для сдавшего (action, не fact-of-end).
- **L545–549**: `draw_offered` — только для предложившего.
- **L655–678**: `game_end` через `trackBoth` после успешного завершения; payload содержит `{result, termination, rating_delta}`.

`EventsService.track()` (`apps/api/src/events/events.service.ts`) делает:
1. Гейт `analytics_consent` (для user — SQL+60s-cache; для guest — уже гарантировано middleware на входе).
2. `XADD actor_events:stream * type=... actor_id=... actor_type=... payload=... occurred_at=...` с `MAXLEN ~ 50000`.
3. Метрика Prometheus `actor_events_ingested_total{type, actor_type}`.
4. **Notify in-memory listeners** (`onTrack`): HintsEngine реактивно проверяет правила сразу же на этом же событии (ADR-147 §4.1 п.1), без ожидания writer→Postgres→matview-refresh цикла.

### 1.3. Что НЕ эмитит game-service

`apps/game-service/src/game/game.service.ts`:
- L453 `resign(gameId, userId)` — обновляет рейтинг, останавливает часы, возвращает `EndResult`. **Нет** `track('resign', ...)`.
- L484 `handleDrawOffer` — пишет offer в Redis. **Нет** `track('draw_offered', ...)`.
- L502 `handleDrawAccept` → `endGame('draw', 'draw_agreement')`. **Нет** `track('game_end', ...)`.
- L512 `endGame(...)` — основной финализатор партии (timeout/checkmate/resignation/agreement). **Нет** ничего.
- Создание партии (после matchmaking или бот-launch) — **нет** `track('game_start', ...)`.

Доступ к Redis у game-service есть (`RedisModule` подключён в app.module.ts), Prisma тоже (используется в game.service.ts L73 для `game.findUniqueOrThrow`). То есть инфраструктурно ничто не мешает писать события — мешает отсутствие архитектурного решения «как».

### 1.4. Следствия разрыва

- Правило `analyze-after-resign` (опубликовано в KS-4744 №2) **не срабатывает для бот-партий** и для live-WS-партий после matchmaking — а это > 80% игр у обычного пользователя на проекте.
- Любые будущие правила, опирающиеся на `game_start`/`game_end`/`resign`/`draw_offered`, имеют ту же проблему.
- Пользовательская формулировка «бот = человек, точка входа одна» — нарушена.

### 1.5. Дополнительный фикс контракта payload (вне выбора варианта, но обязательный)

Сейчас `game_end.payload.result` в KS-4696 несёт значение из `endGame()` — `'white'|'black'|'draw'` (это **итог партии**, не результат для конкретного игрока). Для каждого игрока в payload пишется `color: 'white'|'black'`.

Чтобы выразить правило «3 проигранные партии любым способом», DSL должен фильтровать `count game_end where{result: 'loss'}`. Текущий формат требует двух условий (`where{result: 'white', color: 'black'}` или `where{result: 'black', color: 'white'}`) — а оператор `any` внутри `count.where` DSL §3.2 не поддерживает.

**Требование к контракту** (выполняется в составе унификации): `trackBoth` (или его эквивалент в новой схеме) должен конвертировать per-game result в **per-actor result** перед XADD:

```ts
const playerResult =
  result === 'draw'                       ? 'draw' :
  (result === 'white' && color === 'white') || (result === 'black' && color === 'black')
                                          ? 'win'  : 'loss';
// payload для игрока: { result: playerResult, termination, rating_delta, color, game_id }
```

После фикса правило `analyze-after-loss` (вместо `analyze-after-resign`) выражается как:
```json
{"count": {"event": "game_end", "where": {"result": "loss"}, "windowDays": 7, "gte": 3}}
```

---

## 2. Варианты унификации

### 2.1. Вариант A — Поднять `EventsModule` в game-service (дублирование DI)

Скопировать `EventsModule` (EventsService, EventsMetricsService, types) в `apps/game-service/src/events/`, подключить в `app.module.ts`. game-service получает DI-доступ к собственному `EventsService` и вызывает `events.track(...)` в `game.service.ts` ровно как сейчас apps/api.

**Плюсы.**
- Симметрия архитектуры: оба сервиса имеют идентичный модуль.
- Локальный вызов (без сети) → минимальный latency.
- consent-гейт «как есть» (читается `User.analyticsConsent` через Prisma — у game-service есть PrismaService).

**Минусы.**
- **Полное дублирование кода** — EventsService.ts, events.types.ts, метрики. Поправил баг в одном месте, забыл в другом → дрейф.
- **In-memory listeners HintsEngine не работают кросс-процесс.** В apps/api EventsService.onTrack(...) подписан HintsListener (ADR-147 §4.1 п.1). В game-service отдельный процесс, отдельная in-memory шина → HintsEngine **не увидит** реактивно `game_end` из бот-партии. Reactive-trigger сорвётся, hint покажется только на следующем `page_view` (он идёт через apps/api EventsService и поднимет HintsEngine).
- consent-кэш ×2 — на старте game-service «холодный», первые ~60s каждый user даст SQL-hit (мелко, но артефакт дублирования).
- Если позже добавим Redis hot counters (ADR-147 §2.4) — снова дублируем код в двух местах.

### 2.2. Вариант B — Вынести EventsService в shared-пакет

Создать `packages/events-client` с **pure-функцией** `emit(actor, type, payload, deps)`, где `deps` — `{redis, getUserConsent, metrics?}`. Каждый процесс предоставляет свои реализации deps через локальный Nest-сервис-обёртку (`EventsService` в apps/api и game-service). Pure-функция содержит логику consent + XADD + payload-serialization.

**Плюсы.**
- Один источник истины для core-логики.
- Nest-DI не тянется в shared (правильная архитектура: shared = type-only/pure-functions, см. CLAUDE.md).
- Локальный вызов в обоих процессах.

**Минусы.**
- **In-memory listeners HintsEngine тот же кросс-процесс-разрыв, что в A.** Pure-функция не решает проблему cross-process bus.
- Нужно вытащить consent-кэш и метрики во что-то pluggable — лишняя индирекция в pure-функции, упрощённая до уровня helper'а.
- При любом изменении контракта (например, добавили label метрики) — bump-version shared, обновление обоих apps. Coupling растёт.

### 2.3. Вариант C — game-service шлёт XADD напрямую в Redis

В `apps/game-service/src/game/game.service.ts` сделать минимальный inline-helper:
```ts
private async trackBoth(whiteId, blackId, type, payload) {
  if (whiteId !== STOCKFISH_BOT_ID && await this.hasConsent(whiteId)) {
    await this.redis.xadd('actor_events:stream', 'MAXLEN', '~', 50000, '*', ...);
  }
  // то же для blackId
}
```

**Плюсы.**
- Минимальная цена реализации (~30 строк в game-service).
- Без новых пакетов и без HTTP.

**Минусы.**
- **Дублирование consent-гейта.** game-service должен сам читать `User.analyticsConsent` и кэшировать — это копирование `hasUserConsent()` и `consentCache` из apps/api. С риском забыть какой-то нюанс (например, fail-closed при ошибке БД).
- **In-memory listeners HintsEngine cross-process не работают** (то же, что A/B).
- Метрики дублируются (два Prometheus-counter'а с одинаковыми именами, агрегатор должен объединять — это работает, но требует понимания).
- Контракт XADD payload (магические строки `'type', 'actor_id', ...`) повторяется в двух местах — типичная точка дрейфа.

### 2.4. Вариант D — Перенести обработку resign/end на apps/api, оставить game-service как WS-relay

game-service получает резигн/завершение от клиента и проксирует через REST на apps/api, который выполняет всю логику (clock-stop, rating, endGame, эмит события) и возвращает результат для рассылки клиентам.

**Плюсы.**
- Единая точка владения игровой логикой + событиями.

**Минусы.**
- **Противоречит ADR-012** «split api ↔ game-service для изоляции WS-нагрузки». Возврат к моноархитектуре через back-door.
- **Огромный refactor** — game.service.ts в game-service ~700 LoC бизнес-логики (rating, clock, draw-offer, endgame); вынос — это переписывание контрактов между WS-gateway и core-логикой.
- Latency: каждая операция = +1 HTTP-round-trip; для real-time WS-партии это значимо (+5–20 мс на каждый ход — недопустимо).
- Single point of failure: apps/api ↓ → live-игра ↓.

### 2.5. Вариант E — `POST /internal/events` от game-service к apps/api

apps/api экспонирует internal-endpoint `POST /internal/events` под защитой shared-secret (HMAC header `X-Internal-Auth: <hmac(body, secret)>`). game-service делает HTTP POST на каждое событие, apps/api у себя вызывает штатный `EventsService.track(...)` — со всеми consent-гейтами, метриками и listeners.

**Плюсы.**
- **Единственное место, где живёт `EventsService.track`** — соответствует букве пользовательского замечания «точка входа одна».
- **In-memory HintsEngine listeners работают для ВСЕХ событий**, включая из game-service. Reactive trigger срабатывает мгновенно (ADR-147 §4.1 п.1) — hint после `game_end` в боте показывается без ожидания matview-refresh.
- Минимум кода в game-service — тонкий HTTP-клиент с retry.
- consent-логика не дублируется.
- Метрики в одном Prometheus-counter — простая агрегация.
- Совместимо с ADR-012 (game-service остаётся WS-primary, core game logic не трогаем).

**Минусы.**
- Latency на эмит события: +1 HTTP-round-trip внутри VPC (~1–3 мс в типовой ECS-конфигурации, см. ADR-045 §бенчмарки). Для **post-game** событий (resign/end/draw) — пренебрежимо: эти события идут после команды пользователя, не на критическом пути хода. Для `game_start` — тоже не критично (≤10 мс задержки на старте партии незаметны).
- Failure-mode: если apps/api недоступен → событие теряется. Митигация: try/catch вокруг HTTP-вызова + лог warn. Игровая операция в game-service **не падает** (event — best-effort, как и сейчас в apps/api: `events?.track()` обернут в `void`).
- Дополнительный endpoint с собственной аутентификацией. Однако паттерн уже есть в проекте (см. internal endpoints `/agent/...` с HMAC, ADR-139).

---

## 3. Сравнение

| Критерий | A (DI-дубль) | B (shared-pure) | C (XADD inline) | D (всё в apps/api) | E (internal HTTP) |
|----------|--------------|-----------------|------------------|----------------------|---------------------|
| Цена реализации | 1–1.5 дн | 2 дн | 0.5–1 дн | 5–8 дн | 1–1.5 дн |
| Дублирование кода/контракта | Высокое | Низкое (через shared) | Среднее (consent+XADD) | — | **Минимальное** |
| Единый consent-гейт | Дублирован | Pluggable, не дубль | Дублирован | Единый | **Единый (только apps/api)** |
| In-memory listeners HintsEngine на game-events из game-service | Не работают | Не работают | Не работают | Работают | **Работают** |
| Latency эмита | Локальный (0 мс) | Локальный (0 мс) | Локальный (0 мс) | +5–20 мс на каждую операцию | +1–3 мс на эмит, не на операцию |
| Failure-isolation (apps/api ↓) | game-service работает | game-service работает | game-service работает | game-service ↓ | game-service работает (event теряется, лог) |
| Совместимость с ADR-012 | Да | Да | Да | **Нарушает** | Да |
| Соответствует букве «точка входа одна» | Частично (две копии «той же точки») | Частично | Частично | Да | **Да** (один процесс владеет track) |

---

## 4. Рекомендуемый вариант — гибрид B+E

**Уточнение «B+E»:** не E вместо B, а **B как технический способ переиспользования (общие типы и payload-serialization)** + **E как способ доставки события из game-service в единый EventsService apps/api**.

### 4.1. Что переносится в `packages/events-client` (часть B)

Только то, что обоим процессам нужно в виде стабильного контракта:

- `Actor`, `ActorType`, `EventPayload`, `TrackEvent` (типы — уже в `apps/api/src/events/events.types.ts`, копия).
- Константы `ACTOR_EVENTS_STREAM`, `EVENTS_WRITER_GROUP`, `ACTOR_EVENTS_MAXLEN` (уже есть).
- `serializePayload(payload)` — pure-функция (сейчас inline в EventsService).
- Тип запроса/ответа для `POST /internal/events`.

Что **не переносится**:
- `EventsService` сам (Nest-сервис) — остаётся в apps/api.
- `hasUserConsent` (требует PrismaService) — apps/api only.
- `EventsMetricsService` — apps/api only.
- `onTrack`/listeners — apps/api only (cross-process bus не нужен, см. п.4.3).

Это правильное использование shared-пакета — type-only + pure-utility, без Nest-DI (CLAUDE.md «packages/shared/types/api-contracts.ts — единый источник истины для REST и WebSocket типов»).

### 4.2. Что появляется в apps/api (часть E)

Новый controller `apps/api/src/events/internal-events.controller.ts`:
```
POST /internal/events
  Headers: X-Internal-Auth: <HMAC-SHA256(body, INTERNAL_EVENTS_SECRET)>
  Body: { actor: {type, id}, type: string, payload: object, occurredAt?: ISO8601 }
  Response: 202 Accepted | 400 invalid | 401 bad signature
```

Реализация:
- HMAC-валидация через middleware (по образцу `agent-auth.middleware.ts` ADR-139).
- Вызывает `eventsService.track(actor, type, payload, { occurredAt })` — то есть тот же штатный путь.
- Метрика `actor_events_ingested_total` инкрементируется на одном уровне (в EventsService), с лейблом source=`internal_http` опционально для диагностики.

`INTERNAL_EVENTS_SECRET` — новая переменная окружения, доступна обоим сервисам (через AWS Secrets Manager / env, по образцу `WS_INTERNAL_SECRET` если такой есть). Без неё game-service не сможет аутентифицироваться.

### 4.3. Что появляется в apps/game-service

Новый сервис `apps/game-service/src/events/events-client.service.ts`:
```ts
@Injectable()
export class EventsClientService {
  constructor(private readonly http: HttpService, private readonly config: ConfigService) {}

  async track(actor: Actor, type: string, payload: EventPayload): Promise<void> {
    try {
      const body = JSON.stringify({ actor, type, payload, occurredAt: new Date().toISOString() });
      const sig = createHmac('sha256', this.config.get('INTERNAL_EVENTS_SECRET')).update(body).digest('hex');
      await this.http.post(`${API_INTERNAL_URL}/internal/events`, body, {
        headers: { 'Content-Type': 'application/json', 'X-Internal-Auth': sig },
        timeout: 1000, // не должен блокировать игровую операцию
      });
    } catch (err) {
      this.logger.warn(`EventsClient: track failed (${type}, ${actor.id}): ${err.message}`);
      // best-effort — event может потеряться. Игровая операция не должна падать.
    }
  }
}
```

В `game.service.ts` (game-service) добавляется `private readonly eventsClient: EventsClientService` и `trackBoth(whiteId, blackId, type, payload)` по образцу apps/api L80–99 (с тем же исключением `STOCKFISH_BOT_ID`). Метод вызывается из endGame/resign/handleDrawOffer/createGame по тем же точкам, что и в apps/api.

### 4.4. Почему cross-process listeners не нужны

HintsEngine listeners в apps/api `EventsService.onTrack` — это реактивный triggers для следующего hint показа. В варианте E все события, включая из game-service, **проходят через тот же apps/api EventsService.track** (он вызывается из internal-controller'а) — значит **listeners срабатывают для всех событий одинаково**.

Это ключевое преимущество E над A/B/C: даже без отдельного cross-process bus реактивность hints для бот-партий работает «бесплатно».

### 4.5. Контракт `game_end.payload.result` — фиксируется per-actor

Часть унификации: оба сервиса при формировании payload для каждого игрока считают `result` как `'win'|'loss'|'draw'` (см. §1.5 формула). После этого в DSL правил можно писать:
```json
{"count": {"event": "game_end", "where": {"result": "loss"}, "windowDays": 7, "gte": 3}}
```

и оно срабатывает на сдачу/мат/таймаут одинаково — что и требует пользователь.

---

## 5. План внедрения

### 5.1. Тикеты (предлагается завести)

| # | Тикет | Кто | Содержание | Зависимости |
|---|-------|-----|------------|-------------|
| **G1** | **shared: пакет `packages/events-client`** | backend | Создать `packages/events-client` (или подкаталог в `packages/shared`): типы `Actor`, `EventPayload`, `TrackEvent`, константы `ACTOR_EVENTS_STREAM`/`MAXLEN`/`WRITER_GROUP`, pure-функция `serializePayload`, тип `InternalEventsRequestDto`. Никаких Nest-зависимостей. Bump shared/новой версии. Тесты на `serializePayload` (round-trip JSON, edge cases). | — |
| **G2** | **backend (apps/api): internal-controller `POST /internal/events` + HMAC auth** | backend | Новый `apps/api/src/events/internal-events.controller.ts` + middleware `internal-events-auth.middleware.ts` (HMAC SHA256 по `INTERNAL_EVENTS_SECRET`). Использует существующий `EventsService.track()` без правок. Env-var `INTERNAL_EVENTS_SECRET` (документ + AWS Secrets Manager). Тесты: валидный HMAC → 202, невалидный → 401, malformed body → 400. | G1 |
| **G3** | **backend (apps/api): фикс `game_end.payload.result` в `trackBoth`** | backend | `apps/api/src/game/game.service.ts` L80–99: конвертация per-game `result` ('white'/'black'/'draw') → per-actor `result` ('win'/'loss'/'draw') перед XADD. Обновить тесты `game.service.spec.ts`. **Не часть unified-источника, но обязательный фикс контракта payload** (см. §1.5). | — (можно параллелить с G1/G2) |
| **G4** | **backend (apps/game-service): EventsClientService + self-emit в game.service.ts** | backend | <ul><li>Новый `apps/game-service/src/events/events-client.module.ts` + `events-client.service.ts` — HTTP-клиент к `POST /internal/events` с HMAC, timeout 1s, best-effort (try/catch + log).</li><li>В `apps/game-service/src/game/game.service.ts` добавить `private readonly eventsClient` + `trackBoth(...)` helper (зеркало apps/api L80–99, включая исключение `STOCKFISH_BOT_ID` и фикс per-actor `result` из G3).</li><li>Вставить `track('game_start', ...)` в момент создания live/бот-партии, `track('resign', ...)` в `resign(...)`, `track('draw_offered', ...)` в `handleDrawOffer(...)`, `track('game_end', ...)` в `endGame(...)`.</li><li>Тесты: смок-тест что `eventsClient.track` вызывается с правильными параметрами; unit на HTTP-клиента с mock fetch.</li></ul> | G1, G2, G3 |

Cуммарно: ~3–4 дня backend.

### 5.2. После выкладки

- Координатор пингует backend пройтись `PATCH /admin/hints/<id-of-analyze-after-resign>` чтобы переименовать правило в `analyze-after-loss` и подменить DSL с `count resign` на `count game_end where{result:'loss'}` (см. §4.5). Это **одна команда**, без правок кода (благодаря ADR-148).
- Проверить в Grafana `actor_events_ingested_total{type='game_end', actor_type='user'}` после деплоя — rate должен заметно вырасти (учитываются бот-партии и live-WS-партии).

### 5.3. Совместимость и rollout

- G1 → G2 → G4 — последовательная цепочка по контракту. G3 параллелен.
- Промежуточное состояние «G2 задеплоен, G4 ещё нет» — безопасное: apps/api умеет принимать internal-события, никто пока не шлёт.
- Промежуточное состояние «G4 задеплоен, G2 ещё нет» — недопустимое: game-service будет получать 404 на POST. Поэтому деплой строго в порядке G2 → G4.
- Откат: выключение G4 на game-service возвращает текущее состояние (apps/api продолжает self-emit, game-service не шлёт). Никаких breaking changes для других модулей.

---

## 6. Что НЕ меняется

- `EventsService` в apps/api — без правок логики (consent, listeners, XADD).
- `HintsEngine`, ListenersBus — без правок.
- DSL правил подсказок — без правок (после G3 правило `analyze-after-loss` через `PATCH /admin/hints` без code change, благодаря ADR-148).
- Структура `actor_events` и matviews — без правок.
- ADR-012 (api ↔ game-service split) — без правок. game-service остаётся WS-primary.
- ADR-147 §2.2 (Redis Streams + writer + matviews) — без правок.
- Стрим `actor_events:stream` — тот же, MAXLEN тот же.

---

## 7. Открытые вопросы (вне scope)

1. **`move_made` событие.** Не входит в этот ADR — это масштабная задача (объём ~2 событий/секунду на каждую активную партию × N партий = быстро вырастает в десятки событий/sec). Заводить отдельным ADR с обоснованием объёма, retention, индексов. Сейчас никакое правило hints не требует `move_made`.
2. **Бот-actor в actor_events.** Сейчас события для бота не пишутся (`STOCKFISH_BOT_ID` исключается из `trackBoth`). Это правильно для hints (бот не получает подсказок). Если когда-то понадобится бот-аналитика (например, для качества тренировки) — отдельный ADR с своей категорией actor (`actor_type='bot'`).
3. **Внутренняя network между ECS-task.** Сейчас apps/api экспонирован через ALB. game-service может ходить либо через тот же ALB (внешний trip, лишний latency), либо через private service-discovery (Cloud Map / VPC peering). Решение по транспорту — devops-deтальа, должна выбираться при реализации G4 (предположительно через Cloud Map по образцу archive-service ADR-018).

---

## 8. Резюме

- Архитектурный разрыв: apps/api self-emit'ит game-события, apps/game-service — нет; правила hints не срабатывают для бот- и live-WS-партий.
- Рассмотрены 5 вариантов унификации, выбран гибрид **B (общие типы в `packages/events-client`) + E (internal HTTP `POST /internal/events` от game-service к apps/api)**.
- E удовлетворяет букве «точка входа одна»: `EventsService.track` живёт только в apps/api, consent-гейт и in-memory HintsEngine-listeners работают для всех событий — включая из game-service.
- Дополнительный фикс контракта: `game_end.payload.result` per-actor (`'win'|'loss'|'draw'`), без которого правило `analyze-after-loss` не выразимо.
- План — 4 тикета (G1–G4) на ~3–4 дня. После выкладки координатор обновляет правило `analyze-after-resign` → `analyze-after-loss` через `PATCH /admin/hints` (без code change, ADR-148).
