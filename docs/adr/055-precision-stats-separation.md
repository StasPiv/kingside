# ADR-055: Раздельная статистика и фильтры для `/precision` (play-vs-engine) vs `/puzzles` (forced-line)

**Дата:** 2026-05-10
**Автор:** architect
**Связанная задача:** KS-2713
**Связанные ADR:** ADR-044 (PlayVsEngine puzzles), ADR-046 (Puzzle stats redesign), ADR-048 (Precision Training section), ADR-050 (Client puzzle generation)
**Связанные задачи:** KS-2463/KS-2580 (Puzzle.solutionMode), KS-2484/KS-2578 (Precision page evolution), KS-2493 (`byMode` в `/puzzles/stats/me`), KS-2545 (top-блок stats на /precision), KS-2689/KS-2692 (рейтинг скрыт на /precision), KS-2697 (генератор precision)

---

## 1. Контекст

В разделе `/precision` (Тренировка точности, режим `play-vs-engine`) пользователь сообщил две проблемы:

1. **Нет toggle «Скрыть решённые».** На `/puzzles` чекбокс есть (URL `?hideSolved=true`), на `/precision` — нет.
2. **Смешанная статистика.** Попытки и решения `play-vs-engine` влияют на счётчики, привязанные к классическим задачам (mistakes-diary, рейтинг, daily snapshot, общий «всего попыток / решено»). И наоборот — попытки `forced-line` влияют на блок stats наверху `/precision`, даже если PrecisionPage читает `byMode['play-vs-engine']`.

Задача архитектора — зафиксировать аудит, выбрать архитектуру и декомпозировать в задачи backend/frontend. Код не пишем.

## 2. Аудит текущего состояния

### 2.1 Схема данных (`packages/db/prisma/schema.prisma`)

| Модель | Поле `solution_mode` | Комментарий |
|---|---|---|
| `Puzzle` (`puzzles`) | **есть**, `String @default("forced-line")`, `@@index([solutionMode])` | Заведено в KS-2463 / ADR-044 §3.2. Все lichess-пазлы — `forced-line`; `play-vs-engine` встречается только в `source='generated'` (KS-2659). |
| `PuzzleAttempt` (`puzzle_attempts`) | **нет** | `solutionMode` резолвится через JOIN с `puzzles.solution_mode`. |
| `UserMistake` (`user_mistakes`) | **нет** | Записи создаются на любую неудачную попытку, без учёта режима. |
| `PuzzleRushSessionPuzzle` | — | Rush-пазлы хранятся отдельно от `puzzle_attempts`; см. §2.3. |
| `PuzzleRushScore` | — | Лидерборды по `(timeMode, score)` — независимы. |
| `PuzzleRatingSnapshot` (`puzzle_rating_snapshots`) | **нет** | Дневной снимок `(rating, attempts, solved)` без разреза по режиму. |

**Вывод:** миграция `puzzle_attempts.solution_mode` **не обязательна** — JOIN уже работает (см. §2.2). Денормализация может потребоваться позже из-за нагрузки на JOIN при 6M lichess-строк, но текущее `getStats` уже делает GROUP BY с JOIN и работает.

### 2.2 Где агрегируется статистика

**`PuzzleService.getStats(userId)` (`puzzle.service.ts:547`)** — endpoint `GET /puzzles/stats/me`:

```ts
return {
  rating, ratingDev,
  totalSolved, totalAttempted, solveRate,    // ← НЕ фильтруется по solutionMode
  avgTimeMs,                                  // ← НЕ фильтруется
  currentStreak,                              // ← user.puzzleStreak, общий
  todaySolved, todayAttempted,                // ← из puzzle_rating_snapshots, общий
  bestPuzzleRushScore,                        // ← независим (отдельная таблица)
  byMode: {                                   // ← KS-2493: разрез по режиму через JOIN
    'forced-line':   { attempts, solved, accuracy, avgRating, avgTimeMs },
    'play-vs-engine':{ attempts, solved, accuracy, avgRating, avgTimeMs },
  },
};
```

`byMode` уже реализован корректным `LEFT JOIN puzzles ON puzzle_attempts.puzzle_id` с `GROUP BY COALESCE(p.solution_mode, 'forced-line')`. **Сами top-level счётчики** (`totalSolved/totalAttempted/avgTimeMs/currentStreak/todaySolved/todayAttempted`) — **смешанные**.

**Что читает `/precision` (`PrecisionPage.tsx:303-326`):**
- Делает `GET /puzzles/stats/me`, берёт `byMode['play-vs-engine']` — **уже разделено корректно**.
- Однако «3 попыток / 0 решено» в скриншоте пользователя — это либо именно его play-vs-engine счётчик (тогда вопрос только к остальным потребителям), либо UI считает не там (требует визуальной проверки QA: какие именно цифры показываются и из какого поля).

**Что читает `/puzzles` (главная страница задач) и `/puzzles/stats`:**
- `PuzzleStatsPage` (`PuzzleStatsPage.tsx:128`) показывает `<ModesBreakdown byMode={stats.byMode} />` — обе категории видно. Но top-level карточки страницы (общий solveRate, currentStreak, todaySolved) — **смешанные**.
- Это и есть утечка `play-vs-engine` в раздел классических задач.

### 2.3 Зависимости от `puzzle_attempts` event'ов

| Потребитель | Файл | Учитывает режим? | Что нужно |
|---|---|---|---|
| `/puzzles/stats/me` top-level | `puzzle.service.ts:556-635` | **нет** (только `byMode` разрез) | top-level → только `forced-line`; `play-vs-engine` отдаётся через `byMode` или `/precision/stats` |
| `puzzle_rating_snapshots` (todaySolved/Attempted) | `puzzle-rating.service.ts:77-90` | **нет** | пишется на любой attempt, включая PVE |
| `User.puzzleStreak` / `User.ratingPuzzle` | `puzzle-rating.service.ts:55-71` | **нет** | обновляется и для PVE (KS-2689 скрыл UI, но БД обновляется) |
| `Puzzle.rating` (Glicko-1 на пазле) | `puzzle-rating.service.ts:64-70` | **нет** | для PVE-пазлов рейтинг семантически не определён (§3 KS-2689) |
| `recordPuzzleMistake` → `user_mistakes` | `puzzle.service.ts:509-515` → `mistakes.service.ts:68` | **нет** | mistake пишется на любой `!solved`; для PVE «не удержал WDL» ≠ «зевнул фигуру» |
| `MistakesService.getAggregates` | `mistakes.service.ts:154-200` | **нет** | агрегаты тем включают PVE-mistakes |
| `PuzzleRushService.getNextPuzzle` (picker) | `puzzle-rush.service.ts:629` | **частично** (`source='lichess'`) | Lichess-пазлы все forced-line → de-facto безопасно, но фильтр не явный |
| `PuzzleRushService.recordAttempt` | `puzzle-rush.service.ts:676` | **нет** | пишет в общий `puzzle_attempts` без режима |
| `DailyPuzzleService` | `daily-puzzle.service.ts` | **нет** | работает только с `forced-line` через ручной выбор пазла дня |
| `/puzzles/browse` (`hideSolved`) | `puzzle.controller.ts:246` | независим | `NOT EXISTS (SELECT … FROM puzzle_attempts WHERE puzzle_id=p.id AND user_id=…)` — `solution_mode` не нужен, фильтр работает по `puzzle_id` |

### 2.4 Toggle «Скрыть решённые» в `/puzzles`

Реализован на двух уровнях:
- **Frontend** (`PuzzleBrowserPage.tsx:76-339`): чекбокс пишет `?hideSolved=false` в URL (default: `true`); прокидывается в `useInfinitePuzzles({ hideSolved })`.
- **Backend** (`puzzle.controller.ts:246-252`): `NOT EXISTS (SELECT 1 FROM puzzle_attempts pa WHERE pa.puzzle_id = p.id AND pa.user_id = $userId)`.

Механизм **полностью переиспользуем** для `/precision` — нужно только добавить чекбокс в UI и прокинуть параметр через `useInfinitePuzzles`. Никакой backend-работы по этому пункту не требуется.

## 3. Решение

### 3.1 Выбор варианта — C (гибрид)

| Вариант | Оценка |
|---|---|
| **A** (общий API с `solutionMode` параметром) | Шире нужного. Требует обновления всех потребителей, плюс миграцию `puzzle_attempts.solution_mode`, плюс рефакторинг тестов. Не даёт семантической чёткости — `puzzle-rush` и `mistakes-diary` концептуально связаны только с `forced-line`, а не с «параметризуемой выборкой по режиму». |
| **B** (отдельная таблица `precision_attempts`) | Дублирование схемы, миграция данных, отдельный rating-pipeline. Имеет смысл только если PVE планируется как самостоятельная подсистема с собственными метриками вне `puzzle_attempts` (например, метрики WDL/halfMoves в БД). Сейчас по ADR-044 §5.4 PVE-метрики (`finalWdl`, `halfMovesPlayed`) **в БД не пишутся** (только в логи) — отдельной таблицей покрывать нечего. |
| **C** (гибрид) | Один поток `puzzle_attempts`. JOIN с `puzzles.solution_mode` уже работает в `getStats` (KS-2493). Существующие компоненты (`mistakes`, `rating-snapshot`, `puzzle-streak`) фильтруют **только `forced-line`** — это явное продуктовое решение «PVE-режим не влияет на «обычный» рейтинг и дневник». Отдельный endpoint `/precision/stats` (либо расширение `byMode` в `/puzzles/stats/me`) даёт PVE-блоку свою цифру. |

**Выбираем C.** Обоснование:
1. PVE-режим — производное от классического (та же позиция, другой способ оценки решения). Делать отдельную таблицу — over-engineering.
2. Миграция `puzzle_attempts.solution_mode` **не нужна**: JOIN на `puzzle_id` (PK) дёшев; индекс `puzzles.solution_mode` уже есть; `getStats` это уже использует. Если профилирование при росте данных покажет регресс — денормализация добавляется отдельной задачей без изменения публичного API.
3. Изменения локализованы в 4 точках бэкенда (mistakes, rating, snapshot, getStats top-level) и одной точке фронта (toggle на /precision).

### 3.2 Семантические правила

После реализации действуют:

1. **`puzzle_attempts`** — единый поток событий. Поле `solutionMode` резолвится JOIN'ом по `puzzle_id`.
2. **«Классический» рейтинг (`User.ratingPuzzle`, `User.ratingPuzzleDev`, `User.puzzleStreak`)** — обновляется **только** на attempts, где `puzzles.solution_mode = 'forced-line'`. PVE-attempts рейтинг не двигают (соответствует продуктовому решению KS-2689).
3. **`Puzzle.rating` (Glicko-1)** — обновляется только для `forced-line`. Для `play-vs-engine` рейтинг пазла семантически не определён, остаётся при создании.
4. **`puzzle_rating_snapshots`** (`todaySolved/todayAttempted`) — пишутся только для `forced-line`. PVE — не влияют на snapshot.
5. **`user_mistakes` (Mistakes Diary)** — записываются только для **неудачных** `forced-line` attempts. PVE-«неудача» (WDL ушёл ниже порога) не идёт в дневник ошибок.
6. **`/puzzles/stats/me`** — top-level счётчики (`totalSolved/totalAttempted/solveRate/avgTimeMs/currentStreak/todaySolved/todayAttempted`) считаются только по `forced-line`. Поле `byMode` сохраняется как есть — даёт оба разреза (без изменения контракта).
7. **`/precision/stats`** (новый endpoint) — отдаёт собственный набор метрик для PVE: `attempts/solved/accuracy/avgTimeMs/lastAttemptAt`. Без рейтинга и без streak (их у PVE нет). Альтернативно — фронт продолжает читать `byMode['play-vs-engine']` из `/puzzles/stats/me` (так уже сделано) и отдельный endpoint не вводится. Решение оставляю backend'у при реализации — оба варианта совместимы.
8. **`/puzzles/browse`** — фильтр `hideSolved` остаётся как есть, режим не учитывает (фильтрует по `puzzle_id`). На `/precision` UI добавляет тот же query-параметр.
9. **`PuzzleRushService.getNextPuzzle`** — добавляет явный фильтр `solutionMode='forced-line'` в `where` (страховка; сейчас работает через `source='lichess'`, но это неявно).
10. **`DailyPuzzle`** — выбор пазла дня дополняется фильтром `solutionMode='forced-line'` (защита от случайной публикации PVE-пазла как «daily»).

### 3.3 Toggle «Скрыть решённые» на `/precision`

Минимальное изменение:
- В `PrecisionPage.tsx` добавить `hideSolved` в URL-state (по аналогии с `mineParam` / `visibilityParam`), default `true` (как у `/puzzles`).
- Прокинуть через `InfinitePuzzleFilters → useInfinitePuzzles → /puzzles/browse?hideSolved=…`. Backend уже поддерживает.
- UI-чекбокс — переиспользовать стилистику из `PuzzleBrowserPage`. CSS-классы общие.

Никакой backend-задачи по этому пункту не требуется.

## 4. Риски и компромиссы

| Риск | Митигация |
|---|---|
| Backfill: «потерянная» статистика старых PVE-attempts вылетит из общих счётчиков | Допустимо. Текущие PVE-attempts в проде — единичны (раздел недавно открыт KS-2697). Пересчёт не требуется. |
| Расхождение между `/puzzles/stats/me.totalAttempted` (новое: только forced-line) и `byMode.forced-line.attempts` | Должны совпадать после реализации. Тест: equality assertion в `puzzle.service.spec.ts`. |
| Нагрузка JOIN puzzle_attempts ↔ puzzles на больших объёмах | Текущий `getStats` уже делает JOIN с GROUP BY и работает. При росте >1M attempts/user — рассмотреть денормализацию `puzzle_attempts.solution_mode` отдельной задачей. Сейчас не требуется. |
| Frontend на `/puzzles/stats` показывает «общие» цифры — после фикса они станут только `forced-line`. Пользователь может удивиться разнице | Незаметно: PVE-attempts мало, разница на счётчиках в пределах процента. UI-изменений на `/puzzles/stats` не нужно. |
| `Mistakes Diary` UI-блок на `/puzzles/stats` сейчас скрыт (KS-2554, `MistakesDiaryBlock` возвращает `null`) | Не влияет: правка `recordPuzzleMistake` чистит данные «у источника», вернётся блок в будущем уже без PVE-загрязнения. |

## 5. Декомпозиция задач

### Backend
- **B1.** `PuzzleService.getStats` — top-level счётчики (`totalSolved`, `totalAttempted`, `solveRate`, `avgTimeMs`, `todaySolved`, `todayAttempted`) фильтруются `puzzles.solution_mode = 'forced-line'` (через JOIN). `byMode` остаётся как есть. Тесты в `puzzle.service.spec.ts` обновить.
- **B2.** `PuzzleRatingService.applyRatingChange` — early-return без изменений `User.ratingPuzzle/Dev/Streak`, `Puzzle.rating/Dev` и `puzzle_rating_snapshots` для `play-vs-engine`. Запись в `puzzle_attempts` остаётся (там `ratingBefore=ratingAfter` для retry-ветки уже корректно). Тесты — отдельный case в `puzzle-rating.service.spec.ts`.
- **B3.** `PuzzleService.submitAttempt` — `recordPuzzleMistake` вызывается **только** для `forced-line` (резолв через уже полученный `mode.solutionMode`). PVE-неудача в дневник не пишется.
- **B4.** `PuzzleRushService.getNextPuzzle` — добавить явный `solutionMode: 'forced-line'` в `where` (страховка).
- **B5.** `DailyPuzzleService` — фильтр `solutionMode='forced-line'` при выборе пазла дня (если выбор алгоритмический; для ручного — ничего).
- **B6 (опционально, по решению backend'а).** Endpoint `GET /precision/stats` либо переиспользование `byMode['play-vs-engine']` из `/puzzles/stats/me` (текущий вариант). Если выбрано первое — добавить контроллер `precision.controller.ts`, отдать `attempts/solved/accuracy/avgTimeMs/lastAttemptAt`. Лидерборда нет.

Метки backend-задач: `puzzle`, `analysis`.

### Frontend
- **F1.** `PrecisionPage.tsx` — добавить URL-state `hideSolved` (default `true`), прокинуть в `InfinitePuzzleFilters`. UI-чекбокс рядом с фильтрами «Mine / Visibility».
- **F2.** Перевод-ключи `precision.hideSolved` (en, ru) в `apps/web/src/i18n/locales/*/translation.json` либо использование `puzzleBrowser.hideSolved`.
- **F3 (если backend выбрал B6 с отдельным endpoint).** Перевести `PrecisionPage.fetchStats` с `/puzzles/stats/me` на `/precision/stats`. Убрать чтение `byMode['play-vs-engine']`.
- **F4 (отдельная мелкая задача).** Проверить, что блок stats на `/puzzles/stats` после изменения backend'а остаётся консистентным (top-level счётчики и `byMode.forced-line` теперь совпадают). Снять текущий допуск «суммы могут не сходиться».

Метки frontend-задач: `puzzle`, `analysis`.

### QA
- **Q1.** Сценарий: один и тот же пользователь решает 2 lichess-пазла (один solved) и пытается 1 PVE (failed). Ожидание:
  - `/puzzles/stats/me`: `totalAttempted=2, totalSolved=1, currentStreak=1`, `byMode.forced-line.attempts=2`, `byMode.play-vs-engine.attempts=1`.
  - `puzzle_rating_snapshots` за день: `attempts=2, solved=1`.
  - `user_mistakes`: 1 запись (только forced-line failed). PVE failed не создал mistake.
  - `User.ratingPuzzle` сдвинулся только от lichess-attempts.
  - На `/precision` карточка показывает «1 attempt / 0 solved» (PVE).
  - Toggle hideSolved на /precision скрывает решённые PVE-пазлы.

## 6. Не делаем сейчас

- Денормализацию `puzzle_attempts.solution_mode`. Только при росте нагрузки и подтверждённом регрессе JOIN-запросов.
- Backfill / пересчёт исторических `puzzle_rating_snapshots` и `user_mistakes` (текущий объём PVE-attempts в проде близок к нулю).
- Отдельные лидерборды для `/precision` (по статусу KS-2689 — рейтинг скрыт, лидерборд не нужен).
- Изменения в `PuzzleRushScore` / `PuzzleRushSessionPuzzle` — там пазлы уже отбираются по `source='lichess'`, что эквивалентно `forced-line`. После B4 это станет явным.

## 7. Acceptance

- [x] Аудит зафиксирован (§2).
- [x] Решение по архитектуре с обоснованием (§3, вариант C).
- [x] Декомпозиция backend / frontend / QA (§5).
- [ ] @coordinator согласует с пользователем и поставит подзадачи B1–B5 (+B6 по решению), F1–F2 (+F3–F4 по решению), Q1.
