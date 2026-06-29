# ADR-151 — Реплей контекстной подсказки при handleConnection без переоценки DSL и canShow

- Статус: **Proposed** (2026-06-29)
- Дата: 2026-06-29
- Связанные задачи: KS-4788 (этот ADR), KS-4785 (бридж-промо: чинили DSL и UUID-каст), KS-4786 (текущий replay через checkFor — отменяется)
- Связанные ADR: ADR-147 (контекстные подсказки), ADR-148 (zero-code rules), ADR-150 (test automation)
- Автор: architect

---

## 0. TL;DR

Текущий replay подсказок на `MessageGateway.handleConnection` (KS-4786) реализован вызовом `HintsService.checkFor({triggerEventType:'ws_connected'})` — полный pipeline: загрузка hints → DSL-эвалюация → per-hint фильтры → `canShow` (global throttle) → `markShown` → `emitHintShow`. Из-за этого после первичного матча (например, на `page_view`), который успел поставить `globalThrottle:<actor>` TTL=600s, **повторный checkFor на `ws_connected` через 1–2 секунды получает `canShow=false` и не реплеит ничего**, хотя фактически клиент так и не отрисовал popover (старый WS отключился до `server.to(...).emit`).

Меняем механизм: replay становится **отдельным путём данных**, который **не оценивает DSL**, **не вызывает `canShow`/`markShown`** и **не правит throttle/session-счётчики**. Источник истины — `ActorHintState` (server-emit) сверенный с client-ack по новому полю `shownAckAt`. Алгоритм: при `handleConnection` найти hint, где `lastShownAt > now - replayWindow` AND `shownAckAt IS NULL OR shownAckAt < lastShownAt` AND `dismissedAt IS NULL` AND `actedAt IS NULL` AND `Hint.enabled = true AND deletedAt IS NULL` — построить `HintShowPayload` из актуальной строки `Hint` и эмитнуть `hint:show` в room `user:<id>`. Никаких боковых эффектов на state — re-emit идемпотентен.

Чтобы условие `shownAckAt < lastShownAt` работало, разделяем семантику двух timestamp'ов в `ActorHintState`:
- `lastShownAt` = **server-emit attempt** (пишется только `HintsService.checkFor` при первичном матче);
- `shownAckAt` = **client confirmed render** (новое поле; пишется только `HintsController.shown` от клиентского `POST /hints/:hintId/shown`).

Окно реплея — env `HINTS_REPLAY_WINDOW_SEC` (default 60). После окна старый payload неактуален. Throttle 600s на проде остаётся, он управляет **первичными** показами (по DSL); replay им не управляется.

---

## 1. Контекст

### 1.1. Воспроизведённый сценарий гонки

```
T+0.000  Пользователь перезагружает /analysis (3-й WASM-toggle).
T+0.000  Старый WS отключается. Room user:<id> пустеет (Socket.IO adapter
         удаляет socket из rooms по transport close).
T+0.020  Frontend пишет analytics_engine_started → POST /events.
T+0.040  EventsService.track → HintsListener.onTrack → REACTIVE_TYPES.has →
         HintsService.checkFor({page:'/analysis', triggerEventType:'engine_started'})
T+0.060  DSL bridge-promo-after-3-wasm даёт match.
T+0.061  canShow: throttle не выставлен, sessionCount=0 → true.
         markShown: SET hints:throttle:<id> 1 EX 600 NX → выставлено.
         INCR hints:session:<id>:<date>.
T+0.062  ActorHintState upsert: shownCount=1, lastShownAt=T+0.062.
T+0.063  gateway.emitHintShow(userId, payload) → server.to(user:<id>).emit
         — room пустая, listeners=0, payload дропнут на стороне Socket.IO.
T+0.064  HintsService.checkFor возвращает payload (server-side success).

T+1.800  Frontend завершает page reload, инициализирует Socket клиента,
         handshake. MessageGateway.handleConnection:
T+1.820  client.join(user:<id>).
T+1.821  hints.checkFor({page:lastPage, triggerEventType:'ws_connected'}).
T+1.840  DSL снова даёт match (правило статично).
T+1.841  canShow: throttle exists=1 → false. Возврат null. Replay
         не произошёл.

T+5.000  Frontend шлёт реактивный page_view после reload → checkFor →
         canShow=false → no-match.

T+0.000 + 600s = T+600.000  Throttle TTL истекает. Следующий matching
         трeger сработает только тогда. До этого момента пользователь
         не видит ни одной подсказки.
```

### 1.2. В чём корень проблемы

1. **`lastShownAt` сейчас семантически перегружен.** Его пишут оба пути: `HintsService.checkFor` (когда сервер _пытался_ эмитнуть) и `HintsController.shown` (когда клиент _подтвердил_ рендер). По одному полю нельзя отличить «сервер пытался, клиент не видел» от «клиент видел и закрыл по ttl».
2. **`canShow` — это политика первичного показа, не политика доставки.** Global throttle 600s защищает от «спама подсказок один за другим из-за частых триггеров». На replay уже принятого hint-payload'а он не должен влиять.
3. **DSL-эвалюация в replay-пути избыточна и опасна.** На момент handshake условия DSL могут уже не выполняться (например, окно `count windowMin:30` могло сдвинуться). Если бы canShow вдруг прошёл, replay получил бы `no-match` и тоже бы ничего не показал — хотя _конкретный_ hint уже был найден 2 секунды назад.
4. **Тест-режим закрывает проблему обнулением throttle (`HINTS_TEST_MODE=1` → globalThrottleSec=0).** На проде эти лимиты нужны для антиспама, отключать нельзя.

### 1.3. Почему именно `handleConnection`

WS-handshake — это единственное событие, гарантированно происходящее **после** того, как клиент полностью готов получать `hint:show` (browser script started, Socket.IO client сконструирован, JWT валиден, room joined). До handshake — `server.to(user:<id>).emit` уходит в пустую room. Это семантическая точка восстановления, привязка replay'а к ней корректна.

Альтернативу «retry-с-таймером в HintsService после первого emit» отвергаем (см. §6.4): добавляет фоновый таймер на каждый emit, не знает, успел ли клиент подключиться, и в худшем случае всё равно может прозевать handshake.

---

## 2. Решение

### 2.1. Разделение путей: primary emit и replay

```
┌──────────────────────────────────────────────────────────────────────┐
│ PRIMARY EMIT (без изменений)                                         │
│ HintsListener (page_view, engine_started, ...) →                     │
│   HintsService.checkFor(actor, ctx)                                  │
│     consent → killswitch → quiet-page → load Hints →                 │
│     load ActorHintStates → per-hint filters →                        │
│     evaluateRule (DSL) → canShow → markShown →                       │
│     upsert ActorHintState { shownCount++, lastShownAt=now } →        │
│     emitHintShow                                                     │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ REPLAY (новое; не из checkFor)                                       │
│ MessageGateway.handleConnection →                                    │
│   HintsService.replayPending(actor)                                  │
│     SELECT ActorHintState s JOIN Hint h ON s.hint_id = h.id          │
│       WHERE s.actor_id = $id AND s.actor_type = $type                │
│         AND s.last_shown_at > now() - replay_window                  │
│         AND s.dismissed_at IS NULL                                   │
│         AND s.acted_at IS NULL                                       │
│         AND (s.shown_ack_at IS NULL OR s.shown_ack_at < s.last_shown_at)
│         AND h.enabled = true AND h.deleted_at IS NULL                │
│       ORDER BY s.last_shown_at DESC                                  │
│       LIMIT 1                                                        │
│     если найдено — toShowPayload(h, locale) и emit. Никаких UPDATE.  │
│   gateway.emitHintShow(userId, payload)                              │
└──────────────────────────────────────────────────────────────────────┘
```

Два пути _не_ переиспользуют код друг друга (кроме чистой функции `toShowPayload`). Это сознательное решение: общий метод с флагом `mode: 'primary' | 'replay'` приведёт к ветвлению на каждом шаге (canShow if not replay, markShown if not replay, …) и потере явности. Дешевле два понятных метода.

### 2.2. Поле `shownAckAt` в `ActorHintState`

Семантика двух timestamp'ов разводится:

| Поле | Кто пишет | Когда |
|------|-----------|-------|
| `lastShownAt` | `HintsService.checkFor` (primary path) | После успешного matching + markShown, перед emitHintShow. **`HintsController.shown` это поле больше НЕ пишет.** |
| `shownAckAt` (новое) | `HintsController.shown` (POST /hints/:hintId/shown) | На каждом приходящем `kind:'shown'` от клиента, после успешного render'а popover. |
| `dismissedAt` | `HintsController.dismissed` | Без изменений. |
| `actedAt` | `HintsController.acted` + smart-dismiss | Без изменений. |
| `shownCount` | оба пути (primary checkFor + controller POST /shown) | Без изменений — отражает агрегат «сколько раз эмитили + сколько раз клиент подтверждал». Для replay не используется (используется только сравнение `shownAckAt vs lastShownAt`). |

`POST /hints/:hintId/ignored` — отдельный момент. Сейчас он пишет `lastShownAt = now`, что после ввода `shownAckAt` становится бессмысленным («сервер не пытался эмитить только что — клиент сам закрыл по ttl»). По симметрии меняем: `ignored` пишет `shownAckAt = now` (если клиент сообщил ignored, значит он точно видел), `lastShownAt` не трогает.

### 2.3. `replayWindow`

Окно, в течение которого «пропущенный» payload остаётся актуальным для повторной отправки.

- Env: `HINTS_REPLAY_WINDOW_SEC`, default `60`.
- Читается через тот же `HintsLimitsService.getLimits()` с локальным кэшем 60с.
- Поверх `HINTS_DEFAULTS_OVERRIDE_JSON` тоже принимает поле `replayWindowSec`.
- Тест-режим `HINTS_TEST_MODE=1` оставляет default (тесту удобно иметь длинное окно).

Обоснование 60 секунд:
- Типичный page reload (Chrome dev tools «hard reload» с включённым cache disable) укладывается в 1–5 секунд от disconnect до reconnect. 60s — десятикратный запас.
- Длинный reconnect (network blip > 30s) — пользователь уже сменил контекст, реплей по факту неуместен; короче ставить нет смысла, дольше — рискуем показать неактуальный popover.

### 2.4. Идемпотентность replay'а

Replay **не правит state** — нет UPDATE, нет инкрементов, нет Redis-записей. Это даёт:
- При нескольких сокетах одного пользователя (multi-tab) replay срабатывает на каждом handshake до получения первого ack. Как только первый tab отрендерит popover → POST /shown → `shownAckAt = now`, replay перестанет срабатывать для остальных handshake'ов.
- Если в окне 60s произойдут 3 reconnect'а подряд (нестабильная сеть) до того, как клиент успеет отрендерить и отослать ack — пользователь получит 3 одинаковых `hint:show` event'а. Frontend `<HintHost>` уже умеет deduplicate по `hintId` (popover на экране уже есть — новый событие игнорируется). Это accepted-trade-off: лучше дубль на handshake, чем тишина.
- Replay никогда не «обнуляет» throttle 600s. После первичного матча next-primary эмит этому actor'у не выйдет ещё 10 минут — replay лишь восстанавливает _уже сматченный_ payload.

### 2.5. Удаление текущего вызова в handleConnection

Из `MessageGateway.handleConnection` убирается блок `void this.hints.checkFor({…, triggerEventType:'ws_connected'})` (KS-4786). На его место — `await this.hints.replayPending({type:'user', id: payload.sub})` с fire-and-forget семантикой (try/catch, no-throw).

Триггер `'ws_connected'` больше не нужен ни в `triggerEventType`, ни в `REACTIVE_TYPES` (его там и не было). Если в будущем потребуется telemetry-метка «была попытка replay при connect» — это обычная Prometheus-метрика, а не псевдо-event.

### 2.6. Что не меняется

- `HintsService.checkFor` сигнатура и поведение — без изменений.
- DSL-эвалюация — без изменений.
- Лимиты `HintsLimitsService.canShow`/`markShown` — без изменений.
- WS-emit `MessageGateway.emitHintShow` — без изменений.
- Pull для гостей `GET /hints/pending` — без изменений. Гостям replay при WS не нужен (у них нет WS).

---

## 3. Псевдокод нового метода

```ts
// apps/api/src/hints/hints.service.ts (новый метод)

/**
 * KS-4788 / ADR-151. Replay недоставленных подсказок при WS handshake.
 * НЕ оценивает DSL, НЕ применяет canShow/markShown, НЕ правит state.
 * Возвращает массив payload'ов (0 или 1 элемент в первой реализации).
 */
async replayPending(actor: Actor): Promise<HintShowPayload[]> {
  const owner = this.prismaSvc.getOwner();
  if (!owner) return [];

  const { replayWindowSec, enabled } = this.limits.getLimits();
  if (!enabled) return [];
  if (!replayWindowSec || replayWindowSec <= 0) return [];

  const since = new Date(Date.now() - replayWindowSec * 1000);

  // Один SELECT с JOIN, индексируется по PK (actor_id, hint_id).
  // Для горячего пути выбор первого подходящего candidate'а ок.
  const candidates = await owner.actorHintState.findMany({
    where: {
      actorId: actor.id,
      actorType: actor.type,
      lastShownAt: { gt: since },
      dismissedAt: null,
      actedAt: null,
      // shownAckAt IS NULL OR shownAckAt < lastShownAt:
      // Prisma не умеет column-to-column сравнение в where напрямую,
      // выражаем через дополнительный фильтр + код-проверку.
    },
    include: {
      hint: { select: { id: true, key: true, i18n: true, cta: true, anchor: true, placement: true, ttlSec: true, enabled: true, deletedAt: true } },
    },
    orderBy: { lastShownAt: 'desc' },
  });

  for (const s of candidates) {
    if (!s.hint || !s.hint.enabled || s.hint.deletedAt) continue;
    if (s.shownAckAt && s.shownAckAt >= s.lastShownAt!) continue;
    // Готовый payload — берётся из АКТУАЛЬНОЙ строки hints (свежая i18n,
    // обновлённый anchor/placement, если админ менял). Это норма:
    // показываем тот же hintId, но с актуальным текстом.
    const payload = toShowPayload(s.hint, /* locale */ 'ru');
    this.metrics.replayEmitted.inc({ actor_type: actor.type });
    return [payload];
  }

  this.metrics.replaySkipped.inc({ actor_type: actor.type, reason: 'no_candidate' });
  return [];
}
```

```ts
// apps/api/src/message/message.gateway.ts (замена блока KS-4786)

async handleConnection(client: Socket) {
  try {
    const token = client.handshake.auth?.token || client.handshake.query?.token;
    if (!token) { client.disconnect(); return; }
    const payload = this.jwtService.verify<JwtPayload>(String(token));
    client.data.user = { id: payload.sub, username: payload.username };
    await client.join(`user:${payload.sub}`);

    // KS-4788 / ADR-151: replay (без DSL, без canShow). Идемпотентен.
    try {
      const replays = await this.hints.replayPending({ type: 'user', id: payload.sub });
      for (const p of replays) this.emitHintShow(payload.sub, p);
    } catch (err) {
      this.logger.debug?.(`replayPending failed: ${(err as Error).message}`);
    }

    // ... остальное без изменений (online tracking, friend status).
  } catch { client.disconnect(); }
}
```

---

## 4. Миграция БД и обратная совместимость

### 4.1. Schema change (`packages/events-db`)

```prisma
model ActorHintState {
  actorId         String   @map("actor_id") @db.Uuid
  actorType       String   @map("actor_type") @db.VarChar(8)
  hintId          String   @map("hint_id") @db.Uuid
  shownCount      Int      @default(0) @map("shown_count")
  lastShownAt     DateTime? @map("last_shown_at")
  shownAckAt      DateTime? @map("shown_ack_at")   // NEW (KS-4788)
  dismissedAt     DateTime? @map("dismissed_at")
  actedAt         DateTime? @map("acted_at")
  suppressedUntil DateTime? @map("suppressed_until")

  hint Hint @relation(fields: [hintId], references: [id])

  @@id([actorId, hintId])
  @@index([actorId, suppressedUntil])
  @@map("actor_hint_states")
}
```

SQL:
```sql
ALTER TABLE events.actor_hint_states
  ADD COLUMN shown_ack_at TIMESTAMPTZ NULL;
-- индекс не обязателен: запросы идут по PK (actor_id), кардинальность
-- states/actor мала (десятки строк max на пользователя), full-scan
-- по этим строкам O(1) на уровне query planner'а.
```

### 4.2. Обратная совместимость на момент миграции

- Все существующие строки `actor_hint_states` получат `shown_ack_at = NULL` (nullable column, dump-friendly).
- `NULL < lastShownAt` по правилу replay-условия означает «клиент не подтвердил» → replay сработает для ВСЕХ старых hints в окне 60s после деплоя. На практике это безвредно: окно 60s означает, что в момент деплоя в этом окне реально лежат единицы строк (≤1 hint показан за последние 60 секунд каждому активному пользователю при глобальном throttle 600s). После первого ack эти строки выйдут из replay-области.
- Кода, который читал бы `shownAckAt` где-то ещё, не существует — это новое поле, риск побочек только в путях, которые мы сами правим.

### 4.3. Изменения в HintsController

Семантика `POST /hints/:hintId/shown` и `POST /hints/:hintId/ignored` меняется (см. §2.2):

```ts
// shown: пишем только shownAckAt + инкремент shownCount, lastShownAt не трогаем
case 'shown':
  await owner.actorHintState.upsert({
    where: { actorId_hintId: { actorId: actor.id, hintId } },
    create: {
      actorId: actor.id, actorType: actor.type, hintId,
      shownCount: 1, shownAckAt: now,
      // lastShownAt не выставляем: для create-ветки это значит, что
      // controller получил ack без предшествующего checkFor — аномалия,
      // но если такое произойдёт (например при ручном POST из dev-tools),
      // запись остаётся в БД с lastShownAt=NULL — replay её не выберет.
    },
    update: { shownCount: { increment: 1 }, shownAckAt: now },
  });
  break;

// ignored: семантика — клиент видел и закрыл по ttl, lastShownAt не трогаем
case 'ignored':
  await owner.actorHintState.upsert({
    where: { actorId_hintId: { actorId: actor.id, hintId } },
    create: {
      actorId: actor.id, actorType: actor.type, hintId,
      shownAckAt: now,
    },
    update: { shownAckAt: now },
  });
  break;
```

`dismissed` и `acted` не меняются — они уже работают через свои поля.

---

## 5. Граничные случаи и поведение

| Сценарий | Что произойдёт |
|----------|----------------|
| Hint показался → клиент успел render → POST /shown пришёл (T+200мс). Через 1с reconnect. | `shownAckAt > lastShownAt` → replay skip. Дубля не будет. |
| Hint показался → клиент не получил emit (race). Через 2с reconnect. | `shownAckAt IS NULL`, `lastShownAt > now-60`, `dismissedAt IS NULL`, `actedAt IS NULL` → replay срабатывает. ✓ |
| Через 70с после первичного emit (никакого ack) handshake. | `lastShownAt < now - 60` → replay skip. Hint потерян до следующего триггера; это допустимая граница свежести. |
| Hint показался, клиент явно нажал × → POST /dismissed (T+5с). Через 1с reconnect. | `dismissedAt != NULL` → replay skip. ✓ |
| Hint показался, клиент кликнул CTA → POST /acted. Через 1с reconnect. | `actedAt != NULL` → replay skip. ✓ |
| Hint показался, админ удалил/выключил hint в `/admin/hints` за минуту. Reconnect. | `Hint.enabled=false OR deletedAt!=NULL` → replay skip. ✓ |
| Multi-tab: tab #1 получил `hint:show`, отрендерил, POST /shown. Tab #2 reconnect (новый сокет). | `shownAckAt > lastShownAt` → replay skip. Tab #2 не получит дубль popover. ✓ |
| Multi-tab: оба tab'а коннектятся одновременно после reload, ни один ещё не отрендерил → replay срабатывает на handshake обоих. | Оба получат `hint:show`. `<HintHost>` на frontend дедупит по hintId — popover будет один. Accepted: server не может надёжно различить «два таба одного пользователя» при одновременном handshake. |
| Hint изменил `i18n.title` в админке между emit и replay. | Replay использует свежий `toShowPayload(hint, locale)` — пользователь увидит новый текст. Это норма, тексты должны быть актуальными. |
| Hint изменил `anchor` на DOM-узел, который отсутствует на текущей странице, между emit и replay. | Клиент получит `hint:show`, не найдёт anchor → POST /hints/:hintId/dismissed `reason='no_anchor'`. `dismissedAt` выставится → cooldown. Это норма: при изменении anchor админом старые pending'ы естественно сбрасываются. |
| Network blip 30c (старый сокет умер, новый поднялся, тот же `user_id`). Был неотрендеренный hint. | На новый handshake replay срабатывает. ✓ |
| Replay в момент, когда `HINTS_ENABLED=false`. | `getLimits().enabled=false` → replayPending возвращает []. ✓ |

---

## 6. Альтернативы

### 6.1. ❌ Bypass throttle для `triggerEventType='ws_connected'` в `checkFor`

Идея: добавить в `HintsLimitsService.canShow` опциональный параметр `bypassThrottle=true`, который выставляется в `checkFor` если ctx.triggerEventType === 'ws_connected'.

Минусы:
- Сохраняет DSL-эвалюацию на пути replay — между T+0 и T+2 окно `windowMin` могло сместиться, hint, который реально нужно повторить, на ws_connected уже не сматчится по DSL.
- Размывает контракт `canShow`: «можно показать?» → становится «можно показать с/без bypass?» — два кейса в одной функции с противоположной семантикой. Завтра ещё bypass добавится → ветвление множится.
- Reuses primary path, но primary path делает markShown — на replay не нужно, иначе тот же hint после ack пользователя ещё раз эмитнётся через 10 минут и опять markShown — счётчик сессии накручивается на доставке, не на показах.

Отвергнуто. Bypass правит симптом (canShow), не разделяет роль (primary vs replay).

### 6.2. ❌ Redis pending hash `hints:pending:user:<id> = {hintId: payload}` TTL 60s

Идея: `HintsService.checkFor` после успешного emit делает `HSET hints:pending:user:<userId> <hintId> <payload>` + `EXPIRE 60`. На `POST /hints/:hintId/shown` → `HDEL`. На handleConnection → `HGETALL` + emit для каждого, без `DEL` (TTL чистит).

Плюсы: hot-path без БД-вызова; уже есть прецедент `hints:pending:<guest_id>` для гостей.

Минусы:
- Дублирует source-of-truth: и `ActorHintState.lastShownAt` пишется, и Redis-hash. При расхождении (например, Redis перезапустился, БД не) — состояние теряется.
- Условие задачи прямо говорит: «через ActorHintState.lastShownAt». Это уточнение от backend, который заметил, что у нас уже есть persisted state, и не нужно вводить ещё один слой.
- При guest→user merge (ADR-147 §1.1) появляется дополнительная пара ключей для миграции SCAN+RENAME+DEL — для user'ов и hash тоже придётся обрабатывать.

Не выбираем для user-actor. Для гостей оставляем существующий механизм `hints:pending:<guest_id>` через LIST — он соответствует pull-модели (LPOP по факту запроса), там state нужен в Redis. Для user — replay через БД.

### 6.3. ❌ ActorHintState без `shownAckAt`, только `lastShownAt` и `shownCount`

Идея: использовать сам факт «`lastShownAt > now - 60s` AND `dismissedAt IS NULL` AND `actedAt IS NULL`» как условие replay, без отдельного ack-поля. Чтобы избежать дубля «уже видел, но висит в окне» — при `POST /hints/:hintId/shown` обнулять lastShownAt (или ставить в прошлое).

Минусы:
- Семантика `lastShownAt` уходит в «когда сервер пытался ИЛИ когда клиент ack-нул» — невозможно отличить, для аналитики плохо.
- При шумной сети ack приходит позже emit на 200мс — между emit и ack reconnect (типичный sequence при дешёвом WiFi) реплеит, ack приходит, обнуляет lastShownAt — теряем legitimate показатель «когда последний раз эмитили».
- Делает сложно метрику `hints_shown_ack_lag_seconds` (разница emit vs ack) — нужны оба timestamp'а.

Отвергнуто. Стоимость отдельного поля — одна миграция, нулевые операционные расходы; чистота семантики того стоит.

### 6.4. ❌ Retry-таймер в HintsService после первого emit

Идея: после `emitHintShow` запускать `setTimeout(2000, () => if (!ackReceived) re-emit)`. Через `HintsListener` или специальный AckRegistry проверять, пришёл ли `POST /hints/:hintId/shown` за окно.

Минусы:
- Stateful таймер на одном инстансе backend'а — при горизонтальном масштабе backend (несколько task'ов в ECS) таймер живёт только на инстансе, который сделал emit. Если клиент reconnect'ится на другой инстанс — таймер на первом инстансе всё равно сработает и сделает no-op (или из-за room user:<id> в Socket.IO без Redis-adapter'а — вообще не дойдёт). Нужен распределённый Redis-based scheduler.
- Если клиент не успел reconnect'нуться за 2 секунды — таймер expir'нется без эффекта. Через 5 секунд клиент подключается, hint потерян. Окно 60s с handshake-trigger покрывает этот случай естественно.
- Лишние Redis-операции (хранить «жду ack»), мониторинг таймеров.

Отвергнуто. handleConnection — естественная точка восстановления, не нуждается в дополнительной фоновой машинерии.

### 6.5. ❌ Buffer в Socket.IO Redis-adapter (offline buffering)

Идея: использовать `socket.io-redis-adapter` с offline-buffer — если room пустая, событие копится в Redis и доставляется при следующем подключении.

Минусы:
- Текущая инфраструктура `MessageGateway` не использует Redis-adapter (по `apps/api/src/message/message.module.ts` — local-only adapter). Включение Redis-adapter — отдельная инфра-задача с побочными эффектами на all-other gateways (game, live-analysis, arena) и кросс-инстансным cross-room broadcast'ом.
- Offline-buffer Socket.IO не различает «один и тот же payload, который нужно дослать» и «несколько payload'ов, которые накопились»; для hints с deduplication по hintId это не идеально.
- Перевод всех gateways на Redis-adapter — оправдан в горизонтальном масштабировании, но это другая задача (см. потенциальный ADR по multi-instance backend), не точечный фикс bridge-promo.

Отвергнуто как over-engineering для текущей точки.

---

## 7. Метрики и observability

Новые метрики в `HintsMetricsService` (Prometheus, label `actor_type`):

| Метрика | Тип | Когда инкрементируется |
|---------|-----|------------------------|
| `hints_replay_attempts_total{actor_type}` | counter | На каждый вход в `replayPending` (handleConnection). |
| `hints_replay_emitted_total{actor_type}` | counter | Когда `replayPending` вернул payload. |
| `hints_replay_skipped_total{actor_type, reason}` | counter | `reason` ∈ {`no_candidate`, `window_expired`, `already_acked`, `dismissed_or_acted`, `hint_disabled`}. |
| `hints_shown_ack_lag_seconds{actor_type}` | histogram | На каждом `POST /hints/:hintId/shown`: `shownAckAt - lastShownAt`. Покажет, насколько часто бывает race на handshake и насколько долго клиент идёт до ack. |

Buckets `hints_shown_ack_lag_seconds`: `[0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60]` — покрывают типовой ack-lag (50–500мс) и хвост.

Логи `HintsListener` для входа `handle` снижаются до `debug` после прохода бридж-промо ($KS-4785 диагностика) — отдельным мини-тикетом, не часть этого ADR.

---

## 8. Тестируемость

### 8.1. Юниты (`hints.service.spec.ts`)

Матрица `replayPending`:

| `lastShownAt` | `shownAckAt` | `dismissedAt` | `actedAt` | `hint.enabled` | `hint.deletedAt` | ожидаем |
|---|---|---|---|---|---|---|
| now-30s | NULL | NULL | NULL | true | NULL | payload |
| now-30s | now-29s | NULL | NULL | true | NULL | skip (acked) |
| now-30s | now-31s | NULL | NULL | true | NULL | payload (ack до lastShownAt — стало новое событие) |
| now-90s | NULL | NULL | NULL | true | NULL | skip (window) |
| now-30s | NULL | now-10s | NULL | true | NULL | skip (dismissed) |
| now-30s | NULL | NULL | now-10s | true | NULL | skip (acted) |
| now-30s | NULL | NULL | NULL | false | NULL | skip (disabled) |
| now-30s | NULL | NULL | NULL | true | now-5s | skip (deleted) |
| no state row | — | — | — | — | — | skip (нет состояния) |

`HINTS_ENABLED=false` → `replayPending` возвращает `[]` (общий killswitch). `replayWindowSec=0` → возвращает `[]`.

### 8.2. E2E (`apps/e2e-hints`)

Новый spec `apps/e2e-hints/tests/replay-after-disconnect.spec.ts`:

1. Логиниться как `e2e_user_replay`, перейти на страницу, которая триггерит DSL bridge-promo-after-3-wasm (3 клика по WASM-toggle).
2. На реальной странице оборвать WS до получения `hint:show` (через `page.evaluateOnNewDocument` или CDP `Network.emulateNetworkConditions(offline=true)`).
3. Восстановить сеть (`offline=false`). Socket.IO клиент переподключится автоматически.
4. Ожидать `[data-hint-popover][data-hint-key="bridge-promo-after-3-wasm"]` в течение 10 сек.
5. Проверить через GET `/admin/actor-hint-states?actor_id=<id>` (или прямой SQL в тест-режиме), что `shown_ack_at > last_shown_at`.

Тест-режим `HINTS_TEST_MODE=1` оставляет `replayWindowSec=60` (или больше через override-JSON, если нужно).

### 8.3. Регрессия первичного матча

`hints-rules.spec.ts` (ADR-150 §3.1 L2) при загрузке правил из admin-UI продолжает гонять DSL-эвалюацию — никаких изменений. Замена пути не должна сломать ни один существующий тест.

---

## 9. Влияние на ADR-147

В существующий ADR-147 (§4.1, §4.3, §5.3) добавляются пометки-ссылки на ADR-151:

- §4.1 «Доставка» → добавить упоминание «replay-канал при WS-handshake, см. ADR-151».
- §4.3 «Обратная связь» → уточнить, что `hint_shown` event ставит `shownAckAt`, не `lastShownAt`.
- §5.3 «Состояния» → state diagram остаётся прежним; `shownAckAt` — мета-поле наблюдения доставки, не отдельное состояние.

Сами правки в ADR-147 — мелкие, делаются одним коммитом архитектора в этом же тикете после согласования с координатором (если потребуется — отдельный follow-up).

---

## 10. Roadmap (для координатора)

Замысел: одна задача на backend, без отдельных подзадач — изменения локальны, тесты идут в том же PR.

| # | Задача | Файлы | Кому |
|---|--------|-------|------|
| B1 | Миграция `events.actor_hint_states ADD COLUMN shown_ack_at`. Обновление Prisma schema в `packages/events-db` + `prisma:migrate`. | `packages/events-db/prisma/schema.prisma`, `packages/events-db/prisma/migrations/<ts>_add_shown_ack_at/migration.sql` | backend |
| B2 | `HintsLimitsService`: новое поле `replayWindowSec` (env `HINTS_REPLAY_WINDOW_SEC`, default 60), override-JSON whitelist. | `apps/api/src/hints/hints-limits.service.ts`, `hints.types.ts` (поле `replayWindowSec` в HINTS_DEFAULTS) | backend |
| B3 | `HintsService.replayPending(actor)` — новый метод по §3. | `apps/api/src/hints/hints.service.ts` (+spec) | backend |
| B4 | `HintsController`: `shown` пишет `shownAckAt` (не `lastShownAt`); `ignored` — аналогично. | `apps/api/src/hints/hints.controller.ts` (+spec для двух кейсов) | backend |
| B5 | `MessageGateway.handleConnection`: убрать `checkFor({triggerEventType:'ws_connected'})`, поставить `replayPending`. | `apps/api/src/message/message.gateway.ts` | backend |
| B6 | Метрики `hints_replay_*`, `hints_shown_ack_lag_seconds` в `HintsMetricsService`. | `apps/api/src/hints/hints-metrics.service.ts` | backend |
| B7 | Прогон существующих unit-тестов hints (`hints.service.spec.ts`, `hints.controller.spec.ts`, `hints-dsl.evaluator.spec.ts`) — проверка что primary path не сломан. | — | backend |
| E1 | E2E-сценарий `replay-after-disconnect.spec.ts` (опционально, в рамках ADR-150). | `apps/e2e-hints/tests/replay-after-disconnect.spec.ts` | content / qa |

После B1–B7 — деплой; B6 включает наблюдение `hints_replay_*` на проде на bridge-promo (KS-4784).

---

## 11. Решение

Принять разделение на primary emit (через checkFor) и replay (через `HintsService.replayPending` на handleConnection) с введением поля `ActorHintState.shownAckAt`. Реализация — задачами B1–B7 на backend.
