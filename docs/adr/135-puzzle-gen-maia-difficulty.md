# ADR-135: Раздел «Точность» — отдельный концепт пазлов на Maia-difficulty

Связанные тикеты: KS-4337.
Связанные ADR: 044, 056, 068, 069, 070, 104, 106, 124.

## 1. Контекст

В проекте две сущности пазлов жили в одной таблице `puzzles`:

* **lichess** (`source='lichess'`, `solution_mode='forced-line'`, ~6 M) — классические пазлы с фиксированной линией. База для `/puzzles`, daily-puzzle, puzzle-rush. Целевая аудитория — новички и базовое обучение.
* **generated PVE** (`source='generated'`, `solution_mode='play-vs-engine'`) — генерируемые из партий TWIC через триггер «зевок» (ADR-068/070). Каждый зевок порождал два пазла: `reactive` (наказать) и `preventive` (избежать). Цель — раздел `/precision`.

Прототип в `/tmp/run-combined.mjs` сменил концепт generated-генерации. Триггер пазла больше не привязан к ошибке в партии. На любом ply ≥ 20 ищем позицию, где:

* единственный сильный ход на двух проходах Stockfish (предварительный 1 M nodes и верифицирующий 10 M nodes) — `|strongSet| = 1` (все остальные ходы хуже на `> EPS_EQUIV = 0.02` по expected score),
* Maia-3 на ELO 2400 даёт этому ходу policy < 10 % — человеку 2400 трудно его увидеть,
* лучший ход не проигрывает (`L ≤ 0.5`),
* зазор по expected score между лучшим и вторым `≥ 0.2`,
* лучший ход на обоих проходах совпадает.

Параметры прототипа (проверено на 3 партиях, SF 18, 1 поток):

| Параметр | Значение | Назначение |
|---|---|---|
| `START_PLY` | 20 | Отсечь дебютную теорию |
| `SF_MAIN_NODES` | 1 000 000 | Бюджет предварительного прохода |
| `SF_VERIFY_NODES` | 10 000 000 | Бюджет верифицирующего прохода |
| `SF_MULTIPV` | 10 | Глубина поиска альтернатив |
| `MAIA_ELO` | 2400 | Целевая аудитория |
| `EPS_EQUIV` | 0.02 | Что считается эквивалентным лучшему |
| `DIFFICULTY_MIN` | 0.9 | Σ policy по сильному набору < 0.1 |
| `LOSE_MAX` | 0.5 | Лучший ход не должен проигрывать |
| `GAP_MIN` | 0.2 | bestE − secondE |

**Решение пользователя по поверхности изменений:**

* раздел `/precision` (generated PVE) — **полная переработка**, чистый разрыв;
* раздел `/puzzles` (lichess) — **не трогаем**, lichess остаётся для новичков (daily-puzzle, puzzle-rush);
* старые generated PVE-пазлы и их история — **удаляются**.

Maia-инфраструктура уже в проекте:

* `@kingside/maia-core` — `Maia.predictMoves(fen, elo, elo) → { policy }`, провайдер ONNX-runtime;
* `MaiaAnnotationService` — обёртка-одиночка с отложенной инициализацией, выключателем при ошибке загрузки модели;
* модель `tools/maia3/maia3_simplified.onnx`;
* `expectedScoreFromWdl(wdl)` в shared — формула E из прототипа уже есть.

## 2. Решение

### 2.1. Новая таблица `tactic_puzzles` (Prisma)

Полностью изолирована от `puzzles`. Никаких пересечений колонок и совмещённых индексов. Содержит только поля, нужные новому концепту.

```prisma
model TacticPuzzle {
  id               String   @id @default(uuid()) @db.Uuid
  fen              String   @unique
  /// UCI единственного сильного хода (решение пазла).
  bestMoveUci      String   @map("best_move_uci")
  /// side-to-move в fen — тот, кто решает.
  solverSide       String   @map("solver_side") // 'w' | 'b'

  // Maia-difficulty метрики (см. §2.3)
  bestE            Float    @map("best_e")
  secondE          Float    @map("second_e")
  gap              Float                          // bestE - secondE
  difficulty       Float                          // 1 - Σ policy[strongSet]
  wdlW             Int      @map("wdl_w")
  wdlD             Int      @map("wdl_d")
  wdlL             Int      @map("wdl_l")

  /// 'convertAdvantage' | 'saveEquality'. Определяется по WDL solver на fen.
  objective        String

  /// Drill-теги (pin/fork/skewer/...) через пробел.
  /// Без 'reactive'/'preventive' — этих жанров в новом концепте нет.
  themes           String   @default("")

  /// Glicko-2 рейтинг пазла для подбора игроку.
  rating           Int      @default(1500)
  ratingDev        Int      @default(350) @map("rating_dev")
  popularity       Int      @default(0)
  nbPlays          Int      @default(0) @map("nb_plays")

  // Источник
  sourceGameId     String?  @map("source_game_id") @db.Uuid
  sourceMoveNum    Int?     @map("source_move_num")
  sourceWhiteElo   Int?     @map("source_white_elo")
  sourceBlackElo   Int?     @map("source_black_elo")
  sourceHeaders    Json?    @map("source_headers") @db.JsonB

  // Параметры алгоритма (для воспроизводимости и пересчёта)
  algorithmVersion String   @default("maia-difficulty-v1") @map("algorithm_version")
  maiaElo          Int      @map("maia_elo")
  sfMainNodes      Int      @map("sf_main_nodes")
  sfVerifyNodes    Int      @map("sf_verify_nodes")
  sfMultiPv        Int      @map("sf_multi_pv")

  createdAt        DateTime @default(now()) @map("created_at")

  attempts         TacticPuzzleAttempt[]
  mistakes         TacticUserMistake[]

  @@index([rating])
  @@index([themes])
  @@index([difficulty])
  @@index([gap])
  @@index([objective, rating])
  @@index([algorithmVersion])
  @@map("tactic_puzzles")
}

model TacticPuzzleAttempt {
  id                 String   @id @default(uuid()) @db.Uuid
  puzzleId           String   @map("puzzle_id") @db.Uuid
  userId             String   @map("user_id") @db.Uuid
  solved             Boolean
  timeMs             Int      @map("time_ms")

  // Игровой рейтинг пользователя по разделу «Точность» (свой, не общий /puzzles)
  ratingBefore       Int      @map("rating_before")
  ratingAfter        Int      @map("rating_after")
  puzzleRatingBefore Int?     @map("puzzle_rating_before")
  puzzleRatingAfter  Int?     @map("puzzle_rating_after")
  userMoves          String?  @map("user_moves")

  // Поля precision-метрик (ADR-056) переезжают сюда. Двухтабличная схема
  // PuzzleAttempt + PrecisionAttempt в старой структуре была вынужденной
  // из-за смеси forced-line и PVE в одной таблице. Здесь PVE — норма,
  // отдельной таблицы не нужно.
  wdlStart           Float?   @map("wdl_start")
  wdlEnd             Float?   @map("wdl_end")
  movesAccuracy      Float?   @map("moves_accuracy")
  precisionGrade     Int?     @map("precision_grade")  // 1..5 (KS-3744 / ADR-065)

  createdAt          DateTime @default(now()) @map("created_at")

  puzzle             TacticPuzzle @relation(fields: [puzzleId], references: [id], onDelete: Cascade)
  user               User         @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([puzzleId])
  @@index([userId, createdAt])
  @@index([userId, puzzleId, solved])
  @@map("tactic_puzzle_attempts")
}

model TacticUserMistake {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  puzzleId  String   @map("puzzle_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")
  resolved  Boolean  @default(false)

  puzzle    TacticPuzzle @relation(fields: [puzzleId], references: [id], onDelete: Cascade)
  user      User         @relation(fields: [userId], references: [id])

  @@unique([userId, puzzleId])
  @@index([userId, resolved])
  @@map("tactic_user_mistakes")
}
```

Пользовательский рейтинг по разделу «Точность» — отдельное поле в `User` или отдельная таблица `TacticRatingSnapshot` (по образцу `PuzzleRatingSnapshot`). Решается на T2 (см. §2.6).

### 2.2. Удаление старых данных

Миграция `delete_legacy_generated_pve`:

```sql
-- 1. Precision-метрики старых PVE-попыток
DELETE FROM precision_attempts
WHERE attempt_id IN (
  SELECT pa.id FROM puzzle_attempts pa
  JOIN puzzles p ON pa.puzzle_id = p.id
  WHERE p.source = 'generated' AND p.solution_mode = 'play-vs-engine'
);

-- 2. Ошибки пользователей по старым PVE
DELETE FROM user_mistakes
WHERE puzzle_id IN (
  SELECT id FROM puzzles
  WHERE source = 'generated' AND solution_mode = 'play-vs-engine'
);

-- 3. Сами пазлы (попытки удалятся каскадом — Puzzle.attempts onDelete: Cascade)
DELETE FROM puzzles
WHERE source = 'generated' AND solution_mode = 'play-vs-engine';
```

`puzzle_rush_session_puzzles` ссылается на `puzzles` — проверить на T2 не было ли PVE-пазлов в сессиях rush. Маловероятно (rush работает на lichess), но FK-аудит обязателен.

Lichess (`source='lichess'`, `solution_mode='forced-line'`) **не трогаем**. Колонки `solution_mode`, `maia_weak_choice_prob`, `maia_metric_version`, `maia_top1_elo` остаются — они уже не имеют смысла для lichess (forced-line их не использует), но и не мешают. Чистку этих колонок выносить в отдельную задачу (необязательную, через пол-года когда убедимся что разрыв окончательный).

Колонка `puzzles.solution_mode` после удаления PVE-строк формально становится бесполезной (все оставшиеся строки `'forced-line'`). Удаление колонки не делаем сразу — дешевле оставить, чем переписывать DTO `/puzzles`.

### 2.3. Pipeline в shared и tactic-worker

**Shared** — старый `packages/shared/src/utils/puzzle-gen-pipeline.ts` и `puzzle-gen-core.ts` (всё кроме общих утилит `wdl.ts`/`expectedScoreFromWdl`) удаляются.

Новый файл `packages/shared/src/utils/tactic-puzzle-gen.ts`:

```ts
export interface TacticPuzzleGenSettings {
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

export interface TacticPuzzleCandidate {
  ply: number;
  fen: string;
  solverSide: 'w' | 'b';
  bestMoveUci: string;
  bestE: number;
  secondE: number;
  gap: number;
  wdl: { w: number; d: number; l: number };
  difficulty: number;
  objective: 'convertAdvantage' | 'saveEquality';
}

export type TacticPuzzleRejectReason =
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
  predictMoves(fen: string, eloW: number, eloB: number):
    Promise<{ policy: Array<{ move: string; probability: number }> }>;
}

export interface TacticSfEngine {
  analyze(fen: string, multiPV: number, nodes: number, ctx?: {
    label?: string;
    signal?: AbortSignal;
  }): Promise<{
    lines: Array<{ move: string; E: number; wdl: Wdl | null }>;
    maxDepth: number;
  }>;
}

export async function analyzePlyForTacticPuzzle(
  step: { ply: number; fen: string; isGameOver: boolean },
  sf: TacticSfEngine,
  maia: MaiaPolicySource,
  settings: TacticPuzzleGenSettings,
): Promise<
  | { kind: 'accepted'; candidate: TacticPuzzleCandidate }
  | { kind: 'rejected'; reason: TacticPuzzleRejectReason }
>;

export async function processGameForTacticPuzzles(args: {
  pgn: string;
  sf: TacticSfEngine;
  maia: MaiaPolicySource;
  settings: TacticPuzzleGenSettings;
  signal?: AbortSignal;
}): Promise<{
  candidates: TacticPuzzleCandidate[];
  stats: { positionsAnalyzed: number;
           drops: Record<TacticPuzzleRejectReason, number> };
}>;
```

Только `fen` (без `fenAfter`), нет `puzzlePhase`, нет двойной эмиссии reactive/preventive — один сильный ход на принятый кандидат, один пазл.

**Tactic-worker** — `apps/tactic-worker/src/puzzle-generator/` целиком удаляется и заменяется на `apps/tactic-worker/src/tactic-puzzle-generator/`:

* алгоритм генерации — обёртка над `processGameForTacticPuzzles` из shared;
* провайдер `MaiaPolicyProvider` — общий с `MaiaAnnotationService` (выделить в `apps/tactic-worker/src/maia/maia-policy-provider.ts`, обе точки используют один объект);
* адаптер `StockfishService` → `TacticSfEngine` с режимом `go nodes`;
* запись в `tactic_puzzles` через Prisma (новый клиент или дополнение `prisma.service`);
* CLI `generate-tactic-puzzles.cli.ts` и `generate-tactic-puzzles-from-twic.cli.ts`.

Прогнозируемая стоимость генерации: средняя партия 50 ply × ~1 с (предварительный + Maia) + 3–5 кандидатов × ~10 с (верификация) ≈ **80–150 с на партию на одном потоке**. При `GAME_CONCURRENCY=8` ≈ 10–20 с эффективно. 50 K TWIC-партий: 7–28 ч. Цифры стартовые, проверка — на T5.

### 2.4. Маршрут на backend

Старый `apps/api/src/puzzle/` остаётся под lichess (`/puzzles`, daily-puzzle, rush). Из него удаляются ветки, относившиеся к PVE:

* в `puzzle.service.ts:resolvePveSolutionUci`, `puzzlePhase`-резолвер, ветка `solutionMode === 'play-vs-engine'`;
* в `mistakes.service.ts`, `puzzle-rating.service.ts` — фильтрация по `solutionMode='play-vs-engine'`;
* в `find-puzzles.dto.ts` — параметр `solutionMode` (валидация), эндпоинт `/puzzles?solutionMode=play-vs-engine` — больше не нужен.

Новый модуль `apps/api/src/tactic-puzzle/`:

* `tactic-puzzle.controller.ts` — маршруты `/tactic-puzzles/next`, `/tactic-puzzles/:id`, `/tactic-puzzles/browse`, `/tactic-puzzles/attempts`, `/tactic-puzzles/mistakes`;
* `tactic-puzzle.service.ts` — подбор по рейтингу/темам/сложности, регистрация попыток, расчёт precision-grade (ADR-065) встроенно (старый `PrecisionAttempt` не нужен);
* DTO без полей `solutionMode`, `puzzlePhase`, `acceptedMoves`, `moves` — их в концепте нет;
* отдельный пользовательский рейтинг «точности» (TacticRatingSnapshot или поле в User).

### 2.5. Frontend

Раздел `/precision` целиком переезжает на новый маршрут.

* Новый компонент `apps/web/src/components/tactic/TacticPuzzleRunner.tsx` — заменяет `PlayVsEngineRunner.tsx` для этого раздела. Логика: solver видит позицию, обязан сыграть `bestMoveUci`. Никакой ветки `reactive`/`preventive`, никакого `replayBlunder`, никакого `firstMovePV1` фолбэка. Один путь — «угадай правильный ход».
* `apps/web/src/pages/PrecisionPage.tsx` — переключается на `/tactic-puzzles/*`.
* `apps/web/src/api-puzzle.ts`, `useInfinitePuzzles.ts` — для `/puzzles` (lichess) остаются как есть. Для `/tactic-puzzles` — новые `api-tactic-puzzle.ts`, `useInfiniteTacticPuzzles.ts`.
* `PlayVsEngineRunner.tsx` — после переезда `/precision` остаётся **только** для клиентского PVE-генератора `PuzzleGeneratorModal` (см. §2.7). Если решим выключить и его — компонент удаляется.

Раздел `/puzzles` (lichess), daily-puzzle, puzzle-rush — без изменений.

### 2.6. План внедрения

```
T1. backend  Shared: tactic-puzzle-gen.ts (типы + analyzePlyForTacticPuzzle
             + processGameForTacticPuzzles), удалить старый puzzle-gen-pipeline.ts
T2. backend  Prisma migration: tactic_puzzles + tactic_puzzle_attempts
             + tactic_user_mistakes + tactic_rating_snapshot (или поле в User).
             ⛳ совместимая, можно откатить drop table
T3. backend  tactic-worker: новый модуль tactic-puzzle-generator,
             MaiaPolicyProvider (общий с MaiaAnnotationService),
             SF-adapter на nodes, CLI generate-tactic-puzzles-from-twic
T4. backend  API: новый модуль tactic-puzzle (controller/service/DTO),
             маршруты /tactic-puzzles/*
T5. backend  Smoke-генерация 100–500 партий локально, ручная верификация
             выборки, корректировка дефолтов
             ⛳ если выборка плоха — крутим пороги в shared
T6. frontend TacticPuzzleRunner.tsx + api-tactic-puzzle.ts + переезд
             PrecisionPage.tsx на новый маршрут
T7. backend  Миграция delete_legacy_generated_pve: удалить
             precision_attempts → user_mistakes → puzzles (cascade на
             puzzle_attempts) для source='generated'
             AND solution_mode='play-vs-engine'
             ⛳ выполняется ПОСЛЕ T6 (UI уже не ходит к старым данным)
T8. devops   Массовая генерация tactic_puzzles на TWIC через ECS-шарды,
             наблюдение метрик принятия
T9. backend  Чистка apps/api/src/puzzle/: удалить ветки PVE-резолверов,
             параметр solutionMode из find-puzzles.dto, мёртвые тесты
T10. backend Чистка apps/web/src/components/puzzle/PlayVsEngineRunner.tsx —
             либо удалить (если PuzzleGeneratorModal тоже выключается),
             либо упростить (только клиент-генератор)
```

**Точки безопасной остановки**: после T2 (новая таблица пустая, никто к ней не ходит), после T4 (маршрут готов, фронт ещё на старом), после T6 (фронт переехал, старые данные ещё на месте — можно откатить фронт обратно).

**Откат на любом шаге до T7**: фронт возвращается на `/puzzles?solutionMode=play-vs-engine`, новые таблицы остаются пустыми (drop безопасен). После T7 откат данных невозможен — это сознательный разрыв.

### 2.7. Открытые вопросы

1. **Клиентский PVE-генератор `PuzzleGeneratorModal`** — пользователь генерит пазлы из своих партий через WASM-Stockfish. Сейчас это blunder-based (ADR-070). Maia-difficulty в браузере нереалистично (10 M nodes SF + ONNX-runtime + Maia-модель). Варианты:
   * выключить функционал;
   * оставить blunder-генератор для клиента только (отдельный артефакт shared);
   * упростить — генерировать кандидатов клиентом (низкий бюджет), отправлять на сервер для верификации.

   Решается отдельным согласованием с пользователем. До решения — оставляем blunder-генератор для клиента в `apps/web/src/utils/puzzleGenerator.ts`, шаренный код туда копируется out-of-band.

2. **Рейтинг пользователя по «Точности»** — отдельная таблица `TacticRatingSnapshot` или поле в `User`. Связано с архитектурой `PuzzleRatingSnapshot`. Решается на T2.

3. **Maia-2400** — корректная аудитория для /precision? Игроки часто 1200–1800. Если выборка T5 «слишком трудная» — уменьшить `MAIA_ELO` в конфиге.

4. **Параллелизм Maia ONNX-session** — поточно-безопасен ли `predictMoves` или нужна сериализация через мьютекс. Уточняется на T1.

5. **`go nodes` vs `go depth`** — для предсказуемости времени, возможно, перейти на `depth`. Решается на T5.

6. **Эндшпильные мат-форсы** — нужен ли отдельный отсев или `|strongSet|=1 + gap ≥ 0.2` сами справляются. Оценка на T5.

7. **PuzzleRush PVE** — сейчас PuzzleRush возможно крутил PVE-пазлы (`PuzzleRushSessionPuzzle.puzzleId`). FK-аудит на T2: были ли PVE-сессии. Если да — либо удалить эти сессии, либо обнулить `puzzleId` (тип данных позволяет).

## 3. Последствия

**Плюсы.**

* Раздел «Точность» получает свою таблицу со схемой, точно совпадающей с концептом. Никаких чужих полей, никаких legacy-ветвлений в коде.
* DTO и UI чистые — `solutionMode`, `puzzlePhase`, `acceptedMoves`, `moves`, `reactive`/`preventive` уходят навсегда из новой поверхности.
* Индексы `tactic_puzzles` не делятся с lichess-нагрузкой — раздельная производительность.
* Lichess остаётся стабильным для новичков, daily-puzzle и rush.

**Минусы / риски.**

* Полная переработка раздела — нельзя выкатить «полосочкой». Откат после T7 невозможен (старые PVE-пазлы и попытки удалены).
* Удаление `puzzle_attempts` для PVE стирает игровую историю пользователей в разделе «Точность». Это сознательная цена концептуального разрыва — старые попытки на старых пазлах не имеют ценности при смене триггера.
* Двойная таблица пазлов (`puzzles` lichess + `tactic_puzzles` Maia) — больше Prisma-моделей, больше клиентов. Это плата за чистоту схемы.
* Стоимость генерации высокая (см. §2.3). Полная регенерация TWIC — десятки часов.

**Метрики выкатки** (после T8):

* партий / час;
* доля принятия (accepted / processed);
* распределение drops по причинам;
* распределение `difficulty` и `gap` среди принятых;
* runtime per game p50 / p95.

## 4. Альтернативы рассмотренные

1. **Обратно-совместимая миграция в существующей `puzzles`** (первая редакция этого ADR) — отвергнута пользователем: каша из трёх концептов в одной таблице, перегруженные индексы, теги-зомби.
2. **Отдельная таблица, но lichess тоже сносим** — отвергнуто пользователем: lichess нужен для новичков, daily-puzzle, rush.
3. **Сохранить старые generated PVE через `algorithm_version='blunder-v1'`** — отвергнуто пользователем: смысла нет, концепт другой.
4. **Версионировать `/puzzles?algorithm=maia-difficulty`** — отвергнуто: общая поверхность смешивает несвязанные концепты, валидация и фильтры расходятся.
