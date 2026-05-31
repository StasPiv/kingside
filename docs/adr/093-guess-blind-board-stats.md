# ADR-093. Раздел статистики для Guess-the-Move и Blind-board

Статус: предложен (2026-05-31) — аналитический документ
Связано: KS-3506 (этот ADR), ADR-086 (Guess), ADR-088 (Blind-board),
ADR-057 (Precision UX split — образец паттерна), ADR-081
(Training lobby).

## 1. Контекст

Запрос: добавить раздел статистики прохождения для Guess и Blind-
board по аналогии с существующими `/precision/stats`,
`/drills/stats`, `/puzzles/stats`. Цель — пользователь видит свою
динамику и breakdowns; опционально — лидерборды.

## 2. Проверено по коду

### 2.1 Данные в БД — почти всё уже есть

**`GuessSession`** (`schema.prisma:531–560`):
- Per-session агрегаты: `userAccuracy, playerAccuracy, userStars
  (1-5), score, bestStreak, betterThanPlayerCount`.
- `status, finishReason, startedAt, finishedAt, side, gameSource`.
- Индекс `[userId, finishedAt]` — оптимально для агрегатов и
  истории.

**`GuessMove`** (`:566–598`):
- Per-ply: `ply, fenBefore, playedUci, userUci, bestUci,
  eBefore, eAfterPlayed, eAfterUser, lossPlayer, lossUser,
  accuracyPlayer, accuracyUser, userClass, verdict`.
- Индекс `[verdict]` — для агрегации по verdict'ам.

**`BlindBoardSession`** (`:605–644`):
- Агрегаты: `streak, bestStreak, level, status, finishReason`.
- `startedAt, finishedAt`, `startConfig` JSON (snapshot).
- Индекс `[userId, finishedAt]`.

**`BlindBoardAttempt`** (`:649–671`):
- Per-round: `round, compMoveFrom/To, expectedSquare,
  expectedPieceType, userSquare, userPieceType, correct`.
- Индекс `[sessionId, round]`.

**`User.blindBoardBestStreak`** (KS-3440) — поле + индекс DESC
для лидерборда.

### 2.2 Существующие endpoints

**Guess** (`guess.controller.ts`):
- ✅ `GET /guess/history?limit&offset` — список finished сессий
  (без pgn, KS-3409).
- ❌ Нет `/guess/stats/me`, `/trends/me`, `/breakdowns/me`,
  `/leaderboard`.

**Blind-board** (`blind-board.controller.ts`):
- ✅ `GET /blind-board/leaderboard?limit` — public, derive
  `maxLevel = floor(bestStreak/10)+1` (KS-3485).
- ❌ Нет `/stats/me`, `/trends/me`, `/breakdowns/me`,
  `/history`.

### 2.3 Образцы UI/UX

**Precision** (`PrecisionStatsPage.tsx`, components in
`apps/web/src/components/precision/`):
- `PrecisionSubNav` — 3-вкладочный sub-nav (Training/Progress/
  History) — точно тот шаблон для guess/blind-board.
- `PrecisionStatsCards` — top-4 карточки top-метрик.
- `PrecisionTrendsChart` — линейный график бакетов
  (`GET /precision/trends/me?bucket=day|week|month&since=&until=`).
- `PrecisionBreakdowns` — распределения по phase/themes.
- `PrecisionAttemptsList` — листинг с переходом в review.

**Sidebar** уже содержит `/guess` и `/blind-board` как sub-items
`/train`. Маршрутов `/guess/stats` и `/blind-board/stats` — нет
(добавляем).

## 3. Метрики

### 3.1 Guess — агрегаты per-user (`GET /guess/stats/me`)

- `totalSessions` — count finished.
- `avgUserAccuracy` — AVG(`userAccuracy`).
- `avgPlayerAccuracy` — AVG(`playerAccuracy`) (для сравнения «ты
  vs игроки в среднем»).
- `winsVsPlayer` — count где `userAccuracy > playerAccuracy`.
- `avgStars` — AVG(`userStars`).
- `totalScore` — SUM(`score`).
- `bestStreak` — MAX(`bestStreak`).
- `totalBetterMoves` — SUM(`betterThanPlayerCount`).

### 3.2 Guess — breakdowns (`GET /guess/breakdowns/me?since=`)

Из `guess_moves` агрегаты:
- **Verdict-распределение**: % strongest / betterThanPlayer /
  asPlayer / weaker.
- **UserClass-распределение**: % best / good / inaccuracy /
  mistake / blunder.

### 3.3 Guess — trends (`GET /guess/trends/me?bucket=&since=&until=`)

Бакеты (day/week/month):
- `bucketStart` ISO + `sessions` count + `avgUserAccuracy` +
  `avgPlayerAccuracy`.

### 3.4 Blind-board — агрегаты (`GET /blind-board/stats/me`)

- `totalSessions` — count finished.
- `bestStreak` — `User.blindBoardBestStreak` (готово).
- `currentStreak` — последняя active sessions.streak или 0.
- `maxLevelReached` = `floor(bestStreak/10)+1` (derive).
- `avgRoundsPerSession` — AVG(streak) для finished.
- `wrongAnswerCount` — count finishReason='wrong-answer'.
- `deadEndCount` — count finishReason='dead-end' (бейдж «загнал
  компа в угол»).

### 3.5 Blind-board — breakdowns (`GET /blind-board/breakdowns/me`)

Из `blind_board_attempts` JOIN на sessions:
- **Ошибки по типу фигуры**: для каждого `expectedPieceType`
  (Q/R/N/B) — `attempts, correct, errorRate%`. Показывает «какие
  фигуры чаще не узнаёшь».
- **Ошибки по уровню сложности** (опц., Open Q): требует поля
  `levelAtRound` в attempts — сейчас нет; либо derive из
  `attempts.round` и `streak`-моментов level-up (приблизительно).

### 3.6 Blind-board — trends + история

- `GET /blind-board/trends/me?bucket=` — sessions + bestStreak
  per bucket.
- `GET /blind-board/history?limit&offset` — список finished
  сессий (по образцу `/guess/history`).

### 3.7 Лидерборды

- ✅ `GET /blind-board/leaderboard` — уже есть (public).
- ❌ `GET /guess/leaderboard` — Open Q1. Если делаем — метрика
  `bestStreak` (моё, симметрично blind-board) или
  `avgUserAccuracy` с min-attempts.

## 4. UI — точки входа и навигация

### 4.1 Sub-nav для guess и blind-board

По образцу `PrecisionSubNav`:

**`GuessSubNav`** (3 вкладки):
- `/guess` — Тренировка (текущий лендинг).
- `/guess/stats` — Прогресс (StatsCards + Trends + Breakdowns).
- `/guess/history` — История (`/guess/history` API listing).

**`BlindBoardSubNav`** (3 вкладки):
- `/blind-board` — Тренировка.
- `/blind-board/stats` — Прогресс.
- `/blind-board/history` — История.

Sub-nav рендерится на каждой странице раздела (лендинг + stats +
history), активная вкладка — по location.

### 4.2 Структура страниц `/stats`

Похоже на `/precision/stats`:

```
[GuessSubNav: Training | Progress* | History]

┌──────┬──────┬──────┬──────┐
│ N    │ Avg  │ Wins │ Best │   ← StatsCards row
│ sess │ Acc% │ vs P │ Str  │
└──────┴──────┴──────┴──────┘

[Trends chart: avgUserAccuracy by week, 30d default]

[Breakdowns: verdict pie + userClass bars]
```

### 4.3 Структура `/history`

Список finished сессий с per-row:
- Дата, side, источник партии, accuracy %, stars.
- Tap → review (`/guess/sessions/:id` или
  `/blind-board/sessions/:id`).

## 5. API — новые endpoints

### 5.1 Guess (4 новых)

```
GET /guess/stats/me              — агрегаты, JwtAuthGuard
GET /guess/trends/me?bucket=day|week|month&since=&until=
GET /guess/breakdowns/me?since=
GET /guess/leaderboard?limit=    — public (опц., Open Q1)
```

### 5.2 Blind-board (4 новых)

```
GET /blind-board/stats/me        — JwtAuthGuard
GET /blind-board/trends/me?bucket=&since=&until=
GET /blind-board/breakdowns/me?since=
GET /blind-board/history?limit&offset  — JwtAuthGuard
```

`GET /blind-board/leaderboard` уже есть.

Все per-user endpoints — JwtAuthGuard (гость 401).

## 6. Переиспользование Precision-компонентов

Стратегия M1: **визуально похожие страницы, копия шаблона**
`PrecisionStatsPage.tsx` с заменой data-source на guess/blind-
board. Это быстрее чем сразу выделять generic'и (которые могут
оказаться не совсем подходящими — guess и blind-board имеют свои
специфические метрики).

В M2 (Open Q8) — рефакторинг в generic-компоненты `stats-common/`
(StatsCardsRow / TrendsChart / BreakdownChart / SessionsList).

CSS и iconography в M1 — общие переменные / классы из Precision.

## 7. Что НЕ делаем (M1)

- НЕ заводим глобальный `/stats` лобби — sub-namespace
  достаточно (каждая тренировка имеет свой /stats).
- НЕ выделяем generic-компоненты (M2).
- НЕ добавляем `BlindBoardAttempt.levelAtRound` (Open Q4 — либо
  derive, либо отложить разрез по уровню).
- НЕ строим guess-лидерборд по сложной метрике (M1 — bestStreak
  если делаем; M2 — avgAccuracy с min-attempts).
- НЕ показываем «top-3 best / 3 worst» sessions (Open Q6 —
  достаточно History с сортировкой).
- НЕ интегрируем mini-stats в `/train` карточки (зависит от
  ADR-081 implementation; Open Q7).

## 8. Реализация — follow-up задачи

Зависимости: S1 → (B-guess параллельно B-bb) → F-guess + F-bb +
L1.

### KS (S1) — shared DTO для stats/trends/breakdowns/history

**Assignee:** backend (shared). **Labels:** `puzzle`, `analysis`.
- `GuessStatsResponse`, `GuessTrendsResponse`, `GuessBreakdownsResponse`,
  опц. `GuessLeaderboardResponse`.
- `BlindBoardStatsResponse`, `BlindBoardTrendsResponse`,
  `BlindBoardBreakdownsResponse`, `BlindBoardHistoryResponse`.
- Bucket-тип общий: `'day' | 'week' | 'month'` (как в
  Precision).
- Acceptance: TS-сборка чистая.

### KS (B-guess) — endpoints `/guess/stats`, `/trends`, `/breakdowns`, опц. `/leaderboard`

**Assignee:** backend. **Labels:** `puzzle`, `analysis`.
**Зависит:** S1.
- 3–4 endpoint'а (§5.1). SQL-агрегации через Prisma raw или
  groupBy. JwtAuthGuard на per-user.
- Acceptance: stats возвращают корректные числа на тестовых
  фикстурах сессий; trends бакеты в правильном диапазоне;
  breakdowns суммируются в 100% по distributions.

### KS (B-bb) — endpoints `/blind-board/stats`, `/trends`, `/breakdowns`, `/history`

**Assignee:** backend. **Labels:** `puzzle`, `analysis`.
**Зависит:** S1.
- 4 endpoint'а (§5.2). JwtAuthGuard. История по образцу
  `/guess/history`.
- Acceptance: аналогично; breakdowns по piece-type корректны.

### KS (F-guess) — страницы `/guess/stats` + `/guess/history` + `GuessSubNav`

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** B-guess, S1.
- `GuessSubNav` компонент (3 вкладки, по образцу `PrecisionSubNav`).
- `GuessStatsPage` (StatsCards + Trends + Breakdowns).
- `GuessHistoryPage` (список + переход в review).
- Sub-nav рендерится также на `GuessLandingPage`.
- Acceptance: 3 вкладки работают; stats показывает агрегаты;
  history кликабельна; гость на /stats — login-redirect.

### KS (F-bb) — страницы `/blind-board/stats` + `/blind-board/history` + `BlindBoardSubNav`

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** B-bb, S1.
- По образцу F-guess. На `/blind-board/stats` дополнительно
  ссылка на public-leaderboard (уже есть endpoint).
- Acceptance: аналогично + breakdowns по piece-type визуально
  читаемы.

### KS (L1) — CSS sub-nav + stats-страниц + mobile

**Assignee:** layout. **Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** F-guess, F-bb.
- Sub-nav стиль (по образцу Precision).
- Stats-cards / trends / breakdowns CSS (можно переиспускать
  Precision-классы).
- Mobile-адаптив (3-card row → 2x2 grid на mobile).
- Acceptance: viewport 360×844 — все блоки читаются.

Итого **5 задач** (S1 + 2 backend + 2 frontend + L1). Без новых
миграций.

## 9. Открытые вопросы

1. **`GET /guess/leaderboard`** — нужен в M1? Метрика: bestStreak
   (моё, симметрично blind-board) vs avgUserAccuracy с
   min-attempts vs totalScore?
2. **Min finished sessions** для аггрегата accuracy в лидерборде
   (если делаем) — 5 / 10? Защита от выскочек с одной сессией.
3. **`BlindBoardAttempt.levelAtRound`** — добавить поле для
   разреза breakdowns по уровню или derive из `round +
   startConfig.addOrder.length` (приблизительно)? M1 — derive
   (моё) vs миграция.
4. **Default bucket** для trends — day / week (моё, как Precision)
   / month?
5. **Mini-stats на `/train` карточках** (ADR-081 hero/secondary)
   — делать сейчас или ждать TrainingLobby? Зависит от очерёдности.
6. **Top-best / top-worst sessions** на /stats — добавить (UX-
   bonus) или достаточно полной History с сортировкой?
7. **Generic stats-компоненты** — выделить сразу
   (`stats-common/`) или копи-паст шаблона из Precision и
   рефакторить M2 (моё, быстрее)?
8. **«Опубликовать профиль» / public stats** — статистика
   видна только владельцу или есть public-view (как у Puzzle
   Rush)? M1 — только владельцу (моё).

## 10. Откат

- Все 5 задач additive — endpoints, страницы, компоненты.
- Feature-flag `guessStatsEnabled` / `blindBoardStatsEnabled`
  для UI скрытия sub-nav вкладок (бэк остаётся).
- Существующие endpoints (`/guess/history`, `/blind-board/
  leaderboard`) не меняются.
