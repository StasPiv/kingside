# ADR-070 — Puzzle-gen: Elo-фильтр серверной генерации + двойной пазл (preventive/reactive) + унификация pipeline в shared

- Статус: Accepted
- Дата: 2026-05-20
- Связанные задачи: KS-3156 (этот аудит/план), KS-3140, KS-3145, KS-3148,
  KS-3149, KS-3150, KS-3152, KS-3157.
- Связанные ADR: ADR-068 (deltaW/deltaD, остаётся), ADR-069 (objective
  convertAdvantage/saveEquality, расширяется новой осью `puzzlePhase`),
  ADR-044 (play-vs-engine pivot, без изменений), ADR-050 (унификация
  генератора — этот ADR доводит унификацию до полного pipeline).
- Авторы: architect

---

## 1. Контекст

После KS-3140 (объединённый after-фильтр W+D ≥ 0.5) и KS-3145/KS-3149
(`objective: convertAdvantage | saveEquality`) puzzle-генератор имеет
ровно два жанра пазлов и общую формулу триггера. KS-3157 отключил
solvability-check на сервере по решению пользователя.

### 1.1 Текущее состояние кода

| Что | Где живёт | Дублируется? |
|---|---|---|
| Триггер блaндера (`deltaW/deltaD/W+D-after`) | `packages/shared/src/utils/puzzle-gen-core.ts:evaluateBlunder` | Нет (единая точка) |
| Определение objective | `packages/shared/.../determinePuzzleObjective` | Нет |
| Solvability-критерии | `packages/shared/.../{meetsSolvabilityFinal, holdsSolvabilityIntermediate}` | Нет |
| Замечание по WDL (`wdlSigned`, `wdlOrMateFallback`, `deltaW/DFromWdl`) | `packages/shared/src/utils/wdl.ts` | Нет |
| Replay PGN → собрать `PlyTask[]` | `apps/tactic-worker/.../generator-pipeline.ts` + `apps/web/src/utils/puzzleGenerator.ts` | **Да** |
| Цикл stage1..stage6 (pre/samePv1/gameOver/post/evaluateBlunder/...) | обе обёртки | **Да** |
| Создание `PuzzleRecord` + `sourceMetadata` | обе обёртки, разные структуры | **Да** |
| Elo-фильтр | server-only (`options.minRating`, default 1400 в `defaultGeneratorOptions`) | — |

### 1.2 Запрос пользователя

1. **Elo-фильтр для серверной генерации:** только партии, в которых
   **оба** игрока имеют Elo ≥ **2400**, дают пазлы (TWIC и др.). На
   клиенте — фильтра нет (пользователь генерит из своих партий,
   default 0 = пропускаем всех).

2. **Двойной пазл из одного зевка:** на каждый принятый кандидат
   генерится **два** пазла:
   - **Превентивный** (новое): `fen = fenBefore`, solver = зевнувший.
     Цель — найти правильный ход (не зевнуть). Objective —
     `convertAdvantage` если solver был в выигрыше до зевка (`W_before +
     D_before ≥ 0.5` и `W_before ≥ 0.5`), иначе `saveEquality`.
   - **Реактивный** (текущее поведение): `fen = fenAfter`, solver =
     противник. Цель — реализовать перевес/удержать ничью. Objective
     по `wdlAfterRaw` (как сейчас).

3. **Унификация pipeline в shared.** Полный поток
   (replay → pre/post-analyze → evaluateBlunder → build puzzles) в
   `packages/shared`. Server (`tactic-worker`) и client
   (`puzzleGenerator.ts`) — тонкие обёртки, отличающиеся только I/O
   (Stockfish-pool, БД, PGN-парсинг) и settings (`minPlayerElo`,
   user-tunable пороги на клиенте).

---

## 2. Решение

### 2.1 Полный pipeline в shared

Новый модуль `packages/shared/src/utils/puzzle-gen-pipeline.ts`
(рядом с `puzzle-gen-core.ts`). Содержит:

```ts
// === Контракты ===

/** Минимальный engine-adapter, который должны реализовать обе обёртки. */
export interface PuzzleGenEngine {
  /**
   * MultiPV-анализ позиции. Server-обёртка адаптирует свой
   * `EngineApi.analyzePositionWdl(fen, limit, multiPV, label)`,
   * client-обёртка — свой `EngineAdapter.analyze(fen, depth, multiPV,
   * movetimeMs)`. Возвращает массив строк PV (multipv=1..N) с
   * bestMove, wdl, score.
   */
  analyze(
    fen: string,
    multiPV: number,
    ctx?: { label?: string; signal?: AbortSignal },
  ): Promise<MultiPvLine[]>;
}

/** Replay-шаг — то, что нужно для анализа одного ply. */
export interface PlyStep {
  ply: number;                       // 1-based
  fenBefore: string;
  fenAfter: string;
  playedUci: string;
  isGameOverAfter: boolean;
  /** side-to-move в fenAfter = реактивный solver. */
  reactiveSolverSide: 'w' | 'b';
  /** side-to-move в fenBefore = превентивный solver (= блaндер). */
  preventiveSolverSide: 'w' | 'b';
}

/** Метаданные партии-источника. Заполняет обёртка из своего I/O. */
export interface GameMeta {
  sourceType: 'archive_game' | 'pgn_import';
  sourceId: string | null;
  whiteElo: number | null;
  blackElo: number | null;
  headers: Record<string, string>;   // Seven Tag Roster
}

/** Кандидат-зевок, прошедший evaluateBlunder. */
export interface BlunderCandidate {
  step: PlyStep;
  wdlBeforeRaw: Wdl;                 // POV блaндера до зевка
  wdlAfterRaw: Wdl;                  // POV реактивного solver после зевка
  deltaW: number;
  deltaD: number;
  trigger: BlunderTrigger;
  pv1BeforeUci: string;              // правильный ход зевнувшего (= ответ на превентивный пазл)
  firstMoveAfterUci: string;         // первый ход реактивного solver
}

/** Готовый абстрактный пазл — обёртка пишет в БД через свой адаптер. */
export interface GeneratedPuzzle {
  fen: string;
  sourceType: 'archive_game' | 'pgn_import';
  sourceId: string | null;
  sourceMoveNum: number;
  themes: string[];
  rating: number;
  solutionMode: 'play-vs-engine';
  /** Phase: 'preventive' (fenBefore) или 'reactive' (fenAfter). */
  puzzlePhase: 'preventive' | 'reactive';
  /** Objective (convertAdvantage / saveEquality) с учётом фазы. */
  objective: PuzzleObjective;
  /** Полная sourceMetadata-JSON для записи в БД (структура §3). */
  sourceMetadata: Record<string, unknown>;
}

/** Settings — расширенный BlunderEvalSettings + ELO-фильтр + фазы. */
export interface PuzzleGenSettings extends BlunderEvalSettings {
  /**
   * KS-3156 / ADR-070 §2.4. Минимальный Elo обоих игроков партии,
   * чтобы партия пошла в обработку. Default 0 = без фильтра (клиент).
   * Серверная обёртка передаёт 2400.
   */
  minPlayerElo: number;
  /** Минимальный ply начала поиска зевка. Default PUZZLE_GEN_DEFAULTS.startPly = 20. */
  startPly: number;
  /**
   * KS-3156 / ADR-070 §2.3. Включать ли превентивный пазл (fenBefore).
   * Default true (новое поведение). Если false — только реактивный
   * пазл, как до этого ADR. Используется для регресс-тестов и
   * совместимости со старыми CLI-флагами.
   */
  emitPreventivePuzzle: boolean;
  /**
   * KS-3156 / ADR-070 §2.3. Включать ли реактивный пазл (fenAfter).
   * Default true. Симметрично emitPreventivePuzzle.
   */
  emitReactivePuzzle: boolean;
}

// === Функции ===

/** Elo-фильтр партии. true если оба >= minPlayerElo. minPlayerElo=0 → пропускаем всех. */
export function passesPlayerEloFilter(
  whiteElo: number | null,
  blackElo: number | null,
  minPlayerElo: number,
): boolean;

/** chess.js loadPgn → массив PlyStep, отфильтрованный по startPly. */
export function replayPgnToSteps(
  pgn: string,
  startPly: number,
): { steps: PlyStep[]; headers: Record<string, string> } | { error: string };

/**
 * Анализ одного хода через переданный engine. Делает:
 *   1) pre-analyze (multiPV=2),
 *   2) samePv1 / gameOver pre-checks,
 *   3) post-analyze (multiPV=2),
 *   4) evaluateBlunder → accept/reject.
 *
 * Возвращает либо BlunderCandidate, либо причину drop'а (для
 * stats обёртки).
 */
export async function analyzePlyForBlunder(
  step: PlyStep,
  engine: PuzzleGenEngine,
  settings: BlunderEvalSettings,
): Promise<
  | { kind: 'accepted'; candidate: BlunderCandidate }
  | { kind: 'rejected'; reason: AnalyzePlyRejectReason; deltaW?: number; deltaD?: number }
>;

export type AnalyzePlyRejectReason =
  | 'samePv1' | 'gameOver' | 'noScore' | 'engineError'
  | 'notBlunder' | 'lowWplusDAfter';

/**
 * KS-3156 / ADR-070 §2.3. Кандидат → 1 или 2 пазла. Алгоритм:
 *
 *   1) Если settings.emitReactivePuzzle:
 *        objective_r = determinePuzzleObjective(wdlAfterRaw)
 *        push реактивный пазл (fen = step.fenAfter, phase = 'reactive',
 *        solverSide = step.reactiveSolverSide)
 *
 *   2) Если settings.emitPreventivePuzzle И (wdlBeforeRaw.w +
 *        wdlBeforeRaw.d) / 1000 >= 0.5  (зевнувший до зевка не
 *        проигрышен — есть что «спасать»):
 *        objective_p = (wdlBeforeRaw.w / 1000 >= 0.5) ? 'convertAdvantage' : 'saveEquality'
 *        push превентивный пазл (fen = step.fenBefore, phase =
 *        'preventive', solverSide = step.preventiveSolverSide,
 *        ответ = candidate.pv1BeforeUci)
 *
 * Дедуп между фазами не нужен: fenBefore ≠ fenAfter всегда (применили
 * легальный ход). Дедуп с уже сохранёнными пазлами — на БД через
 * UNIQUE(fen) + skipDuplicates.
 */
export function buildPuzzlesFromCandidate(
  candidate: BlunderCandidate,
  gameMeta: GameMeta,
  settings: PuzzleGenSettings,
): GeneratedPuzzle[];

/**
 * Главный entry-point: обработать одну партию целиком. Обёртка передаёт
 * pgn + engine + callbacks для логирования/прогресса/инсёрта.
 * Внутри: replayPgnToSteps → для каждого step analyzePlyForBlunder →
 * для каждого accepted buildPuzzlesFromCandidate. Возвращает
 * статистику и список GeneratedPuzzle'ов.
 *
 * Параллелизм между ply внутри партии (Promise.all pre-analyze,
 * Promise.all post-analyze) — реализуется обёрткой через engine
 * concurrent behavior (server: Stockfish-pool, client: один WASM).
 * Shared не диктует параллельность.
 */
export async function processGameForPuzzles(args: {
  pgn: string;
  gameMeta: GameMeta;
  engine: PuzzleGenEngine;
  settings: PuzzleGenSettings;
  onProgress?: (s: { ply: number; total: number }) => void;
  abortSignal?: AbortSignal;
}): Promise<{
  puzzles: GeneratedPuzzle[];
  stats: { positionsAnalyzed: number; drops: Record<AnalyzePlyRejectReason, number> };
}>;
```

Аргументы за такой раскрой:

- **Engine-абстракция (`PuzzleGenEngine.analyze`)** — единственная точка
  I/O в shared. Server делает adapter из `EngineApi.analyzePositionWdl(...,
  limit, multiPV, label)`, client — из `EngineAdapter.analyze(fen, depth,
  multiPV, movetimeMs)`. `multiPV` — единственный обязательный
  параметр; engine-specific параметры (`limit`/`depth`/`movetimeMs`)
  захватываются внутри adapter'а замыканием.
- **`processGameForPuzzles`** — самый высокий уровень. Обёртке остаётся
  только: получить pgn (БД-row / textarea), построить `engine` adapter,
  передать settings, вернуть puzzles в БД через свой insert-callback.
- **Параллелизм** — отдельная забота обёртки (server: между партиями
  через `GAME_CONCURRENCY`, между ply через Stockfish-pool; client:
  последовательно через один WASM). Shared делает Promise.all внутри
  одной партии — но реальная конкуррентность ограничивается тем, что
  отдаёт engine.

### 2.2 Elo-фильтр

Пользователь требует **жёстко 2400 на сервере** и **0 на клиенте**.

- В `PuzzleGenSettings` поле `minPlayerElo`. Default в
  `PUZZLE_GEN_DEFAULTS.minPlayerElo` = **0** (клиентское поведение —
  default).
- Сервер (`apps/tactic-worker`) в своей обёртке передаёт
  `minPlayerElo: 2400`. Это **не CLI-флаг**, а константа в коде
  (так же, как `HARD_DELTA_W = 0.6`). Запрос явный: «не регулируется
  через ENV / CLI».
- Фильтр применяется **до анализа партии** в обёртке:
  ```ts
  if (!passesPlayerEloFilter(row.white_elo, row.black_elo, settings.minPlayerElo)) {
    stats.skippedByEloFilter++;
    return;
  }
  ```
- Если одного из Elo нет (`null`), партия **отбрасывается** при
  `minPlayerElo > 0` (нет данных = не можем гарантировать качество).
  При `minPlayerElo = 0` — пропускаем (клиент).
- Старое поле `options.minRating: number = 1400` (server-only) в
  `defaultGeneratorOptions` — **deprecated**, переходим на единое
  имя `minPlayerElo`. Если в server-CLI остаются обращения к
  `--min-rating`, parseArgs мапит его на `minPlayerElo` для
  совместимости (одноразовый переходный алиас).

### 2.3 Двойной пазл

Алгоритм в `buildPuzzlesFromCandidate` (см. §2.1):

| Поле | Превентивный (новое) | Реактивный (текущее) |
|---|---|---|
| `fen` | `step.fenBefore` | `step.fenAfter` |
| `solverSide` | `step.preventiveSolverSide` (= блaндер) | `step.reactiveSolverSide` (= противник) |
| `puzzlePhase` | `'preventive'` | `'reactive'` |
| `objective` | по `wdlBeforeRaw.w/1000`: ≥ 0.5 → convertAdvantage, иначе saveEquality | `determinePuzzleObjective(wdlAfterRaw)` |
| Правильный ход (для UI / телеметрии) | `candidate.pv1BeforeUci` (PV1 до зевка) | `candidate.firstMoveAfterUci` (PV1 после зевка) |
| `sourceMoveNum` | `step.ply` | `step.ply` |
| Pre-filter | `(wdlBeforeRaw.w + wdlBeforeRaw.d) / 1000 ≥ 0.5` — иначе позиция и так проигрышная для зевнувшего, превентивный пазл бессмыслен (нечего «не зевать») | (нет — after-фильтр evaluateBlunder уже гарантировал W+D ≥ 0.5 для реактивного solver) |

**Защитный pre-filter для превентивного** обоснован:

- если зевнувший в позиции `W=0.05, D=0.0, L=0.95` (уже проигрывает),
  любой его ход — не «зевок» с пользой для обучения. evaluateBlunder
  пропустит такие случаи через `lowWplusDAfter`-фильтр на реактивной
  стороне, но превентивная сторона имеет собственный fenBefore: до
  зевка тоже могло быть проигрышно (мы могли упустить выигрыш
  *раньше*, ещё до этого хода). Не делать пазл «не упустите проигранную
  позицию ещё больше».

**Дедуп:** fenBefore ≠ fenAfter после применения легального хода.
`puzzles.fen UNIQUE` индекс + `skipDuplicates:true` — стандарт. Никакой
доп. логики не нужно.

**Метаданные** — общие на оба пазла внутри пары (одна и та же партия,
тот же ply, тот же зевочный ход):

```jsonc
{
  "blunderMove": "d5d6",                  // UCI зевка
  "fenBeforeBlunder": "<step.fenBefore>", // на UI для рендера SAN
  "wdlBefore": { w, d, l },               // raw POV блaндера
  "wdlAfter":  { w, d, l },               // raw POV реактивного solver
  "wdlBeforeBlunder": <signed POV блaндера>,  // legacy compat
  "wdlAfterBlunder":  <signed POV реактивного solver>,
  "deltaW": 0.952,
  "deltaD": 0.0,
  "blunderTrigger": "W",
  "objective": "<convertAdvantage|saveEquality>",  // фаза-specific
  "puzzlePhase": "<preventive|reactive>",          // NEW
  "halfMovesN": 6, "winThreshold": 0.5, "failThreshold": 0.0,
  "depth": 18,
  // только для превентивного: PV1, который игроку нужно найти,
  // как «правильный ответ» в hint/check (UI потом валидирует).
  "preventiveCorrectMoveUci": "<pv1BeforeUci>"     // только при phase=preventive
}
```

`puzzlePhase` хранится в:
1. `sourceMetadata.puzzlePhase` (JSON) — для DTO и UI.
2. **Тег в `themes`** (`preventive` / `reactive`) — для будущей
   фильтрации через существующий `?themes=…` LIKE-механизм. (Фильтр-UI
   по фазе пока не делаем; тег пишем сразу, чтобы потом не пересчитывать.)

**Никакой миграции БД не требуется** — оба поля живут в JSON и
TEXT-list тегов.

### 2.4 Что меняется в обёртках

**`apps/tactic-worker/src/puzzle-generator/generator-pipeline.ts`** —
становится тонкой обёрткой:

```ts
// Адаптер EngineApi → PuzzleGenEngine
function makeServerEngine(engine: EngineApi, gameId: string, limit: AnalysisLimit): PuzzleGenEngine {
  return {
    analyze: (fen, multiPV, ctx) =>
      engine.analyzePositionWdl(fen, limit, multiPV, ctx?.label ?? `g=${gameId}`),
  };
}

// Settings: minPlayerElo=2400 hardcoded, остальные пороги — те же HARD_*
const SERVER_SETTINGS: PuzzleGenSettings = {
  ...PUZZLE_GEN_DEFAULTS,
  deltaWThreshold: HARD_DELTA_W,
  deltaDThreshold: HARD_DELTA_D,
  minWPlusDAfterForSolver: HARD_MIN_WD_AFTER,
  minPlayerElo: 2400,           // ← новое
  emitPreventivePuzzle: true,    // ← новое (двойной пазл)
  emitReactivePuzzle: true,
  startPly: PUZZLE_GEN_DEFAULTS.startPly,
};

// processGame(row, options, stats):
//   1) passesPlayerEloFilter — если false, return early.
//   2) processGameForPuzzles(pgn, gameMeta, engine, SERVER_SETTINGS).
//   3) Для каждого GeneratedPuzzle вызвать options.insertPuzzle с
//      адаптированной PuzzleRecord (PuzzleRecord = GeneratedPuzzle +
//      id, ratingDev, depth, isPublic=true, themes-join-string).
```

Stockfish-pool параллелизм (`GAME_CONCURRENCY`, Promise.all по pre/post
внутри партии) остаётся **в обёртке**: shared делает анализ ply
последовательно, обёртка может либо обернуть `engine.analyze` через
очередь, либо группировать ply pre/post вне shared. Простейший
вариант: shared `analyzePlyForBlunder` делает свой pre+post внутри
последовательно, обёртка параллелит между ply снаружи (через
`processGameForPuzzles` принимает массив step'ов с `Promise.all(steps.map(...))`).

**Альтернатива:** shared даёт «split-API» (отдельно `prefetchPreWdl(steps)`,
`prefetchPostWdl(steps)`, `evaluateAll(steps, preMap, postMap)`), а
обёртка решает, как параллелить. Это более гибко и сохраняет stage-based
структуру server-кода. **Берём этот вариант** — он минимизирует
изменения в server-обёртке.

**`apps/web/src/utils/puzzleGenerator.ts`** — аналогичная тонкая
обёртка:

```ts
function makeClientEngine(engine: EngineAdapter, depth: number, movetimeMs: number): PuzzleGenEngine {
  return {
    analyze: (fen, multiPV, ctx) =>
      engine.analyze(fen, depth, multiPV, movetimeMs).then(r => r.lines).then(adaptLines /* InfoLine → MultiPvLine */),
  };
}

// Settings: minPlayerElo=0 (default клиента), пороги — из user-controls.
const settings: PuzzleGenSettings = {
  ...PUZZLE_GEN_DEFAULTS,
  ...userSettings,
  minPlayerElo: 0,
  emitPreventivePuzzle: true,
  emitReactivePuzzle: true,
};

// Один цикл по splitPgnIntoGames → processGameForPuzzles → push.
```

Клиентский solvability-check (`solvabilityCheck: true`) — отдельный
post-step, делается обёрткой между accept и pre-puzzle-creation.
Shared в этой задаче solvability не делает (он уже отключён на server,
и есть отдельные shared helper'ы `meetsSolvabilityFinal` /
`holdsSolvabilityIntermediate`, которые обёртка вызывает напрямую).

### 2.5 API: `puzzle.service.ts:resolveSolutionMode`

Расширить чтение `sourceMetadata`:

```ts
const puzzlePhase =
  meta.puzzlePhase === 'preventive' || meta.puzzlePhase === 'reactive'
    ? meta.puzzlePhase
    : 'reactive'; // legacy fallback — старые пазлы все «реактивные»
```

В DTO `PlayVsEngineDto` добавить опц. поле `puzzlePhase?:
'preventive' | 'reactive'`. UI его не использует прямо сейчас — это
задел для будущего бэджа/фильтра.

---

## 3. Совместимость

### 3.1 С ADR-068 (deltaW/deltaD)

Без изменений. `evaluateBlunder` остаётся единым триггером, settings
и thresholds — те же.

### 3.2 С ADR-069 (objective)

Расширяется новой осью `puzzlePhase`. Полная матрица:

| puzzlePhase | objective | Смысл |
|---|---|---|
| `reactive` | `convertAdvantage` | «Накажи зевок — реализуй перевес» (текущее convert) |
| `reactive` | `saveEquality` | «Накажи зевок — удержи ничью» (текущее save) |
| `preventive` | `convertAdvantage` | «Не упусти выигрыш» (зевнувший был в W ≥ 0.5) |
| `preventive` | `saveEquality` | «Не упусти ничью» (зевнувший был в W < 0.5, но W+D ≥ 0.5) |

UI-текст и иконка зависят от пары (phase, objective). Сейчас UI
зависит только от objective; новые случаи через F2/F3 (опц. follow-up).

### 3.3 С KS-3156 (solvability fix)

Solvability-критерии (`meetsSolvabilityFinal`,
`holdsSolvabilityIntermediate`) уже в shared и принимают `objective`.
В новом pipeline обёртка вызывает их **отдельно** на каждой фазе:

- Для `reactive`: solverSide = противник, objective из wdlAfter — как
  сейчас.
- Для `preventive`: solverSide = зевнувший, objective из wdlBefore.
  Solvability-чек на preventive — это «может ли зевнувший удерживать
  W+D / signed после правильного хода». Полезно при `solvabilityCheck=true`
  на клиенте; на сервере solvability выключен (KS-3157), так что для
  server это вопрос не стоит.

KS-3156 не сломаем — те же shared helper'ы, тот же контракт.

### 3.4 Legacy-пазлы в БД

- Все существующие play-vs-engine пазлы без `puzzlePhase` в meta.
- Backend `resolveSolutionMode` fallback'ом возвращает `puzzlePhase:
  'reactive'` (старый алгоритм генерил только из fenAfter).
- Фильтр UI по фазе (если будет) — `preventive` теги встречаются
  только у новых пазлов; legacy не попадают (`?themes=preventive`
  даст пустой результат для legacy). Это приемлемо.

### 3.5 Дедуп / UNIQUE

`puzzles.fen UNIQUE` — старый индекс. При двух новых пазлах из одного
зевка `fenBefore ≠ fenAfter` всегда (легальный ход меняет позицию).
Между разными партиями возможны коллизии (одна и та же транспозиция)
— `skipDuplicates:true` молча пропустит. Никаких новых индексов не
требуется.

---

## 4. Декомпозиция на тикеты

| Ключ | Кто | Summary |
|---|---|---|
| **A1** | architect | ADR-070 + правка ADR-068/069 (cross-link). **Выполнено этим коммитом.** |
| **S1** | backend | Shared: новый модуль `packages/shared/src/utils/puzzle-gen-pipeline.ts` с типами `PuzzleGenEngine`, `PlyStep`, `GameMeta`, `BlunderCandidate`, `GeneratedPuzzle`, `PuzzleGenSettings` + функциями `passesPlayerEloFilter`, `replayPgnToSteps`, `analyzePlyForBlunder`, `buildPuzzlesFromCandidate`, `processGameForPuzzles`. Расширение `PUZZLE_GEN_DEFAULTS` полем `minPlayerElo: 0`. Тесты на каждую функцию. `npm run build` shared. |
| **B1** | backend | tactic-worker: `apps/tactic-worker/src/puzzle-generator/generator-pipeline.ts` переписать как тонкую обёртку над shared (server engine adapter, `SERVER_SETTINGS` с `minPlayerElo: 2400`, `emitPreventivePuzzle: true`). Stage1..6 stage-based код упрощается: replay+headers через `replayPgnToSteps`, evaluateBlunder через `analyzePlyForBlunder`, build через `buildPuzzlesFromCandidate`. Stockfish-pool параллелизм между партиями + между ply остаётся. `generate-puzzles.cli.ts` — `--min-rating` → алиас на `minPlayerElo` (`PuzzleGenSettings`). `generate-puzzles-from-twic.cli.ts` — наследует. Spec'и обновить (`generator-pipeline.spec.ts`, `generate-puzzles-from-twic.cli.spec.ts`). |
| **B2** | backend | api: `apps/api/src/puzzle/puzzle.service.ts:resolveSolutionMode` — чтение `meta.puzzlePhase` с fallback на `'reactive'`. В `PlayVsEngineDto` (`packages/shared/src/types/puzzle.ts`) — опц. поле `puzzlePhase?: 'preventive' \| 'reactive'`. Spec обновить (`puzzle.service.spec.ts`). |
| **F1** | frontend | client `apps/web/src/utils/puzzleGenerator.ts` — переписать как тонкую обёртку над shared (client engine adapter, settings с `minPlayerElo: 0`, `emitPreventivePuzzle: true`, `emitReactivePuzzle: true`). Локальный stage-based цикл удалить — он теперь в `processGameForPuzzles`. Solvability-check на клиенте остаётся отдельным post-step через `meetsSolvabilityFinal`/`holdsSolvabilityIntermediate` (уже в shared). Тесты `puzzleGenerator.test.ts` — проверить, что на одном зевке возвращаются ДВА пазла (`puzzlePhase: 'preventive'` + `'reactive'`), fenBefore ≠ fenAfter, objective-pair корректный. |
| **D1** | devops | После деплоя B1 — прогнать `generate-puzzles-from-twic` на одном TWIC issue с дефолтным `minPlayerElo=2400` и проверить: (a) только Elo≥2400 партии заходят (см. `skippedByEloFilter` в логе обёртки), (b) на каждый принятый зевок 2 пазла (`preventive` + `reactive`) с разными FEN'ами, (c) legacy-пазлы через `/puzzles` и `/precision` отдают `puzzlePhase: 'reactive'` (fallback). Если QA-окружения нет — pre-prod проверка локально через `dry-run` CLI. |

**Опциональные follow-up (вне scope этого ADR):**

| Ключ | Кто | Summary |
|---|---|---|
| F2 (опц.) | frontend | UI badge «Preventive / Reactive» в карточке пазла + summary. i18n en+ru. |
| F3 (опц.) | frontend | Фильтр-чип по фазе в `PuzzleBrowserPage.THEME_FILTER_WHITELIST` (`preventive`, `reactive`). |
| M1 (опц.) | backend | Денормализованная колонка `puzzles.puzzle_phase TEXT` + миграция + индекс. Полезно если фильтр по фазе станет нагрузочно частым. Текущий механизм через `themes` LIKE достаточен для MVP. |

### 4.1 Порядок

```
A1 (architect)    ──► merge сразу (этот коммит)
                        │
S1 (shared)       ──► merge ПЕРВЫМ — B1/B2/F1 импортируют типы и функции
                        │
B1 (backend gen)  ──┐
B2 (backend api)  ──┤ — параллельно после S1
F1 (frontend gen) ──┘
                        │
D1 (devops/qa)    ──► после B1/B2 на staging/prod
```

S1 — синхронный блокер. B1/B2/F1 — параллелятся.

### 4.2 Деплой и риски

- B1 меняет server-генерацию: после деплоя количество пазлов **может
  упасть** (Elo ≥ 2400 — узкая выборка) и **может вырасти** (на каждый
  принятый зевок 2 пазла). Чистая дельта зависит от состава TWIC.
  Логи `skippedByEloFilter` + `puzzlesGenerated` дают ответ.
- B2 — чистое расширение DTO, обратная совместимость full (опц. поле).
- F1 — клиентская генерация поведенчески меняется: один зевок → два
  пазла. UI готов (`/precision/?mine=true&visibility=draft` покажет
  оба, фильтрация по теме `convertAdvantage`/`saveEquality` работает
  как раньше).
- D1 проверяет реальное распределение Elo в текущей TWIC БД (если
  доминируют GM-партии — выборка широкая; если много 2300- партий —
  поток пазлов резко уменьшится). Если поток падает критически (например,
  до < 50 пазлов с одного TWIC issue) — повод подумать о снижении
  `minPlayerElo` до 2300 или 2200; пока ставим **2400 как
  фиксированную константу** по запросу пользователя.

---

## 5. Acceptance ADR-070

- [x] Этот документ создан в `docs/adr/070-puzzle-gen-elo-filter-and-dual-puzzle.md`.
- [x] ADR-068 §3.2 — cross-link с ADR-070 (двойной пазл расширяет
  pipeline после accept). Делается этим же коммитом.
- [x] ADR-069 §3 — cross-link с ADR-070 (новая ось `puzzlePhase`,
  матрица 2×2 фаза×objective). Делается этим же коммитом.
- [ ] Тикеты S1, B1, B2, F1, D1 заведены координатором по списку §4
  (architect код не правит).
