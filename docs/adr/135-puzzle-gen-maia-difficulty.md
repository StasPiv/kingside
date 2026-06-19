# ADR-135: Переход puzzle-generator на Maia-difficulty trigger

Связанные тикеты: KS-4337.
Связанные ADR: 044, 068, 069, 070, 104, 106, 124.

## 1. Контекст

Текущий генератор пазлов (ADR-068/070) ищет **зевки в партии**: сравнивает ход партии с PV1 Stockfish, требует падение `deltaW` или `deltaD` ≥ 0.6 и after-фильтр `W+D ≥ 0.5`. На один зевок строит до двух пазлов — `reactive` (наказать) и `preventive` (избежать).

Прототип в `/tmp/run-combined.mjs` у backend сменил концепцию. Триггер пазла больше **не привязан к ошибке в партии**. На любом ply ≥ 20 ищем позицию, где:

* единственный сильный ход на двух проходах Stockfish (предварительный и верифицирующий) — `|strongSet| = 1` (все остальные ходы хуже на `> EPS_EQUIV = 0.02` expected score),
* Maia-3 на ELO 2400 даёт этому ходу policy < 10 % — то есть человеку 2400 трудно увидеть его,
* лучший ход не проигрывает (`L ≤ 0.5`),
* зазор по expected score между лучшим и вторым `≥ 0.2`,
* лучший ход на обоих проходах совпадает.

Цель пазла теперь — **«найди единственный сильный ход в трудной позиции»**, без жанров «реализуй перевес»/«спасение» как структурного разделения reactive/preventive. Backend утвердил концепцию с пользователем.

Параметры прототипа (на трёх партиях SF18, 1 поток):

| Параметр | Значение | Назначение |
|---|---|---|
| `START_PLY` | 20 | Отсечь дебютную теорию |
| `SF_MAIN_NODES` | 1 000 000 | Бюджет main pass (дешёвый отсев) |
| `SF_VERIFY_NODES` | 10 000 000 | Бюджет verify pass (защита от артефактов main) |
| `SF_MULTIPV` | 10 | Глубина поиска альтернатив |
| `MAIA_ELO` | 2400 | Целевая аудитория |
| `EPS_EQUIV` | 0.02 | Что считается «эквивалентным» лучшему по E |
| `DIFFICULTY_MIN` | 0.9 | Σ policy[strongSet] < 0.1 |
| `LOSE_MAX` | 0.5 | Лучший ход не должен проигрывать |
| `GAP_MIN` | 0.2 | bestE − secondE |

В проекте уже есть **вся необходимая Maia-инфраструктура**:

* `@kingside/maia-core` — `Maia.predictMoves(fen, elo, elo) → { policy }`, провайдер ONNX-runtime для Node;
* `MaiaAnnotationService` в `apps/tactic-worker/src/maia/maia-annotation.service.ts` — singleton-обёртка с lazy-init, kill-switch при ошибке загрузки;
* модель `tools/maia3/maia3_simplified.onnx`, ENV `PRECISION_MAIA_MODEL_PATH`, путь, конфиг;
* `expectedScoreFromWdl(wdl)` в shared — формула E из прототипа уже есть.

Сейчас Maia используется только для **post-аннотации** уже созданных PVE-пазлов (`maiaWeakChoiceProb`, ADR-106). После ADR-135 Maia становится частью триггера генерации, а не пост-аннотации.

## 2. Решение

### 2.1. Контракты типов в `packages/shared`

Файл `src/utils/puzzle-gen-pipeline.ts` — добавляем параллельный pipeline. Старый (blunder) **остаётся** до полного перехода — нужен для отката и клиентского генератора (`PuzzleGeneratorModal`, ADR-070).

Новые сущности (новый файл `src/utils/puzzle-gen-maia.ts`):

```ts
export interface MaiaDifficultySettings {
  startPly: number;             // 20
  sfMainNodes: number;          // 1_000_000
  sfVerifyNodes: number;        // 10_000_000
  sfMultiPv: number;            // 10
  maiaElo: number;              // 2400
  epsEquiv: number;             // 0.02
  difficultyMin: number;        // 0.9
  loseMax: number;              // 0.5
  gapMin: number;               // 0.2
}

/** Один сильный ход с метриками. */
export interface MaiaDifficultyCandidate {
  ply: number;
  fen: string;                  // позиция-кандидат (она же FEN пазла)
  solverSide: 'w' | 'b';        // = side-to-move в fen
  bestMoveUci: string;
  bestE: number;
  secondE: number;
  gap: number;                  // bestE - secondE
  wdl: { w: number; d: number; l: number } | null;
  difficulty: number;           // 1 - Σ policy[strongSet] (на main pass)
  mainPassMaxDepth: number;
  verifyPassMaxDepth: number;
}

export type MaiaDifficultyRejectReason =
  | 'gameOver'
  | 'engineError'
  | 'noEngineLines'
  | 'notUniqueStrongMain'
  | 'maiaInferenceFailed'
  | 'maiaLowDifficulty'
  | 'notUniqueStrongVerify'
  | 'bestMoveMismatch'
  | 'bestMoveLoses'
  | 'gapTooSmall';

export interface MaiaPolicySource {
  /** Совместимо с Maia.predictMoves сигнатурой. */
  predictMoves(fen: string, eloW: number, eloB: number):
    Promise<{ policy: Array<{ move: string; probability: number }> }>;
}

/** Adapter к Stockfish, отдающий expected score E на каждую PV. */
export interface MaiaSfEngine {
  analyze(fen: string, multiPV: number, nodes: number, ctx?: {
    label?: string;
    signal?: AbortSignal;
  }): Promise<{ lines: Array<{ move: string; E: number; wdl: Wdl | null }>;
                maxDepth: number }>;
}

export async function analyzePlyForMaiaDifficulty(
  step: PlyStep,
  sf: MaiaSfEngine,
  maia: MaiaPolicySource,
  settings: MaiaDifficultySettings,
): Promise<
  | { kind: 'accepted'; candidate: MaiaDifficultyCandidate }
  | { kind: 'rejected'; reason: MaiaDifficultyRejectReason }
>;

export function buildPuzzleFromMaiaCandidate(
  candidate: MaiaDifficultyCandidate,
  gameMeta: GameMeta,
): GeneratedPuzzle;
```

`PlyStep` переиспользуем из текущего pipeline (нужно `fen`/`ply` и индикатор `isGameOver`). Поля `fenAfter`/`reactiveSolverSide` остаются ненужными для нового алгоритма — pipeline берёт только `fenBefore` и не делает применения хода партии.

`GeneratedPuzzle` остаётся существующим типом, но новые пазлы заполняют его иначе:

* `fen` = позиция-кандидат (то есть `fenBefore` ply из партии-источника);
* `solverSide` = side-to-move в `fen`;
* `solutionMode: 'play-vs-engine'` — без изменений;
* `puzzlePhase: 'preventive'` — **технический маркер для совместимости с UI** (`PlayVsEngineRunner` сейчас по этому тегу выбирает ветку «solver играет ВМЕСТО зевка»; новые пазлы используют тот же UX);
* `objective` определяется по WDL solver на `fen`: `wdl.w / 1000 >= 0.5 ? 'convertAdvantage' : 'saveEquality'`;
* `themes` = `['playVsEngine', objective, 'maia-difficulty', ...drillTags]` — **тег `reactive` уходит**; новый маркер `maia-difficulty` отличает алгоритм-источник;
* `sourceMetadata` — новая форма (см. §2.3).

Уходят (для нового пайплайна; в shared остаются ради клиента и legacy):

* `BlunderEvalInput/Settings/Result/Trigger/RejectReason`,
* `analyzePlyForBlunder` (в новом не используется),
* `buildPuzzlesFromCandidate` (новый pipeline вызывает другую функцию),
* двойственность reactive/preventive,
* `meetsSolvabilityFinal`/`holdsSolvabilityIntermediate` — у нового алгоритма нет solvability-прогона (`halfMovesN`-режим), доказательство сильной позиции делается на verify pass.

### 2.2. Pipeline в tactic-worker

`apps/tactic-worker/src/puzzle-generator/generator-pipeline.ts` — добавляем ветку выбора по `options.algorithm`.

```
algorithm = 'maia-difficulty'      (default после миграции)
algorithm = 'blunder'              (legacy, для отката / клиент-режима)
```

Новая ветка `processGame` (псевдокод):

```
replayPgnToSteps(pgn, startPly)            # тот же из shared
for step in steps (last 100 ply max):
    if step.isGameOverAfter: drop gameOver
    main = sf.analyze(step.fenBefore, MULTIPV, MAIN_NODES,
                       label='ply=N stage=main')
    if main.lines == 0: drop noEngineLines
    mainBestE = max(E)
    mainStrong = [L | mainBestE − L.E ≤ EPS_EQUIV]
    if |mainStrong| ≠ 1: drop notUniqueStrongMain

    maia = await maiaProvider.predictMoves(fenBefore, MAIA_ELO, MAIA_ELO)
    strongProb = Σ policy[m] for m ∈ mainStrong
    difficulty = 1 − strongProb
    if difficulty ≤ DIFFICULTY_MIN: drop maiaLowDifficulty

    verify = sf.analyze(step.fenBefore, MULTIPV, VERIFY_NODES,
                         label='ply=N stage=verify')
    if verify.lines == 0: drop noEngineLines
    vBestE = max(E)
    vStrong = [L | vBestE − L.E ≤ EPS_EQUIV]
    if |vStrong| ≠ 1: drop notUniqueStrongVerify
    if vStrong[0].move ≠ mainStrong[0].move: drop bestMoveMismatch

    bestL = wdl.l/1000 (fallback по E)
    if bestL > LOSE_MAX: drop bestMoveLoses

    second = sortBy(E desc)[1].E or 0
    gap = vBestE − second
    if gap < GAP_MIN: drop gapTooSmall

    accept → MaiaDifficultyCandidate
    insert via buildPuzzleFromMaiaCandidate + adaptGeneratedPuzzleToRecord
```

**Maia singleton** — переиспользуем `MaiaAnnotationService.getEngine()` рефакторингом в `MaiaPolicyProvider` (выделить общий слой, чтобы и аннотация, и генерация делили один ONNX-session per process). Альтернатива (минимум кода): ввести `MaiaPolicyProviderModule`, в котором `Maia` создаётся один раз и инжектится в оба места.

**Adapter SF → MaiaSfEngine.** Текущий `EngineApi.analyzePositionWdl(fen, limit, multiPV, label)` принимает `AnalysisLimit = { timeMs?, depth?, nodes? }`. Нужен путь `nodes` (он уже поддерживается в `StockfishService` — проверить под `go nodes`). Adapter переводит `lines` → `{move, E = expectedScoreFromWdl(wdl) || fallback, wdl}` через `wdlOrMateFallback` + `expectedScoreFromWdl` из shared.

**Бюджет ресурсов на партию.** Прикидка:

* партия ≈ 50 ply ≥ 20 → 50 итераций;
* main pass: 1 SF-вызов 1M nodes MultiPV=10 на 1 поток → 0.3–2 с (зависит от позиции и nps);
* Maia inference: 10–30 мс;
* доля кандидатов, доходящих до verify, ≈ 5–10 % после `|strongSet|=1 + difficulty > 0.9`;
* verify pass: 1 SF-вызов 10M nodes MultiPV=10 → 5–20 с.

Средняя партия: 50 × ~1 с (main+maia) + 3–5 × ~10 с (verify) = **80–150 с / партия / SF-поток**. При `GAME_CONCURRENCY=8` на 8-thread VPS ≈ **10–20 с / партия эффективно**. На 50 000 TWIC-партий: 7–28 часов. Цифры стартовые — реальная скорость проверяется на smoke-прогоне 100–500 партий (T4).

**Куда уходят отбракованные.** `GeneratorStats.drops` расширяется новыми ключами (см. список выше). Категорные счётчики уже инфраструктурно поддержаны (`bumpDrop`, `logProgress`); ничего нового кроме перечисления случаев.

### 2.3. Схема БД (Prisma)

Существующая таблица `puzzles` сохраняется; **никакие колонки не удаляются**.

Добавляем (миграция `puzzles_add_maia_difficulty`):

```sql
ALTER TABLE puzzles
  ADD COLUMN maia_difficulty Float NULL,
  ADD COLUMN gen_algorithm   VARCHAR(32) NULL;
CREATE INDEX puzzles_solution_mode_maia_difficulty_idx
  ON puzzles (solution_mode, maia_difficulty);
CREATE INDEX puzzles_gen_algorithm_idx
  ON puzzles (gen_algorithm) WHERE gen_algorithm IS NOT NULL;
```

Семантика:

* `maia_difficulty` Float? — значение `1 − strongProb` на main pass. **Отдельное поле от `maia_weak_choice_prob`**: метрики близки, но рассчитываются по-разному (weak\_choice ограничен Maia-TopK с policy > 0.10, difficulty считается по `strongSet` из SF). Совмещение в одной колонке исказит фильтрацию /precision (ADR-106 §2.6).
* `gen_algorithm` String? — маркер источника пазла: `'maia-difficulty-v1'` для новых, NULL для всех старых (legacy lichess и blunder-generated). Дополнительно дублируется в `source_metadata.algorithm` для дебага.

`source_metadata` для новых пазлов:

```json
{
  "algorithm": "maia-difficulty-v1",
  "bestMovePV1": "e2e4",
  "bestE": 0.83,
  "secondE": 0.41,
  "gap": 0.42,
  "wdl": { "w": 800, "d": 150, "l": 50 },
  "difficulty": 0.93,
  "maiaElo": 2400,
  "epsEquiv": 0.02,
  "loseMax": 0.5,
  "gapMin": 0.2,
  "mainPassNodes": 1000000,
  "verifyPassNodes": 10000000,
  "multiPv": 10,
  "sourceMoveNum": 27,
  "headers": { "White": "...", "Black": "...", "Event": "..." },
  "engine": "stockfish",
  "generatedAt": "2026-06-19T15:42:32Z"
}
```

Поле `firstMovePV1` — оставляем как алиас `bestMovePV1` для обратной совместимости с `MaiaAnnotationService.annotate()` и аналитикой `KS-4100/ADR-124` (`maia-weak-choice` пост-аннотация требует `firstMovePV1`). UI-фолбэк в `puzzleGenerator.ts:502` уже умеет читать `preventiveCorrectMoveUci` и `firstMovePV1`; добавляем второе имя в этот же резолвер.

**`solutionMode`** — остаётся как enum строкой (`'forced-line' | 'play-vs-engine'`). Новые maia-difficulty пазлы пишутся с `'play-vs-engine'` — фильтры /precision и UI-ветка `PlayVsEngineRunner` работают без изменений.

**`puzzlePhase`** как доменная сущность **уходит из shared**, но значение `'preventive'` остаётся в `themes` и `source_metadata.puzzlePhase` для совместимости с фронтом (текущий код во `PlayVsEngineRunner` ветвится `if (puzzlePhase === 'preventive')` — новая ветка алгоритмически идентична preventive UX-флоу). Удалять колонку или enum-значение НЕ нужно.

**`gap` (Int)** — поле уже есть, семантика **меняется**: было `WDL_signed_after_blunder × 100`, становится `(bestE − secondE) × 100`. Старые значения для лidens/blunder-generated не сопоставимы с новыми. Решение:

* НЕ перезаписываем legacy.
* Для нового pipeline пишем новую семантику в то же поле.
* В API/UI пользоваться `gap` для cross-algorithm фильтра нельзя; фильтр привязывается к `gen_algorithm = 'maia-difficulty-v1'`.
* Документируется в комментарии к колонке в Prisma и в Backend-задаче.

**Индексы.** `@@index([solutionMode, maiaWeakChoiceProb])` остаётся, `@@index([themes])` уже есть. Новый `@@index([solutionMode, maiaDifficulty])` — под фильтр `/puzzles/browse?maiaDifficultyMin=`. `@@index([genAlgorithm])` partial — под выборку «только новые».

### 2.4. API / UI совместимость

`/puzzles`, `/puzzles/:id`, `/puzzles/browse`, `/precision` — **поверхность не меняется**. Версионирования эндпоинтов нет. Изменения:

1. **Backend (apps/api):**
   * `puzzle.controller.ts:394` (SELECT `/puzzles/browse`) — добавить `p.maia_difficulty, p.gen_algorithm` в SELECT-листы, прокинуть в DTO.
   * `puzzle-browse-filter.ts:281` — рядом с фильтром `maia_weak_choice_prob` добавить `maia_difficulty_min` (опц.). Старые фильтры сохраняются.
   * DTO `puzzle.service.ts:1480` (`maiaWeakChoiceProb`) — добавить `maiaDifficulty?: number | null`, `genAlgorithm?: string | null`.
   * `resolveSolutionMode` в `puzzle.service.ts:1438` — оставить fallback `'reactive'` для legacy без `puzzlePhase`; новые пазлы кладут `'preventive'`, маршрут не меняется.

2. **Frontend (apps/web):**
   * `api-puzzle.ts`/`useInfinitePuzzles.ts` — типы DTO расширяются `maiaDifficulty`, `genAlgorithm`.
   * `PlayVsEngineRunner.tsx:522` — `puzzlePhaseFromThemes` остаётся; новые пазлы попадают в ветку `preventive`. Алгоритмическое поведение идентично («solver видит позицию и обязан сыграть единственный сильный ход»). Никаких UI-правок этой ветки.
   * **Опционально** (отдельная задача `frontend`): фильтр-чип в /precision «алгоритм» — `maia-difficulty | blunder | mixed`, по `genAlgorithm`. Не блокирует выкатку.
   * `WdlChancesBar.tsx`, `PuzzleBoard.tsx` — никаких правок, ориентация и оценка строятся из `wdl`/`fen`.

3. **Feature-flag.** Включение нового алгоритма — флаг на стороне tactic-worker:
   * CLI: `--algorithm=maia-difficulty | blunder` (default зафиксировать `blunder` до полного готова, после T7 — переключить);
   * ENV: `PUZZLE_GEN_ALGORITHM` — для крон-скриптов.

   Эндпоинты ничего про алгоритм не знают, флага на стороне API не нужен.

4. **Dual-read период не требуется**: shape пазла в API не меняется. Старые и новые пазлы лежат рядом в одной таблице, читаются одной выборкой. Различение через `gen_algorithm` для UI/аналитики при необходимости.

### 2.5. Стратегия для уже сгенерированных пазлов

Соcуществование. Конкретно:

* **Лichess-пазлы (`source='lichess'`, ~6M)** — не трогаем. `gen_algorithm = NULL`, `solutionMode = 'forced-line'`. Ничего не меняется.
* **Blunder-generated PVE (`source='generated'`, `solutionMode='play-vs-engine'`)** — не трогаем. `gen_algorithm = NULL` (или одной миграцией backfill `'blunder-v1'` — отдельная подзадача T8, не блокирует выкатку). `themes` сохраняют `reactive`/`preventive`. Maia-аннотация (`maiaWeakChoiceProb`) у них уже есть.
* **Новые maia-difficulty пазлы** — пишутся с `gen_algorithm='maia-difficulty-v1'`, `solutionMode='play-vs-engine'`, `themes=['playVsEngine', objective, 'maia-difficulty', preventive, drill-tags...]`.

**Soft-deprecate.** Не делаем сразу. После T7 (если новый алгоритм даст лучшую сравнительную статистику принятия игроками) — отдельной задачей переключить /precision на выдачу только `gen_algorithm = 'maia-difficulty-v1'`.

**Стоимость полной регенерации.** Опционально — НЕ обязательно. На TWIC-базе ~50 K партий: 7–28 часов на 8-thread сервере (см. §2.2). Существующие старые пазлы не удаляем при перегенерации (`puzzles.fen` UNIQUE — `skipDuplicates` отбросит дубли). Если решим полную замену, отдельная задача — `tactic-worker dump → backup → DELETE WHERE gen_algorithm IS NULL AND source='generated' → regen`. В рамках ADR не утверждаем — это business-решение.

### 2.6. План внедрения

Последовательность задач (детальный список — в комментарии к KS-4337). Точки безопасной остановки помечены ⛳.

```
T1. backend  shared/puzzle-gen-maia.ts                — типы + analyzePlyForMaiaDifficulty
                                                       + buildPuzzleFromMaiaCandidate
                                                       + processGameForMaiaDifficultyPuzzles
T2. backend  Prisma migration                         — maia_difficulty, gen_algorithm,
                                                       индексы
                                                       ⛳ совместимая, можно откатить drop column
T3. backend  tactic-worker generator-pipeline.ts      — ветка algorithm='maia-difficulty',
                                                       MaiaPolicyProvider singleton (общий
                                                       с MaiaAnnotationService),
                                                       SF nodes-adapter, drops
T4. backend  smoke-генерация 100–500 партий локально  — ручная верификация выборки в
                                                       /precision, измерение времени
                                                       партии, корректировка дефолтов
                                                       ⛳ если выборка плоха — крутим
                                                       пороги в shared без правки кода
T5. backend  API расширение DTO                       — maiaDifficulty, genAlgorithm
                                                       в /puzzles/:id, /browse;
                                                       опц. фильтр maiaDifficultyMin
T6. frontend types + опц. фильтр /precision           — не блокирует выкатку
                                                       ⛳ можно остановиться до T6
T7. devops  переключить CLI default на maia-difficulty — массовая регенерация на TWIC,
                                                       наблюдение метрик принятия
T8. backend (опц.) backfill gen_algorithm='blunder-v1' — для существующих generated;
                                                       включить UI-фильтр «алгоритм»
```

**Откат.**

* T1–T3 без T7: CLI флаг `--algorithm=blunder`, легаси-pipeline остался работоспособным.
* После T2 (миграция): новые колонки nullable, drop column безопасен.
* После T7 (массовая регенерация): новые записи отделяются по `gen_algorithm`; при необходимости — `DELETE FROM puzzles WHERE gen_algorithm = 'maia-difficulty-v1'`.

### 2.7. Что вынесено в конфиг

Пороги прототипа стартовые. Параметры алгоритма вынести в TypeScript-константы рядом с `HARD_DELTA_W` в `generator-pipeline.ts` (имя `MAIA_DIFFICULTY_DEFAULTS`), переопределение через CLI-флаги:

```
--maia-difficulty-min 0.9
--gap-min 0.2
--lose-max 0.5
--eps-equiv 0.02
--sf-main-nodes 1000000
--sf-verify-nodes 10000000
--sf-multipv 10
--maia-elo 2400
```

ENV для крон-скриптов: `PUZZLE_GEN_*` префикс (например `PUZZLE_GEN_DIFFICULTY_MIN`). Это согласовано с текущим стилем (см. `PRECISION_MAIA_*`).

### 2.8. Что не делаем в этом ADR

* Не меняем клиентский генератор (`apps/web/src/utils/puzzleGenerator.ts`, ADR-070). Maia-difficulty требует ONNX-runtime + 10 M nodes SF — нереалистично в браузере. Клиентский режим остаётся blunder-based.
* Не меняем UI /precision и PlayVsEngineRunner функционально. Опциональный фильтр-чип — отдельной задачей T6/T8.
* Не удаляем колонку `solutionMode` и тип `'forced-line'` — пазлы lichess живые.
* Не удаляем поле `puzzlePhase` из метаданных — UI ветвится по нему для legacy и новых пазлов одинаково.

## 3. Последствия

**Плюсы.**

* Пазлы привязаны к **обучающей ценности позиции**, а не к ошибке игрока в партии. Из той же базы TWIC можно извлечь существенно больше пазлов высокого уровня.
* `gap`/`difficulty` дают понятную численную ось сложности для /precision-фильтра.
* Maia-инфраструктура уже в проекте — внедрение минимально инвазивно.

**Минусы / риски.**

* Стоимость генерации выросла. Verify pass 10 M nodes / MULTIPV=10 — 5–20 с / позиция. Полная регенерация TWIC — десятки часов.
* Сильная зависимость от качества Maia-3 ONNX-модели. Деградация модели = ложно-positive по difficulty.
* `gap` Int меняет семантику внутри одного поля. Любой код, который сейчас читает `gap` без учёта `gen_algorithm`, начнёт смешивать величины. На текущей кодовой базе таких читателей **один**: `puzzle.controller.ts:644` отдаёт `gap` в DTO без интерпретации — фронт его сейчас не использует для логики. Поэтому риск ограничен.
* Singleton `MaiaPolicyProvider` живёт пока жив worker. Утечки ONNX-session — отслеживать в smoke T4.

**Метрики выкатки.** После T7:

* партий / час;
* доля принятия (accepted / processed);
* распределение drops по причинам;
* распределение `difficulty` и `gap` среди принятых;
* runtime per game p50/p95.

## 4. Альтернативы рассмотренные

1. **Не вводить `maia_difficulty`, переиспользовать `maia_weak_choice_prob` с `maia_metric_version=2`.** Отвергнуто: метрики `weakChoiceProb` (ADR-106 §2.1, Maia-TopK + loss\_E) и `difficulty` (Σ policy по SF-strongSet) считаются по-разному и не взаимозаменяемы. Перетирание поля сломает фильтр /precision на legacy пазлах.
2. **Один проход SF с большим бюджетом без main/verify деления.** Отвергнуто: дорого. Большинство ply отсеивается по `|strongSet|≠1` на дешёвом проходе. Двухступенчатый отсев — экономия на порядок.
3. **Версионировать эндпоинт `/puzzles/v2`.** Отвергнуто: shape DTO не меняется, dual-read бессмыслен.
4. **Удалить колонку `solutionMode` и enum `forced-line`.** Отвергнуто: lichess-пазлы (6 M) живые, форсированная линия — корректный режим для них.
5. **Удалить теги `reactive`/`preventive` из themes сразу.** Отвергнуто: legacy PVE-пазлы будут читаться без них и попадут в неверную ветку `PlayVsEngineRunner` (default reactive). Уходит из новой генерации, но не из старых записей.

## 5. Открытые вопросы

* Целевая глубина SF main vs nodes-бюджет. `nodes=1M` на 1 потоке = `depth ≈ 20–25`. Возможно, перейти на `depth=18` для предсказуемости. Решается на T4.
* Maia-2400 — корректная аудитория? Игроки /precision могут иметь рейтинг 1200–1800. Если пазлы получаются «слишком трудные», уменьшить `MAIA_ELO`.
* Параллелизм Maia-inference. Один ONNX-session — нужно ли сериализовать `predictMoves` через мьютекс, или библиотека thread-safe. Уточнить у backend на T1.
* Что делать с шахматными окончаниями (мат-форсы 5–7 ply). Прототип их не отсеивает специально — `gap ≥ 0.2` и `|strongSet|=1` сами их пропускают. Если в выборке T4 окажется много шаблонных эндшпильных пазлов — добавить `--filter-endgame` (опц.).
