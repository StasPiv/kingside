# ADR-147 — Контекстные подсказки пользователю на основе аналитики действий

- Статус: **Proposed** (2026-06-27)
- Дата: 2026-06-27
- Связанные задачи: KS-4678
- Связанные ADR: ADR-004 (API+WS), ADR-024 (lessons-module — пример декларативного контента), ADR-026 (user-courses — прогресс пользователя), ADR-128 (public routes / guest)
- Автор: architect

---

## 0. TL;DR

Заводим модуль `hints` в `apps/api`: declarative-конфиг правил (JSON в БД, редактируется через админ-UI отдельным тикетом), событийная аналитика в новой таблице `user_events` (через `/logs`-подобный endpoint + Redis-буфер), агрегаты считаются Postgres-запросами поверх `user_events` (без отдельного OLAP-стека), доставка на UI — push через существующий `MessageGateway` (room `user:<id>`, событие `hint:show`), placement — anchor по `data-hint-anchor="<id>"` в DOM. Lifecycle (`viewed | dismissed | acted | ignored`) трекается обратно тем же gateway-ом. Глобальные лимиты — ≤1 подсказки в 10 минут на пользователя, ≤5 за сессию. Согласие на трекинг включено в существующий cookie-banner отдельной галочкой; пользователь без согласия — события не пишутся, подсказки не показываются.

---

## 1. Контекст и проблема

Сайт оброс функциональностью (puzzle-rush, blind board, tactic-drills, opening-trainer, lectures, user-courses, archive, live-analysis), и большинство пользователей пользуется ≤30% возможностей. Tour-онбординг на старте пробовать не хотим: он раздражает и быстро забывается. Цель — **живые контекстные подсказки**, которые реагируют на то, что пользователь делает прямо сейчас: «играешь третий рейтинговый блиц подряд — посмотри pre-move в настройках», «открыл свою партию без анализа — запусти анализ», «не решал пазлы 7 дней — забыли про rush-режим?».

Принципиальные ограничения:
- Ожидаемый объём аналитики на горизонте 6–12 месяцев — 50–150K событий/день (оценка, обоснование и сценарии границ — §2.3; план эволюции при превышении — §7A). На таком объёме отдельный аналитический стек (Clickhouse, Kafka, dedicated warehouse) технически избыточен: вся нагрузка укладывается в одну PostgreSQL-инстанцию с правильными индексами и retention.
- Существующий WS-канал и `Notification`-таблица **не подходят как есть**: notifications — это transactional inbox с историей; подсказки же эфемерные и не должны засорять колокольчик. Нужен отдельный канал, но через ту же gateway-сокетную инфраструктуру.
- База одна, отдельный warehouse не заводим (см. выше) — нужно сразу думать о retention и индексах.
- GDPR: пользователь должен иметь возможность отключить трекинг событий, и сами события должны храниться ограниченное время.

---

## 2. Аналитика действий пользователя

### 2.1. Какие события собираем

Минимально достаточный список для первого набора правил (если правила потребуют — расширим декларативно, без изменения схемы):

| Категория | Тип события (`event_type`) | Откуда | Поля payload |
|-----------|---------------------------|--------|--------------|
| Сессия | `session_start` | frontend, при загрузке App после auth | `device`, `referrer` |
| Сессия | `session_idle` | frontend, при простое 60+ сек на странице | `page`, `idle_seconds` |
| Навигация | `page_view` | frontend, React Router listener | `path`, `prev_path` |
| Игра | `game_start` | backend, gateway после matchmaking | `time_control`, `rated`, `opponent_id` |
| Игра | `game_end` | backend, gateway | `result`, `termination`, `rating_delta` |
| Игра | `pre_move_used` | backend, gateway | `game_id` |
| Пазл | `puzzle_start` | backend, `puzzle.controller` | `puzzle_id`, `theme` |
| Пазл | `puzzle_solved` / `puzzle_failed` | backend | `puzzle_id`, `attempts` |
| Пазл-раш | `rush_start` / `rush_end` | backend, `puzzle-rush` | `score`, `mode` |
| Анализ | `analysis_open` | frontend | `game_id`, `source` |
| Анализ | `analysis_engine_started` | frontend | `game_id` |
| Курсы | `lesson_start` / `lesson_complete` | backend | `lesson_id`, `course_id` |
| Tactic-drill | `drill_start` / `drill_complete` | backend | `drill_id` |
| Действие | `feature_used` | frontend, generic | `feature_key` (например, `board_settings_opened`) |
| Подсказка | `hint_shown` / `hint_dismissed` / `hint_acted` / `hint_ignored` | backend сам пишет при доставке/реакции | `hint_id`, `rule_id` |
| Ошибка | `error_seen` | frontend, через ErrorBoundary | `kind` (network/render/api), `path` |

Принцип: **не собираем мышь, клики и input-keystrokes**. Только высокоуровневые domain-события. Это держит и объём, и privacy-риски управляемыми.

### 2.2. Где собираем

```mermaid
flowchart LR
  FE[Frontend\nReact 19] -- batch /events --> API[(apps/api\nEventsController)]
  GW[WebSocket gateways\n(game, message)] -- emit() --> EV[EventsService]
  API -- enqueue --> R[(Redis LIST\nuser_events:buffer)]
  EV -- enqueue --> R
  R -- worker tick (1s) --> PG[(PostgreSQL\nuser_events)]
  RULES[HintsEngine] -- query aggregates --> PG
  RULES -- emit() --> WSOUT[MessageGateway\nroom user:id\nevent hint:show]
```

- **Frontend → API**: новый endpoint `POST /events` (rate-limited по IP, batch до 50 событий, schema валидация class-validator). По образцу `/logs`, но с персистенцией.
- **Backend self-emit**: существующие сервисы (`game`, `puzzle`, `puzzle-rush`, `lesson`, `tactic-drill`) дёргают `EventsService.track(userId, type, payload)` в local-bus стиле. Это надёжнее, чем доверять фронту в момент конца партии.
- **Redis-буфер**: `LPUSH user_events:buffer <json>`. Воркер внутри API (`@Cron('*/1 * * * * *')` или `setInterval`) каждую секунду делает `LRANGE 0 999` + `LTRIM 1000 -1` + `INSERT ... SELECT FROM jsonb_to_recordset(...)` батчем. Это решает три задачи: (1) бэкпрешер при всплесках, (2) backend self-emit не блокируется на write, (3) при downtime PG события не теряются (на ttl Redis).

Альтернативу «писать напрямую в PG из каждого сервиса» отвергаем: пик в момент окончания турнира = десятки `INSERT` на один игровой gateway-тик. Буфер дешевле, чем сразу гонять connection pool.

### 2.3. Объём, индексы, retention

**Оценка объёма — это оценка, не измерение.** В проекте нет включённой DAU-метрики (нет Prometheus-counter активных сессий с дедупом по user_id, нет аналитического дашборда). Поэтому диапазон строится из двух косвенных опор:

1. **База пользователей.** Зафиксировано в ADR-128 §7.4.2 (KS-3401, страница `/player/:username`): «все зарегистрированные — на старте сотни/тысячи, цель — десятки тысяч». Это registered users, не DAU. Допускаем коэффициент активности 5–15% (отраслевая норма для freemium-сервисов; источник: усреднённые публичные данные SimilarWeb по chess.com / lichess.org за 2024, проверить точное значение нечем — мы не имеем доступа к их закрытой аналитике). При registered ∈ [1K, 50K] и активности 5–15% даёт DAU ∈ [50, 7500].
2. **События на одного активного пользователя в день.** Раскладка по §2.1, без эмпирических измерений:
   - `session_start` — 1
   - `page_view` — 10–30 (типичная сессия с навигацией по разделам)
   - `session_idle` — 1–3
   - `game_start` + `game_end` — 0–20 (от 0 у наблюдателя до 10 партий у активного блиц-игрока)
   - `pre_move_used` — 0–N (учитывается отдельно за партию)
   - `puzzle_start` + `puzzle_solved`/`puzzle_failed` — 0–60 (puzzle-rush сессия = десятки решений)
   - `rush_start` / `rush_end` — 0–4
   - `lesson_start`/`lesson_complete`, `drill_start`/`drill_complete` — 0–10
   - `hint_shown`/`hint_dismissed`/`hint_acted`/`hint_ignored` — 0–20 (учитывая глобальный лимит 5 показов/сессия и до 4 lifecycle-событий на каждый)
   - `error_seen` — редко, 0–2
   - `feature_used` — 0–10

   Суммарно: пассивный зритель ≈ 15 событий, средний играющий ≈ 50, heavy puzzle-rush сессия ≈ 150–200. Среднее по всем активным **оценочно 30–80**.

**Производное (грубая оценка ±2×):**

| Сценарий | DAU (оценка) | Событий на активного (оценка) | Событий/день |
|----------|--------------|------------------------------|--------------|
| Сегодня (низкая граница registered) | 50–500 | 30–50 | 1.5K–25K |
| Через 6–12 мес (рост базы) | 500–3K | 30–60 | 15K–180K |
| Достижение цели «десятки тысяч registered» | 2K–7.5K | 40–80 | 80K–600K |

Цифра **50–150K событий/день**, фигурирующая дальше в обоснованиях, соответствует middle-сценарию «через 6–12 мес». Это **верхняя граница для горизонта планирования первого года** — если рост окажется быстрее, см. раздел 7A «Масштабирование».

**Что нужно сделать в момент запуска, чтобы заменить оценку измерением:** на этапе T13 (observability, см. §8) добавить Prometheus-метрику `user_events_inserted_total{type}` — counter будет давать фактический rate, ему доверять, а не текущей оценке.

Схема (Prisma DSL, для иллюстрации; реальную миграцию делает backend):

```prisma
model UserEvent {
  id        BigInt   @id @default(autoincrement())
  userId    String   @map("user_id") @db.Uuid
  type      String   @db.VarChar(64)
  payload   Json     @db.JsonB
  createdAt DateTime @default(now()) @map("created_at")

  @@index([userId, createdAt(sort: Desc)])
  @@index([userId, type, createdAt(sort: Desc)])
  @@index([createdAt])
  @@map("user_events")
}
```

- `id BigInt`, а не UUID: 8 байт против 16, и для append-only логов UUID лишний.
- Композитный индекс `(user_id, type, created_at desc)` покрывает 90% правил («сколько раз пользователь сделал X за N минут/дней»).
- `payload` как `jsonb` — для редких ad-hoc запросов; GIN-индекс пока не вешаем (нет правил, которые фильтруют по полю payload).
- **Retention 90 дней**: `DELETE FROM user_events WHERE created_at < now() - interval '90 days'` ежедневным cron. Долгая ретенция не нужна — все правила оперируют интервалами «за час / за сутки / за неделю».

### 2.4. Агрегаты для триггеров

Правила оперируют **уже посчитанными агрегатами**, не сырыми событиями. Это снимает нагрузку на индексы при росте таблицы и упрощает декларативный конфиг.

Два пути расчёта:
1. **On-demand SQL** — для редко срабатывающих правил (раз в N минут на пользователя). Запросы вида `SELECT count(*) FROM user_events WHERE user_id=$1 AND type='puzzle_start' AND created_at > now() - interval '7 days'`. Покрыто индексом `(user_id, type, created_at)`.
2. **Counter cache в Redis** — для горячих агрегатов, которые читаются на каждом page_view. Ключи вида `ue:cnt:<user_id>:<type>:<window>` с TTL = размер окна. Инкрементятся одновременно с записью в PG.

Стартуем с пути №1. На №2 переходим только если SQL-нагрузка станет видна в Grafana (KPI: p95 `hints_check_duration` > 50 ms).

---

## 3. Дерево подсказок

### 3.1. Формат правил

**Декларативный JSON в БД**, не код. Причины:
- Можно редактировать без деплоя (важно для контент-менеджмента подсказок — это маркетингово-продуктовая задача, не инженерная).
- Конфиг версионируется в `hint_rules` таблице (audit-trail кто и когда менял).
- DSL ограниченный: только примитивы count/exists/time-since/page-equals. Полный DSL не нужен — и так покроет 95% сценариев.

Схема (Prisma DSL — для иллюстрации):

```prisma
model Hint {
  id           String   @id @default(uuid()) @db.Uuid
  key          String   @unique @db.VarChar(64)  // стабильный id для аналитики, напр. "analyze-your-game"
  title        String   @db.VarChar(200)         // i18n: ключ перевода или прямой текст
  body         String   @db.Text
  ctaLabel     String?  @map("cta_label")
  ctaHref      String?  @map("cta_href")          // относительный URL внутри SPA
  ctaEvent     String?  @map("cta_event")         // или клиентский event для in-page action
  anchor       String   @db.VarChar(64)           // значение data-hint-anchor на UI
  placement    String   @db.VarChar(16)           // 'top'|'bottom'|'left'|'right'|'overlay'
  priority     Int      @default(0)               // выше = важнее при конфликте
  enabled      Boolean  @default(true)
  rule         Json     @db.JsonB                  // см. ниже
  cooldownSec  Int      @default(86400) @map("cooldown_sec") // после dismiss/show
  ttlSec       Int      @default(0) @map("ttl_sec")           // автозакрытие на UI, 0 = ручное
  maxShows     Int      @default(3) @map("max_shows")          // лимит за всё время
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  @@map("hints")
}

model UserHintState {
  userId       String   @map("user_id") @db.Uuid
  hintId       String   @map("hint_id") @db.Uuid
  shownCount   Int      @default(0) @map("shown_count")
  lastShownAt  DateTime? @map("last_shown_at")
  dismissedAt  DateTime? @map("dismissed_at")
  actedAt      DateTime? @map("acted_at")
  suppressedUntil DateTime? @map("suppressed_until")

  @@id([userId, hintId])
  @@index([userId, suppressedUntil])
  @@map("user_hint_states")
}
```

### 3.2. DSL правила (`rule` jsonb)

```json
{
  "all": [
    { "page": { "matches": "/play/*" } },
    { "count": { "event": "game_start", "where": { "rated": true }, "windowMin": 30, "gte": 3 } },
    { "not": { "event": "feature_used", "where": { "feature_key": "board_settings_opened" }, "sinceDays": 7 } }
  ]
}
```

Операторы первой версии:
- `page.matches` — текущая страница (frontend шлёт в hint-check вместе с запросом, см. §4).
- `count.event` + `windowMin|windowHours|windowDays|sinceDays` + `gte|lte|eq` — счётчик за окно.
- `exists.event` / `not.exists.event` — был ли в окне.
- `timeSince.event` + `gtMin|gtHours|gtDays` — давно ли последний раз.
- `all` / `any` — логические комбинаторы.

Парсер DSL — небольшая чистая функция на 200–300 строк, без рантайм-зависимостей. Каждый оператор превращается в SQL-фрагмент (или Redis-чтение для горячих счётчиков). Незнакомый оператор → правило игнорируется + лог в `client-logs`-стиле.

### 3.3. Кто редактирует подсказки

Первая версия — **коммит в репозиторий**: seed-файл `apps/api/prisma/seeds/hints.ts`, `prisma db seed` идемпотентен по `hint.key`. Это позволит:
- Завести 10–15 базовых подсказок без админ-UI.
- Версионировать тексты в git.
- Делать ревью через PR.

Админ-UI (CRUD по таблице `hints`) — **отдельный тикет** (`KS-XXXX: admin UI для редактирования контекстных подсказок`). До тех пор маркетинг/контент готовит тексты в Google Doc, разработчик переносит в seed.

### 3.4. Разрешение конфликтов

Триггер: периодический check (см. §4.1) возвращает **массив** подходящих hint-ов. Выбираем один:

1. Сортируем по `priority desc, created_at asc`.
2. Фильтруем по `UserHintState`: исключаем `suppressedUntil > now()`, `shownCount >= maxShows`, `dismissed_at within cooldown`.
3. Фильтруем по глобальным лимитам (§5.2): «≤1 показ за 10 минут», «≤5 за сессию».
4. Берём верхний. Остальные **не запоминаем как «скипнутые»** — просто появятся при следующем check, если их триггер всё ещё активен.

---

## 4. Доставка на UI

### 4.1. Push vs pull

**Push через существующий `MessageGateway`**. У нас уже есть WebSocket-соединение для уведомлений (`message`-namespace, room `user:<userId>`). Добавляем туда событие `hint:show` с payload `{ hintId, key, title, body, ctaLabel, ctaHref?, ctaEvent?, anchor, placement, ttlSec }`. Pull-вариант (poll каждые N сек) отвергаем: лишний трафик и задержка реакции на «закончил партию → покажи подсказку про анализ».

Бэкенд считает подсказки в двух точках:
1. **Реактивно** — после ключевых событий (`game_end`, `puzzle_failed`, `session_idle`, `page_view`). `HintsEngine.checkFor(userId, context)` запускается из соответствующих сервисов через event-bus (`@nestjs/event-emitter`).
2. **Тиковая проверка** — `@Cron('*/30 * * * * *')` для правил, привязанных к «время с момента X» (например, «не заходил неделю» — проверять незачем, пока пользователь не зашёл; «играет 10+ минут без перерыва» — раз в полминуты ок).

### 4.2. Anchor на UI

`data-hint-anchor="<anchor-key>"` на DOM-узлах, к которым может «прилипнуть» подсказка. Список anchor-ов — закрытый enum в `packages/shared/types/hint-anchors.ts`, чтобы фронт и сервер не разъезжались.

Frontend-компонент `<HintHost>` монтируется в `App.tsx` один раз, слушает `hint:show` через socket. На получении:
1. Ищет `document.querySelector('[data-hint-anchor="' + anchor + '"]')`.
2. Если узла нет (страница без anchor) — отвечает на сервер `hint:no-anchor`, сервер пишет в `user_events` как `hint_dismissed { reason: 'no_anchor' }` и больше эту подсказку в текущем page-view не предлагает.
3. Если узел есть — рендерит popover через portal, позиционирует по `placement` относительно anchor через `@floating-ui/react` (уже в зависимостях? проверить; если нет — добавить, это лёгкая либа, ~10 KB). Координаты НЕ передаём с сервера: только anchor-key, чтобы responsive-верстка не ломала позиционирование.

### 4.3. Обратная связь

Те же события, что в §2.1 (`hint_shown`, `hint_dismissed`, `hint_acted`, `hint_ignored`):
- `hint_shown` — отправляется фронтом сразу после успешного рендера.
- `hint_dismissed` — клик по «×».
- `hint_acted` — клик по CTA (или произошёл `ctaEvent`).
- `hint_ignored` — закрылась по `ttlSec` без действия.

События пишутся в `user_events` и параллельно обновляют `UserHintState` (поля `shownCount`, `lastShownAt`, `dismissedAt`, `actedAt`).

---

## 5. Lifecycle подсказки

### 5.1. Когда «выполнена»

Подсказка считается выполненной, когда у `UserHintState.actedAt` появилось значение. После этого:
- Если `actedAt` через CTA-клик — `suppressedUntil = now() + 365 days` (показывать не надо, человек узнал).
- Если правило снова сработает через год — покажем (например, новый интерфейс настроек, повторное напоминание уместно).

Альтернативный сценарий: подсказка «не закрывал пазлы неделю» считается выполненной, когда после показа произошло событие `puzzle_start`. Это правило прописывается отдельно в подсказке полем `acceptedBy: ['puzzle_start']` (`uniform с шагом «smart-dismiss»). Если в течение 24 часов после показа произошло одно из `acceptedBy` — `actedAt = now()`, даже если пользователь не кликал CTA.

### 5.2. Глобальные лимиты

Хардкод в `HintsEngine`:
- **≤1 показ за 10 минут на пользователя** — Redis-ключ `hints:throttle:<user_id>` с TTL 600.
- **≤5 показов за сессию** — счётчик в Redis с TTL до конца суток (сессия определяется грубо как «активность в пределах 30 минут», но для лимита достаточно дневного окна).
- **Глобальный «kill switch»** — feature-flag `hints_enabled` (уже есть `feature-flags`-модуль). При выключении `HintsEngine.checkFor` сразу возвращает пусто.

Per-hint лимиты — `maxShows` (общий), `cooldownSec` (после dismiss), `ttlSec` (автозакрытие).

### 5.3. Состояния

```mermaid
stateDiagram-v2
  [*] --> NeverShown
  NeverShown --> Shown: hint:show emitted + ack
  Shown --> Dismissed: user clicks ×
  Shown --> Acted: user clicks CTA / acceptedBy event
  Shown --> Ignored: ttlSec истёк
  Dismissed --> NeverShown: cooldown истёк
  Ignored --> NeverShown: cooldown истёк
  Acted --> [*]: suppressedUntil
```

---

## 6. Privacy

### 6.1. Что хранится

- `user_events` — userId + type + payload + timestamp. Payload намеренно ограничен полями из таблицы §2.1, никаких персональных данных (имена, тексты сообщений, FEN-ы партий) туда **не пишем**.
- `user_hint_states` — userId + hintId + статусы.
- Гости (без аккаунта) — события **не пишем вообще**. Аналитика только для авторизованных. Подсказки гостям не показываем (одно правило исключения, обсуждается отдельно: «гость на странице регистрации застрял 60 секунд» — пока вне scope).

### 6.2. Согласие

Добавляем в существующий cookie-banner отдельный чекбокс «Аналитика для персональных подсказок» (по умолчанию **выключен** — это ужесточение от того, что есть сейчас в Notification flow, но необходимо для GDPR). Состояние сохраняется в БД на User (новое поле `analyticsConsent boolean`).

`EventsService.track()` первым делом читает `user.analyticsConsent`. Если `false` — событие отбрасывается на входе, не доходит до Redis-буфера. `HintsEngine.checkFor` для такого пользователя возвращает пусто.

Кнопка «Удалить мои данные» (уже планируется в profile-настройках по GDPR — отдельный сквозной тикет) дополнительно стирает `user_events` и `user_hint_states` по userId.

### 6.3. Retention

90 дней (см. §2.3). Этого достаточно для всех правил, заявленных в §2.1.

---

## 7. Альтернативы

| Подход | Плюсы | Минусы | Решение |
|--------|-------|--------|---------|
| **SaaS Appcues / Userpilot / Pendo** | Готовый редактор подсказок, A/B, аналитика «из коробки» | $200–500/мес от первого пользователя, чужой JS на странице (privacy/perf), нельзя триггерить от backend-событий (только DOM/URL), vendor lock-in | Отвергнуто. Цена не оправдана при текущем DAU, и главное — нам нужны server-side триггеры (`game_end`, `puzzle_failed`), которых SaaS-решения этого класса нативно не умеют. |
| **PostHog (self-hosted) для аналитики + наш HintsEngine** | Богатые аналитические возможности, готовые SDK, funnels/A-B/cohorts «из коробки» | См. блок «Цифры по PostHog» ниже — затраты на инфраструктуру и поддержку существенно выше, чем у Postgres-таблицы, при том что funnels/cohorts для задачи «триггер подсказки» не нужны. | Отвергнуто. Если в будущем появится отдельная задача продуктовой аналитики (а не триггеров подсказок) — пересмотреть. |
| **Только декларативный конфиг в коде (TS-файл)** | Нет миграции, нет admin-UI | Любое изменение текста — деплой | Отвергнуто. Контент подсказок будет правиться часто, гонять деплой на каждую правку строки — лишнее. |
| **Engine на правилах в коде (`if`-блоки в `HintsEngine`)** | Можно делать сложные условия | Не масштабируется на 50+ правил, нет audit-trail | Отвергнуто. DSL §3.2 простой и покрывает все заявленные сценарии. |
| **Pull-модель (frontend polls `/hints/active` каждые N сек)** | Проще, нет WS-зависимости | Задержка реакции на server-side события (game_end), лишний трафик | Отвергнуто. WS у нас уже есть, переиспользуем. |
| **Хранить события в Redis stream и не персистить в PG** | Самое дешёвое по записи | События пропадают, агрегаты «не запускал 7 дней» нереализуемы | Отвергнуто. Аналитика нужна durable. |
| **Свой DSL на основе CEL / JSONata** | Готовые библиотеки | Лишняя зависимость, мощность не нужна | Отвергнуто. 5 операторов своего DSL дешевле. |

### Цифры по PostHog (обоснование)

Все значения — **оценки**, не наши измерения. Источники указаны явно; в скобках — степень доверия.

**Инфраструктура.** PostHog self-hosted production-minimum по их официальной документации (`posthog.com/docs/self-host/deploy/hobby` и `…/aws`, версия 1.49, состояние на 2025-12):

| Компонент | Минимальная конфигурация | AWS SKU (eu-central-1 Frankfurt, On-Demand, 2026) | $/мес |
|-----------|--------------------------|----------------------------------------------------|-------|
| PostHog app (web + worker + plugin-server) | 1× m5.large (2 vCPU, 8 GB) | EC2 `m5.large` 0.107 $/h | ~78 |
| Clickhouse | 1× r5.large (2 vCPU, 16 GB) — minimum по docs PostHog | EC2 `r5.large` 0.152 $/h | ~110 |
| Clickhouse storage (events) | 100 GB gp3 | EBS gp3 0.0928 $/GB/мес | ~9 |
| Kafka/Redpanda | 1× t3.medium (2 vCPU, 4 GB) | EC2 `t3.medium` 0.0464 $/h | ~34 |
| Postgres (служебный) | db.t3.micro + 20 GB | RDS `db.t3.micro` 0.022 $/h + storage | ~21 |
| **Итого** | | | **~252** |

Цифра «≥$160/мес», стоявшая в предыдущей правке, занижена — пересчитал по актуальным позициям AWS pricelist 2026-06 (eu-central-1, без Reserved Instances). Реалистичный диапазон — **$200–280/мес** для минимальной production-конфигурации. На Reserved 1-year — минус ~30%, то есть $140–195. (Доверие: **высокое** для AWS SKU — это публичные тарифы; **среднее** для конфигурации PostHog — их docs дают «recommended minimum», реальные требования зависят от объёма событий и могут быть выше при росте.)

**Поддержка.** Цифра «4–6 ч/мес» — **экспертная оценка, без эмпирического бенчмарка**, основана на:
- Релизный цикл PostHog: minor-релизы раз в 1–2 недели, major — раз в 1–2 месяца (источник: `github.com/PostHog/posthog/releases` за 2024–2025). Не каждый minor требует действия, но раз в 1–2 месяца есть migration или breaking change в плагинах.
- Clickhouse-миграции в PostHog регулярно меняют schema (схема `events` стабильна, но дополнительные таблицы funnels/cohorts эволюционируют) — каждая требует проверки на staging перед накатом на prod.
- Базовая операционка: бэкапы Clickhouse, мониторинг диска, ротация логов — 30–60 мин/мес даже когда ничего не ломается.

Доверие к цифре «4–6 ч/мес»: **низкое-среднее**. Диапазон «реалистично 2–10 ч/мес» был бы честнее. Принципиально это не меняет вывод — у Postgres-таблицы поверх существующего RDS этот показатель **0 часов** (RDS уже обслуживается devops в рамках существующего контура, см. ADR-027 «archive-rds-sizing» и ADR-045 «backend-deploy-perf»).

**Альтернатива (наш подход) — конкретные цифры.** Postgres-таблица `user_events` на существующем RDS (`db.t3.medium` Multi-AZ, см. ADR-027 §3): инкрементальная нагрузка по storage 100 GB при retention 90 дней (см. §7A) = ~$9/мес EBS, инкрементальная по CPU/RAM — пренебрежимо при 150K событий/день (~2 INSERT/sec в среднем, пик ≤20/sec). Постоянных эксплуатационных часов — 0 поверх существующего RDS-обслуживания. p95 запросов <20 мс — **оценка, не измерение** (типовой p95 для индексированного `WHERE user_id=$1 AND type=$2 AND created_at > now() - interval '7 days'` при таблице ≤50M строк и rowsize ~200 байт; источник — наша же практика на других таблицах сопоставимого объёма, см. ADR-033 «archive-database-interface»). Реальный показатель измеряется на этапе T13.

---

## 7A. Масштабирование

ADR заявляет конкретное архитектурное решение для горизонта 6–12 мес (объём 50–150K событий/день, см. §2.3). Здесь — **что меняется при превышении** и **какие наблюдаемые сигналы запускают переход**.

### 7A.1. Пороги и эволюция

| Порог (входной поток) | Активный размер таблицы (при retention 90 дней) | Что меняется | Оценка трудозатрат на переход |
|----------------------|------------------------------------------------|--------------|-------------------------------|
| **≤150K событий/день** (≤14M строк live) | ~3 GB данных + ~3 GB индексов | Базовая конфигурация ADR: одна таблица, 2 композитных индекса, retention 90 дней, daily cleanup-cron | — |
| **150K – 1M событий/день** (14M – 90M live) | ~20 GB | (1) Партиционирование по месяцам через `PARTITION BY RANGE(created_at)`, retention снижается до 60 дней. (2) Материализация горячих агрегатов в Redis hash `agg:<user_id>:<type>:<window>` с TTL = размер окна, инкремент одновременно с INSERT. (3) Vacuum + autovacuum-tuning на партициях | 1–2 нед backend |
| **1M – 10M событий/день** (90M – 900M live) | 200 GB+ | (1) Выделить `user_events` в **отдельную PG-инстанцию** (read-write split: основная RDS для приложения, events-RDS на db.r5.large — по образцу ADR-018 «archive-service-extraction» и ADR-027 «archive-rds-sizing»). (2) Партиционирование по неделям. (3) HintsEngine читает агрегаты ИСКЛЮЧИТЕЛЬНО из Redis cache, raw-events — только для ad-hoc разборов | 3–4 нед backend + devops (новая RDS, миграция, мониторинг) |
| **>10M событий/день** (>900M live) | >2 TB при retention 90 дней | (1) Поток raw events идёт в **Clickhouse** через Redpanda (или Kinesis Data Streams — выбор в follow-up ADR). PG-таблица остаётся для **последних 7 дней** как hot-store для агрегатов. (2) HintsEngine продолжает работать на материализованных Redis-агрегатах, обновление агрегатов — Clickhouse-материализованные views. (3) Учить новый стек эксплуатации | 6–10 нед, кросс-команда |

### 7A.2. Триггеры миграции (наблюдаемые KPI на T13)

Не «когда DAU вырастет в 10 раз», а **конкретные сигналы из Prometheus**:

| Метрика | Порог | Что запускает |
|---------|-------|---------------|
| `pg_stat_user_tables{relname='user_events'}.n_live_tup` | > 50M | Партиционирование (порог 1) |
| `histogram_quantile(0.95, user_events_query_duration_seconds)` | > 50 мс sustained 1 неделя | Партиционирование + Redis-агрегаты |
| `user_events_buffer_size` (Redis LLEN) | > 5K sustained 5 мин | Воркер не справляется → батч-размер 1000 мал, повысить или отдельная DB |
| `pg_database_size('main') - pg_database_size('main' WITHOUT user_events)` | > 50 GB | Вынос в отдельную RDS (порог 2) |
| `rate(user_events_inserted_total[5m])` | > 100 events/sec sustained 1 неделя | Подготовка к Clickhouse-варианту (порог 3) |
| `pg_replication_lag_seconds` (replica) | > 30s | Признак, что write-нагрузка не вытягивается основным RDS |

### 7A.3. Что НЕ меняется при росте

- **Контракт `EventsService.track(userId, type, payload)`** — продуктовый код выше не знает, куда пишутся события: PG, Redis stream, Kafka. Это позволяет менять storage без переписывания game/puzzle/lesson-сервисов.
- **DSL правил §3.2** — оперирует абстрактными «count события за окно», в реализации может ходить и в PG, и в Clickhouse-MV, и в Redis-cache.
- **WS-канал `hint:show`** и frontend — индифферентны к storage аналитики.

### 7A.4. Когда пересматривать сам ADR

Полная ревизия ADR (новый ADR со ссылкой на этот) — при пересечении **любого** из:
- DAU фактически > 5K в течение месяца (то есть «достижение цели» по ADR-128 §7.4.2).
- Появилась отдельная задача продуктовой аналитики (funnels, retention cohorts, A/B-эксперименты) — у неё другие требования, может оказаться, что PostHog-подобный стек оправдан.
- Меняется требование к retention (например, регуляторное «хранить 1 год» вместо «90 дней») — это сразу х4 по storage.

---

## 8. План внедрения (декомпозиция на тикеты)

Порядок — последовательный, каждый следующий зависит от предыдущего по схеме данных. Backend и frontend для каждого этапа разносим на отдельные тикеты — координатор заведёт по итогам ADR.

### Этап 1. Сбор событий (фундамент)

1. **backend: миграция `user_events` + EventsService + Redis-буфер**
   - Prisma model `UserEvent`, миграция, индексы из §2.3.
   - `EventsModule`: `EventsService.track(userId, type, payload)`, `EventsService.batchInsertFromBuffer()` (worker).
   - `POST /events` controller с DTO-валидацией, IP-rate-limit (по образцу `client-logs`).
   - Cron на retention 90 дней.
   - Тесты: запись в буфер, dump в PG, drop по retention.

2. **frontend: events-клиент**
   - `apps/web/src/lib/events.ts` — функция `track(type, payload)`, batch до 50 событий или раз в 5 сек, `navigator.sendBeacon` на unload.
   - Хук `usePageViewTracking` в App.tsx (на изменение route).
   - Хук `useIdleTracking` (60s простоя → `session_idle`).
   - Заглушка: если `analyticsConsent === false` — функция no-op.

3. **backend: self-emit из существующих сервисов**
   - `game.service.ts` / `game.gateway.ts`: `game_start`, `game_end`, `pre_move_used`.
   - `puzzle.service.ts`: `puzzle_start`, `puzzle_solved`, `puzzle_failed`.
   - `puzzle-rush.service.ts`: `rush_start`, `rush_end`.
   - `lesson.service.ts`: `lesson_start`, `lesson_complete`.
   - `tactic-drill.service.ts`: `drill_start`, `drill_complete`.
   - Все через `eventsService.track()` (fire-and-forget, не блокирует основной flow).

### Этап 2. Согласие и privacy

4. **backend: поле `analyticsConsent` на User + endpoint**
   - Миграция: `users.analytics_consent boolean default false`.
   - `PATCH /me/consent { analytics: boolean }`.
   - Проверка `analyticsConsent` в `EventsService.track`.

5. **frontend: обновление cookie-banner + чекбокс в настройках**
   - Чекбокс «Аналитика для персональных подсказок» в баннере и в `Settings → Privacy`.
   - i18n (ru/en) для текстов.

### Этап 3. Hints engine

6. **backend: миграция `hints`, `user_hint_states` + HintsEngine (без UI)**
   - Prisma модели из §3.1.
   - `HintsService`: `checkFor(userId, context)` — выполнение DSL §3.2, выбор одного hint, запись в `UserHintState`.
   - Парсер DSL: операторы `page`, `count`, `exists`, `timeSince`, `all`, `any`, `not`. Unit-тесты на каждый оператор.
   - Глобальные лимиты Redis (§5.2).
   - Feature-flag `hints_enabled` (default `false` — включим после прохода QA).
   - Hook на event-bus: после `game_end`, `puzzle_failed`, `session_idle`, `page_view` — вызывать `HintsEngine.checkFor`.
   - Seed `apps/api/prisma/seeds/hints.ts` с 5 базовыми подсказками (см. §9).

7. **shared: типы anchor-enum и hint-payload**
   - `packages/shared/types/hint-anchors.ts` — enum значений `data-hint-anchor`.
   - `packages/shared/types/api-contracts.ts` — `HintShowPayload`, `HintLifecyclePayload`.

8. **backend: WS-emit hint:show + REST для lifecycle**
   - Добавить событие `hint:show` в `MessageGateway` (room `user:<id>`).
   - `POST /hints/:id/dismissed` / `/acted` / `/ignored` / `/shown` — обновление `UserHintState` + запись в `user_events`.

### Этап 4. Frontend подсказки

9. **frontend: компонент `<HintHost>` + позиционирование**
   - Глобальный mount в `App.tsx`.
   - Подписка на `hint:show` через существующий socket.
   - Поиск anchor в DOM, рендер через portal, позиционирование `@floating-ui/react`.
   - Кнопки «×» / CTA.
   - Авто-закрытие по `ttlSec`.
   - Отправка lifecycle-событий назад на API.
   - Тесты: render, dismiss, cta-click, no-anchor fallback.

10. **frontend: расстановка `data-hint-anchor` на ключевых элементах**
    - Список из 10–15 anchor-ов: кнопка «Анализ» на странице игры, плитка «Пазлы» на главной, переключатель темы доски в настройках, кнопка «Pre-move» в настройках доски, и т. д.
    - Без визуальных изменений, только атрибуты.

### Этап 5. Контент и админ-UI (следующая итерация)

11. **content: первые 10–15 подсказок** (текст + правила) — задача для marketing/content.
12. **admin: CRUD UI для `hints` таблицы** — отдельный ADR/тикет, не блокирующий MVP.
13. **observability: метрики Prometheus** — `hints_check_duration`, `hints_shown_total{key}`, `hints_acted_total{key}`, `events_buffer_size`. Дашборд в Grafana.
14. **QA: ручной test-plan на каждое из 10 правил**.

### Зависимости (граф)

```mermaid
graph LR
  T1[1. user_events backend] --> T3[3. self-emit]
  T1 --> T6[6. HintsEngine]
  T2[2. events frontend] --> T6
  T3 --> T6
  T4[4. consent backend] --> T6
  T4 --> T5[5. consent frontend]
  T6 --> T8[8. WS emit + REST]
  T7[7. shared types] --> T8
  T7 --> T9[9. HintHost frontend]
  T8 --> T9
  T9 --> T10[10. anchor placement]
  T10 --> T11[11. content seed]
  T10 --> T14[14. QA]
  T6 --> T12[12. admin UI - отдельный ADR]
  T9 --> T13[13. observability]
```

---

## 9. Примеры стартовых подсказок (для seed-файла)

| key | Когда | Текст (ru) | Anchor | CTA |
|-----|-------|-----------|--------|-----|
| `analyze-your-game` | После `game_end` если за 5 мин не было `analysis_open` для этой партии | «Партия закончена. Посмотри, где ход решил исход — встроенный анализ под доской.» | `game-end-analysis-button` | «Открыть анализ» → `/game/<id>?tab=analysis` |
| `try-pre-move` | На странице `/play/*` если за 30 мин ≥3 `game_start { rated: true }` и ни одного `pre_move_used` | «Играешь много блица — pre-move сэкономит секунды на очевидных ходах.» | `board-settings-icon` | «Включить» → открыть `BoardSettingsModal` через `ctaEvent: open_board_settings` |
| `puzzles-comeback` | Если `timeSince puzzle_start > 7 days` и текущая страница — главная | «Не решал пазлы неделю — рейтинг тактики просел. 5 минут на разминку?» | `home-puzzles-tile` | «К пазлам» → `/puzzles` |
| `rush-mode-discovery` | После 10-го успешного `puzzle_solved` если ни разу не было `rush_start` | «Понравились пазлы? Попробуй Puzzle Rush — гонка на время.» | `puzzles-rush-tab` | «Запустить Rush» → `/puzzle-rush` |
| `mistakes-diary` | Если `count puzzle_failed за 7 days >= 5` и ни одного `feature_used { feature_key: 'mistakes_diary_opened' }` | «Накопились ошибки в пазлах — посмотри их в «Дневнике ошибок».» | `profile-mistakes-link` | «Открыть дневник» → `/profile/mistakes` |

---

## 10. Открытые вопросы (вне scope ADR)

1. **Гостевые подсказки.** Пока запрещены (нет userId для state). Если маркетинг попросит — отдельный ADR с client-only state в localStorage.
2. **A/B-тесты текстов подсказок.** Не входит в первую версию. Можно прикрутить позже через существующий `feature-flags` (флаг определяет вариант текста).
3. **Подсказки на мобильной верстке.** В §4.2 предполагается desktop-popover. Для мобайла нужен отдельный паттерн — bottom-sheet вместо popover. Решается на этапе T9, не блокирует архитектуру.
4. **Подсказки в иммерсивных режимах (live-партия, lecture).** По умолчанию `HintsEngine` блокируется на этих страницах через правило `page.matches`. Конкретный список «тихих» страниц фиксируется на этапе T11.
5. **Internationalization текстов.** Тексты в `hints.title/body` — на русском, для en вариант кладём отдельной таблицей `hint_translations(hint_id, lang, title, body, cta_label)` или в JSON-поле `i18n` на самой `Hint`. Решение принимается на T11 (зависит от того, как контент-команда хочет редактировать).

---

## 11. Резюме

- **Своё решение, не SaaS.** Стоимость, server-side триггеры, privacy.
- **Postgres + Redis-буфер**, без отдельного аналитического стека. По оценке §2.3 — хватит на горизонт 6–12 месяцев; пороги перехода и план эволюции до Clickhouse — §7A.
- **Декларативный JSON-DSL** для правил, редактируется через seed (MVP) и админ-UI (позже).
- **Push через существующий MessageGateway.** Anchor по `data-hint-anchor`, позиционирование на клиенте.
- **Lifecycle 4 состояния**, suppression на год после действия, hard-лимиты 1/10мин и 5/сессия.
- **Privacy by default**: согласие выкл, гости не трекаются, retention 90 дней.

Декомпозиция в §8 — 14 тикетов, минимально жизнеспособный продукт после прохода T1–T10. Контент (T11) и админка (T12) не блокируют запуск с seed-набором подсказок.
