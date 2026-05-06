# ADR-044: Puzzle generation pivot — «играй против движка из позиции после зевка»

**Дата:** 2026-05-06
**Статус:** Предложено
**Задача:** KS-2461
**Связанные:**
- [ADR-041 Tactical puzzle generation](./041-tactical-puzzle-generation.md) — **частично supersede** (см. §1.2 ниже): forced-line с `cook_advantage` / `cook_mate` и `is_valid_attack` отменяется как продакт-механика. Часть инфраструктуры (`tactic-worker`, archive-pipeline, `Puzzle` модель, рейтинг) переиспользуется без изменений.
- [ADR-042 tactic-worker extraction](./042-tactic-worker-extraction.md) — генерация по-прежнему живёт в `apps/tactic-worker`, task-def `kingside-tactic-worker`, ECS RunTask.
- KS-2431 (закрыта `done`) — этап 1 MVP forced-line, продуктовое наследие сохраняется как `solutionMode='forced-line'` для уже сгенерированных пазлов.
- KS-2452 / KS-2453 (drill explanation) — независимый эпик, не пересекается.

---

## 1. Контекст

### 1.1 Что было

ADR-041 (KS-2430) спроектировал генерацию по схеме lichess-puzzler:
1. По каждому ply партии — Stockfish MultiPV=2 с UCI_ShowWDL.
2. Триггер «здесь есть пазл» = переход в выигранную позицию (`ΔWDL ≥ 0.6`).
3. Построение **forced-line**: `cook_advantage` / `cook_mate`, `is_valid_attack` (`spread ≥ 0.7 WC`), длина ≥ 5 полуходов нечётная.
4. Хранение в `Puzzle.moves` (UCI через пробел), `acceptedMoves` для альтернатив.
5. Решение в UI: классический puzzle-flow (`apps/web/src/pages/PuzzlePage.tsx`) — пользователь играет ход, сравнивается с эталоном, если совпало — следующий полуход.

KS-2431 закрыл этап 1: pipeline собран в `apps/tactic-worker/src/puzzle-generator/`, миграция БД partial UNIQUE применена, sample-batch на 50 партиях прошёл.

### 1.2 Что выяснилось в исследовательской сессии (2026-05-06)

Backend в исследовательской сессии прогнал текущий `analyze-pgn.cli` на эталонах (TWIC1641 + Турнир претендентов 2026, 18 результативных партий) с разными лимитами Stockfish и порогами:

| Параметры | Результат |
|---|---|
| `depth=22, time=10s, nodes=10M`, lichess-параметры (X=0.6, spread Y=0.7, forced-line) | ≈ 50 минут на 18 партиях; пазлов после `is_valid_attack` — **0–2 на батч**; spread Y=0.7 на нашей глубине почти не достижим. |
| Мягкие пороги (Y=0.4) + early-exit при сходимости PV1/PV2 | Шум: ≈ 30% «пазлов» — recapture, тривиальные защитные ходы, не уникальные ходы. |
| `time=1s, depth=∞, nodes=∞`, X=0.6, без Y/forced-line/trivialCapture (только зевок) | **91 секунда** на 18 партиях, **21 зевок**; вердикты `notBlunder=639, decided=503, blunder=21, samePv1=4, gameOver=1`. Ручная проверка зевков показала: позиции **тренировочно ценные**. |

**Главный вывод:** lichess-puzzler-подобный pipeline (depth=50, X=0.6, Y=0.2, forced-line + uniqueness + trivialCapture) физически недостижим на нашем железе (1 vCPU spot, threads=1 для детерминизма). Глубина шумная, `is_valid_attack` на низкой depth даёт много ложных «единственных лучших ходов»; форсированная линия превращается в шумовой рукав.

**Решение пользователя в сессии:** менять не пороги, а **продуктовую парадигму**.

> «Делай ТОЛЬКО зевки, без построения линии. Дальше пользователь играет позицию интерактивно против движка — как реальную партию из выигранной позиции».

Это формально **смена шаблона задачи** для пользователя:
- **Было:** «угадай заданную последовательность ходов» (детерминистический ответ, как у lichess).
- **Стало:** «обыграй движок из выигранной позиции, не дай отыграться» (открытый ответ, проверка по WDL).

Парадигма ближе к classic chess.com / lichess **«играть позицию»** в анализе после партии, чем к puzzle. Тренировочное преимущество: вместо одной заученной линии пользователь учится **реализовывать преимущество** разными способами — задача не зашита в один правильный ход, а определяется условием «удержать перевес N полуходов».

### 1.3 Числа из последнего прогона (база калибровки)

18 результативных партий Кандидатов 2026, `time=1s, multiPV=2, threads=1`, X=0.6, без Y/forced-line:

- **91 секунда** на 16 параллельных воркерах = ~80 vCPU-секунд + накладные.
- **21 зевок** на корпус.
- Вердикты: `notBlunder=639` (ход не понизил WDL ≥ 0.6), `decided=503` (партия уже решена, `|wdl_before| > 0.95`, пропуск), `blunder=21`, `samePv1=4` (совпало с PV1 движка → не зевок), `gameOver=1`.
- Экстраполяция на 1000 классических партий: **~5000–10000 зевков**, **~85 минут CPU** (одна машина 16-vCPU, ~5 минут wall).

Это на 1.5–2 порядка дешевле forced-line-pipeline'а из ADR-041 (там было ~17 vCPU-часов на 1000 партий).

### 1.4 Scope ADR

Только дизайн:
- формальные критерии зевка и победы/поражения решателя;
- БД-схема (`Puzzle.solutionMode`);
- UI-контракт нового режима;
- судьба forced-line пазлов и research-инструментария;
- декомпозиция на тикеты.

Без миграций, кода, компонентов. Тикеты создаются в `To Do`, без запуска.

---

## 2. Критерии (формальные)

Все WDL-значения — `WDL_signed ∈ [-1, +1]`, POV side-to-move, по формуле lichess (`UCI_ShowWDL` per-mille → конвертация в `[-1..1]`). Для матовых оценок: `mate-for-stm = +1`, `mate-against-stm = -1`. См. ADR-041 §2.0.

### 2.1 Параметры зевка (criterion для отбора позиций)

| Параметр | MVP | Альтернатива | Обоснование |
|---|---|---|---|
| `time-ms` (limit на позицию) | 1000 мс | 2000 мс при низкой пропускной способности | Прогон показал, что на 1с детектируются крупные зевки (`ΔWDL ≥ 0.6`) с приемлемым шумом. Глубина не фиксируется (Stockfish 17, threads=1 на 1с обычно достигает depth 18–22). |
| `multiPV` | 2 | — | Нужна PV2, чтобы определить `samePv1`. |
| `threads` | 1 (env `STOCKFISH_THREADS=1`) | — | Детерминированность (lazy SMP даёт нерепродуцируемость). |
| `blunderΔ` (X) | **0.6** WDL | 0.5 (мягче) / 0.7 (жёстче) | Калибруется. На прогоне 18 партий 0.6 даёт 21 «чистый» зевок. После первого batch'а на 1000 партий chess-expert аудирует 100 случайных и принимает финальное X. |
| `skipDecided` | `|wdl_before| > 0.95` | — | Партия уже решена, ход в +0.99 → +0.96 не учебный (`decided=503` в прогоне). |
| `samePv1` | drop если ход партии = PV1 движка | — | Если человек сыграл лучший ход — это не зевок, даже если cp/WDL после хода низкий (Stockfish мог ошибаться на 1 секунде). 4 случая на 18 партий. |
| `gameOver` | drop если позиция на ply мат / ничья (по chess.js) | — | Технический фильтр. |
| Уникальность правильного ответа | **НЕ требуется** | (ср. ADR-041 §2.4 `is_valid_attack`) | Принципиальное изменение: pipeline ищет только **факт зевка** (`prev_wdl - (-cur_wdl) ≥ X`), без проверки `spread(cur) ≥ Y`. Уникальность хода у решателя проверяется на этапе solvability check (§2.3), а не на отборе позиции. |

### 2.2 Что хранится при срабатывании зевка

- `fen` = позиция **после** зевка (т. е. позиция, в которой ходит **решатель**).
- `blunderMove` = UCI-ход партии, который был зевком (для UX «соперник зевнул»).
- `wdlAfterBlunder` = WDL_signed для решателя в `fen` (это и есть «стартовая высота» пазла, ≈ +0.6..+1.0).
- `wdlBeforeBlunder` = WDL_signed для зевнувшего в позиции до хода.
- `sourceMoveNum` = ply в партии, где был сделан зевок.

В отличие от forced-line режима **не хранятся** `moves` (нет «правильной линии»), `acceptedMoves` (нет «равноценных альтернатив соперника»).

### 2.3 Solvability check (этап генерации, до записи)

Pipeline до записи проверяет, что позиция действительно решаемая:

1. От стартовой позиции `fen` Stockfish играет за решателя (PV1, тот же `time-ms=1000`), затем за соперника (PV1) — **N полуходов** (см. §2.4).
2. На каждом полуходе решателя замеряем `WDL_signed_for_solver`.
3. Если в любой момент `WDL_signed_for_solver < failThreshold` (см. §2.4) → drop позиции (`solvabilityFailed`). Это значит: даже Stockfish-vs-Stockfish не удерживает преимущество — пазл шумовой (например, спорный зевок против сильной защиты).
4. Иначе — позиция принимается.

Это эквивалент `is_valid_attack` в lichess-puzzler, но проверяется не уникальностью PV-spread'а, а **самосогласованностью**: «движок против движка реализует перевес — значит, и человек сможет».

Solvability check добавляет в pipeline `~N × 1с = ~6 сек/позицию`. С 21 зевком на 18 партий это ~2 минуты на батч 1000 партий. В рамках бюджета.

### 2.4 Критерий победы решателя в UI

Это центральное продуктовое решение. Варианты, рассмотренные в проектировании:

**(A) «Hold the advantage» — удержать перевес N полуходов.**
- Решатель играет N полуходов против Stockfish PV1.
- Win, если на конец N полуходов `WDL_signed_for_solver ≥ winThreshold`.
- Lose, если в любой момент `WDL_signed_for_solver < failThreshold`.
- Mate — досрочный win (если решатель ставит мат раньше N).
- Stalemate / противник сдался по eval (Stockfish PV1 returns `score mate -K` для себя) — досрочный win.

**(B) «Convert the advantage» — довести до мата или явной победы.**
- Win, только если `WDL_signed_for_solver ≥ 0.95` (≈ выиграно) на каком-то полуходе ≤ N.
- Lose, если N исчерпано без достижения 0.95, либо `WDL_signed_for_solver < failThreshold`.

**(C) «Just don't blunder» — не зевнуть в N полуходов.**
- Win, если `WDL_signed_for_solver` не упал на > 0.4 за всё N.
- Lose, если упал.

**MVP — вариант (A).** Обоснование:
- Проще объяснить пользователю: «играй позицию, не дай сопернику отыграться».
- Менее строгий, чем (B): на 6 полуходах из +0.7 до мата довести часто невозможно — это требовало бы сужать корпус позиций, теряя 80% зевков. (A) допускает «правильно играю эндшпиль с перевесом» как валидное решение.
- Более полезный в обучении, чем (C): просто «не зевнуть» слишком пассивный критерий, не тренирует активную игру.

**Параметры (A) для MVP:**

| Параметр | MVP | Калибруется |
|---|---|---|
| `N` (полуходов = 2 × ходов решателя) | **6** (3 хода юзера + 3 хода движка) | Может уменьшиться до 4 для коротких пазлов или вырасти до 10 для эндшпильных. Решение по итогам chess-expert аудита. |
| `winThreshold` (WDL_signed_for_solver, удержать ≥) | **0.5** | Выше — пазл сложнее (нужно не дать «съесть» перевес даже на 0.2). Ниже — слишком мягкий. |
| `failThreshold` (WDL_signed_for_solver, упал ниже → lose) | **0.0** | «Преимущество ушло в равенство» — критерий поражения. Ниже (-0.2) — даём пользователю шанс ошибиться раз и отыграться. Выше (+0.3) — слишком жёсткий. |
| `mateBonus` | mate за решателя в ≤ N полуходов → win | — | Без бонуса в рейтинге; считается как обычный win. |
| `engineResign` | если Stockfish PV1 для соперника даёт `mate` против себя (`mate -K`) → досрочный win | — | Симуляция «сдачи» движка. |

**Что делать с ничейными концовками после зевка**: drop на этапе генерации. Если `wdlAfterBlunder < 0.4` (порог для зачисления в puzzle) — позиция не хранится как пазл. Если человек зевнул из +0.0 в -0.4 — для **другой** стороны это +0.4, и пазл «доиграй ничью» в MVP **не делаем** (слишком тонкий, можно довести до отдельного режима в v2). MVP-фильтр: `wdlAfterBlunder ≥ 0.5`.

### 2.5 Открытый вопрос: ход решателя не лучший, но в пределах win-критерия

Сценарий: решатель играет «нейтральный» ход (например, не лучший защитный). WDL после хода = 0.55. Критерий `winThreshold=0.5` соблюдён, движок отвечает PV1, WDL остаётся ≥ 0.5. На конец N — win.

Лучший ход дал бы WDL = 0.8. Решатель победил, но с «не оптимальной» игрой.

**Решение:** засчитываем как win. Это сознательный выбор парадигмы:
- Тренировочно ценно «удержать перевес», даже не самым сильным ходом.
- Альтернатива (требовать «PV1 на каждом ходу») сводит парадигму обратно к forced-line — это та проблема, от которой мы уходим.
- Рейтинг (Glicko-2) выровняет: пазл, в котором есть «нейтральные» удерживающие ходы, окажется проще и скорректирует рейтинг вниз.

В UI после решения показываем индикатор «лучший ход был X», но не штрафуем.

---

## 3. БД-схема: `Puzzle.solutionMode`

### 3.1 Решение

Добавить колонку `Puzzle.solution_mode` (текст) с двумя значениями:

```
'forced-line'    → старая семантика; решатель проходит заданную moves-цепочку; acceptedMoves опционально
'play-vs-engine' → новая семантика; moves='', решатель играет позицию против движка
```

`solutionMode` — **обязательное** поле в API, в БД — с `DEFAULT 'forced-line'` для обратной совместимости.

### 3.2 Миграция

```sql
ALTER TABLE puzzles
  ADD COLUMN solution_mode TEXT NOT NULL DEFAULT 'forced-line';

-- Существующие записи: все = 'forced-line' (lichess-импорт + старый KS-2431-batch).
-- Для нового источника генерации pipeline пишет 'play-vs-engine'.
-- Backfill для уже существующих generated пазлов из KS-2431 не нужен —
-- они остаются играбельными в старом режиме. UI покажет их как обычные.

CREATE INDEX puzzles_solution_mode_idx ON puzzles(solution_mode);
```

Идемпотентная (без ошибок при повторном применении). Не трогает Lichess-данные.

### 3.3 Что заполняется в `Puzzle` для `play-vs-engine`

| Поле | Значение |
|---|---|
| `id` | UUID |
| `fen` | позиция после зевка |
| `moves` | `''` (пустая строка; `''.split(' ').length = 1` — учесть в `validatePlayerSide`) |
| `acceptedMoves` | `null` |
| `source` | `'generated'` |
| `sourceType` | `'archive_game'` |
| `sourceId` | `archive_games.id` |
| `sourceMoveNum` | ply зевка |
| `gap` | `round((wdlAfterBlunder - 0) × 100)` — для UX «насколько большой перевес», совместимо с UX gap-фильтра |
| `depth` | фактическая глубина Stockfish при детекции зевка (не запрошенная) |
| `themes` | теги через пробел (см. §4) |
| `rating` | начальное по §3.5 |
| `ratingDev` | 350 (стандартный default) |
| `isPublic` | `true` для MVP |
| `solutionMode` | `'play-vs-engine'` |
| `sourceMetadata` | JSON: `{ "blunderMove": "<UCI>", "wdlBeforeBlunder": <float>, "wdlAfterBlunder": <float>, "winThreshold": 0.5, "failThreshold": 0.0, "halfMovesN": 6, "engine": "stockfish-XX", "engineParams": { "timeMs": 1000, "multiPV": 2, "threads": 1 }, "generatedAt": "<ISO>" }` |

Поле `gap` оставлено для UX-сортировки/фильтрации «лёгкий перевес vs крушение» — независимо от `solutionMode`.

### 3.4 Партишн UNIQUE

Существующий `puzzles_fen_source_unique ON puzzles(fen) WHERE source='generated'` (KS-2431) **остаётся как есть**. Дедуп FEN внутри `source='generated'` работает для обоих режимов. Если один и тот же FEN детектируется дважды (раз в forced-line, раз в play-vs-engine) — UNIQUE conflict, второй insert пропускается. На MVP это допустимо: forced-line больше не генерируется (новый pipeline пишет только play-vs-engine), коллизии не накапливаются.

### 3.5 Начальный рейтинг для play-vs-engine

```
avgPlayerRating = round(avg(whiteElo, blackElo, default 1500))
modeAdj = -100  // play-vs-engine MVP калибровочно проще forced-line: «удержать»
                 // не требует точной линии, можно сыграть несколько способами
gapAdj  = wdlAfterBlunder > 0.85 ? -150 : 0  // лёгкие позиции — сильный отрицательный
                                              // сдвиг (выигрыш фигуры реализуется тривиально)
rating = clamp(600, 2800, avgPlayerRating + modeAdj + gapAdj)
```

Glicko-2 после ~50 attempts стабилизирует. На первом batch'е chess-expert аудит даёт обратную связь по реальной сложности.

---

## 4. Тегирование

### 4.1 Что меняется относительно ADR-041 §4

Для `play-vs-engine` нет «первого хода линии» (решатель не зафиксирован в moves). Тегирование через drill-предикаты по **первому ходу решателя в solvability-check Stockfish PV1** (§2.3) — это лучший доступный proxy «какой паттерн в позиции».

| Тег | Источник для play-vs-engine |
|---|---|
| `fork`, `pin`, `hangingPiece`, `discoveredAttack`, `skewer` | drill-predicates применяются к `fen` + первый ход PV1 решателя (как в ADR-041 §4.1а, но «первый ход линии» = `solvability.firstMove`). |
| `mateInN` | в solvability-check Stockfish PV1 находит мат в N полуходов. |
| `endgame` | ≤ 7 фигур на доске. |
| `crushing` / `advantage` / `mate` | по `wdlAfterBlunder`: ≥ 0.95 — `crushing`, ≥ 0.5 — `advantage`, mate — `mate`. |
| `playVsEngine` | технический тег, всегда ставится для нового режима — даёт UI-фильтр «новые пазлы». |

### 4.2 Технический тег для UX

`playVsEngine` (или `mode:play-vs-engine`) — обязательный тег для всех записей нового режима. Frontend по нему фильтрует «свежий формат» в категориях `/puzzles`.

---

## 5. Frontend: UI-контракт

### 5.1 Где живёт

Новый режим **переиспользует** `apps/web/src/pages/PuzzlePage.tsx`, ветвится по `puzzle.solutionMode`:

- `solutionMode === 'forced-line'` → текущий flow (без изменений).
- `solutionMode === 'play-vs-engine'` → новая ветвь.

Альтернатива «отдельная страница `/puzzles/play/:id`» отвергнута: это удваивает router/router-guards/header/footer. Один компонент с двумя стратегиями — проще.

Внутри `PuzzlePage` две strategy-функции:
- `strategy.forcedLine` — текущий цикл (move → check vs `puzzleMoves[moveIndex]`).
- `strategy.playVsEngine` — новый цикл (см. §5.2).

### 5.2 Цикл «play-vs-engine»

```
[mount]
  Загрузить puzzle (PuzzleDto + sourceMetadata).
  Инициализировать chess.js на FEN.
  Инициализировать локальный Stockfish (WasmEngineAdapter — он уже используется в PuzzlePage).
  state = 'thinking', halfMovesPlayed = 0, history = []

[loop пока halfMovesPlayed < N AND state ∈ {thinking, engine}]
  if state == 'thinking':
    ждём ход пользователя на доске.
    apply move → chess.js.
    halfMovesPlayed++.
    state = 'evaluating'.
  if state == 'evaluating':
    Stockfish.analyze(fen, time=1000, multiPV=1) → score, bestmove.
    wdl_user = WDL_signed_for_user (POV в текущем fen — это движок; инвертируем).
    if wdl_user < failThreshold → state = 'lose'.
    elif chess.isCheckmate() (мат поставлен) → state = 'win'.
    elif Stockfish reports mate ≤ -K (движок проиграет в K) → state = 'win'.
    else state = 'engine'.
  if state == 'engine':
    apply Stockfish.bestmove → chess.js.
    halfMovesPlayed++.
    if halfMovesPlayed >= N → break.
    if chess.isCheckmate() (движок поставил мат? не должен после фильтра §2.3, но защита) → state = 'lose'.
    state = 'thinking'.

[после break]
  Stockfish.analyze(final_fen, time=1000, multiPV=1) → final_wdl_user.
  if final_wdl_user >= winThreshold → state = 'win'.
  else state = 'lose'.
```

**state**: `thinking | evaluating | engine | win | lose | error`. DOM-маркер `data-state`, `data-half-moves`, `data-mode="play-vs-engine"`.

### 5.3 Вспомогательные UX-сигналы

- **Прогресс-бар** «осталось N полуходов» — пользователь видит, сколько ещё держать.
- **WDL-индикатор** (eval bar, как в анализе) — слева/справа доски, обновляется после каждого хода. Опционально показывает `winThreshold` риской.
- **Сообщение «соперник только что зевнул»** на старте, с подсветкой клеток `blunderMove.from` / `blunderMove.to` (те, что в `sourceMetadata`).
- **После win**: показать «лучший ход был X на ходу N» (если решатель играл не-PV1) — без штрафа, образовательная подсказка.
- **После lose**: показать в каком полуходе WDL упал ниже `failThreshold`, какой был лучший ход.
- **Анти-чит**: для MVP **не делаем**. Всё считается локально через WASM Stockfish. Рейтинговые риски: пользователь может «накрутить» через консоль; принимаем (как у lichess для puzzle-rush). В v2 опционально: server-side pre-validation первого хода через api Stockfish.

### 5.4 Submit attempt

```
POST /api/puzzles/:id/attempts
  body: {
    solved: boolean,             // true если win
    timeMs: number,
    userMoves: string,           // UCI через пробел
    halfMovesPlayed: number,     // как далеко дошёл
    finalWdl: number,            // WDL_signed_for_user на конец
    reason: 'win' | 'lose-wdl' | 'lose-mate' | 'win-mate' | 'win-engine-resign'
  }
```

Сервер записывает `PuzzleAttempt` (поля `solved`, `timeMs`, `userMoves` уже есть). Glicko-2 update — стандартный по `solved`. Дополнительные поля (`finalWdl`, `reason`) пока **не сохраняются** в БД — они нужны только для логирования / клиентского UX и могут попасть в `PuzzleAttempt.metadata` JSONB в v2 (отдельный апдейт схемы; в MVP не блокируем релиз).

### 5.5 PuzzleDto (shared)

Добавить поле:

```ts
export type PuzzleSolutionMode = 'forced-line' | 'play-vs-engine';

export type PuzzleDto = {
  // ...существующее
  solutionMode: PuzzleSolutionMode;       // обязательное
  /**
   * Поля, релевантные только для solutionMode === 'play-vs-engine'.
   * Для forced-line — undefined.
   */
  playVsEngine?: {
    blunderMove: string;        // UCI
    wdlAfterBlunder: number;    // [0..1]
    winThreshold: number;       // 0.5 default
    failThreshold: number;      // 0.0 default
    halfMovesN: number;         // 6 default
  };
};
```

Backend кладёт `solutionMode` всегда; для play-vs-engine достаёт `playVsEngine` из распарсенного `sourceMetadata` JSON. Старая логика `validatePlayerSide` остаётся для forced-line; для play-vs-engine **не вызывается** (нет эталонной линии). `puzzle.service.ts:526` дополняется early-return для `solutionMode === 'play-vs-engine'`.

---

## 6. Backend pipeline: что меняется

### 6.1 Алгоритм генерации (рефакторинг `generator-pipeline.ts`)

Удаляем:
- `buildForcedLine` — больше не строится линия. Файл `line-builder.ts` остаётся в репозитории как research-инструмент для возможной reactivation forced-line режима, но из основного pipeline убирается импорт.
- Проверка `is_valid_attack` (`spread ≥ Y` на каждом нашем ходу) — не нужна.
- `acceptedMoves` обработка — не пишется.
- Hard-drop conditions ADR-041 §2.2.1 (`is_up_in_material`, `material_diff` для advantage) — **остаются** как есть. Они не зависят от forced-line, фильтруют шум независимо от подхода.

Добавляем:
- `samePv1` filter (drop если ход партии = PV1 движка из `analyzePositionWdl(fen_before, ...)`).
- `skipDecided` (`|wdlBeforeBlunder| > 0.95`).
- Solvability check (§2.3): после детекции зевка прогнать N полуходов Stockfish-vs-Stockfish, проверить, что `WDL_signed_for_solver ≥ failThreshold` всё время.
- `wdlAfterBlunder ≥ 0.5` фильтр (§2.4 решение по ничейным).
- Запись с `solutionMode='play-vs-engine'`, `moves=''`, `acceptedMoves=null`, заполнение `sourceMetadata` (§3.3).

### 6.2 Перенос экспериментальных оптимизаций

Из `apps/tactic-worker/src/cli/analyze-pgn.cli.ts` (research-CLI) и `stockfish.service.ts` (есть локальные правки backend'а):

| Оптимизация | Что переносим в продовый pipeline |
|---|---|
| `analyzePositionWdl(..., earlyStop)` callback | Уже в `stockfish.service.ts:217`. Использовать в pipeline для ранней остановки, когда PV1/PV2 уже спред-стабильны (см. ADR-041 §3.3). |
| `STOCKFISH_THREADS=1`, `STOCKFISH_POOL_SIZE=N` ENV | Уже в `stockfish.service.ts:99,76`. Документировать в README pipeline. |
| `STOCKFISH_LOG_TIMINGS` | Использовался в `analyze-pgn.cli.ts` для логирования времени per-position. Опциональный ENV — добавить в `stockfish.service.ts` (если ещё нет) для production-логов в pipeline. |
| `samePv1` / `skipDecided` логика | Сейчас в `analyze-pgn.cli.ts`. Переносится в `generator-pipeline.ts` как явные фильтры. |

### 6.3 Судьба `analyze-pgn.cli.ts`

**Оставляем** в репозитории как research-инструмент. Зарегистрирован subcommand'ом в `main.ts` (см. также `validate-etalons.cli.ts`, `dump-puzzles.cli.ts` — паттерн research-CLI принят).

Документировать в README пакета `apps/tactic-worker/README.md` (если нет — создать) как «инструмент калибровки порогов на одной партии», без production-deploy.

### 6.4 CLI-параметры

Существующий `generate-puzzles.cli.ts` расширяется флагами:

```
--solution-mode=play-vs-engine   default play-vs-engine (forced-line legacy, не запускать без явного флага)
--blunder-delta=0.6              X
--time-ms=1000                   stockfish limit
--half-moves-n=6                 N для solvability check и записи в sourceMetadata
--win-threshold=0.5
--fail-threshold=0.0
--skip-decided-wdl=0.95
--min-wdl-after-blunder=0.5      фильтр §2.4 (нечейные drop'аются)
```

Все стартовые значения — из этого ADR §2. Калибруются по результатам first-batch (chess-expert sample).

### 6.5 Бюджет CPU

По экстраполяции из §1.3 + накладные solvability-check'а:

| Объём | Время на 1 vCPU | На 4 vCPU (pool=5) | На 16 vCPU |
|---|---|---|---|
| 100 партий | ~10 мин | ~3 мин | ~50 сек |
| 1000 партий | ~85 мин (детекция) + ~2 мин (solvability) | ~25 мин | ~5 мин |
| 10000 партий | ~14 ч | ~3.5 ч | ~50 мин |

Daily-incremental на 500 партий — ~12 минут на 4 vCPU. Помещается в night-window с большим запасом.

После калибровки можно увеличить `time-ms` до 2000 без ущерба бюджету.

---

## 7. Метрики качества

### 7.1 Автоматические

- **Solvability rate**: `accepted / detected` (после §2.3). Ожидаемое: > 70%. Если ниже — порог `winThreshold` слишком жёсткий, мягчим.
- **Длина игры до решения**: распределение `halfMovesPlayed` пользователей. Если медиана < 2 — пазлы тривиальные, повышаем `failThreshold`. Если медиана = N (доходят до конца почти всегда) — нормально.
- **Winrate по сложности**: per-rating-bucket pass-rate. Ожидаемое — Glicko-стабилизация в районе 50% после 50 attempts.

### 7.2 Sample-test (chess-expert)

После первого batch'а 1000 партий → ожидается ~5000–10000 пазлов. Сэмпл для аудита:
- 30 случайных,
- 10 с `wdlAfterBlunder ∈ [0.5, 0.7]` (граничные),
- 10 эндшпильных (≤ 7 фигур),
- 10 с тегом `mateInN`.

Chess-expert по каждому: «учебный / проходной / drop». Если шум > 15% — обсуждаем причину (calibration `X`, `winThreshold`, `solvability check`). При шуме < 10% — публикуем `isPublic=true`, открываем для пользователей.

---

## 8. Декомпозиция на тикеты

Все тикеты создаются в статусе **To Do**, **без запуска**. Координатор передаёт команду пользователя, после чего тикеты подбираются исполнителями.

Префикс заголовка: **`[Puzzle play-vs-engine]`**.

### 8.1 Граф зависимостей и реальные ключи

```
KS-2462 (shared: PuzzleDto.solutionMode + playVsEngine)
   │
   ├──► KS-2463 (migration: Puzzle.solution_mode + index)
   │      │
   │      ├──► KS-2464 (backend pipeline: рефакторинг generator-pipeline)
   │      │      │
   │      │      └──► KS-2467 (devops batch на 1000 партиях)
   │      │             │
   │      │             └──► KS-2468 (chess-expert аудит 60 пазлов)
   │      │
   │      └──► KS-2465 (backend api: PuzzleDto + submit attempt)
   │             │
   │             └──► KS-2466 (frontend: PuzzlePage strategy.playVsEngine)
   │                    │
   │                    └──► KS-2469 (qa: e2e регресс + win/lose)
```

### 8.2 Тикеты — таблица

| Key | Assignee | Тема | Зависит от |
|---|---|---|---|
| KS-2462 | backend | shared `PuzzleDto.solutionMode` + `playVsEngine` | — |
| KS-2463 | backend | migration `puzzles.solution_mode` + index | KS-2462 |
| KS-2464 | backend | pipeline: убрать forced-line, добавить samePv1/skipDecided/solvability/wdlAfterBlunder ≥ 0.5 | KS-2462, KS-2463 |
| KS-2465 | backend | api: `PuzzleDto.playVsEngine` + submit-attempt fields | KS-2462, KS-2463 |
| KS-2466 | frontend | `PuzzlePage` strategy.playVsEngine + UI + eval-bar + progress | KS-2462, KS-2465 |
| KS-2467 | devops | research-batch на 1000 партиях, дамп 60 пазлов | KS-2463, KS-2464 |
| KS-2468 | chess-expert | аудит 60 пазлов, калибровка X/win/fail/N | KS-2467 |
| KS-2469 | qa | e2e: forced-line регресс + play-vs-engine win/lose | KS-2465, KS-2466 (желательно KS-2467+2468) |

### 8.3 Параллелизм

- Все тикеты — в **To Do**, без запуска. Координатор передаст команду пользователя на старт.
- KS-2462 — атомарный, делается один раз.
- KS-2463 + KS-2464 — последовательно: миграция перед pipeline (pipeline пишет в новую колонку).
- KS-2464 + KS-2465 — могут идти параллельно после KS-2463 (разные файлы).
- KS-2466 — может стартовать параллельно с KS-2464/KS-2465 на моках.
- KS-2467 — после KS-2464.
- KS-2468 — после KS-2467.
- KS-2469 — после KS-2466 + KS-2465 (с реальными пазлами после KS-2468).

---

## 9. Что НЕ делаем

- Не меняем `Puzzle.moves` семантику для существующих forced-line записей (Lichess + KS-2431 generated). Они продолжают играться как есть.
- Не вводим anti-cheat для play-vs-engine. WASM-Stockfish на клиенте, валидация локально. (Допустимый риск для puzzle-режима без денежных ставок.)
- Не вводим новых таблиц. `Puzzle` + новая колонка покрывают всё.
- Не меняем Glicko-2 / рейтинговую систему.
- Не пишем новые Lichess-лайк форсированные пазлы. Если в v2 захочется combine-режим — отдельный ADR.
- Не запускаем тикеты без команды пользователя.

---

## 10. Открытые вопросы

1. **Длина N**. Может быть по-разному для тактических vs эндшпильных позиций. MVP — фикс 6, обсуждаем по итогам chess-expert аудита.
2. **WDL-стабильность Stockfish 1s**. WDL на 1с может быть шумным (depth 18–22 не всегда хватает для сложных эндшпилей). После batch'а — анализ распределения `wdlAfterBlunder` по depth-bucket'ам, при необходимости поднять `time-ms` до 2000.
3. **Sound-эффекты для нового режима**. PuzzlePage сейчас использует `useSounds`. Реализация — стандартная, в рамках тикета 5; не требует ADR-решения.
4. **Mobile UX**. Eval-bar и progress на mobile — компактные. Детали layout в тикете 5 + при необходимости отдельный layout-тикет.
5. **Отдельная страница в архиве «попробовать пазл из своего зевка»**. Этап 3 ADR-041 (персональная генерация) остаётся в плане, но к новому режиму применяется буквально (тот же pipeline + UI). Не блокируется этим ADR.
