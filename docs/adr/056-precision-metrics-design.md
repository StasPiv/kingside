# ADR-056: Метрики раздела «Тренировка точности» (Precision)

**Дата:** 2026-05-10
**Автор:** architect
**Связанная задача:** KS-2714
**Связанные ADR:** ADR-044 (PlayVsEngine puzzles), ADR-047 (Eval and review для PVE), ADR-048 (Precision Training section), ADR-055 (раздельная статистика — инфра)
**Связанные задачи:** KS-2465 (PVE submit metadata в логах), KS-2473/KS-2505/KS-2506/KS-2527/KS-2533/KS-2686 (per-move WDL/cp tracking на клиенте), KS-2509 (`UserBestSnapshot`), KS-2554 (Mistakes Diary block hidden), KS-2689/KS-2692 (рейтинг скрыт на /precision)

---

## 1. Семантика precision-режима

Precision (`/precision`) — это **не one-shot tactics**. Концептуально это «матч с движком на удержание»:

1. Игрок получает позицию, где соперник зевнул преимущество (генератор precision-пазлов отбирает такие моменты из реальных партий, KS-2697).
2. Игроку дано N полуходов (по умолчанию 6), за которые он должен **удержать преимущество против Stockfish**, не упустив итоговый WDL ниже `winThreshold`.
3. Между ходом игрока и ответом движка идёт **анализ Stockfish'ом обеих сторон**: в позиции до хода игрока (best UCI + WDL) и в позиции после (фактический WDL). На клиенте это уже работает (KS-2473, KS-2505, KS-2506, KS-2686) и собирается в `UserBestSnapshot[]` для PostGameReview.
4. Завершение: «удержал» (`win` / `win-mate` / `win-engine-resign`) или «упустил» (`lose-wdl` / `lose-mate`).

Из этой механики вытекают главные пользовательские вопросы:

> **«Насколько точно я играю?»** (per-move accuracy)
> **«Где я упускаю?»** (когда первый раз ошибся, какой ход стал переломным, какие позиции даются хуже)

«Решено N из M» как метрика **не отвечает ни на один из них**. Она показывает только бинарный исход, не качество игры между стартом и финишем. Большая часть PVE-обучения — именно в этих полуходах, и текущий top-блок их полностью игнорирует.

## 2. Метрики Precision (3 уровня)

### 2.1 Уровень А — Top-level cards на `/precision`

Минимум для главного экрана раздела. Заменяет «X попыток / Y решено» на 4 карточки:

| Карточка | Метрика | Формула | Где смотреть |
|---|---|---|---|
| **Точность ходов** | `accuracyPercent` (avg по всем PVE-attempts user'а) | (`bestMovesCount + goodMovesCount`) / `totalUserMoves` × 100 | Главная цифра. Соответствует Lichess «Accuracy» по смыслу, но считается из тех же `MoveClass`-классификаций, что уже работают на клиенте (`utils/moveClassification.ts`). |
| **Удержано / Упущено** | `retainedCount / totalCount` | `count(solved=true) / count(*)` среди PVE-attempts | Смысл — бинарный исход. Текстовая метка: «удержано», не «решено». |
| **Средняя утечка WDL** | `avgWdlLeakPerMove` | `Σ(wdlBefore_user − wdlAfter_user) / totalUserMoves`, в пунктах WDL [-1..+1] | Сколько в среднем WDL «утекает» за один ход юзера. Чем меньше — тем точнее. Можно показывать как «−0.04 за ход», или в процентах от стартового WDL. |
| **До первой ошибки** | `avgPlysToFirstMistake` | среднее `firstMistakePly` по attempts, где он определён | Полуходы до первого `mistake`/`blunder`. NULL-attempts (без ошибок) не входят в среднее, но показываются справочно: «N attempts без ошибок». |

**Почему именно эти четыре:**
- (1) и (3) отвечают «насколько точно». (2) — бинарный итог. (4) — «где я упускаю» в виде «как долго держусь».
- Все четыре считаются **только из данных, которые клиент уже собирает в `UserBestSnapshot`** (KS-2509). Backend-агрегация — ровно над одним новым полем `precision_attempt_summary`.
- Streak/best/avgRating сюда **не идут** — для PVE они либо не определены (рейтинг, KS-2689), либо вводят шумовую метрику.

### 2.2 Уровень Б — Detail page (per-attempt review)

Уже работает на клиенте через `PostGameReview` (KS-2686): PGN с NAG-знаками, WDL до/после каждого user-хода, depth, best UCI как вариант. **Сейчас всё это считается runtime'ом из `UserBestSnapshot[]`, в БД не пишется** (KS-2465 явно: «v2»).

Что нужно изменить:
1. **Сохранять** `UserBestSnapshot[]` в БД при `submitAttempt` (для PVE-attempts).
2. На detail-странице (`/puzzle/:id?source=precision&attemptId=…`) **читать из БД**, а не пересчитывать. Это позволяет:
   - смотреть старые попытки (сегодня — нельзя, runtime-state теряется при уходе со страницы);
   - агрегировать Уровень А и В без перевычислений на клиенте;
   - не зависеть от того, был ли у пользователя движок в момент попытки (бридж-движок vs WASM, разные depth).
3. Per-attempt блок дополнить агрегатами:
   - `accuracyPercent` (для именно этой попытки),
   - `wdlAtStartSigned` → `wdlAtEndSigned` (сводный «маршрут оценки»),
   - `firstMistakePly` (если был),
   - распределение `MoveClass`: best/good/inaccuracy/mistake/blunder — счётчиками.
4. График WDL по полуходам — готов из `UserBestSnapshot.wdlAfter`. Mini-chart (sparkline) рядом со списком ходов.

### 2.3 Уровень В — Агрегаты по времени и темам

Не для MVP, но фиксируем модель данных так, чтобы это можно было добавить **без миграций**.

- **Тренд точности** — график `avgAccuracyPercent` по дням/неделям. Источник: `precision_attempts.accuracyPercent` + `puzzle_attempts.createdAt`.
- **Слабые типы позиций** — по двум осям:
  1. **Фаза игры** (opening / middlegame / endgame) — эвристика по числу фигур и оставшемуся материалу. Не нужна модель ML; считается на клиенте/бэке из `puzzle.fen`. Расчёт: 0 ходов из `puzzle.moves` (старт), считаем по числу major+minor фигур: ≥10 → middlegame; ≤6 → endgame; иначе — opening (для precision это «опенинг» редкость, т.к. зевок преимущества обычно в миттельшпиле/эндшпиле).
  2. **Темы** — переиспользуем `Puzzle.themes` (поле уже есть, у generated PVE-пазлов темы могут быть пустыми; backfill через анализ FEN — отдельная задача, не в этом ADR).
- **Серии и стрики** — для precision **убираем**. «Удержал 5 подряд» технически считается (через `count(*) WHERE solved`), но семантически слабая мотивация: один сложный пазл рушит серию. Лучше показывать **«Last 10»** — accuracy за последние 10 attempts.

## 3. Доменная модель

### 3.1 Выбор схемы

Кандидаты:
- **A.** Расширить `puzzle_attempts` JSON-полем `precision_data jsonb`. Минус: индексы по агрегатам внутри JSON неудобны; для Уровня В нужны отдельные запросы по `wdlAtStart`/`firstMistakePly`. Плюс: одна миграция.
- **B.** Расширить `puzzle_attempts` 6–8 nullable-колонками (NULL для forced-line). Минус: «грязная» таблица; LEFT-семантика на каждом запросе. Плюс: индексы простые.
- **C.** Отдельная таблица `precision_attempts(attemptId PK = puzzle_attempts.id, …)` 1:1 + `precision_attempt_moves(attempt_id, ply, …)` для per-move детализации.

**Выбираем C.**

Обоснование:
1. Forced-line attempts вообще не имеют этих полей — отдельная таблица убирает NULL-семантику.
2. Per-move детализация (`precision_attempt_moves`) **обязательна** для Уровня Б (читать из БД, а не пересчитывать). Проще завести её сразу как отдельную таблицу с FK на `puzzle_attempts`, чем городить JSONB-массивы внутри строки puzzle_attempts.
3. Уровень В (агрегаты по фазе/темам/времени) — стандартные SQL-запросы по двум хорошо проиндексированным таблицам; JSONB неудобен.
4. Семантическая чистота: PVE — другая активность, у неё отдельная сущность. Это согласуется с тем, что говорил пользователь: «раздел абсолютно другой».

### 3.2 Схема (Prisma DSL)

```prisma
model PrecisionAttempt {
  // 1:1 с puzzle_attempts. PK = FK = attempt_id.
  attemptId String   @id @map("attempt_id") @db.Uuid

  // Стартовые параметры пазла на момент попытки (snapshot — пазл может
  // меняться: regenerate, cleanup). Берутся из payload submitAttempt.
  wdlAtStartSigned Float @map("wdl_at_start_signed")    // [-1..+1]
  wdlAtEndSigned   Float @map("wdl_at_end_signed")
  halfMovesPlayed  Int   @map("half_moves_played")
  halfMovesTarget  Int   @map("half_moves_target")      // halfMovesN из puzzle params

  // Агрегаты по ходам (вычисляются бэком при submitAttempt из массива
  // moves; денормализация для быстрых выборок Уровня А).
  accuracyPercent     Float @map("accuracy_percent")    // 0..100
  bestMovesCount      Int   @map("best_moves_count")
  goodMovesCount      Int   @map("good_moves_count")
  inaccuraciesCount   Int   @map("inaccuracies_count")
  mistakesCount       Int   @map("mistakes_count")
  blundersCount       Int   @map("blunders_count")
  firstMistakePly     Int?  @map("first_mistake_ply")   // null = ошибок не было
  wdlLeakSum          Float @map("wdl_leak_sum")        // Σ(wdlBefore − wdlAfter)

  // Завершение
  endReason String  @map("end_reason")  // 'win' | 'win-mate' | 'win-engine-resign'
                                        // | 'lose-wdl' | 'lose-mate' | 'timeout'

  attempt PuzzleAttempt @relation(fields: [attemptId], references: [id], onDelete: Cascade)
  moves   PrecisionAttemptMove[]

  @@map("precision_attempts")
  @@index([accuracyPercent])
  @@index([endReason])
}

model PrecisionAttemptMove {
  attemptId    String  @map("attempt_id") @db.Uuid
  ply          Int                                       // 1-based, по полуходам user'а
  fenBefore    String  @map("fen_before")                // FEN до user-хода
  playedUci    String  @map("played_uci")
  bestUci      String  @map("best_uci")
  cpBefore     Int?    @map("cp_before")                 // ±MATE_CP_ENCODING для mate (см. KS-2505)
  cpAfter      Int?    @map("cp_after")
  // WDL хранится как 3 числа per-mille (0..1000), как и приходит от Stockfish.
  wdlBeforeW   Int?    @map("wdl_before_w")
  wdlBeforeD   Int?    @map("wdl_before_d")
  wdlBeforeL   Int?    @map("wdl_before_l")
  wdlAfterW    Int?    @map("wdl_after_w")
  wdlAfterD    Int?    @map("wdl_after_d")
  wdlAfterL    Int?    @map("wdl_after_l")
  depth        Int?
  classification String  @map("classification")          // 'best'|'good'|'inaccuracy'|'mistake'|'blunder'

  attempt PrecisionAttempt @relation(fields: [attemptId], references: [attemptId], onDelete: Cascade)

  @@id([attemptId, ply])
  @@map("precision_attempt_moves")
  @@index([classification])      // для агрегатов «топ типов ошибок»
}
```

Объяснения:
- `PrecisionAttempt` 1:1 с `PuzzleAttempt` — чтобы не дублировать `userId/createdAt/timeMs/solved`, всё уже есть в parent-row.
- `PrecisionAttemptMove` — индекс по `(attemptId, ply)` PK даёт упорядоченное чтение для PostGameReview без ORDER BY.
- WDL хранится тремя int-полями вместо JSONB — выигрываем на индексах и простоте SQL-агрегатов.
- Классификация `MoveClass` уже считается на клиенте (`utils/moveClassification.ts`), но для **server-trust** (нельзя верить клиенту) бэк **пересчитывает** classification из `cpBefore/cpAfter` через тот же алгоритм (порт `classifyMove` в backend, либо в `@kingside/shared`). Это **обязательно**: без серверной валидации можно нарисовать любой accuracy.

### 3.3 Server-side trust

Клиент шлёт массив `moves: UserBestSnapshot[]`. Бэк:
1. Валидирует длину: `moves.length === halfMovesPlayed` (не больше `halfMovesN`).
2. Валидирует, что каждый `playedUci` легален в `fenBefore` (через `chess.js`).
3. Пересчитывает `classification` из `cpBefore`/`cpAfter` (или WDL) — клиентскому полю не верим.
4. Пересчитывает агрегаты (`accuracyPercent`, `wdlLeakSum`, `firstMistakePly`, счётчики) — то же.
5. Пишет `PuzzleAttempt` + `PrecisionAttempt` + `PrecisionAttemptMove[]` в одной транзакции.

Это требует портирования `classifyMove` в shared-пакет (сейчас он в `apps/web/src/utils/moveClassification.ts`). Это разумная задача — функция чистая, без DOM.

## 4. UI-контракт

### 4.1 Top-блок `/precision` (Уровень А)

Заменяет текущие 2 карточки «Attempts / Solved» на 4:

```
┌─────────────────┬─────────────────┬─────────────────┬─────────────────┐
│ Точность        │ Удержано        │ Утечка/ход      │ До первой       │
│  82%            │  3/7            │  −0.06          │  ошибки 4 хода  │
│ best+good       │ выиграно из 7   │ WDL за полуход  │ среднее         │
└─────────────────┴─────────────────┴─────────────────┴─────────────────┘
```

Точные тексты — забота фронта/i18n. Обязательно:
- никакой «solveRate» / «accuracy» терминологии из forced-line;
- никаких rating/streak;
- toggle «Скрыть удержанные» (см. §4.3) — рядом с фильтрами.

### 4.2 Detail-страница попытки

`/puzzle/:id?source=precision&attemptId=…` (нужен query-параметр для конкретной попытки; без него — режим решения, как сейчас).

Блоки:
1. **Сводка попытки** — `accuracyPercent`, `wdlAtStart → wdlAtEnd`, `halfMovesPlayed/halfMovesTarget`, метка `endReason`.
2. **График WDL по полуходам** — sparkline из `wdlAfter` каждого хода. Х: ply, Y: WDL_signed.
3. **Распределение классификаций** — bar-chart: best / good / inaccuracy / mistake / blunder.
4. **PostGameReview** (как сейчас, KS-2686) — но данные читаются из БД, не из runtime.

### 4.3 hideSolved → переосмысление

Toggle «Скрыть решённые» переименовать в «Скрыть удержанные» (`hideRetained`). Семантически — то же поле `puzzle_attempts.solved=true`, query-параметр backend'а тот же `hideSolved=true` (внутреннее имя оставляем — иначе ломается контракт `/puzzles/browse`). Меняется только UI-копия и i18n-ключ (`precision.hideRetained` вместо `puzzleBrowser.hideSolved`).

Альтернатива на v2 — три-состояние: «Все / Только новые / Только упущенные». Не для MVP.

## 5. Декомпозиция

### Backend
- **B1.** Миграция: новые таблицы `precision_attempts`, `precision_attempt_moves`. Без backfill (старые PVE-attempts остаются без расширения; UI обращается по LEFT JOIN, в их карточках фолбек на «—»). Метки: `puzzle, prisma`.
- **B2.** `@kingside/shared`: вынести `classifyMove` из `apps/web/src/utils/moveClassification.ts` в пакет (одна pure-функция). Тесты переехать вместе. Метка: `puzzle`.
- **B3.** Расширить `submitAttempt` контракт для PVE: `playVsEngine.moves: UserBestSnapshot[]`. DTO + class-validator. Сделать поле опциональным на первый релиз (старые клиенты продолжают слать без `moves` — пишется только `PuzzleAttempt` + минимальный `PrecisionAttempt` без movesN). Метка: `puzzle`.
- **B4.** `PuzzleService.submitAttempt` для PVE: server-side валидация ходов + classification + расчёт агрегатов + запись `PrecisionAttempt` + `PrecisionAttemptMove[]` в транзакции. Метка: `puzzle`.
- **B5.** Endpoint `GET /precision/stats` — Уровень А (4 метрики + `lastAttempts: { id, accuracyPercent, solved, createdAt, fen }[]` для списка). Метка: `puzzle, analysis`.
- **B6.** Endpoint `GET /precision/attempts/:attemptId` — Уровень Б (агрегат + `moves: PrecisionAttemptMove[]`). Авторизация: владелец attempt'а. Метка: `puzzle, analysis`.
- **B7 (Уровень В, отложено).** Endpoint `GET /precision/stats/trends?days=30` — `[ { date, avgAccuracy } ]`. По мере необходимости. Метка: `puzzle, analysis`.

### Frontend
- **F1.** `PlayVsEngineRunner` — отправлять `moves: UserBestSnapshot[]` в `submitAttempt` (расширить `PlayVsEngineSubmit`). Без UI-изменений. Метка: `puzzle`.
- **F2.** `PrecisionPage` top-блок — 4 карточки Уровня А. Источник — `GET /precision/stats`. Удалить чтение `byMode['play-vs-engine']` из `/puzzles/stats/me` (становится не нужно). Метка: `puzzle`.
- **F3.** `PrecisionPage` toggle — переименовать «Скрыть решённые» → «Скрыть удержанные», новый i18n-ключ. Параметр backend'а тот же `hideSolved`. Метка: `puzzle, i18n`.
- **F4.** Detail-страница попытки — читать `GET /precision/attempts/:attemptId`, передать `moves` в `PostGameReview` вместо runtime-state. Прибавить блоки: сводка, sparkline WDL, распределение классификаций. Метка: `puzzle, analysis`.
- **F5 (Уровень В, отложено).** Тренд accuracy-графика. Метка: `puzzle, analysis`.

### QA
- **Q1.** Сценарий: 3 PVE attempts с разной точностью (например 100%/60%/0%). Проверить: top-блок показывает корректные средние; detail-страница показывает per-move classification; tренд (если F5) считается. Forced-line attempts не влияют на цифры.
- **Q2.** Server-trust: попытка послать заведомо `accuracyPercent=100` в payload — бэк должен проигнорировать клиентское значение, пересчитать своё, ответ должен совпасть с реальностью.

## 6. Связь с ADR-055

Из ADR-055 **остаётся**:
- §5 B1 (getStats top-level фильтр по `forced-line`) — нужен независимо.
- §5 B2 (`applyRatingChange` skip PVE) — нужен независимо.
- §5 B3 (`recordPuzzleMistake` skip PVE) — нужен независимо. Дневник ошибок остаётся forced-line-only; precision-«ошибки» имеют свою аналитику в `precision_attempt_moves`.
- §5 B4 (`PuzzleRushService.getNextPuzzle` явный `solutionMode='forced-line'`).
- §5 B5 (`DailyPuzzleService` фильтр).

Из ADR-055 **переосмысляется**:
- §5 B6 (`/precision/stats`). Был «опционально, упрощённый набор полей». **Становится обязательным** (§5 B5 этого ADR), с другим набором полей (Уровень А).
- §5 F1 (toggle hideSolved на /precision). **Остаётся**, но с новым i18n-ключом и UI-копией «Скрыть удержанные» (§4.3, §5 F3 этого ADR).
- §5 F3 (фронт переключается на новый endpoint). **Становится обязательным** (§5 F2 этого ADR).

Из ADR-055 **отменяется** (или включается в новые задачи):
- ничего не отменяется — все B-пункты совместимы.

ADR-055 остаётся валидным как **инфра-уровень** (как разделить counters в существующей схеме). ADR-056 строит **доменный уровень** поверх него: что эти counters означают для пользователя и какие ещё нужны.

## 7. Риски и компромиссы

| Риск | Митигация |
|---|---|
| Размер payload `submitAttempt` для PVE растёт (≤6 ходов × ~200 байт) | ~1.2 КБ — пренебрежимо. |
| Server-side classification расходится с клиентским (старый Stockfish без WDL-патча) | `classifyMove` входы — `cpBefore/cpAfter`, оба считаются у обоих сторон. Если на клиенте `cpAfter=null` (post-analyze упал) — backend фолбечится в `'good'` (нейтрально). |
| Нагрузка на запись (3 таблицы транзакцией) | На один PVE-attempt 1+1+≤6 строк. Объём низкий; PVE в проде < 100 attempts/день суммарно. |
| Backfill старых PVE-attempts | Не делаем. `precision_attempts` у них NULL → UI показывает «Нет данных по попытке» на detail-странице, top-блок не учитывает (LEFT JOIN с фильтром `precision_attempts.attempt_id IS NOT NULL`). |
| Дублирование данных между `puzzle_attempts.userMoves` и `precision_attempt_moves.played_uci` | `userMoves` — текстовая строка UCI через пробел (для forced-line — основной носитель). Для PVE можно оставить пустым или продолжать заполнять — не несёт вреда. Решает backend при реализации B4. |
| `endReason` ENUM расширяется (`timeout`, новые варианты) | Хранится как text, не как PG-enum. Расширяется без миграции. |

## 8. Acceptance

- [x] §1 — семантика precision как активности.
- [x] §2 — три уровня метрик (А, Б, В) с обоснованием выбора.
- [x] §3 — доменная модель (`precision_attempts`, `precision_attempt_moves`) с обоснованием выбора варианта C.
- [x] §4 — UI-контракт top-блока, detail-страницы, hideSolved.
- [x] §5 — декомпозиция backend / frontend / QA (B1–B7, F1–F5, Q1–Q2).
- [x] §6 — связь с ADR-055: что остаётся, что переосмысляется.
- [ ] @coordinator — на согласование с пользователем и постановку подзадач.
