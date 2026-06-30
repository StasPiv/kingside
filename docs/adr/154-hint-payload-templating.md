# ADR-154 — Шаблонизация payload контекстной подсказки (`{{var}}` подстановка из triggering event)

- Статус: **Proposed** (2026-06-30)
- Дата: 2026-06-30
- Связанные задачи: KS-4824 (этот ADR), KS-4821 (CTA на анализ конкретной партии), KS-4823 (`instructionBody` в payload), KS-4822 (UI «Подробнее» в HintPopover)
- Связанные ADR: **ADR-147 §3.1** (Hint schema, i18n, cta), **ADR-151 §2.2** (`ActorHintState.shownAckAt`, замороженный snapshot для replay), ADR-148 (admin CRUD), ADR-150 (test automation)
- Автор: architect

---

## 0. TL;DR

Выбираем **серверную подстановку `{{var}}` в момент primary emit + сохранение готового payload в `ActorHintState.lastShownPayload` для корректного replay**. Клиент остаётся «глупым»: получает payload с уже резолвенными значениями, ничего не знает про шаблоны и про триггер. Whitelist разрешённых переменных закреплён в `packages/shared/src/types/hint-templating.ts` и **зависит от `trigger_event_type`** (game_end даёт `game_id`/`result`/`time_control`/`rating_delta`, puzzle_failed — `puzzle_id`/`theme`/`attempts`, и так далее). Шаблонизируются только три поля: `ctaHref`, `ctaLabel`, `instructionBody`. `title` и `body` — нет (это короткий копирайт, расширение не нужно). Синтаксис — Mustache-минимум: `\{\{([a-z][a-z0-9_]*)\}\}`, без вложений/условий/фильтров. Поведение при отсутствии значения: `ctaHref` → если хотя бы один `{{var}}` не разрешён, используется опциональный `Hint.cta.fallbackHref`; если fallback отсутствует — CTA-кнопка не показывается (`ctaHref=null`, `ctaLabel=null`). Для `ctaLabel`/`instructionBody` нерешённые плейсхолдеры удаляются (regex replace на пустую строку, trim); если итог пустой — поле становится `null`. Валидация шаблонов происходит **в админ-CRUD** (`POST/PUT /admin/hints`): парсер проходит по полям, проверяет каждый `{{var}}` против whitelist'а, ассоциированного с `acceptedBy` и/или `triggerEventTypes` правила; неизвестная переменная → `400` с указанием места. На replay (`HintsService.replayPending`) подставлять заново нечем — берём snapshot из `ActorHintState.lastShownPayload`. Размер snapshot ≈1 КБ на актора, ≤1 active state одновременно → ≤7 МБ на 7K активных пользователей (целевая нагрузка ADR-147 §2.3) — пренебрежимо.

---

## 1. Контекст и проблема

### 1.1. Почему вообще нужна подстановка

KS-4821 (`analyze-after-loss`) хочет: «третий раз проиграл → popover «Открыть в анализе» → клик ведёт на `/game/<id_той_самой_партии>/review`». В таблице `hints` сейчас `ctaHref` хранится как статичная строка. Без подстановки придётся:
- вариант A: каждое game_id — отдельный hint (не масштабируется);
- вариант B: ctaHref = `/profile`, фронт сам ищет последнюю партию (хрупкий шаринг state между backend rule и frontend UI);
- вариант C: ctaEvent = `open_last_game_review`, фронт-сторона определяет game_id из своего state (то же самое, что B).

Все три плохие. Архитектурно правильный путь — параметризовать payload через подстановку из триггера, который и так известен backend'у на момент match'а.

KS-4823 ввёл `instructionBody` в `HintI18nEntry` — расширенный текст инструкции для попапа. Для `analyze-after-loss` инструкция может содержать «откройте партию [game_id], запустите Stockfish глубину 18…» — те же самые переменные. Симметрично, KS-4822 в UI добавил тоггл «Подробнее» для instructionBody — там тоже шаблоны имеют смысл.

`ctaLabel` — кнопка CTA. Простой кейс — «Открыть партию», без vars. Но иногда полезно: «Открыть рейтингблиц 3+2» (вставка `time_control`). Малая выгода, но шаблонизировать дёшево, и админ-команда сама решит, использовать ли.

### 1.2. Что уже знает backend в момент `checkFor`

- `HintsListener.handle` принимает `(actor, type, payload)` из `EventsService.onTrack`. **`payload` уже содержит все нужные поля** (`game_id`, `result`, `time_control`, `rating_delta` для game_end — см. ADR-147 §2.1).
- В `HintCheckContext` сейчас передаётся только `page` и `triggerEventType` (`hints.types.ts:12`). Расширение контекста на `triggerEventPayload?: Record<string, unknown>` — тривиально.
- `HintsService.checkFor` оперирует `ctx.triggerEventPayload` только на шаге §7 («Payload») — в `toShowPayload`. Остальные шаги (consent → killswitch → quiet → DSL → canShow → markShown) от него не зависят.

### 1.3. Что мешает решению «клиент сам подставляет»

- Клиент не знает контракт payload триггерующего события. Сейчас он не получает payload триггера ни через WS, ни через REST.
- Чтобы клиент знал — backend должен класть `triggerEvent.payload` в `HintShowPayload`. Это:
  - расширяет публичный WS-контракт лишним полем,
  - может протекать чувствительные значения (например, `rating_delta` сам по себе ОК; но если завтра в payload `game_end` появится `opponent_email` — он полетит на клиент),
  - заставляет писать и поддерживать клиентский парсер шаблонов, идентичный серверному (drift-риск).
- В админ-UI превью «как выглядит подсказка после подстановки» требует, чтобы превью знал клиентский парсер — лишний транзит логики.
- Контент-менеджер в админ-UI вводит шаблон, ожидая что он отработает на сервере. Если ввёл с опечаткой — серверный CRUD должен это поймать. Если подстановка на клиенте — серверная валидация всё равно нужна, чтобы поймать опечатку до релиза; так что клиент тоже становится зависимым от того же whitelist.

Вывод: **подстановка на клиенте лишь распределяет работу, не упрощая ничего, и добавляет risk-поверхность**.

### 1.4. Что мешает решению «сервер подставляет, не сохраняет»

ADR-151 (replay-on-WS-connect): при reconnect внутри окна 60 с `HintsService.replayPending` берёт строку `ActorHintState`, грузит `Hint`, пересобирает payload через `toShowPayload(hint, locale)`. На этом пути `triggerEvent.payload` **недоступен** — событие уже ушло в `events.actor_events`, и поднимать его обратно ради подстановки — лишняя ходка в БД. Возможный workaround — «при отсутствии vars в replay сделать fallback» — но тогда пользователь увидит popover с обрезанным CTA (`/profile` вместо `/game/<id>/review`), что хуже, чем не показывать вообще.

Решение: **сохранить готовый `HintShowPayload` в snapshot-поле** `ActorHintState.lastShownPayload jsonb null`. Replay возвращает snapshot напрямую (без `toShowPayload`). Это:
- симметрично текущему ADR-151 решению хранить точку восстановления в БД (`lastShownAt`, `shownAckAt`);
- даёт корректное поведение замены текста админом между emit и replay — replay восстанавливает _тот же_ payload, что не был доставлен. Это правильно: replay — «дослать упущенное», а не «новый показ».
- размер: один payload ≤1 КБ (JSON 10–15 коротких полей); на actor одновременно ≤1 active state (другие — либо acted/dismissed, либо вне окна) → совокупный жирок десятки МБ при 10K active actors.

---

## 2. Решение

### 2.1. Серверная подстановка в момент primary emit

В `HintsService.checkFor`:

```ts
// (внутри блока «7. Payload»)
const rawPayload = toShowPayload(winner, locale);                       // как сейчас
const resolved = applyTemplate(rawPayload, {                            // НОВОЕ
  triggerEventType: ctx.triggerEventType,
  triggerEventPayload: ctx.triggerEventPayload,
});

// Snapshot для replay
await owner.actorHintState.upsert({
  /* ... */
  update: {
    shownCount: { increment: 1 },
    lastShownAt: now,
    lastShownPayload: resolved as Prisma.JsonObject,                    // НОВОЕ
  },
  create: { /* ... */, lastShownPayload: resolved },                    // НОВОЕ
});
await this.limits.markShown(actor);
// emit
if (actor.type === 'user' && this.gateway) this.gateway.emitHintShow(actor.id, resolved);
return resolved;
```

`applyTemplate(payload, ctx)` — чистая функция, живёт в `packages/shared/src/types/hint-templating.ts` (см. §2.4 спецификация).

`HintCheckContext` расширяется одним полем:

```ts
export interface HintCheckContext {
  page?: string;
  triggerEventType?: string;
  triggerEventPayload?: Record<string, unknown>;   // НОВОЕ
  clockLowTimeFocus?: boolean;
}
```

`HintsListener.handle` уже имеет `payload` (вход в onTrack), просто прокидывает дальше:

```ts
result = await this.hints.checkFor(actor, {
  page: ctxPage,
  triggerEventType: type,
  triggerEventPayload: (payload as Record<string, unknown>) ?? undefined,  // НОВОЕ
});
```

Cron-trigger `@Cron('*/30 ...')` для time-since правил передаёт `triggerEventPayload: undefined` — подстановка работает в fallback-режиме (§2.7).

### 2.2. Replay читает snapshot напрямую

`HintsService.replayPending`:

```ts
for (const s of candidates) {
  if (!s.hint || !s.hint.enabled || s.hint.deletedAt) continue;
  if (s.shownAckAt && s.shownAckAt >= s.lastShownAt!) continue;
  // НОВОЕ: snapshot имеет приоритет
  const payload = (s.lastShownPayload as HintShowPayload | null)
    ?? toShowPayload(s.hint, locale);                                     // fallback для строк до миграции
  this.metrics.replayEmitted.inc({ actor_type: actor.type });
  return [payload];
}
```

Fallback `toShowPayload(s.hint, locale)` для строк, существующих до миграции (на момент применения миграции `lastShownPayload IS NULL` у всех старых ActorHintState — это норма, и payload без подстановки → CTA с буквальным `{{game_id}}` смотрелось бы плохо, но: эти строки уже >60 с и replay-окно их не выберет, так что fallback фактически не будет срабатывать в production-сценарии после деплоя). На всякий случай fallback остаётся в коде — защита от непредвиденных миграционных state'ов.

### 2.3. Поля payload, на которые распространяется подстановка

| Поле | Шаблонизируется | Обоснование |
|------|-----------------|-------------|
| `ctaHref` | **Да** | Основной use case (KS-4821). |
| `ctaLabel` | **Да** | Возможны кейсы вроде «Открыть партию [time_control]» — дёшево разрешить. |
| `instructionBody` | **Да** | Расширенный текст инструкции (KS-4823) — самый частый кандидат на параметры. |
| `title` | Нет | Короткий копирайт, не предполагает параметризации. Расширение whitelist полей в этом ADR (через minor follow-up) — допустимо, но без триггера. |
| `body` | Нет | То же. |
| `anchor` | Нет | Это DOM-якорь, должен быть статичной строкой по ADR-148. |
| `ctaEvent` | Нет | Имя клиентского события, статично. |
| `placement` / `ttlSec` / `key` / `hintId` / `locale` | Нет | Контрольные поля, не имеют смысловой параметризации. |

### 2.4. Синтаксис

Минималистичный Mustache-подобный:

```
PLACEHOLDER  = "{{" VAR "}}"
VAR          = [a-z][a-z0-9_]*       ; 1..32 символа
```

Регулярка: `/\{\{([a-z][a-z0-9_]{0,31})\}\}/g`.

**Не поддерживается** (явный отказ):
- Вложенные шаблоны (`{{ {{foo}} }}`).
- Условные блоки / итерации (`{{#if}}`, `{{#each}}`).
- Фильтры / форматтеры (`{{game_id | upper}}`).
- Иные синтаксисы (`${...}`, `%{...}`).

Если в будущем понадобится форматирование (например, склонения числительных) — расширим, но без обратной несовместимости в синтаксисе.

### 2.5. Whitelist переменных по `trigger_event_type`

Whitelist в `packages/shared/src/types/hint-templating.ts`:

```ts
export interface TriggerVarSpec {
  /** Имя переменной в шаблоне (без скобок). */
  name: string;
  /** Из какого поля triggerEvent.payload берётся. */
  payloadField: string;
  /** Тип значения для админ-валидации и для тестов. */
  type: 'string' | 'number' | 'boolean';
}

export const TRIGGER_VAR_WHITELIST: Readonly<Record<string, ReadonlyArray<TriggerVarSpec>>> = {
  game_end: [
    { name: 'game_id',       payloadField: 'game_id',       type: 'string' },
    { name: 'result',        payloadField: 'result',        type: 'string' },  // 'win'|'loss'|'draw'
    { name: 'time_control',  payloadField: 'time_control',  type: 'string' },  // например '3+2'
    { name: 'rating_delta',  payloadField: 'rating_delta',  type: 'number' },
  ],
  game_start: [
    { name: 'game_id',       payloadField: 'game_id',       type: 'string' },
    { name: 'time_control',  payloadField: 'time_control',  type: 'string' },
  ],
  puzzle_solved: [
    { name: 'puzzle_id',     payloadField: 'puzzle_id',     type: 'string' },
    { name: 'theme',         payloadField: 'theme',         type: 'string' },
    { name: 'attempts',      payloadField: 'attempts',      type: 'number' },
  ],
  puzzle_failed: [
    { name: 'puzzle_id',     payloadField: 'puzzle_id',     type: 'string' },
    { name: 'theme',         payloadField: 'theme',         type: 'string' },
    { name: 'attempts',      payloadField: 'attempts',      type: 'number' },
  ],
  rush_end: [
    { name: 'score',         payloadField: 'score',         type: 'number' },
    { name: 'mode',          payloadField: 'mode',          type: 'string' },
  ],
  lesson_start: [
    { name: 'lesson_id',     payloadField: 'lesson_id',     type: 'string' },
    { name: 'course_id',     payloadField: 'course_id',     type: 'string' },
  ],
  lesson_complete: [
    { name: 'lesson_id',     payloadField: 'lesson_id',     type: 'string' },
    { name: 'course_id',     payloadField: 'course_id',     type: 'string' },
  ],
  drill_complete: [
    { name: 'drill_id',      payloadField: 'drill_id',      type: 'string' },
  ],
  analysis_engine_started: [
    { name: 'game_id',       payloadField: 'game_id',       type: 'string' },
  ],
  // Гостевые — без vars: гость не имеет полезных параметров (его id
  // — синтетика, его landing — путь, тоже не часто нужно подставлять).
  // При появлении кейса — расширяем тут.
  guest_landing_viewed: [],
  guest_play_attempted: [],
  // page_view, session_idle, hint_*  — vars нет.
};

export function getTriggerVars(triggerType: string | undefined): ReadonlyArray<TriggerVarSpec> {
  return triggerType ? (TRIGGER_VAR_WHITELIST[triggerType] ?? []) : [];
}
```

**Ключевое свойство**: whitelist привязан к `trigger_event_type`, не глобальный. Это не даёт случайно «протечь» поле, которое случайно совпадает по имени с whitelist'ом, но на другом триггере.

### 2.6. Алгоритм `applyTemplate`

```ts
export interface ApplyTemplateContext {
  triggerEventType?: string;
  triggerEventPayload?: Record<string, unknown>;
}

const PLACEHOLDER_RE = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;

export function applyTemplate(
  payload: HintShowPayload,
  ctx: ApplyTemplateContext,
  /** Опциональный fallback для ctaHref, берётся из Hint.cta.fallbackHref. */
  fallbackHref: string | null = null,
): HintShowPayload {
  const allowed = getTriggerVars(ctx.triggerEventType);
  const resolveVar = (name: string): string | null => {
    const spec = allowed.find((v) => v.name === name);
    if (!spec) return null;                                   // неразрешённая
    const v = ctx.triggerEventPayload?.[spec.payloadField];
    if (v == null) return null;
    // Простая coercion: number/boolean → string, string как есть.
    return String(v);
  };

  // Возвращаем { resolved: string, anyUnresolved: boolean }.
  function replaceField(input: string | null): { value: string | null; anyUnresolved: boolean } {
    if (input == null) return { value: null, anyUnresolved: false };
    let anyUnresolved = false;
    const out = input.replace(PLACEHOLDER_RE, (_, name) => {
      const r = resolveVar(name);
      if (r == null) { anyUnresolved = true; return ''; }     // удаляем плейсхолдер
      return encodeIfHref(r, /* isHref */ false);
    });
    return { value: out, anyUnresolved };
  }

  // Особый случай для ctaHref: подставленные значения URL-encode'им; если
  // anyUnresolved — используем fallback или null.
  const ctaHrefResult = (() => {
    if (payload.ctaHref == null) return null;
    let anyUnresolved = false;
    const out = payload.ctaHref.replace(PLACEHOLDER_RE, (_, name) => {
      const r = resolveVar(name);
      if (r == null) { anyUnresolved = true; return ''; }
      return encodeURIComponent(r);
    });
    return anyUnresolved ? fallbackHref : out;
  })();

  const ctaLabelResult = replaceField(payload.ctaLabel).value?.trim() || null;

  // instructionBody живёт в HintI18nEntry, в payload его пока нет
  // буквально (KS-4823 положил в i18n, ещё не вынесли в HintShowPayload).
  // Когда вынесем — он тоже шаблонизируется через replaceField.
  const instructionBodyInput = (payload as unknown as { instructionBody?: string | null }).instructionBody ?? null;
  const instructionBodyResult = replaceField(instructionBodyInput).value?.trim() || null;

  return {
    ...payload,
    ctaHref: ctaHrefResult,
    ctaLabel: ctaHrefResult ? ctaLabelResult : null,                  // см. §2.7 строгое правило
    ...(instructionBodyInput !== null
      ? { instructionBody: instructionBodyResult } as Partial<HintShowPayload>
      : {}),
  };
}
```

(псевдокод; финальные имена/выравнивание — на реализатора)

### 2.7. Fallback при отсутствии значения

| Поле | Поведение |
|------|-----------|
| `ctaHref` содержит `{{var}}`, `var` не разрешён или payload пуст | `Hint.cta.fallbackHref` (новое опц. поле) если задано; иначе `ctaHref = null`. **Если итог `null`, `ctaLabel` тоже принудительно `null`** — кнопка либо есть и работает, либо её нет, не показываем «битую» кнопку без ссылки. |
| `ctaLabel` содержит `{{var}}`, `var` не разрешён | Плейсхолдер удаляется (replace на пустую строку). Если после trim строка пустая — `ctaLabel = null`. |
| `instructionBody` содержит `{{var}}`, `var` не разрешён | Плейсхолдер удаляется. Если итог пустой — `instructionBody = null` → UI не показывает кнопку «Подробнее» (KS-4822). |

Логика «или fallback, или ничего» симметрична UI-инвариант: пользователь не должен видеть кнопку, которая ведёт в никуда (`/game//review` после подстановки пустоты выглядит как баг).

**Новое поле в `Hint.cta` для fallback:**

```ts
export interface HintCtaPayload {
  href?: string | null;
  event?: string | null;
  fallbackHref?: string | null;   // НОВОЕ — для §2.7
}
```

В админ-CRUD `HintCtaDto` добавляется `fallbackHref?: string` (та же валидация что и `href`). На уровне БД хранится в существующем `Hint.cta jsonb` без миграции схемы.

### 2.8. Валидация шаблонов в админ-CRUD

В `apps/api/src/hints/admin/hints-admin.service.ts` при `create`/`update`:

1. Извлечь все `{{var}}` из полей `cta.href`, `cta.fallbackHref`, `i18n[locale].ctaLabel`, `i18n[locale].instructionBody` для всех локалей.
2. Определить **множество допустимых vars** для текущего hint'а:
   - Если правило (`rule jsonb`) содержит `triggerEventType.equals: 'X'` или `count.event: 'X'` или `exists.event: 'X'` — собираем все упомянутые типы.
   - Допустимый whitelist = объединение `TRIGGER_VAR_WHITELIST[trigger]` для всех найденных trigger-типов.
   - Если в правиле нет ни одного event-имени — допустимый whitelist пустой; шаблоны не разрешены.
3. Каждый `{{var}}` сравнить с допустимым whitelist; неизвестная переменная → `400` с указанием поля и имени.

Это упрощённая статическая валидация. Она не покрывает случаи, когда правило срабатывает на cron-trigger (`timeSince`), в котором triggerEventPayload нет, — для таких правил админ должен либо не использовать шаблоны, либо обеспечить fallback. Раннее предупреждение в UI («это правило срабатывает на cron, переменные могут не разрешиться — рекомендуется fallbackHref») — отдельная UX-задача, не блокирует ADR.

### 2.9. Что не меняется

- Контракт WS `hint:show` для клиента — без изменений (значения уже резолвены, клиент работает как раньше).
- `HintLifecyclePayload` — без изменений.
- Pull-эндпоинт `GET /hints/pending` для гостей — payload уже резолвен на этапе попадания в `hints:pending:<guest_id>` (см. `hints.listener.ts:117`, теперь `result` уже после applyTemplate в checkFor — корректно).
- Frontend `<HintHost>` — без изменений (просто продолжает рендерить готовый payload).

---

## 3. Полная спецификация в одном месте

| Аспект | Спецификация |
|--------|--------------|
| Синтаксис | `\{\{([a-z][a-z0-9_]{0,31})\}\}` — Mustache-минимум, без условий/итераций/фильтров. |
| Поля payload с шаблонизацией | `ctaHref`, `ctaLabel`, `instructionBody`. **НЕ**: `title`, `body`, `anchor`, `ctaEvent`, `placement`, `ttlSec`, `key`, `hintId`, `locale`. |
| Источник значений | `triggerEvent.payload`, через whitelist `TRIGGER_VAR_WHITELIST[trigger_event_type]` в `packages/shared/src/types/hint-templating.ts`. |
| URL-encoding | Значения в `ctaHref` пропускаются через `encodeURIComponent`. В `ctaLabel`/`instructionBody` — как есть. |
| Поведение `{{var}}` без значения в `ctaHref` | `Hint.cta.fallbackHref` если задано, иначе `ctaHref = null` + `ctaLabel = null`. |
| Поведение `{{var}}` без значения в `ctaLabel`/`instructionBody` | Плейсхолдер удаляется (`""`), trim. Если итог пустой — поле `null`. |
| Place сохранения готового payload | Новое поле `ActorHintState.lastShownPayload jsonb null` (схема `events`, миграция в `packages/events-db`). |
| Replay (ADR-151) | Возвращает `lastShownPayload` напрямую, без пересборки. Fallback `toShowPayload(hint, locale)` для строк до миграции. |
| Валидация в админ-CRUD | Парсит все `{{var}}` в шаблонизируемых полях; whitelist определяется по упомянутым в `rule` event-именам; неизвестная переменная → 400. |
| Новое опциональное поле `cta` | `fallbackHref` — хранится в `Hint.cta jsonb` без миграции PG-схемы (это property внутри jsonb). |
| Тест-режим (`HINTS_TEST_MODE=1`) | Без изменений. Тесты должны передавать корректный `triggerEventPayload` через тест-эмиттер. |
| i18n | Шаблоны живут внутри `i18n[locale].ctaLabel` и `i18n[locale].instructionBody`. Каждая локаль валидируется отдельно. |
| Локализация значений | Значения подставляются как есть из payload (числа/строки). Локализация числительных, форматирование даты — вне scope (потенциальный follow-up, см. §6). |

---

## 4. Альтернативы

| Вариант | Плюсы | Минусы | Решение |
|---------|-------|--------|---------|
| **Клиентская подстановка** (сервер кладёт `triggerEvent.payload`, фронт подставляет) | Replay тривиален (тот же payload работает); снимает миграцию `lastShownPayload`. | Раздувает публичный WS-контракт; протекает поля payload на клиент; требует дублирования логики на frontend + backend (валидация); админ-превью требует клиентского парсера; whitelist дублируется. | **Отвергнуто.** Сложность распределена, не уменьшена; risk-поверхность шире. |
| **Сервер подставляет, payload не сохраняется** | Минимальная схема (без `lastShownPayload`). | Replay даёт обрезанный payload (`{{game_id}}` буквально или fallback `/profile`) — UX хуже, чем не показывать вообще. | **Отвергнуто.** Выгода миграционная, минус регулярный. |
| **Хранить только `lastShownVars jsonb`, пересобирать payload при replay** | Меньше места (1 строка JSON вместо payload), всегда свежий админский текст. | Дополнительный DB-call в replay-path для загрузки Hint; админский edit между emit и replay меняет видимый текст пользователю (см. ADR-151 §5 — там зафиксировано «replay восстанавливает упущенный показ, не новый»); расходится с уже принятой семантикой. | Отвергнуто. Размер payload пренебрежим. |
| **Глобальный whitelist (одно множество vars для всех триггеров)** | Проще шаблоны и валидация. | Контент-менеджер может случайно использовать `{{rating_delta}}` в hint, который триггерится на `puzzle_failed` — там нет такой переменной → run-time fallback. Валидация в админ-CRUD не сможет это поймать. | Отвергнуто. Привязка к триггеру даёт строгую early-error. |
| **Шаблонизировать `title` и `body`** | Полная симметрия полей. | Title/body — короткий копирайт, кейсов с параметризацией не видим; увеличивает поверхность для опечаток. При появлении кейса — добавим в этом же ADR follow-up'ом. | Отвергнуто на старте. |
| **Любой синтаксис кроме `{{var}}`** (`${var}`, `%{var}`, ICU MessageFormat) | ICU даёт plurals/select/dates. | ICU — большая внешняя библиотека; для трёх полей и базовых vars overkill. | Отвергнуто. Mustache-минимум 1 функция, без deps. |

---

## 5. Граничные случаи и поведение

| Сценарий | Поведение |
|----------|-----------|
| `game_end` payload содержит `game_id=abc-123`, `ctaHref='/game/{{game_id}}/review'` | Резолвится в `/game/abc-123/review` (URL-encoded). ✓ |
| `game_end` payload без `game_id` (теоретически — bug source) | `ctaHref={{game_id}}` нерезолвен → fallback `Hint.cta.fallbackHref` либо `ctaHref=null` → CTA не показывается. ✓ |
| `ctaLabel='Открыть партию {{time_control}}'`, payload содержит `time_control='3+2'` | `'Открыть партию 3+2'`. ✓ |
| `ctaLabel='Открыть партию {{time_control}}'`, payload без `time_control` | После replace → `'Открыть партию '` → trim → `'Открыть партию'`. Если хотелось бы строгое поведение «удалить кнопку» — admin должен задать `fallbackHref=null` + явный пробельный шаблон. (Решение: оставляем мягким — текст частично есть, кнопка отрабатывает.) |
| `instructionBody='Игра {{game_id}} закончилась со счётом {{rating_delta}}.'`, payload `{game_id:'abc',rating_delta:-8}` | `'Игра abc закончилась со счётом -8.'`. ✓ |
| Шаблон `{{user_email}}` в `ctaHref` (НЕ в whitelist) | Валидация в админ-CRUD → 400 при сохранении. Если каким-то образом просочилось в БД (миграция, ручной патч) — runtime воспринимает как «неразрешённая var» → fallback. ✓ |
| Cron-trigger (`timeSince` правило, `triggerEventPayload=undefined`), шаблон `{{game_id}}` | Все vars не разрешаются → fallback/null. Админ-валидация: если в `rule` нет event-имени (только `timeSince` без event) — whitelist пустой → шаблон в любом поле = 400. Cron-trigger правил без шаблонов = OK. |
| Multi-tab replay: tab #1 кэширует snapshot, tab #2 reconnect | Оба раза `replayPending` отдаёт тот же `lastShownPayload` snapshot. ✓ |
| Админ изменил `Hint.i18n` между emit и replay (60 с) | Replay отдаёт snapshot со старыми значениями. Это **правильно** по ADR-151 §5: replay дослывает упущенный show, не «свежий показ». Следующий primary emit получит новый текст. |
| `lastShownPayload` после миграции у всех старых строк = NULL | Replay-path делает fallback `toShowPayload(hint, locale)`; на практике эти строки старше 60 с и не выбираются. После первого primary emit поле заполнится. ✓ |
| Шаблон с URL-небезопасным символом `'/game/{{theme}}/...'`, `theme='knight + queen'` | `encodeURIComponent('knight + queen')='knight%20%2B%20queen'` → ссылка валидна. ✓ |

---

## 6. Открытые вопросы / follow-ups

1. **Форматирование значений (числительные, даты).** Сейчас `rating_delta=-8` подставляется как `-8`. Если контент захочет «потерял 8 пунктов рейтинга» — нужна форматирующая функция или `i18n` plural в самом тексте. Отложено, возвращаемся при сигнале.
2. **Шаблонизация `title` и `body`.** Не включаем на старте; возвращаемся при сигнале от контент-команды.
3. **Превью в админ-UI.** Превью «как видит пользователь» с моковыми vars для каждого trigger-типа — UX-задача в `/admin/hints/[id]/edit`. ADR фиксирует контракт, UI делается отдельным тикетом.
4. **Шаблонизация в guest-pending payload.** Сейчас гостевые vars пустые (TRIGGER_VAR_WHITELIST содержит `[]` для `guest_*`). При появлении гостевого use-case — расширяем whitelist, replay-инфраструктуры у гостей нет, snapshot не нужен.

---

## 7. Разбивка на implementation-задачи

| # | Задача | Файлы | Зона | Грубая оценка |
|---|--------|-------|------|---------------|
| S1 | `packages/shared/src/types/hint-templating.ts` — `TRIGGER_VAR_WHITELIST`, `getTriggerVars`, `applyTemplate`, regex, типы. Unit-тесты на матрицу (резолв / нерезолв / encode / fallback). | `packages/shared/src/types/hint-templating.ts`, `packages/shared/src/types/hint-templating.spec.ts` | backend (owner shared) | 0.5 дн |
| S2 | Добавить `instructionBody?: string \| null` в `HintShowPayload` (вынос из `HintI18nEntry` на уровень payload) + `Hint.cta.fallbackHref?: string \| null`. Обновить `toShowPayload` чтобы пробрасывать `instructionBody` из i18n в payload. | `packages/shared/src/types/hint-payload.ts`, `apps/api/src/hints/hints.service.ts` (`toShowPayload`) | backend | 0.25 дн |
| B1 | Расширить `HintCheckContext.triggerEventPayload`. Прокинуть в `HintsListener.handle`. Вызвать `applyTemplate(rawPayload, ctx, hint.cta?.fallbackHref ?? null)` в `HintsService.checkFor`. | `apps/api/src/hints/hints.types.ts`, `apps/api/src/hints/hints.listener.ts`, `apps/api/src/hints/hints.service.ts` | backend | 0.5 дн |
| B2 | Миграция Prisma + SQL: `ALTER TABLE events.actor_hint_states ADD COLUMN last_shown_payload jsonb NULL`. Обновить Prisma модель в `packages/events-db`. | `packages/events-db/prisma/schema.prisma`, новая миграция | backend | 0.25 дн |
| B3 | Запись `lastShownPayload` в `actorHintState.upsert` в `HintsService.checkFor`. Возврат snapshot из `replayPending` с fallback на `toShowPayload`. Unit-тесты. | `apps/api/src/hints/hints.service.ts` (+ spec) | backend | 0.5 дн |
| B4 | Валидация шаблонов в админ-CRUD: парсер `{{var}}`, объединение whitelist'ов по `rule`, 400 при неизвестной vars. Unit-тесты на матрицу. Добавление `fallbackHref` в `HintCtaDto`. | `apps/api/src/hints/admin/hints-admin.service.ts`, `apps/api/src/hints/admin/admin-hint.dto.ts` (+ spec) | backend | 0.75 дн |
| Q1 | E2E `analyze-after-loss` с реальным game_id: партия проиграна, popover, ctaHref содержит резолвенный uuid партии, клик ведёт на `/game/<id>/review`. | `apps/e2e-hints/tests/templating-game-end.spec.ts` | qa | 0.5 дн |

**Итого:** ~2.75 дн backend + 0.5 дн QA. Зависимости: S1 → B1, B3; S2 → B1; B2 → B3; B4 независим от B2/B3 но опирается на S1.

**Метки задач:** `onboarding`, `infra` — наследуются от KS-4824.

---

## 8. Решение

Принять **серверную подстановку Mustache-минимум `{{var}}` в момент primary emit + snapshot в `ActorHintState.lastShownPayload`** для корректного replay. Whitelist привязан к `trigger_event_type` и живёт в `packages/shared`. Шаблонизируются три поля: `ctaHref`, `ctaLabel`, `instructionBody`. Валидация шаблонов — в админ-CRUD, raise `400` на неизвестную переменную. Реализация — задачами S1–S2, B1–B4, Q1.
