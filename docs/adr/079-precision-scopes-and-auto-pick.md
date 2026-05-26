# ADR-079. /precision — отделение пользовательских задач, «Начать тренировку», авто-подбор по рейтингу

Статус: предложен (2026-05-26)
Связано: KS-3339 (этот ADR), ADR-048 (Precision раздел),
ADR-057 (Precision UX split), ADR-076 (mobile chips-bar +
bottom-sheet), ADR-065 (5-звёздочный score).

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

Использует **существующий** `User.ratingPuzzle` (общий puzzle-
рейтинг по lichess + generated). Заводить отдельный
`ratingPrecision` в БД — не нужно (риск дублирования метрики,
сложности калибровки). Если в будущем калибровка ADR-044 §3.5
покажет существенное расхождение precision-кривой — отдельный
ADR.

Алгоритм `PrecisionService.pickNext(userId, filters)`:

1. **Базовый рейтинг.** `target = user.ratingPuzzle ?? 1200`.
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

- НЕ заводим отдельный `User.ratingPrecision`. Общий
  `ratingPuzzle` достаточен.
- НЕ делаем «уровни сложности» (easy/medium/hard) — это поверх
  rating-окна, для precision сложнее предсказать.
- НЕ удаляем slider «Рейтинг» — он остаётся как **override** для
  тех, кто хочет ручной контроль. Авто-подбор использует его если
  установлен (не на дефолтах).
- НЕ меняем `User.ratingPuzzle` логику — это другой ADR.
- НЕ переименовываем разделы; названия pill'ов — i18n-ключи,
  локализуются позже.

### 2.5 (опционально) `GET /precision/scope-counts`

`{ server: number, drafts: number, published: number }`. Три
SELECT COUNT для текущего пользователя. Кешировать на 60 секунд
per-user (in-memory или Redis). Используется для бейджей на pill'ах
chips-bar.

Не блокирует M1 (бейджи — UX-приятность, не функционал). Можно
сделать отдельной задачей.

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

- Существующий PuzzleResolution UX + новая кнопка «Следующая →»
  рядом с «Назад к списку».
- Tap «Следующая» — re-fetch `GET /precision/next` с теми же
  query-фильтрами из `return` URL.

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

Никаких. `GET /puzzles/browse` уже поддерживает все нужные
комбинации (`mine`, `visibility`, `themes`, `blundererEloMin/Max`,
`hideSolved`).

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

Зависимости: S1 → B1 → F1 → F2 → L1. B2 опц., F3 опц.

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
**Зависит:** KS-3340.
**Описание:**
- В `PrecisionService.pickNext(userId, filters)` — алгоритм по §2.3.
- В `PrecisionController` метод с `OptionalJwtGuard`.
- `@UserRateLimit(60, 60)`.
- Использовать `User.ratingPuzzle` (fallback 1200).
- Расширение окна 150 → 300 → 500 → 1000 → ∞ через цикл с
  SQL-запросом на каждой итерации (можно лимитировать 4 итерациями).
- `hideSolved=true` по умолчанию.
**Acceptance:**
- Тест: ratingPuzzle=1500 → подбирает в окне 1350..1650; если нет
  — расширяет.
- Тест: scope=drafts → возвращает только свои `mine=true,
  visibility=draft`.
- Тест: solved-задачу не возвращает.
- Тест: гость → fallback 1200, scope=server.
- Тест: пустая выборка → 404 `no_puzzles_available`.

### KS-3342 (B2, опц.) — endpoint `GET /precision/scope-counts`

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** —
**Описание:**
- 3 COUNT-запроса по `puzzles` с разными `mine`/`visibility`.
- Cache в Redis 60 сек per-user.
**Acceptance:**
- Возвращает корректные числа для server / drafts / published.
- Второй вызов в течение минуты — из кэша (быстрее ~10×).

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

### KS-3345 (F3, опц.) — кнопка «Следующая» на PuzzleResolution

**Assignee:** frontend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** KS-3341.
**Описание:**
- На странице `/puzzle/:id?source=precision`, в блоке после
  solve/fail — кнопка «Следующая →».
- Читает query-фильтры из `?return=` (URL-decoded), вызывает
  `GET /precision/next` с теми же параметрами.
- При успехе — `navigate('/puzzle/' + nextId + '?source=precision&return=' + sameReturn)`.
**Acceptance:**
- Кнопка отображается только при `source=precision`.
- 404 → toast + tap «Назад к списку».

### KS-3346 (L1) — стили scope-pill'ов, sticky-CTA, mobile safe-area

**Assignee:** layout.
**Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** KS-3343, KS-3344.
**Описание:**
- CSS для 3 scope-pill'ов (активный — accent, остальные — neutral;
  при overflow — horizontal scroll как все chips).
- Sticky-кнопка: на mobile fixed-bottom с safe-area-inset; на
  desktop inline с chips-bar.
- Counter'ы на pill'ах (если KS-3342 готов) — после имени pill'а в
  `(N)` лёгким цветом.
**Acceptance:**
- На viewport 360×844 — кнопка «Начать тренировку» видна без
  скролла (sticky на mobile), не перекрыта tab-bar'ом приложения.
- На desktop — кнопка справа от chips-bar, без переноса строк.
- Цвета чётко отличают активную scope-pill.

## 9. Откат

- Снять scope-pill'ы → вернуться к Authorship 2-pill (через
  feature-flag или revert F1).
- Скрыть sticky-кнопку (revert F2). Авто-подбор endpoint
  остаётся.
- Backend endpoint `GET /precision/next` — additive, удаление
  безопасно.
- URL-state `?scope=` остаётся; backward-compat в обратную сторону
  не нужен (он же только read-side).
