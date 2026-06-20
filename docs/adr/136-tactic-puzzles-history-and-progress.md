# ADR-136: История решения и прогресс пользователя в /tactic-puzzles

Связанные тикеты: KS-4352.
Связанные ADR: 135 (концепт раздела), 044, 056, 057, 065, 079, 082, 106.

## 1. Контекст

Раздел `/tactic-puzzles` (ADR-135) запущен: генерация работает, каталог открыт, страница решения с двух-проходным анализом Maia + Stockfish, маршруты `/next`, `/browse`, `/mistakes`, `/:id`, `POST /:id/attempts`. Следующий слой — **история решения и прогресс пользователя**.

База данных уже содержит (миграция KS-4339):

* `tactic_puzzle_attempts` — попытки (`rating_before/after`, `puzzle_rating_before/after`, `line_half_moves`, `stop_reason`, `user_moves`, `time_ms`, `wdl_start/end`, `moves_accuracy`, `precision_grade`, `solved`);
* `tactic_user_mistakes` — журнал ошибок (`userId`, `puzzleId`, `resolved`, `createdAt`, UNIQUE `(userId, puzzleId)`);
* `user_tactic_ratings` — Glicko-1 рейтинг пользователя (`rating`, `deviation`, `volatility`, `attempts`, `lastAttemptAt`, PK = `userId`).

API уже отдаёт `GET /tactic-puzzles/mistakes`.

Что нужно достроить:
* пагинированную историю попыток с фильтрами;
* агрегаты прогресса (стрик, % solved, среднее время, средняя длина линии, распределение `stopReason`);
* график динамики рейтинга;
* (опц.) лидерборд;
* интеграцию в общий профиль `/profile/...`.

## 2. Аудит существующих разделов

Фиксируем паттерны, которые переиспользуем без выдумывания нового.

### 2.1. `/puzzles` (lichess, forced-line)

| Слой | Артефакты |
|---|---|
| БД | `puzzle_attempts` (rating-история), `puzzle_rating_snapshots` (дневные снимки), `user_mistakes` (журнал) |
| API | `GET /puzzles/stats/me`, `GET /puzzles/stats/rating-history`, `GET /puzzles/stats/themes`, `GET /puzzles/attempts` |
| Frontend | `PuzzleStatsPage.tsx` (агрегаты + график), `PuzzleMistakesPage.tsx`, `PuzzleMistakesPracticePage.tsx` |
| Навигация | Через `Sidebar`, отдельной субнавигации нет |

`PuzzleRatingSnapshot` — `(userId, date, rating, attempts, solved)`, UNIQUE `(userId, date)`. Заполняется заданием на завершение каждого дня (см. ADR-082 §3). График — точка на день.

### 2.2. `/precision` (legacy PVE)

| Слой | Артефакты |
|---|---|
| БД | `puzzle_attempts` + `PrecisionAttempt` (1:1, точные метрики) + `PrecisionAttemptMove` (на каждый ход) + `UserPrecisionRating` (Glicko-1) |
| API | `/precision/stats/me`, `/trends/me`, `/breakdowns/me`, `/scope-counts`, `/me/rating`, `/theme-counts`, `/attempts/me`, `/attempts/:id`, `/next` |
| Frontend | `PrecisionPage`, `PrecisionHistoryPage`, `PrecisionStatsPage`, `PrecisionAttemptPage` (детальный разбор одной попытки) |
| Навигация | `<PrecisionSubNav />` — общий подзаголовок раздела (Train / Stats / History) |
| ADR | 056 (доменная сущность), 057 (страничная разбивка), 065 (5-балльная оценка), 079 (Glicko-1), 082 (rating dynamics) |

Самый похожий по концепту источник паттернов. Структура страниц и навигации — наш ориентир. `PrecisionSubNav` — отдельный компонент, переиспользуемый на трёх страницах.

### 2.3. `/puzzle-rush`

| Слой | Артефакты |
|---|---|
| БД | `PuzzleRushScore` (одна сессия = один score + timeMode), `PuzzleRushSessionPuzzle` (порядок пазлов в сессии) |
| API | `/start`, `/session`, `/solve`, `/leaderboard`, `/best`, `/review/:scoreId` |
| Frontend | `PuzzleRushPage`, `PuzzleRushLeaderboardPage`, `PuzzleRushReviewPage` (post-mortem сессии) |

Лидерборд глобальный, разрез по `timeMode`. Для /tactic-puzzles прямого аналога нет (концепт не сессионный), но идея «лидерборд по рейтингу» применима.

### 2.4. `/lessons`

| Слой | Артефакты |
|---|---|
| БД | `UserLessonProgress` (per-lesson state, `stepsState` JSON), `SM2Review` (повторения), `Lesson*Attempt` |
| API | `/lessons/progress/step`, `/lesson/complete`, `/puzzle-attempt`, `/lessons/:lessonId/step`, `/:lessonId/complete` |
| Frontend | `LessonsPage`, `LessonPage`, прогресс встроен в карточки уроков |

Прогресс — per-lesson, без глобального лидерборда. Для /tactic-puzzles концептуально не подходит (нет фиксированного набора уроков).

### 2.5. Общие выводы аудита

* Везде применяется одна и та же тройка: **rating-таблица + дневные снимки рейтинга + список попыток с фильтрами**.
* `/precision` ближе всех по структуре (PVE-метрики, Glicko, history/stats/attempt-страницы).
* Лидерборд — только в `/puzzle-rush` (концепт сессионный).
* SubNav-компонент применяется в `/precision`. Для разделов с двумя-тремя страницами это стандарт.

## 3. Решение

Раздел `/tactic-puzzles` получает структуру по образцу `/precision`, без изобретения нового.

### 3.1. Маршрутизация фронта

```
/tactic-puzzles                    — каталог (есть)
/tactic-puzzles/:id                — страница решения (есть, SolveTacticPuzzlePage)
/tactic-puzzles/history            — НОВАЯ: история попыток
/tactic-puzzles/stats              — НОВАЯ: агрегаты прогресса + график рейтинга
/tactic-puzzles/attempts/:id       — НОВАЯ: разбор одной попытки (по образцу PrecisionAttemptPage)
/tactic-puzzles/mistakes           — НОВАЯ: журнал ошибок («работа над ошибками»)
```

Все четыре новые страницы делят общий `<TacticPuzzlesSubNav />` — компонент по образцу `<PrecisionSubNav />`.

В общем `/profile/{username}` — секция «Точность» (рядом с lichess-пазлами и precision): рейтинг + ссылки в `/tactic-puzzles/history` и `/tactic-puzzles/stats`. Отдельной страницы `/profile/tactic` не делаем — это размазывает концепт.

### 3.2. История попыток

**Что показывает.** Пагинированный список (cursor-based, по образцу `/puzzles/attempts`):

| Колонка | Источник |
|---|---|
| Дата/время | `tactic_puzzle_attempts.created_at` |
| Пазл (мини-доска по `fen` + UCI первого хода) | join на `tactic_puzzles` |
| Исход (бейдж: «решено» / «ошибка» / «прервано» / «пропустил» / «мат») | `stop_reason` + `solved` |
| Длина линии (полуходы) | `line_half_moves` |
| Время | `time_ms` |
| Изменение рейтинга (`±N`) | `rating_after − rating_before` |
| Точность (1–5 звёзд, опц.) | `precision_grade` |
| Действия: «Открыть пазл», «Открыть в мастерской» | `puzzleId` |

**Фильтры:**
* по периоду (последние 7 / 30 / 90 / 365 / все);
* по исходу (`stop_reason` — мультивыбор);
* по rating-bucket (≤1500, 1500–1800, 1800–2100, ≥2100);
* по `solved` (true/false/all).

**Источник данных.** Новый маршрут `GET /tactic-puzzles/attempts`:

```
GET /tactic-puzzles/attempts?cursor=&limit=&period=&stop=&rating=&solved=
  → 200 { items: TacticAttemptListItem[], nextCursor?: string }
```

Не расширяем `POST /:id/attempts` — там приём попытки, GET-маршрут отдельный, единое RESTful поведение.

### 3.3. Прогресс пользователя

**Stats-страница** `GET /tactic-puzzles/stats/me`:

```
{
  rating: { value: number, deviation: number, attempts: number, lastAttemptAt: string | null },
  totals: {
    attempts: number,
    solved: number,
    solvedPercent: number,        // solved / attempts
    avgTimeMs: number,
    avgLineHalfMoves: number,
    avgPrecisionGrade: number | null,
  },
  streak: {
    current: number,              // подряд решённых (только consecutive solved=true)
    best: number,                 // лучший за всё время
  },
  stopReasonBreakdown: Record<StopReason, number>,
  difficultyBuckets: { '0.9-0.93': number, '0.93-0.96': number, '0.96-0.99': number, '0.99-1.0': number },
}
```

KS-4367: жанровая разбивка `objectiveBreakdown` (`convertAdvantage`/`saveEquality`) снята — раздел «Точность» оценивает только умение находить сильнейший ход, без жанровых меток.
```

**График рейтинга** `GET /tactic-puzzles/stats/rating-history`:

```
GET /tactic-puzzles/stats/rating-history?from=&to=&granularity=day
  → 200 { points: Array<{ date: string, rating: number, attempts: number, solved: number }> }
```

Источник — новая таблица **`tactic_rating_snapshots`** (см. §3.6). По образцу `puzzle_rating_snapshots`: ежедневный снимок последнего значения `user_tactic_ratings.rating` + счётчики попыток за день. Скаппинг точек на пустые дни — линейная интерполяция или просто пропуск (фронт сам соединит).

**Темы.** В новом концепте `themes` менее центральны (есть `difficulty` и `gap`), но drill-tags (pin/fork/skewer/...) остаются для подбора и аналитики. Если drill-tags статистически малы — пропускаем, не делаем отдельный эндпоинт; иначе:

```
GET /tactic-puzzles/stats/themes
  → 200 { themes: Array<{ theme: string, attempts: number, solved: number, avgPrecisionGrade: number | null }> }
```

Решение оставить как опциональный T5 — после смотра реального наполнения банка.

### 3.4. Журнал ошибок (`/tactic-puzzles/mistakes`)

Уже частично есть — `GET /tactic-puzzles/mistakes`. Достроить:

* страница `TacticPuzzlesMistakesPage.tsx` — список unresolved ошибок, кнопка «Попробовать ещё раз» (по образцу `/puzzles/mistakes/practice`);
* `POST /tactic-puzzles/mistakes/:puzzleId/resolve` — пометить как resolved (или резолвить автоматически при успешной повторной попытке).

Авто-резолв в `submitAttempt` — пишем в этот же сервис: если попытка solved=true и есть `tactic_user_mistakes WHERE userId=X AND puzzleId=Y AND resolved=false` → `resolved=true`. Это упрощает фронт.

### 3.5. Лидерборд (опционально)

Не критично для MVP. Если решим показывать — отдельной задачей по образцу `/puzzle-rush/leaderboard`:

```
GET /tactic-puzzles/leaderboard?limit=100
  → 200 { items: Array<{ userId, username, rating, attempts, solvedPercent }> }
```

Сортировка по `user_tactic_ratings.rating DESC` с фильтром `attempts >= N` (например ≥20, чтобы отсечь свеже-зарегистрированных). Отдельная страница `/tactic-puzzles/leaderboard` + ссылка в SubNav.

В этом ADR — оставляем как открытый вопрос (см. §6.1). MVP без лидерборда.

### 3.6. Схема БД — новая таблица

```prisma
/// KS-4352 / ADR-136 §3.3. Дневной снимок рейтинга пользователя в
/// разделе «Точность». По образцу `puzzle_rating_snapshots`
/// (ADR-082). Используется графиком динамики рейтинга на
/// /tactic-puzzles/stats. Точка пишется задачей ежедневного шедулера
/// в конце каждого дня (одна точка на пользователя в сутки).
model TacticRatingSnapshot {
  id       String   @id @default(uuid()) @db.Uuid
  userId   String   @map("user_id") @db.Uuid
  rating   Float
  date     DateTime @db.Date
  attempts Int      @default(0)
  solved   Int      @default(0)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, date])
  @@index([userId])
  @@map("tactic_rating_snapshots")
}
```

Существующие таблицы (`tactic_puzzle_attempts`, `tactic_user_mistakes`, `user_tactic_ratings`) изменений не требуют. Все агрегаты §3.3 покрываются индексами:

* `tactic_puzzle_attempts (userId, createdAt)` — пагинация истории и агрегаты по периоду;
* `tactic_puzzle_attempts (userId, puzzleId, solved)` — расчёт стрика и unique-solved;
* `tactic_user_mistakes (userId, resolved)` — журнал ошибок.

Дополнительных индексов не нужно. Materialized view не нужны — объём `tactic_puzzle_attempts` на этапе MVP не оправдывает их сложность; вернуться при p95 query latency > 200 мс.

### 3.7. Контракты типов

`packages/shared/src/types/tactic-puzzle.ts` дополняется:

```ts
export type TacticStopReason =
  | 'user-finished'
  | 'user-skipped'
  | 'mate'
  | 'mistake'
  | 'aborted';

export interface TacticAttemptListItem {
  id: string;
  puzzleId: string;
  fen: string;                    // для мини-доски
  bestMoveUci: string;
  solverSide: 'w' | 'b';
  solved: boolean;
  stopReason: TacticStopReason;
  lineHalfMoves: number;
  timeMs: number;
  ratingBefore: number;
  ratingAfter: number;
  precisionGrade: number | null;
  createdAt: string;
}

export interface TacticUserStats {
  rating: {
    value: number;
    deviation: number;
    attempts: number;
    lastAttemptAt: string | null;
  };
  totals: {
    attempts: number;
    solved: number;
    solvedPercent: number;
    avgTimeMs: number;
    avgLineHalfMoves: number;
    avgPrecisionGrade: number | null;
  };
  streak: { current: number; best: number };
  stopReasonBreakdown: Record<TacticStopReason, number>;
  difficultyBuckets: Record<string, number>;
}

export interface TacticRatingPoint {
  date: string;        // YYYY-MM-DD
  rating: number;
  attempts: number;
  solved: number;
}

export interface TacticAttemptDetail {
  // Расширение TacticAttemptListItem полями для разбора:
  // полные user_moves, WDL по ходам (если есть), ссылки на пазл
  // и мастерскую, маркер решённости каждого хода.
}

export interface TacticMistakeListItem {
  puzzleId: string;
  fen: string;
  themes: string[];
  difficulty: number;
  createdAt: string;
}
```

### 3.8. Маршруты API

```
GET  /tactic-puzzles/attempts                  — список попыток (фильтры, cursor)
GET  /tactic-puzzles/attempts/:id              — разбор одной попытки
GET  /tactic-puzzles/stats/me                  — агрегаты (TacticUserStats)
GET  /tactic-puzzles/stats/rating-history      — точки графика
GET  /tactic-puzzles/stats/themes              — (опц.) разбивка по drill-tags
POST /tactic-puzzles/mistakes/:puzzleId/resolve — пометить resolved
GET  /tactic-puzzles/leaderboard               — (опц.) лидерборд
```

Все авторизованные эндпоинты — `JwtAuthGuard`. Гостям 401, фронт рендерит CTA «Войти, чтобы видеть прогресс».

## 4. План задач-наследников

```
T1. backend  Prisma migration tactic_rating_snapshots
             ⛳ совместимая, drop безопасен
T2. backend  Шедулер ежедневного снимка (apps/api или cron-задача):
             на закрытии дня пишем по записи в tactic_rating_snapshots
             для всех пользователей с attempts > 0 за сутки
T3. backend  shared types — TacticAttemptListItem, TacticUserStats,
             TacticRatingPoint, TacticAttemptDetail, TacticMistakeListItem,
             TacticStopReason
T4. backend  API: GET /tactic-puzzles/attempts, /attempts/:id,
             /stats/me, /stats/rating-history;
             POST /mistakes/:puzzleId/resolve;
             авто-резолв в submitAttempt
T5. backend  (опц.) GET /tactic-puzzles/stats/themes — после смотра
             наполнения банка drill-tags
             ⛳ можно остановиться до T5
T6. frontend TacticPuzzlesSubNav компонент (по образцу PrecisionSubNav)
T7. frontend TacticPuzzlesHistoryPage + маршрут /tactic-puzzles/history
T8. frontend TacticPuzzlesStatsPage + график рейтинга
             + распределения stopReason/difficulty
T9. frontend TacticPuzzleAttemptPage + маршрут /tactic-puzzles/attempts/:id
             (разбор одной попытки, опционально для MVP)
T10. frontend TacticPuzzlesMistakesPage + маршрут /tactic-puzzles/mistakes
             + интеграция с авто-резолвом
T11. frontend Интеграция в /profile/:username — секция «Точность»
             с рейтингом и ссылками
T12. layout  CSS для четырёх новых страниц + SubNav + мини-доска
             в строке истории
T13. backend (опц.) GET /tactic-puzzles/leaderboard
             ⛳ MVP без него
T14. frontend (опц.) TacticPuzzlesLeaderboardPage + ссылка в SubNav
T15. devops  (опц.) Cloudwatch alarm на латентность /stats/* > 500 мс p95
```

**Точки безопасной остановки:**
* после T4 — backend готов, фронт можно подключать любой страницей по очереди;
* после T8 — основной UX закрыт (история + статистика + график), журнал и разбор попытки — приятный довесок;
* после T10 — MVP полный;
* T13+T14 — отдельная задача после смотра пользователей по факту.

**Зависимости:**
* T2 (шедулер) → можно отделить, его задержка не блокирует T4 (просто график будет пустой);
* T4 зависит от T3 (типы);
* T6/T7/T8 параллельны после T4 готов;
* T11 параллелен T8/T9;
* T12 (layout) идёт параллельно с T7-T11.

## 5. Последствия

**Плюсы.**

* Раздел получает полный набор страниц истории/прогресса по проверенному паттерну `/precision`. Никакой архитектурной новизны — снижается риск ошибок.
* `user_tactic_ratings` и `tactic_puzzle_attempts` уже спроектированы под эти запросы (индексы и поля). Достраивается только дневной снимок.
* Все новые маршруты — в существующем модуле `tactic-puzzle/`. Никаких новых модулей или подмодулей.

**Минусы / риски.**

* Дублирование схемы между `puzzle_rating_snapshots`, `puzzle_rush_*`, `tactic_rating_snapshots`. Архитектурный шум, но осознанный — каждая система Glicko-1 ведёт свою историю независимо (ADR-079).
* Шедулер дневного снимка — лишний движущийся элемент. При сбое — дыра в графике, точки пропадут на день. Алерт на пропущенный запуск — отдельной задачей devops.
* `stopReason` в фильтрах истории — 5 значений + комбинации; UI должен быть аккуратным, чтобы не превратиться в форму. Layout (T12) — критичный шаг.

## 6. Открытые вопросы

1. **Лидерборд** — нужен ли в MVP. Концепт `/tactic-puzzles` не сессионный, в отличие от `/puzzle-rush`. Если показывать «топ-100 по рейтингу» — мотивация для регулярного решения. Если не показывать — раздел остаётся «личной тренировкой». Решается продуктово, не архитектурно.
2. **Авто-резолв ошибок в submitAttempt** — резолвить ошибку при первой успешной попытке или требовать N подряд правильных. Влияет на UX «работы над ошибками». Решается на T4.
3. **Темы (drill-tags) — нужен ли отдельный эндпоинт `/stats/themes`** — зависит от того, насколько информативны drill-tags в новом концепте. Решается после T5 (наполнение банка по ADR-135).
4. **Granularity графика рейтинга** — day / week / month с агрегацией. Day по умолчанию; week/month — фронт сам агрегирует или вводим `?granularity=` параметр. Решается на T8.
5. **Хранение `wdl_per_move`** — для детального разбора одной попытки (`/attempts/:id`) полезно иметь WDL по каждому ходу пользователя, как в `precision_attempt_moves`. Сейчас в `tactic_puzzle_attempts` хранятся только агрегаты (`wdl_start`, `wdl_end`, `moves_accuracy`). Если детальный разбор хотим — отдельная таблица `tactic_attempt_moves` (отдельной задачей). Для MVP — без неё.
