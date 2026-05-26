# ADR-079. /precision — отделение пользовательских задач, «Начать тренировку», авто-подбор по рейтингу

Статус: предложен (2026-05-26)
Связано: KS-3339 (этот ADR), ADR-048 (Precision раздел),
ADR-057 (Precision UX split), ADR-076 (mobile chips-bar +
bottom-sheet), ADR-065 (5-звёздочный score),
ADR-035 (Glicko-1 для tactical drills).

**Ревизия 2 (2026-05-26):** после уточнений пользователя по
KS-3339 — заводим отдельный `precision-рейтинг` (а не используем
`User.ratingPuzzle`); счётчики scope-counts становятся обязательными;
backward-compat старых URL — переписывание сразу. См. §3.6, §8 (новые
задачи B0/B0.5/S2).

## 1. Контекст

Три запроса пользователя по разделу `/precision`:

1. **Разделить пользовательские (Черновик) задачи и серверные.**
   Сейчас на табе «Мои пазлы» в одной сетке смешаны draft (исходно
   `isPublic=false`) и published-задачи владельца. Пользователь не
   ориентируется, что из этого «недоделанные тренировки», а что
   уже «отпубликованное».
2. **Кнопка «Начать тренировку»** — автоматический запуск следующей
   задачи без ручного клика по карточке в сетке. Сейчас пользователь
   сам выбирает диаграмму глазами.
3. **Подбор задачи по рейтингу пользователя.** Сейчас slider
   «Рейтинг» — ручной фильтр; автоматического подбора по
   `ratingPuzzle ± окно` нет.

Текущее состояние кода (см. `apps/web/src/pages/PrecisionPage.tsx`):

- URL-state: `?mine=true|false` (Authorship), `?visibility=draft|public|all`
  (фильтр публичности), `?objective=convertAdvantage|saveEquality|all`,
  `?showSolved=true`, `?blundererEloMin/Max`.
- Backend `GET /puzzles/browse?source=generated&mine&visibility&themes&blundererElo*`
  уже поддерживает все нужные комбинации фильтров (KS-2578/KS-2580).
- `User.ratingPuzzle` существует и используется lessons-модулем
  (`CourseRecommendationResponse.ratingPuzzle`), доступен через
  `PrismaService`.
- `PrecisionController` есть (`apps/api/src/precision/precision.controller.ts`).
- ADR-076 (chips-bar) находится в работе (KS-3243); этот ADR
  совместим — добавляет 3 scope-pill'ы вместо текущей 2-pill
  Authorship-секции.

## 2. Решение

### 2.1 Три scope-pill'ы вместо Authorship (Все/Мои)

В chips-bar (компонент `PrecisionFilterChipsBar` из ADR-076)
заменить 2-pill Authorship на 3 mutually-exclusive pill'ы:

| Pill | URL `scope` | Маппинг в backend |
|---|---|---|
| `[Серверные]` | `server` (default) | `mine=false, visibility=public` |
| `[Мои черновики]` | `drafts` | `mine=true, visibility=draft` |
| `[Мои опубликованные]` | `published` | `mine=true, visibility=public` |

Опционально (M2) — на каждой pill'е counter в скобках: «Серверные
(1k+)», «Мои черновики (12)», «Мои опубликованные (4)». Источник —
`GET /precision/scope-counts` (см. §2.5).

Существующий URL-state мапится:
- `mine=false` (или нет) + `visibility != draft` → `scope=server`.
- `mine=true, visibility=draft` → `scope=drafts`.
- `mine=true, visibility=public` (или нет) → `scope=published`.
- Если backward-incompatible комбинация — fallback на `scope=server`.

Гостям (не залогинен) показываются только `server` (две другие
pill'ы скрыты — у гостя нет своих задач).

### 2.2 Кнопка «Начать тренировку» с авто-подбором

Sticky-кнопка над сеткой карточек (на mobile — full-width;
на desktop — справа от chips-bar):

```
[ ▶ Начать тренировку ]
```

Tap → `GET /precision/next?scope=...&objective=...` →
- 200 `{ puzzleId, rating, ratingDelta }` → `navigate('/puzzle/' +
  puzzleId + '?source=precision&return=' + encodeURIComponent(location))`
- 404 `no_puzzles_available` → toast «По текущим фильтрам задач
  нет — измените фильтры или сбросьте».

После решения задачи (`/puzzle/:id?source=precision`) на странице
результата — кнопка «Следующая →», которая повторяет тот же запрос
с теми же фильтрами (читает их из `return` URL). Без ручного
возврата на `/precision`.

### 2.3 Алгоритм подбора по рейтингу

Использует **отдельный** `precision-рейтинг` пользователя (см.
§3.6). Хранится в `user_precision_ratings`, Glicko-1, начальное
значение 1500. Не путать с `User.ratingPuzzle` (общий puzzle-рейтинг
по lichess-задачам). Решение завести отдельный — фиксация решения
пользователя по KS-3339 ревизии 2: precision-кривая сложности
отличается от lichess-puzzle (ADR-044 §3.5), общий рейтинг
смешивал бы две метрики.

Алгоритм `PrecisionService.pickNext(userId, filters)`:

1. **Базовый рейтинг.** `target = getPrecisionRating(userId) ?? 1500`
   (1500 — стандартный Glicko-1 initial; для гостя или нового
   пользователя без attempts).
2. **Окно поиска.** Старт `window = 150`. Расширения: 300, 500,
   1000, бесконечность. Останавливаемся как только нашли ≥ 1
   подходящий пазл.
3. **Фильтры.** Применяем существующие из `PuzzleRepository.browse`:
   - `source = 'generated'`;
   - `mine + visibility` по scope (§2.1);
   - `themes = [objective]` если `objective != all`;
   - `hideSolved = true` (исключаем уже preserved/hold — пользователь
     не должен видеть «решённую заново»);
   - `ratingMin = target - window, ratingMax = target + window`.
4. **Random pick.** Из подходящих — `ORDER BY random() LIMIT 1`.
5. **Возврат.** `{ puzzleId, rating: puzzle.rating, ratingDelta:
   puzzle.rating - target }`. `ratingDelta` — для UX-надписи на
   следующей странице («задача на 80 выше твоего рейтинга»).
6. **Если ничего нет даже при `window = ∞`** — 404
   `no_puzzles_available`.

`overrideRating(Min|Max)` (опц. query) — если пользователь явно
сдвинул slider, override алгоритма. Используется UI только когда
slider не на дефолтах.

### 2.4 Что НЕ делаем

- НЕ делаем «уровни сложности» (easy/medium/hard) — это поверх
  rating-окна, для precision сложнее предсказать.
- НЕ удаляем slider «Рейтинг» — он остаётся как **override** для
  тех, кто хочет ручной контроль. Авто-подбор использует его если
  установлен (не на дефолтах).
- НЕ меняем `User.ratingPuzzle` логику — это другой ADR.
- НЕ переименовываем разделы; названия pill'ов — i18n-ключи,
  локализуются позже.
- НЕ ретроактивно пересчитываем precision-рейтинг по старым
  `PrecisionAttempt`-записям (см. §3.6 «backfill»).

### 2.5 `GET /precision/scope-counts` (обязательный)

`{ server: number, drafts: number, published: number }`. Три
SELECT COUNT для текущего пользователя. Кешировать на 60 секунд
per-user (in-memory или Redis). Используется для бейджей на pill'ах
chips-bar.

После ревизии 2 KS-3339 — это **обязательная** часть M1, не
опциональная. Пользователь хочет видеть «(N)» рядом с каждой
scope-pill сразу, чтобы понимать, какие разделы пусты.

### 2.6 Backward-compat URL

Старый URL `?mine=true&visibility=draft` (и любые комбинации `mine`
+ `visibility`) при mount странице **переписываем сразу** на
`?scope=...` через `setSearchParams({ replace: true })`. Без
переходного периода — пользователь по уточнению KS-3339 ревизии 2
выбрал «сразу». Закладки и shareable-ссылки после первого открытия
автоматически нормализуются.

Маппинг (single source of truth, утилита `precisionUrlMigrate.ts`):

```
mine=true, visibility=draft           → scope=drafts
mine=true, visibility=public          → scope=published
mine=true, no visibility              → scope=drafts (default для своих)
mine=false (or missing)               → scope=server
```

Все остальные query-параметры (`objective`, `showSolved`,
`blundererEloMin/Max`) переносятся без изменений.

## 3. UX-сценарии

### 3.1 Гость заходит на /precision

- chips-bar: `[Все типы]` `[Реализуй]` `[Ничью]` `[+ Рейтинг]` (без
  scope-pill'ов — гостю недоступны draft/published).
- Sticky-кнопка «Начать тренировку» — видна. Tap → `/puzzle/:id`
  для случайной серверной задачи (target = 1200 — default
  для не-залогиненных, либо нет ratingPuzzle).

### 3.2 Залогиненный, на server scope

- chips-bar: `[Серверные]` (активна) `[Мои черновики]` `[Мои
  опубликованные]` + остальные pill'ы.
- Сетка: только публичные серверные задачи.
- «Начать тренировку» → `/precision/next?scope=server` → подбор
  по `ratingPuzzle ± 150`.

### 3.3 Залогиненный, на drafts scope

- chips-bar: `[Мои черновики]` (активна).
- Сетка: только мои draft-задачи (с бейджем «Черновик», owner-
  actions).
- «Начать тренировку» → `/precision/next?scope=drafts` → подбор
  среди моих draft'ов по рейтингу. **Внутри drafts окно поиска
  расширяется быстрее** (10–30 задач обычно — узкая выборка).
- Может не быть задач — UX явно говорит «У вас нет черновиков
  по фильтрам, сгенерируйте новые через ⋮ → Генерация из PGN».

### 3.4 После solve на /puzzle/:id?source=precision

- Существующий PuzzleResolution UX + две кнопки: **«← Назад к
  списку»** и **«Следующая →»** рядом.
- Tap «Следующая» — re-fetch `GET /precision/next` с теми же
  query-фильтрами из `return` URL.
- Tap «Назад» — возврат на `/precision?...` из `return`-параметра.

Оба варианта остаются по уточнению KS-3339 ревизии 2 — пользователь
хочет иметь возможность вернуться к сетке вручную (например, чтобы
сменить scope или подсмотреть, какие задачи ждут).

### 3.5 Precision-рейтинг — отображение

- На странице `/precision` рядом с compact-stats (одна строка)
  добавить «Рейтинг: 1487 (±42)» — текущий `ratingPrecision` ±
  `ratingDeviation`. Источник — `GET /precision/me/rating` (см. §4.4).
- На странице `/puzzle/:id?source=precision` после solve — дельта
  «Рейтинг 1487 → 1502 (+15)» рядом с финальным score'ом.
- На странице `/precision/stats` (KS-2744) добавить блок
  «Precision-рейтинг» (история): график как у puzzle-rating.
  M2 — отдельная задача после стабилизации формулы.

### 3.6 Precision Rating — модель и алгоритм

#### 3.6.1 Хранилище

Отдельная таблица `user_precision_ratings` — по образцу drill-
рейтинга (ADR-035 / KS-2311). НЕ поле в `User` — Glicko требует
≥ 3 связанных полей (rating, deviation, volatility) + ts-маркеры,
изоляция в отдельной таблице чище и не раздувает базовую сущность.

```prisma
model UserPrecisionRating {
  userId           String   @id @map("user_id") @db.Uuid
  rating           Float    @default(1500)
  deviation        Float    @default(350)        // Glicko RD
  volatility       Float    @default(0.06)       // Glicko-2 (для будущего)
  attempts         Int      @default(0)
  lastAttemptAt    DateTime? @map("last_attempt_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("user_precision_ratings")
}
```

PK = userId (одна запись на пользователя; история — через
`PrecisionAttempt.ratingBefore/ratingAfter`, добавим поля).

#### 3.6.2 Когда обновляется

Сразу после успешной записи `PrecisionAttempt` в
`PrecisionService` (см. `apps/api/src/precision/precision.service.ts`,
там уже есть `tx.precisionAttempt.create({ ... })`). Внутри той же
транзакции — вызов `PrecisionRatingService.applyRatingChange(userId,
puzzleRating, attemptScore)`, который:

1. Skip если `userId == null` (гость — рейтинг не пишем).
2. Skip если `User.isHidden || User.isTestAccount` (service-аккаунты
   не попадают в leaderboard'ы; согласовано с ADR-035 §10.7-4).
3. Берёт текущий `UserPrecisionRating` (или создаёт default 1500/350).
4. Маппит `PrecisionAttempt.score` (0..100, ADR-065 5-звёздочный) в
   Glicko-outcome:
   - score ≥ 80 (4–5★) → outcome **1.0** (победа)
   - 50 ≤ score < 80 (3★) → outcome **0.5** (ничья)
   - score < 50 (1–2★) → outcome **0.0** (поражение)
5. Получает соперника = `Puzzle.rating` (если null — fallback
   1500, новые generated до калибровки). PuzzleRD = 50 (тот же
   фиксированный, что у drill).
6. Glicko-1 continuous update через `GlickoRatingService` (он уже
   есть в `apps/api/src/puzzle/glicko-rating.service.ts`,
   переиспользуем без правок).
7. Burst-penalty и daily-cap — НЕ применяем в MVP (precision не
   competitive, лидерборд позже). Если в будущем — расширяем
   копируя из `TacticDrillRatingService`.
8. Записывает обновлённые `rating/deviation/attempts/lastAttemptAt`
   в `UserPrecisionRating`. В `PrecisionAttempt` добавляем поля
   `ratingBefore`/`ratingAfter` (миграция).

#### 3.6.3 Backfill (что делаем со старыми attempts)

**Не делаем backfill.** Старые attempts (до выкатки этого ADR)
не пересчитываются — рейтинг пользователя стартует с 1500 на момент
первой новой попытки. Причины:
- Glicko требует серию попыток в хронологическом порядке, замер RD
  меняется с каждой; пересчёт батчем — не вполне корректно
  (volatility-параметр не калибруется).
- Объём данных невелик (ADR-079 в начале M1 precision), стартовать
  с чистого листа дешевле.
- Если пользователь хочет историю — отдельный M2-job можно сделать
  позже.

В `PrecisionAttempt` ретро-поля `ratingBefore/ratingAfter` остаются
`NULL` для старых строк — UI это нормально обрабатывает (нет
«дельты» в показе результата).

#### 3.6.4 Гости

У гостя нет `UserPrecisionRating`. `pickNext` использует target
1500. После регистрации первая попытка инициализирует запись.

#### 3.6.5 «Сложность» задачи для Glicko

`Puzzle.rating` — это единственный источник. У некоторых
generated-пазлов он null (до калибровки, KS-2689) — fallback 1500.
Калибровка `Puzzle.rating` для precision — отдельная история
(ADR-044 §3.5 признан кривым; калибровка в backlog).

Это значит: на первых неделях рейтинг будет «шумным», потому что
puzzle.rating сам неточный. Это **известный риск**, не блокер: с
1000-2000 attempt'ами система самоконвергирует. Если калибровка
покажет систематический bias — отдельный recalc job.

## 4. API

### 4.1 Новый endpoint `GET /precision/next`

```
GET /precision/next?scope=server|drafts|published
                   &objective=all|convertAdvantage|saveEquality
                   &overrideRatingMin=...&overrideRatingMax=...
                   &hideSolved=true (default)
```

- Auth: `OptionalJwtGuard` (гость → `scope=server`,
  `target=1200`).
- Response 200: `{ puzzleId: string; rating: number; ratingDelta: number }`.
- Response 404: `{ code: 'no_puzzles_available'; reason?: string }`.

Реализация в `PrecisionController` + `PrecisionService.pickNext`.
Используем существующий `PuzzleRepository.browse` с
`limit=20, orderBy='random'` (или кастомный SQL с `ORDER BY random()
LIMIT 1` для производительности).

### 4.2 Опц. `GET /precision/scope-counts`

```
GET /precision/scope-counts
```

- Auth: `JwtAuthGuard` (гостю не возвращаем — у него нет
  drafts/published).
- Response: `{ server: number; drafts: number; published: number }`.
- Cache: 60 сек per-user.

Не блокирует MVP.

### 4.3 Изменения существующих endpoints

`GET /puzzles/browse` — без изменений (поддерживает все нужные
комбинации).

### 4.4 Новый endpoint `GET /precision/me/rating`

```
GET /precision/me/rating
```

- Auth: `JwtAuthGuard`.
- Response 200: `{ rating: number; deviation: number; attempts: number;
  lastAttemptAt: string | null }`.
- Response 200 для нового пользователя без attempts: `{ rating: 1500,
  deviation: 350, attempts: 0, lastAttemptAt: null }`.

Используется страницей `/precision` для отображения «Рейтинг: 1487
(±42)» и страницей `/precision/stats` для блока истории (M2).

### 4.5 Расширение `PrecisionAttempt`-records

В response endpoint'а записи attempt (внутренний `POST /precision/
attempts` — что вызывает `tx.precisionAttempt.create`, см.
`precision.service.ts:684`) добавляем в выдачу:

```
{
  ...
  ratingBefore: number | null,    // null для гостя
  ratingAfter: number | null,
  ratingDelta: number | null,     // ratingAfter - ratingBefore
}
```

Frontend (страница результата задачи) использует для отображения
дельты.

## 5. Лимиты и безопасность

- `GET /precision/next` без owner-check (это random-pick по
  репозиторию). Backend сам не отдаст draft чужому через `visibility=public`.
- Rate-limit `@UserRateLimit(60, 60)` (1 req/sec) — защита от спама
  «next next next next» на frontend кликах. Реалистично — даже
  кликаль клиент-маньяк ≤ 10/мин.
- Лимит размера окна не нужен — он итерируется до конца, тяжёлых
  запросов нет (count-задач — миллион, single index по rating).
- Гостю показываем только `scope=server`, `target=1200`. Никаких
  персональных данных не светим.

## 6. Влияние на ADR-076

ADR-076 (chips-bar, в работе) переопределяет фильтры мобильного
UI. Этот ADR не конфликтует — добавляет:

- 3 scope-pill'ы вместо 2-pill Authorship (изменение в
  `PrecisionFilterChipsBar`).
- Кнопку «Начать тренировку» сверху над сеткой (новая sticky-зона
  между chips-bar и compact-stats).

Координация — координатору при назначении задач связки: F1 этого
ADR делается **поверх** KS-3243/3244/3245, не параллельно.

## 7. Риски

1. **`hideSolved=true` исключает уже решённые** — в drafts scope
   у пользователя своих задач 10–30, после 5–10 успешных подряд
   `pickNext` начнёт возвращать 404. Решение: при 404 в drafts —
   UX-toast «Вы решили все свои черновики, сгенерируйте новые».
2. **Пустые серверные при узком фильтре** (`objective=saveEquality,
   ratingMin=2200`). Алгоритм расширяет окно до бесконечности — но
   `objective` не расширяется. Если задач 0 — 404 с понятным
   reason.
3. **Backward-compat URL** (если в закладках `?mine=true`) —
   мапим в `scope=drafts` или `scope=published` через server-side
   логику в Frontend на старте страницы (one-time переписывание
   URL через `replace`). Тесты покрывают 4 комбинации.
4. **Бейджи с counters могут быть устаревшими** (60-sec cache) —
   приемлемо для UX, никто не следит за точным числом.
5. **Гость без `ratingPuzzle`** — fallback 1200. Альтернативы:
   спросить уровень при первом заходе (overkill), показать all-rating
   (плохо для UX). 1200 — стандартный начальный.
6. **«Следующая» на PuzzleResolution** требует знать query-
   контекст. Передаём через `?return=` URL-encoded. Tests на
   round-trip.
7. **`overrideRatingMin/Max` vs auto** — если slider не на
   дефолтах (800–3000), считаем что пользователь явно ограничил.
   Окно фиксированное (slider), `target` игнорируется. UX-нотис на
   странице solve «Slider ограничил выборку — отключите для
   полного диапазона».

## 8. Реализация — follow-up задачи

Ревизия 2 (KS-3339 уточнения): добавлены `B0` (миграция precision-
рейтинга), `B0.5` (`PrecisionRatingService` + интеграция в
PrecisionService.create), `S2` (shared типы для рейтинга). KS-3342
становится обязательным (счётчики). KS-3345 («Следующая» на
PuzzleResolution) обязательным.

Зависимости:
- **S1 + S2** → независимые shared (можно параллельно).
- **B0** (миграция) → **B0.5** (rating-сервис) → встроен в
  существующий `PrecisionService.create` (тот же тикет либо
  отдельный refactor-task).
- **B1** (pickNext) зависит от B0.5 (target = ratingPrecision).
- **B2** (scope-counts) — независим от B0/B0.5, можно параллельно
  B1.
- **B3** (`GET /precision/me/rating`) — после B0.
- **F1** (chips-pills) — KS-3340 + KS-3243.
- **F2** (sticky-CTA) — после B1, F1.
- **F3** («Следующая») — после B1.
- **F4** (показ рейтинга на /precision и на странице solve) — после
  B3 и B0.5.
- **L1** — после F1, F2, F4.

### KS-3340 (S1) — shared types для scope + pick-next

**Assignee:** backend (shared owner).
**Labels:** `puzzle`, `analysis`.
**Описание:**
- В `packages/shared/src/types/api-contracts.ts`: добавить
  `PrecisionScope = 'server' | 'drafts' | 'published'`,
  `PickNextPrecisionRequest = { scope; objective?; overrideRatingMin?;
  overrideRatingMax?; hideSolved? }`, `PickNextPrecisionResponse =
  { puzzleId; rating; ratingDelta }`,
  `PrecisionScopeCountsResponse = { server; drafts; published }`.
**Acceptance:**
- TS-сборка без ошибок.
- Discriminated union для error/success (если нужно — отдельный
  тип `PickNextPrecisionResult = Success | NotAvailable`).

### KS-3341 (B1) — endpoint `GET /precision/next`

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** KS-3340, KS-3349 (для target из precision-рейтинга).
**Описание:**
- В `PrecisionService.pickNext(userId, filters)` — алгоритм по §2.3.
- В `PrecisionController` метод с `OptionalJwtGuard`.
- `@UserRateLimit(60, 60)`.
- Использовать `UserPrecisionRating.rating` (fallback 1500). НЕ
  `User.ratingPuzzle` (revision 2 — отдельный рейтинг).
- Расширение окна 150 → 300 → 500 → 1000 → ∞ через цикл с
  SQL-запросом на каждой итерации (можно лимитировать 4 итерациями).
- `hideSolved=true` по умолчанию.
**Acceptance:**
- Тест: rating=1500 → подбирает в окне 1350..1650; если нет
  — расширяет.
- Тест: scope=drafts → возвращает только свои `mine=true,
  visibility=draft`.
- Тест: solved-задачу не возвращает.
- Тест: гость → fallback 1500, scope=server.
- Тест: пустая выборка → 404 `no_puzzles_available`.

### KS-3342 (B2, обязательно) — endpoint `GET /precision/scope-counts`

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** —
**Приоритет:** P1 (KS-3339 ревизия 2 — пользователь требует
counter'ы на pill'ах сразу).
**Описание:**
- 3 COUNT-запроса по `puzzles` с разными `mine`/`visibility`.
- Cache в Redis 60 сек per-user.
**Acceptance:**
- Возвращает корректные числа для server / drafts / published.
- Второй вызов в течение минуты — из кэша (быстрее ~10×).

### KS-3347 (S2) — shared types для precision-рейтинга

**Assignee:** backend (shared owner).
**Labels:** `puzzle`, `analysis`.
**Описание:**
- В `packages/shared/src/types/api-contracts.ts`:
  - `PrecisionRatingDto = { rating: number; deviation: number;
    attempts: number; lastAttemptAt: string | null }`.
  - `GetPrecisionRatingResponse = PrecisionRatingDto`.
  - Расширить `PrecisionAttemptDto` (или responseDTO) полями
    `ratingBefore: number | null; ratingAfter: number | null;
    ratingDelta: number | null`.
**Acceptance:**
- TS-сборка без ошибок.
- Поля nullable — frontend корректно обрабатывает гостя и legacy
  attempts.

### KS-3348 (B0) — миграция `user_precision_ratings` + поля в `PrecisionAttempt`

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`, `prisma`.
**Зависит:** —
**Описание:**
- Prisma миграция:
  - Новая модель `UserPrecisionRating` (см. §3.6.1).
  - В `PrecisionAttempt` добавить поля `ratingBefore Float?`,
    `ratingAfter Float?` (NULL для legacy).
- Без backfill — старые attempts оставляем с NULL (см. §3.6.3).
**Acceptance:**
- `npm run prisma:migrate` без ошибок.
- Repository-тест: создать запись, обновить, прочитать.

### KS-3349 (B0.5) — `PrecisionRatingService` + интеграция

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** KS-3348, KS-3347.
**Описание:**
- Сервис `PrecisionRatingService.applyRatingChange(userId,
  puzzleRating, score)` — алгоритм §3.6.2 (Glicko-1 через
  существующий `GlickoRatingService`).
- Skip для гостей, hidden/test-аккаунтов.
- Маппинг score → outcome (≥80=1.0; 50..80=0.5; <50=0.0).
- PuzzleRD = 50; fallback puzzleRating = 1500 если null.
- Интеграция в `PrecisionService` (там где `tx.precisionAttempt.create`):
  внутри той же транзакции вызвать `applyRatingChange` и записать
  `ratingBefore/ratingAfter` в attempt.
- БЕЗ burst-penalty / daily-cap в MVP.
**Acceptance:**
- Юнит-тесты на 6 сценариев: новый user; победа +; ничья ≈;
  поражение −; гость skip; hidden skip.
- Integration-тест: запись precision-attempt с score=85 → rating
  пользователя увеличился, в attempt записаны before/after.
- `PrecisionAttempt.ratingBefore != ratingAfter` после успешного
  обновления.

### KS-3350 (B3) — endpoint `GET /precision/me/rating`

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** KS-3348.
**Описание:**
- `PrecisionController.GET /me/rating` под `JwtAuthGuard`.
- Возвращает `UserPrecisionRating` пользователя, либо default
  `{rating: 1500, deviation: 350, attempts: 0, lastAttemptAt: null}`
  для нового user'а без записей.
**Acceptance:**
- Endpoint работает; гость → 401; новый user → default-значения.

### KS-3343 (F1) — 3 scope-pill'ы в `PrecisionFilterChipsBar`

**Assignee:** frontend.
**Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** KS-3340, KS-3243 (chips-bar из ADR-076).
**Описание:**
- В `PrecisionFilterChipsBar` заменить 2 Authorship-pill'ы на 3
  scope-pill'ы (Серверные / Мои черновики / Мои опубликованные).
- URL-state: `?scope=server|drafts|published` (default `server`).
- Backward-compat: на mount страницы — если `mine`/`visibility`
  без `scope` — конвертировать в `scope` и переписать URL через
  `setSearchParams({ replace: true })`.
- Гостям — только 1 pill (Серверные, default selected, отключаема
  тап-ом… либо просто скрытая).
- Если KS-3342 готов — counter'ы в скобках на pill'ах.
**Acceptance:**
- Tap по pill меняет URL и triggers re-fetch сетки.
- Backward-compat: открытие `?mine=true&visibility=draft` → URL
  становится `?scope=drafts`.
- Гость видит только pill «Серверные».

### KS-3344 (F2) — sticky-кнопка «Начать тренировку»

**Assignee:** frontend.
**Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** KS-3341, KS-3343.
**Описание:**
- Sticky-кнопка над сеткой (на mobile full-width, на desktop
  inline с chips-bar).
- onClick: GET `/precision/next` с текущими query (scope, objective,
  override-rating если slider не на дефолтах, hideSolved).
- Success → navigate(`/puzzle/:id?source=precision&return=...`).
- 404 → toast «По текущим фильтрам задач нет».
**Acceptance:**
- Tap при ratingPuzzle=1500 → открывает задачу в окне.
- Tap при scope=drafts с 0 задач → toast с инструкцией.
- Tap на гостевом /precision → подбор серверной по 1200.

### KS-3345 (F3, обязательно) — кнопки «Назад» + «Следующая» на PuzzleResolution

**Assignee:** frontend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** KS-3341.
**Приоритет:** P1 (KS-3339 ревизия 2 — обязательная часть).
**Описание:**
- На странице `/puzzle/:id?source=precision`, в блоке после
  solve/fail — две кнопки рядом:
  - **«← Назад к списку»** — navigate в `return`-URL.
  - **«Следующая →»** — re-fetch `GET /precision/next` с теми же
    query-фильтрами из `?return=` (URL-decoded). При успехе —
    `navigate('/puzzle/' + nextId + '?source=precision&return=' +
    sameReturn)`.
- Дельта рейтинга «Рейтинг 1487 → 1502 (+15)» рядом с финальным
  score (если `ratingDelta != null`).
**Acceptance:**
- Обе кнопки отображаются только при `source=precision`.
- «Следующая» 404 → toast + остаёмся на странице.
- Дельта показывается для залогиненных, скрыта для гостей.

### KS-3351 (F4) — отображение precision-рейтинга на /precision

**Assignee:** frontend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** KS-3350, KS-3347.
**Описание:**
- На `PrecisionPage` рядом с compact-stats добавить «Рейтинг: 1487
  (±42)» (источник `GET /precision/me/rating`).
- Гостям скрыто (вместо — placeholder «Войдите, чтобы получить
  рейтинг»).
**Acceptance:**
- Залогиненный видит рейтинг; гость не видит.
- Новый user (без attempts) — «Рейтинг: 1500 (±350) — сыграйте
  первую задачу».

### KS-3346 (L1) — стили scope-pill'ов, sticky-CTA, rating-pill, mobile safe-area

**Assignee:** layout.
**Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** KS-3343, KS-3344, KS-3351.
**Описание:**
- CSS для 3 scope-pill'ов (активный — accent, остальные — neutral;
  при overflow — horizontal scroll как все chips).
- Counter'ы на pill'ах в `(N)` лёгким цветом (KS-3342 обязателен).
- Sticky-кнопка: на mobile fixed-bottom с safe-area-inset; на
  desktop inline с chips-bar.
- Rating-pill «Рейтинг: 1487 (±42)» — compact-line рядом со
  stats, mobile-адаптив (single-row, ellipsis).
- На странице solve — две кнопки «Назад» + «Следующая» равной
  ширины (на mobile — full-width grid 1fr 1fr).
**Acceptance:**
- На viewport 360×844 — кнопка «Начать тренировку» видна без
  скролла (sticky на mobile), не перекрыта tab-bar'ом приложения.
- На desktop — кнопка справа от chips-bar, без переноса строк.
- Цвета чётко отличают активную scope-pill.
- Rating-pill читается в одну строку на mobile.
- На странице solve кнопки «Назад» + «Следующая» помещаются без
  переноса.

## 9. Откат

- Снять scope-pill'ы → вернуться к Authorship 2-pill (через
  feature-flag или revert F1).
- Скрыть sticky-кнопку (revert F2). Авто-подбор endpoint
  остаётся.
- Backend endpoint `GET /precision/next` и `GET /precision/me/rating`
  — additive, удаление безопасно.
- Таблица `user_precision_ratings` — данные сохраняются как
  «история»; обновление через `applyRatingChange` можно отключить
  через feature-flag без миграции вниз. Если решено полностью
  отказаться от precision-рейтинга — отдельный rollback-task
  (DROP TABLE).
- URL-state `?scope=` остаётся; backward-compat в обратную сторону
  не нужен (он же только read-side).
