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

  /// Drill-теги (pin/fork/skewer/...) через пробел.
  /// Без 'reactive'/'preventive' и без 'convertAdvantage'/'saveEquality' —
  /// в новом концепте этих жанровых меток нет, цель пазла одна:
  /// найти сильнейший ход в позиции.
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

  /// Длина решённой линии (число полуходов пользователя). Не известна
  /// заранее — определяется во время игры. Клиент на каждом полуходе
  /// проверяет сложность позиции по shared-модулю; пазл продолжается,
  /// пока |strongSet|=1 + difficulty > порога + gap ≥ порога.
  lineHalfMoves      Int      @map("line_half_moves")
  /// Все ходы пользователя через пробел (UCI). Длина переменная.
  userMoves          String?  @map("user_moves")
  /// Причина остановки пазла:
  ///   'user-finished' — пользователь сам нажал «завершить задачу»
  ///                     (доступно когда difficulty упала ниже порога);
  ///   'user-skipped'  — пользователь нажал «пропустить ход»
  ///                     (доступно когда difficulty упала ниже порога);
  ///   'mate'          — мат / пат на доске;
  ///   'mistake'       — пользователь сыграл не bestMove;
  ///   'aborted'       — закрыл страницу / явно прервал.
  stopReason         String   @map("stop_reason")

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

FK-каскады в текущей схеме (проверено в `packages/db/prisma/schema.prisma`):

* `PuzzleAttempt.puzzle → Puzzle onDelete: Cascade`;
* `PrecisionAttempt.attempt → PuzzleAttempt onDelete: Cascade`;
* `PrecisionAttemptMove.attempt → PrecisionAttempt onDelete: Cascade`;
* `PuzzleRushSessionPuzzle.puzzle → Puzzle onDelete: Cascade`;
* `DailyPuzzle.puzzle → Puzzle onDelete: Cascade`;
* `UserMistake.puzzle → Puzzle onDelete: SetNull` (KS-2675 сознательно — строка ошибки пользователя сохраняется без ссылки на пазл).

Поэтому миграция `delete_legacy_generated_pve` — один запрос:

```sql
DELETE FROM puzzles
WHERE source = 'generated' AND solution_mode = 'play-vs-engine';
```

Каскадно удалится:
* все `puzzle_attempts` по этим пазлам → `precision_attempts` → `precision_attempt_moves`;
* `puzzle_rush_session_puzzles` со ссылкой на эти пазлы;
* `daily_puzzles` со ссылкой на эти пазлы (если есть).

Сохранится:
* `user_mistakes.puzzle_id` обнулится через SetNull — строка ошибки остаётся в истории пользователя без ссылки на источник.

**Обязательные FK-аудиты до миграции (шаг T2)** — без них миграция не запускается:

```sql
-- 1. Сколько PVE-пазлов под удаление и сколько связей сорвётся
SELECT
  (SELECT count(*) FROM puzzles
   WHERE source='generated' AND solution_mode='play-vs-engine') AS pve_puzzles,
  (SELECT count(*) FROM puzzle_attempts pa
   JOIN puzzles p ON pa.puzzle_id = p.id
   WHERE p.source='generated' AND p.solution_mode='play-vs-engine') AS attempts,
  (SELECT count(*) FROM puzzle_rush_session_puzzles prsp
   JOIN puzzles p ON prsp.puzzle_id = p.id
   WHERE p.source='generated' AND p.solution_mode='play-vs-engine') AS rush_sessions,
  (SELECT count(*) FROM user_mistakes um
   JOIN puzzles p ON um.puzzle_id = p.id
   WHERE p.source='generated' AND p.solution_mode='play-vs-engine') AS mistakes_setnull;

-- 2. Сколько среди удаляемых — авторские черновики пользователей
SELECT count(*) FROM puzzles
WHERE source='generated' AND solution_mode='play-vs-engine'
  AND created_by IS NOT NULL;
```

**Авторские черновики пользователей (`puzzles.created_by IS NOT NULL`)** — отдельный риск. Сейчас `PuzzleGeneratorModal` создаёт пазлы с `source='generated', solution_mode='play-vs-engine'`, `created_by = req.user.id`. Под предложенный DELETE они попадают вместе с TWIC. Решение — открытый вопрос (см. §2.7 п.1).

Lichess (`source='lichess'`, `solution_mode='forced-line'`) **не трогаем**. Колонки `solution_mode`, `maia_weak_choice_prob`, `maia_metric_version`, `maia_top1_elo` остаются — они уже не имеют смысла для lichess (forced-line их не использует), но и не мешают. Чистку этих колонок выносить в отдельную задачу (необязательную, через пол-года когда убедимся что разрыв окончательный).

Колонка `puzzles.solution_mode` после удаления PVE-строк формально становится бесполезной (все оставшиеся строки `'forced-line'`). Удаление колонки не делаем сразу — дешевле оставить, чем переписывать DTO `/puzzles`.

### 2.3. Pipeline в shared, tactic-worker и в браузере

Длина решения у пазла **не зафиксирована**. Сервер оценивает только стартовую позицию и сохраняет первый правильный ход. Дальше — клиент во время игры:

1. Пользователь сыграл `bestMoveUci` правильно.
2. Движок (Stockfish WASM) отвечает оптимальным ходом.
3. На новой позиции (ход пользователя) клиент **запускает Stockfish в режиме `go infinite`** + одиночный быстрый Maia-инференс (~30–80 мс). Сложность позиции пересчитывается по тем же критериям (`|strongSet|=1`, `difficulty > порога`, `gap ≥ порога`), но значение `difficulty` растёт по мере углубления SF — индикатор сложности на доске обновляется в реальном времени.
4. Пока сложность выше порога — пользователь обязан искать ход. Когда падает ниже — на доске появляются кнопки «пропустить ход» (`stopReason='user-skipped'`) и «завершить задачу» (`stopReason='user-finished'`).
5. Пользователь играет ход → клиент отправляет `stop` в SF, фиксирует текущую оценку и сверяет ход с `bestMoveUci`. Совпало — возврат к шагу 1, не совпало — `stopReason='mistake'`, оценка ставится.

Поэтому общий модуль в shared — архитектурная необходимость, не косметика. Один и тот же код запускается:
* на сервере при генерации стартовой позиции (с фиксированным `go nodes` по бюджету сервера);
* в браузере на каждом полуходе пользователя (с `go infinite` и потоковым обновлением сложности).

Параметр режима SF (`nodes` vs `infinite`) — на уровне обёртки над shared-модулем; алгоритм отбора `|strongSet|=1 / difficulty / gap` идентичен.

**Жанровое разделение `objective` (`convertAdvantage`/`saveEquality`) — снято** (KS-4367). Суть раздела «Точность» — найти **сильнейший ход в позиции**, неважно, реализация перевеса это или удержание равенства. Поле `objective` убрано из контракта `TacticPuzzleCandidate`, схемы `tactic_puzzles`, фильтра `browse?objective=`, статистики `objectiveBreakdown`. Соответствующая миграция БД и правки кода — в задачах-наследниках KS-4367.

**Источник партий для серверной генерации** — `archive_games` со следующими фильтрами:
* `white_elo >= 2600 AND black_elo >= 2600` (оба игрока сильнее текущего `MAIA_ELO=2400` — это даёт партии, в которых трудные позиции возникают чаще);
* `time_control_category = 'classical'` (классические партии — больше расчёта, чище позиции).

Эти значения заменяют прежний серверный порог `SERVER_MIN_PLAYER_ELO=2400` из blunder-генератора (ADR-070).

**Объём источника (по данным devops на 2026-06-19):** в `archive_games` под фильтр `elo обоих ≥ 2600 + classical` подходит **4037 партий**.

Скорость Stockfish на используемых ECS-инстансах — 1M узлов в секунду на поток (со слов пользователя). Тогда:
* main pass 1M узлов = 1 сек/ply;
* verify pass 10M узлов = 10 сек/ply, запускается только для прошедших `|strongSet|=1 + difficulty > 0.9`;
* партия ≈ 50 ply ≥ 20 → main вклад 50 с;
* при допущении 5–20 % кандидатов до verify (доля не замерена) дополнительно 25–100 с;
* партия на 1 поток ≈ 1–2.5 минуты.

Параллелизм генератора: 8 шардов, каждый на отдельном ядре с одним потоком Stockfish (`GAME_CONCURRENCY=1`, `STOCKFISH_POOL_SIZE=1`).

Поэтапная выкатка:

1. **T5 — тестовый прогон 100 партий** на одном шарде (проще наблюдать логи и ошибки).
   * расчёт при 3 мин/партию: 100 × 3 = 300 мин ≈ **5 часов**;
   * на выходе — точное среднее время на партию, доля кандидатов до verify, выявленные ошибки;
   * корректировка дефолтов и/или порогов в `TACTIC_PUZZLE_GEN_DEFAULTS`.
2. **T8 — полный прогон** после успешного T5. По расчёту 3 мин/партию: 4037 / 8 ≈ 505 партий на шард × 3 мин ≈ **25 часов**. Реальное число пересчитывается по фактическому времени из T5.

Стартовый банк пазлов при доле принятия 1–3 % от ply ≥ 20 — ориентировочно 2–6 тыс. записей. Этого достаточно для первого открытия раздела; при необходимости расширения — отдельной задачей понижается порог elo или добавляются rapid-партии.

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

Прогнозируемая стоимость генерации — **стартовая оценка, требует замера на T5**:

* nps Stockfish зависит от сборки (SF18 с NNUE на 1 потоке) и нагрузки на сервер — не проверял в проекте;
* доля кандидатов, доходящих до верифицирующего прохода после `|strongSet|=1 + difficulty > 0.9` — на 3 партиях прототипа точная статистика не снималась;
* при допущении 1–2 с на main + Maia и 10–20 с на verify, средняя партия 50 ply ориентировочно 60–180 с на одном потоке. На 8 потоках 50 K TWIC ≈ 6–30 ч.

Замер на T5 — обязателен до перехода к T8 (массовая генерация).

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

Раздел `/precision` целиком переезжает на новый маршрут `/tactic-puzzles/*`.

* `PlayVsEngineRunner.tsx` **остаётся и развивается** до `TacticPuzzleRunner.tsx`. На его базе встраивается:
  * Stockfish WASM через существующий `engineAdapter.ts` (поддерживает `go nodes N`);
  * Maia browser через существующий `apps/web/src/lib/maia/` (`@kingside/maia-core/browser`);
  * цикл проверки сложности на каждом полуходе пользователя через общий модуль из shared (см. §2.3).
* Логика среды выполнения:
  1. Старт: показывается `puzzle.fen`, пользователь играет ход.
  2. Сравнение с `bestMoveUci` (стартовое значение пришло с сервера): не совпало — `stopReason='mistake'`, оценка ставится.
  3. Совпало — движок отвечает оптимально, клиент показывает новую позицию.
  4. На новой позиции клиент запускает SF в режиме `go infinite` + одиночный Maia-инференс. По мере роста глубины SF значение `difficulty` обновляется в реальном времени.
  5. **На доске постоянно отображается индикатор сложности** следующего хода. Пока выше порога — кнопки «пропустить» / «завершить» скрыты, пользователь обязан искать ход. Ниже порога — кнопки появляются.
  6. Пользователь играет ход → клиент шлёт `stop` в SF, фиксирует текущую `difficulty`/`bestMoveUci`, сверяет с ходом пользователя. Цикл с шага 2.
  7. Пользователь жмёт «пропустить ход» → клиент за пользователя играет зафиксированный `bestMoveUci`, дальше движок отвечает, цикл с шага 4. `stopReason='user-skipped'` фиксируется в attempt по запросу пользователя завершить — пока пропуски не остановили, attempt продолжается.
  8. Пользователь жмёт «завершить задачу» → attempt закрывается с `stopReason='user-finished'`, оценка ставится.
* Никакой ветки `reactive`/`preventive`, никакого `replayBlunder`, никакого `firstMovePV1` фолбэка. Один путь — «угадай правильный ход, индикатор покажет когда стало просто».
* `apps/web/src/pages/PrecisionPage.tsx` — переключается на `/tactic-puzzles/*`.
* `apps/web/src/api-puzzle.ts`, `useInfinitePuzzles.ts` — для `/puzzles` (lichess) остаются как есть. Для `/tactic-puzzles` — новые `api-tactic-puzzle.ts`, `useInfiniteTacticPuzzles.ts`.
* Клиентский генератор `PuzzleGeneratorModal` переводится на тот же Maia-difficulty pipeline (общий модуль в shared) — создаёт `tactic_puzzles` записи через тот же API, что и сервер.

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
T7. backend  Миграция delete_legacy_generated_pve: один DELETE FROM puzzles
             WHERE source='generated' AND solution_mode='play-vs-engine'.
             FK-каскады снимут puzzle_attempts → precision_attempts →
             precision_attempt_moves, puzzle_rush_session_puzzles,
             daily_puzzles. user_mistakes.puzzle_id обнулится (SetNull).
             ПЕРЕД миграцией — FK-аудиты из §2.2 + решение по черновикам
             (§2.7 п.1).
             ⛳ выполняется ПОСЛЕ T6 (UI уже не ходит к старым данным)
T8. devops   Массовая генерация tactic_puzzles на TWIC через ECS-шарды,
             наблюдение метрик принятия
T9. backend  Чистка apps/api/src/puzzle/: удалить ветки PVE-резолверов,
             параметр solutionMode из find-puzzles.dto, мёртвые тесты
T10. frontend Развить PlayVsEngineRunner.tsx в TacticPuzzleRunner.tsx —
             встроить SF WASM + Maia browser + цикл проверки сложности на
             каждом полуходе через shared-модуль. Удалить старый
             apps/web/src/utils/puzzleGenerator.ts (blunder-генератор не
             используется). PostGameReview/PrecisionScoreBlock — обновить
             под переменную длину линии
```

**Точки безопасной остановки**: после T2 (новая таблица пустая, никто к ней не ходит), после T4 (маршрут готов, фронт ещё на старом), после T6 (фронт переехал, старые данные ещё на месте — можно откатить фронт обратно).

**Откат на любом шаге до T7**: фронт возвращается на `/puzzles?solutionMode=play-vs-engine`, новые таблицы остаются пустыми (drop безопасен). После T7 откат данных невозможен — это сознательный разрыв.

### 2.7. Открытые вопросы

1. **Авторские черновики пользователей** — `puzzles WHERE source='generated' AND solution_mode='play-vs-engine' AND created_by IS NOT NULL`. Это пазлы, сделанные через старый blunder-`PuzzleGeneratorModal`. Под предложенный DELETE в §2.2 они попадают вместе с TWIC. Варианты:
   * удалить вместе с TWIC (пользователи теряют черновики);
   * перенести в `tactic_puzzles` с NULL в Maia-полях и маркером `algorithm_version='legacy-blunder-v1'` (рантайм покажет их через тот же `TacticPuzzleRunner` — клиент сам проверит сложность на каждом полуходе через Maia, даже если запись создана старым алгоритмом).

   Второй вариант рабочий: `TacticPuzzleRunner` на клиенте умеет оценивать сложность сам, не доверяя стартовым метрикам записи. Запрос объёма — в §2.2.

2. **Порог сложности для появления кнопок «пропустить» / «завершить»** — на каком значении `difficulty` показывать пользователю возможность остановиться. Стартово — тот же порог, что в генераторе (`difficultyMin=0.9`), но возможно нужен зазор (например показывать кнопки при `difficulty < 0.8`, чтобы пользователю не давали выйти из реально трудной позиции). Решается на T6.

3. **Рейтинг пользователя по «Точности»** — отдельная таблица `TacticRatingSnapshot` или поле в `User`. Связано с архитектурой `PuzzleRatingSnapshot`. Решается на T2.

4. **Параллелизм Maia ONNX-session** — поточно-безопасен ли `predictMoves` или нужна сериализация через мьютекс. Не проверено по документации `onnxruntime-node`/`onnxruntime-web`. Уточняется на T1 тестом.

5. **`go nodes` vs `go depth` на сервере** — для предсказуемости времени, возможно, перейти на `depth`. На клиенте режим уже зафиксирован — `go infinite`. Решается на T5.

6. **Эндшпильные мат-форсы** — нужен ли отдельный отсев или `|strongSet|=1 + gap ≥ 0.2` сами справляются. Оценка на T5.

## 3. Последствия

**Плюсы.**

* Раздел «Точность» получает свою таблицу со схемой, точно совпадающей с концептом. Никаких чужих полей, никаких legacy-ветвлений в коде.
* DTO и UI чистые — `solutionMode`, `puzzlePhase`, `acceptedMoves`, `moves`, `reactive`/`preventive` уходят навсегда из новой поверхности.
* Индексы `tactic_puzzles` не делятся с lichess-нагрузкой — раздельная производительность.
* Lichess остаётся стабильным для новичков, daily-puzzle и rush.

**Минусы / риски.**

* Полная переработка раздела — нельзя выкатить кусочно. Откат после T7 невозможен (старые PVE-пазлы и попытки удалены).
* Удаление `puzzle_attempts` для PVE стирает игровую историю пользователей в разделе «Точность». Это сознательная цена концептуального разрыва — старые попытки на старых пазлах не имеют ценности при смене триггера.
* `user_mistakes` для удалённых PVE-пазлов сохраняются (SetNull по `puzzle_id`) — строки ошибок остаются в истории пользователя без ссылки на источник. UI должен корректно отображать ошибку без пазла.
* Авторские черновики пользователей попадают под удаление, если не вынесены отдельно (§2.7 п.1).
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
