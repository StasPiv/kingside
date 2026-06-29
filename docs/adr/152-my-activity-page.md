# ADR-152 — Страница «Мои действия» (личный лог событий пользователя)

- Статус: **Proposed** (2026-06-29)
- Дата: 2026-06-29
- Связанные задачи: KS-4797
- Связанные ADR: ADR-004 (API+WS), ADR-141 (settings tabs), **ADR-147 §1.1, §2.1–2.3, §6.1–6.3** (events pipeline, retention 90 дней, GDPR endpoints), ADR-149 (game events single entry)
- Автор: architect

---

## 0. TL;DR

Заводим страницу `/me/actions` — личный read-only журнал событий авторизованного пользователя из таблицы `events.actor_events`. Доступ — только под JWT, видны только свои события (`actor_id = req.user.id AND actor_type = 'user'`). Backend — один новый эндпоинт `GET /me/events` в существующем `MeController` (apps/api/src/me), фильтр + cursor-пагинация по композитному `(createdAt desc, id desc)`; чтение через `EventsPrismaService.getOwner()` (та же owner-Prisma, через которую уже работают `analytics-data.service.ts` `streamExport`/`deleteActorData`, новые миграции/индексы не нужны — индекс `(actor_id, type, created_at desc)` из ADR-147 §2.3 покрывает оба запроса). Frontend — отдельная страница в `apps/web/src/pages/MyActionsPage.tsx` под `<ProtectedRoute>`, infinite-scroll список, фильтр-чипы по **категориям** (Игры / Пазлы / Уроки / Подсказки / Сессия), категории и человекочитаемые подписи типов — в `packages/shared/src/types/event-catalog.ts` (единый источник правды, чтобы backend-валидатор и frontend-рендер не разъезжались). Неизвестные `type` показываются с raw-ключом и компактным JSON payload — страница работоспособна, даже если в БД появился новый `type`, для которого ещё не добавлена локализация. Шумные типы (`page_view`, `session_idle`, `session_start`) скрыты по умолчанию, появляются по чек-боксу «Показать системные события». Гости — вне scope (у гостя нет личного кабинета и сессия короткая, ценность журнала ≈ 0). Ссылка на страницу — из `PrivacyTab` в `/settings?tab=privacy` (контекстно рядом с export/delete) + из дроп-меню профиля. Retention 90 дней унаследован от ADR-147 §6.4 и выводится в UI явной плашкой «история за последние 90 дней».

---

## 1. Контекст и проблема

ADR-147 ввёл append-only лог `events.actor_events` (см. §2.3 — pg_partman weekly, retention 90 дней, индекс `(actor_id, type, created_at desc)`). На текущий момент пользователь может:
- отозвать согласие на сбор (`PATCH /me/consent`),
- удалить накопленные данные (`DELETE /me/analytics-data`),
- выгрузить их как JSON-файл (`GET /me/analytics-export`).

Чего нет — простого человекочитаемого окна «что система обо мне знает». GDPR Art. 15 (право доступа) сейчас закрывается экспортом — формально соответствует, фактически JSON-файл на сотни записей человек не читает. Запрос пользователя из KS-4797: показать события на сайте, в читаемом виде, со ссылками на связанные сущности (партии, пазлы, уроки), без обязательного скачивания файла.

Принципиальные ограничения, влияющие на решение:
- **Один разработчик, ограниченный бюджет времени.** Решение должно укладываться в 2–3 дня. Это исключает: отдельный admin-grade аналитический фронтенд, графики/timeline-виджеты, экспорт в PDF, поиск full-text.
- **Целевая верхняя граница из ADR-147 §2.3** — 600K событий/день на платформу при retention 90 дней. На одного активного пользователя за 90 дней при средних 30–80 событий/день это **~2.7K–7.2K строк**, у heavy-user (puzzle-rush сессии по 150–200 событий) — до **~18K**. Это объём, при котором клиентский «загрузить всё разом» не работает: 18K карточек × 200 байт DOM = ~3.6 МБ heap на странице. Нужен server-side фильтр + пагинация **с самого начала**, не follow-up.
- **Источник правды — уже существующий `EventsPrismaService.getOwner()`.** Та же owner-Prisma, через которую `analytics-data.service.ts` уже умеет читать события actor'а. Не вводим новый DB-роль, не пишем новые миграции — индекс `(actor_id, type, created_at desc)` из ADR-147 §2.3 нативно покрывает оба запрашиваемых паттерна (с фильтром по `type` и без — Postgres делает index-only scan по первому полю композитного индекса).
- **Тип события — строка `^[a-z][a-z0-9_]*$` ≤64 байт без БД-whitelist** (см. `apps/api/src/events/dto/create-events.dto.ts`). UI **не может** сделать exhaustive switch по типам, иначе любой новый emit ломает страницу. Решение должно работать с unknown-типами degraded-but-correct.
- **Гость не получает страницу** — у него нет личного кабинета, а сессия короткая. `GET /guest/events` не вводим; гостевой analytics-export уже есть в `/guest/analytics-export` (ADR-147 §6.3) для тех редких случаев, когда гость хочет посмотреть свои события до регистрации.

---

## 2. Решение

### 2.1. Backend — `GET /me/events`

**Новый метод `MeController.listEvents()` в существующем файле `apps/api/src/me/me.controller.ts`.** Никаких новых модулей/контроллеров — `MeController` уже под `JwtAuthGuard`, уже инжектит `AnalyticsDataService` и `EventsService`. Добавляется второй public-метод сервиса `AnalyticsDataService.listEvents(actor, opts)` рядом со `streamExport` / `deleteActorData` (зеркальная зона ответственности — read-only выборка для UI).

```http
GET /me/events?cursor=<base64>&limit=50&types=puzzle_solved,puzzle_failed&showSystem=false
Authorization: Bearer <jwt>
```

| Query | Тип | Default | Описание |
|-------|-----|---------|----------|
| `limit` | int | 50 | 1..100. Жёсткий cap 100. |
| `cursor` | string | — | Opaque base64-токен — encoded `{ createdAtIso, id }` последней записи предыдущей страницы. Отсутствует → первая страница (от `now()`). |
| `types` | comma-list | — | Whitelist `event_type`. Регистр-чувствителен, повторяет grammar DTO (`^[a-z][a-z0-9_]*$`, ≤64). Пустой/отсутствует → все. |
| `showSystem` | boolean | `false` | Если `false` — исключаются типы из закрытого списка `SYSTEM_EVENT_TYPES` (см. §2.3), независимо от `types`. |

Response (JSON):

```json
{
  "items": [
    { "id": "1234567890", "type": "puzzle_solved", "payload": { "puzzle_id": "...", "theme": "fork" }, "created_at": "2026-06-28T11:42:03.117Z" }
  ],
  "next_cursor": "eyJjcmVhdGVkQXRJc28iOiIyMDI2LTA2LTI4VC4uLiIsImlkIjoiMTIzNDU2Nzg5MCJ9",
  "has_more": true,
  "retention_days": 90
}
```

Замечания:
- `id` сериализуется как **string** — Prisma возвращает `BigInt`, JSON.stringify падает на BigInt без явной конверсии (та же логика, что в `streamExport`, line 137).
- `next_cursor` отсутствует, если `has_more=false`.
- `retention_days` дублирует серверную константу — фронт показывает плашку «за 90 дней», и при изменении retention не нужно менять frontend.

**Запрос к БД:**

```ts
// AnalyticsDataService.listEvents — псевдокод
const where: Prisma.ActorEventWhereInput = {
  actorId: actor.id,
  actorType: actor.type,           // всегда 'user' в /me-эндпоинте
  ...(types?.length ? { type: { in: types } } : {}),
  ...(systemFilter ? { type: { notIn: SYSTEM_EVENT_TYPES } } : {}),
  ...(cursor ? {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  } : {}),
};
const rows = await owner.actorEvent.findMany({
  where,
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  take: limit + 1,           // +1 чтобы вычислить has_more без второго запроса
  select: { id: true, type: true, payload: true, createdAt: true },
});
```

**Использование индекса.** Композитный индекс `(actor_id, type, created_at desc)` из ADR-147 §2.3 покрывает:
- запрос без `types` → index scan по prefix `(actor_id)` + сортировка по `created_at desc` нативно (третья колонка в индексе).
- запрос с `types` (`type IN (...)`) → bitmap-индекс scan по `(actor_id, type)`, сортировка `created_at desc` — внутри каждой группы по индексу.

Партиционирование (pg_partman weekly) не мешает: planner делает partition pruning по `created_at` cursor'а, в худшем случае (без cursor) читает текущую и предыдущую партиции. Для одного user-актора это десятки строк — read amplification нулевой.

**Cursor — opaque base64.** Не публикуем формат во фронт, не подписываем (нет смысла — фронт не может сконструировать «чужой» cursor, потому что фильтр `actor_id = req.user.id` зашит на сервере). Парсим `try { JSON.parse(atob(cursor)) } catch { throw 400 }`.

**Безопасность.** Фильтр `actorId: req.user.id` и `actorType: 'user'` — на сервере, **не из query**. Клиент не может попросить чужие события даже подменив запрос — параметра `actorId` в DTO нет. Это симметрично подходу в `streamExport` / `deleteActorData` (line 65, 116) — единая модель доступа в `MeController`.

**Кейс «нет owner-Prisma»** (dev/local без `EVENTS_DATABASE_URL`): возвращаем `{ items: [], next_cursor: null, has_more: false, retention_days: 90 }` с `200 OK` + warn-лог. Симметрично `analytics-data.service.ts` (line 79) — приложение работает без events-инфры, страница просто пустая.

### 2.2. Frontend — страница `/me/actions`

**Новый файл `apps/web/src/pages/MyActionsPage.tsx`**, маршрут в `App.tsx` под `<ProtectedRoute>`:

```tsx
<Route path="/me/actions" element={<ProtectedRoute><MyActionsPage /></ProtectedRoute>} />
```

Маршрут именно `/me/actions`, а не `/profile/activity` или вкладка в `/settings`:
- `/me/*` — namespace для read/write личных данных авторизованного пользователя, уже занят на бекенде (`/me/consent`, `/me/analytics-export`, `/me/analytics-data`). На фронте префикс `/me/*` сейчас не используется — заводим естественную зеркальную семантику и закрепляем за личным кабинетом.
- В `/settings?tab=privacy` не помещаем как вкладку: страница содержит длинный скроллящийся список (потенциально 1K+ карточек), а табы настроек по ADR-141 — для коротких форм с парой полей. Privacy остаётся местом CRUD-управления данными; «посмотреть» — отдельная страница, со ссылкой из Privacy.
- `/profile/activity` отвергнут — `/profile` сейчас редиректит на публичный `/player/:username` (см. `App.tsx:1164` `ProfileRedirect`), туда личный лог не помещается семантически (страница профиля — публичная, лог — приватный).

**Структура страницы:**

```
┌─────────────────────────────────────────────────────────────┐
│  Мои действия                                                │
│  История ваших действий на платформе за последние 90 дней.   │
│                                                              │
│  Категории: [Игры ●] [Пазлы ●] [Уроки ●] [Подсказки ○]      │
│                                                              │
│  ☐ Показать системные события (page_view, session_*)         │
│                                                              │
│  ─────────────────────────────────────────────────────────   │
│  29 июн, 14:32  ♟  Сыграли партию против ChessFan42         │
│                    Блиц 3+2, поражение, −8                   │
│                    → Открыть партию                          │
│  ─────────────────────────────────────────────────────────   │
│  29 июн, 14:18  🧩 Решили задачу «вилка»                     │
│                    Попыток: 2                                │
│                    → К задаче                                │
│  ─────────────────────────────────────────────────────────   │
│  29 июн, 14:05  📚 Начали урок «Защита Каро-Канн»            │
│                    → К уроку                                 │
│  ─────────────────────────────────────────────────────────   │
│                                                              │
│  [Загрузить ещё]                                             │
└─────────────────────────────────────────────────────────────┘
```

**Компоненты (один файл, без дробления — объём ≈300 LOC):**
- `<MyActionsPage>` — корневой, держит state `{ items, cursor, categories, showSystem, loading }`.
- `<EventCard>` (внутренний) — рендер одной записи: иконка категории, человекочитаемый заголовок, payload-форматтер по типу, опциональная ссылка-CTA.

**Loading-стратегия:**
- Первая страница: `useEffect(() => fetch(), [categories, showSystem])` — при смене фильтра сбрасываем список и грузим заново.
- Доп. страницы: кнопка «Загрузить ещё» (не intersection-observer infinite-scroll) — простой и надёжный паттерн под mobile-Safari, без потенциальных «прыжков» из-за virtual scroll. При 50/страница и максимуме 18K строк это до 360 нажатий, что неприемлемо как UX, но **в реальности** пользователь скроллит первые 50–200 записей и уходит. Если поведенческие метрики покажут массовые «прокручивают до конца» — это сигнал на инфинит-скролл (follow-up).
- Loading-state: spinner внизу + disabled-кнопка. Errors — toast + retry-кнопка.

**Кастомные форматтеры payload-а — таблица в `packages/shared/src/types/event-catalog.ts` (см. §2.3).** Forматтеры — pure-функции `(payload) => { title, subtitle?, href? }`. Для неизвестных типов — fallback `{ title: t('myActions.unknownEvent', { type }), subtitle: JSON.stringify(payload) }`.

**Mobile (`<768px`):** карточки — на всю ширину, чипы-категории — горизонтальный scroll. Layout-агент решает финальный CSS, ADR фиксирует только то, что mobile-вариант делается **в том же тикете**, без отложенного follow-up — без этого нельзя выпустить страницу пользователю.

**i18n.** Все строки UI через `useTranslation()`, ключи в namespace `myActions.*`. Локали `ru` и `en` (см. ADR-147 §3.1 — проект двуязычный).

### 2.3. Каталог событий — `packages/shared/src/types/event-catalog.ts`

**Единый источник правды для UI-meta событий.** Backend EventsService не использует его (там DTO-валидация — `apps/api/src/events/dto/create-events.dto.ts` принимает любой `^[a-z][a-z0-9_]*$` для гибкости — это специально, чтобы добавление нового события не требовало миграции shared-пакета). Frontend читает каталог для подписей/категорий/форматтеров.

**Структура файла:**

```ts
export type EventCategory = 'game' | 'puzzle' | 'lesson' | 'hint' | 'session' | 'other';

export interface EventMeta {
  type: string;            // совпадает с actor_events.type
  category: EventCategory;
  /** i18n-ключ заголовка. Конечный текст — через t(titleKey, payload). */
  titleKey: string;
  /** Опционально: построитель href в SPA. Возвращает null если нет linking. */
  hrefBuilder?: (payload: Record<string, unknown>) => string | null;
}

export const EVENT_CATALOG: ReadonlyArray<EventMeta> = [
  { type: 'game_start',     category: 'game',   titleKey: 'event.game_start',     hrefBuilder: (p) => p.game_id ? `/play/${p.game_id}` : null },
  { type: 'game_end',       category: 'game',   titleKey: 'event.game_end',       hrefBuilder: (p) => p.game_id ? `/play/${p.game_id}` : null },
  { type: 'puzzle_solved',  category: 'puzzle', titleKey: 'event.puzzle_solved',  hrefBuilder: (p) => p.puzzle_id ? `/puzzle/${p.puzzle_id}` : null },
  { type: 'puzzle_failed',  category: 'puzzle', titleKey: 'event.puzzle_failed',  hrefBuilder: (p) => p.puzzle_id ? `/puzzle/${p.puzzle_id}` : null },
  { type: 'rush_end',       category: 'puzzle', titleKey: 'event.rush_end' },
  { type: 'lesson_start',   category: 'lesson', titleKey: 'event.lesson_start',   hrefBuilder: (p) => p.lesson_id ? `/lesson/${p.lesson_id}` : null },
  { type: 'lesson_complete',category: 'lesson', titleKey: 'event.lesson_complete',hrefBuilder: (p) => p.lesson_id ? `/lesson/${p.lesson_id}` : null },
  { type: 'drill_complete', category: 'lesson', titleKey: 'event.drill_complete' },
  { type: 'hint_shown',     category: 'hint',   titleKey: 'event.hint_shown' },
  { type: 'hint_acted',     category: 'hint',   titleKey: 'event.hint_acted' },
  { type: 'page_view',      category: 'session',titleKey: 'event.page_view' },
  { type: 'session_idle',   category: 'session',titleKey: 'event.session_idle' },
  { type: 'session_start',  category: 'session',titleKey: 'event.session_start' },
  // … остальные из ADR-147 §2.1 + те, что появятся декларативно
];

/** Типы, которые HTTP-параметр `showSystem=false` отрезает на бекенде. */
export const SYSTEM_EVENT_TYPES: ReadonlyArray<string> = [
  'page_view', 'session_idle', 'session_start',
];

export function findEventMeta(type: string): EventMeta | undefined {
  return EVENT_CATALOG.find((m) => m.type === type);
}
```

**Расширение каталога — без миграций.** Новый тип события (декларативный, как `feature_used` или будущие domain-события) → добавляется одна строка в `EVENT_CATALOG` + ключ в `apps/web/src/i18n/locales/{ru,en}.json` → деплой. Backend ничего не знает про каталог. До добавления — событие показывается через fallback (`unknown`), не ломая страницу.

**`SYSTEM_EVENT_TYPES` импортируется на бекенде** через `@kingside/shared` (как уже делает `hint-anchors.ts`) — фильтр по `showSystem=false` на сервере, не на клиенте. Если фильтровать на клиенте — нарушится пагинация (страница 50 элементов после фильтра может содержать 0 видимых, и UI «зависнет» на пустой странице).

### 2.4. Privacy и доступ

Полностью наследуется из ADR-147 §6:
- Page доступна только под JWT (`<ProtectedRoute>`), backend — `@UseGuards(JwtAuthGuard)`.
- Фильтр `actorId = req.user.id AND actorType = 'user'` — на сервере, без возможности override из query.
- При `analyticsConsent=false` события не пишутся (ADR-147 §6.2), поэтому страница у пользователя без согласия покажет только историю до момента отзыва (или пустоту, если он никогда не давал). Это **корректное** поведение, не баг.
- Retention 90 дней — то же. Пользователь видит в UI плашку «история за последние 90 дней» (текст через `t('myActions.retentionHint', { days })`, параметр из `retention_days` ответа).

GDPR Art. 15 (право доступа) теперь закрывается **двумя путями**:
- человекочитаемое UI (`/me/actions`) — для повседневного use case,
- machine-readable export (`GET /me/analytics-export`) — для портативности (Art. 20).

### 2.5. Точки входа на страницу

1. **`PrivacyTab`** (`apps/web/src/pages/settings/privacy/PrivacyTab.tsx`) — добавляется секция «Посмотреть мои действия» с `<Link to="/me/actions">`. Контекстно рядом с export/delete: пользователь, дошедший до privacy-настроек, явно интересуется тем, что система знает.
2. **Дроп-меню профиля** (если такое есть в `<Sidebar>` / `<TopBar>`) — пункт «Мои действия». Уточнить точное расположение — задача layout/frontend, ADR фиксирует требование «должна быть точка входа кроме `/settings`».

---

## 3. Диаграмма потока

```mermaid
flowchart LR
  UI[/me/actions<br/>MyActionsPage] -- GET /me/events?cursor=...&types=... --> CTL[MeController.listEvents]
  CTL -- AnalyticsDataService.listEvents --> SVC[AnalyticsDataService]
  SVC -- owner-Prisma --> EDB[(events.actor_events<br/>index (actor_id, type, created_at desc))]
  EDB -- rows --> SVC
  SVC -- {items, next_cursor, has_more} --> CTL
  CTL -- 200 JSON --> UI
  UI -- findEventMeta(type) --> CAT[(packages/shared<br/>EVENT_CATALOG)]
  CAT -- EventMeta or undefined --> UI
  UI -. fallback for unknown .-> UI
```

---

## 4. Альтернативы

| Подход | Плюсы | Минусы | Решение |
|--------|-------|--------|---------|
| **Вкладка в `/settings?tab=activity`** | Одна страница меньше, естественно рядом с PrivacyTab | Список 1K+ карточек в табе с короткими формами визуально ломает страницу. ADR-141 §2.1 распределил вкладки по принципу «короткая форма на вкладку» | Отвергнуто. |
| **Использовать существующий `/me/analytics-export` + парсить на фронте** | Нулевой backend | Скачивание JSON-файла в браузер каждый раз, парсинг 7K+ записей на клиенте, нет фильтров на сервере, rate-limit 1/24ч в export'е сломает UX | Отвергнуто. |
| **Отдельный модуль `apps/api/src/activity/`** | Чистая граница ответственности | `MeController` уже агрегирует все `/me/*`-операции (`consent`, `analytics-data`, `analytics-export`); вынос одного метода в отдельный модуль — over-engineering | Отвергнуто. |
| **GraphQL вместо REST** | Гибкие выборки | Проект не использует GraphQL нигде; новая инфра ради одного эндпоинта — нет | Отвергнуто. |
| **Streaming JSON (как у `analytics-export`)** | Bounded память на сервере | Frontend для UI не умеет работать со streaming JSON естественным образом (нужны парсеры). Пагинация cursor-based решает ту же проблему лимитом 100 строк/запрос | Отвергнуто. |
| **Server-Sent Events / WebSocket live-feed** | Live-обновление при новых событиях | Поведенческой нужды нет (пользователь не сидит на странице ждать новые события); добавляет инфра-нагрузку (WS-room на user) ради features-vanity | Отвергнуто, потенциальный follow-up если появится спрос. |
| **Включить гостей через `/guest/events`** | Симметрия с `/guest/analytics-export` | У гостя нет личного кабинета и UI входной точки; гостевая сессия короткая (часы), смотреть нечего | Отвергнуто. Гостевой analytics-export уже покрывает редкий запрос. |
| **Polling / автообновление страницы** | Свежесть данных | Лишняя нагрузка на индекс при каждом тике; пользователь сам нажмёт refresh когда захочет | Отвергнуто. |
| **Полнотекстовый поиск по payload** | Удобство навигации | GIN-индекс на `actor_events.payload` — лишняя нагрузка на pg_partman и индекс-bloat; ADR-147 §2.3 явно отказался от GIN для аналогичного use case | Отвергнуто, потенциальный follow-up по сигналу. |

---

## 5. Открытые вопросы

1. **Точное место точки входа кроме `/settings`** — пункт меню профиля, иконка в сайдбаре, кнопка в дашборде. Решает layout/frontend в имплементационном тикете на основе текущего IA сайта; не блокирует выпуск.
2. **Конкретный набор payload-форматтеров.** В §2.3 показан минимум (`game_start`, `puzzle_solved`, `lesson_start` и т.п.). Полный список (включая `pre_move_used`, `rush_end` с показом счёта, `hint_acted` с названием подсказки) утверждается в реализационном тикете на основе фактического содержимого payload из `apps/api/src/events/internal-events.controller.ts` и self-emit'ов в `game`/`puzzle`/`puzzle-rush` модулях. Это **наполнение**, не архитектура.
3. **Расширение до гостей** — отложено. Включать `/guest/events` имеет смысл только если появится UX-вход у гостя (например, кнопка «как меня используют» в cookie-banner), а не сама по себе.
4. **Live-feed** — отложен (см. таблицу альтернатив).

---

## 6. Разбивка на implementation-задачи

Координатор финализирует декомпозицию. Предлагаемое разбиение:

| # | Задача | Зона | Грубая оценка | Зависимости |
|---|--------|------|---------------|-------------|
| T1 | `event-catalog.ts` в `packages/shared/src/types/` + экспорт + i18n-ключи `event.*` в локалях ru/en + unit-тесты `findEventMeta` / fallback | backend (owner shared) **или** frontend по контексту — фактически чистый TS-модуль | 0.5 дн | — |
| T2 | `AnalyticsDataService.listEvents(actor, opts)` + `MeController.listEvents()` + DTO с валидацией (`cursor`, `limit`, `types`, `showSystem`) + jest-тест на фильтр+cursor+отсутствие owner-Prisma | backend | 0.5 дн | T1 (импорт `SYSTEM_EVENT_TYPES`) |
| T3 | Страница `MyActionsPage.tsx` + маршрут `/me/actions` + список + пагинация «Загрузить ещё» + чипы-категории + чек-бокс «Показать системные» + i18n + vitest-тесты основных сценариев | frontend | 1.5 дн | T1, T2 |
| T4 | Mobile-адаптация страницы (карточки full-width, чипы scroll, safe-area) | layout | 0.5 дн | T3 |
| T5 | Ссылка-вход из `PrivacyTab` + пункт в меню профиля (если согласован с layout) | frontend | 0.25 дн | T3 |
| T6 | QA: ручная проверка под user'ом без событий / с heavy-объёмом / без согласия / на mobile-viewport | qa | 0.5 дн | T3, T4, T5 |

**Итого:** ~3.75 дн (без QA — ~3.25 дн). Помещается в бюджет одного разработчика за неделю с учётом контекстных переключений.

**Метки задач:** `profile`, `infra` — наследуются от KS-4797. Для T3/T4/T5 уместно добавить `mobile`, для T2 — оставить как `profile`.

---

## 7. Контрольные критерии готовности

Страница считается готовой к включению пользователям, когда:

1. `GET /me/events` под нагрузкой 100 записей/запрос отвечает <100 мс p95 (метрика прометея на endpoint — стандартный middleware, добавления не требует).
2. Пользователь без события (`analyticsConsent=false`, никогда не давал) видит пустое состояние с пояснением «события не собираются — см. настройки приватности».
3. Пользователь с heavy-объёмом (синтетический сценарий: 10K записей) — первая страница рендерится <500 мс, прокрутка не лагает.
4. Новый тип события, добавленный после деплоя страницы (не присутствующий в `EVENT_CATALOG`), показывается через fallback без ошибок в консоли.
5. Mobile viewport (375×667) — карточки читаемы, чипы доступны, кнопка «Загрузить ещё» в safe-area.
6. i18n: переключение ru ↔ en меняет все строки страницы (включая категории и заголовки событий) без перезагрузки.
