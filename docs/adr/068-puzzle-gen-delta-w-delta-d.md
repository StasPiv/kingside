# ADR-068 — Puzzle-генератор: переход с `wdlSigned` (W−L) на независимые `deltaW` и `deltaD`

- Статус: Accepted
- Дата: 2026-05-20
- Связанные задачи: KS-3134 (этот audit/план), запрос пользователя 2026-05-20
  (Web).
- Связанные ADR: **Partially supersedes** ADR-050 §2.1 / §3 #5 в части метрики
  блaндера и `PUZZLE_GEN_DEFAULTS.blunderDelta` / `minWdlAfterBlunder`.
  Источник данных (`UCI_ShowWDL`), draft/publish-flow, общее место алгоритма
  (`packages/shared`) — ADR-050 остаётся актуальным. ADR-044 (play-vs-engine
  pivot, WDL) — без изменений.
- **Follow-up:** ADR-069 (KS-3142) — различение жанра пазла
  `convertAdvantage` / `saveEquality` (`determinePuzzleObjective` по
  `wdlAfterRaw`), UI-надписи и фильтрация. Алгоритм отбора в §3.2
  остаётся, но генератор после accept определяет и записывает `objective`.
- Авторы: architect

---

## 1. Контекст и решение

### 1.1 Проблема

Сейчас триггер пазла — свёртка `blunderΔ = W_до − L_до + W_решающего_после − L_решающего_после` (по
факту `wdlBefore + wdlAfterForSolver`). Свёртка работает по математике
(сумма signed-WDL вокруг хода = «насколько перевернулись шансы»), но:

- Это **абстрактная** единица [0..2] без физического смысла для
  пользователя. Объяснить «60% свёртки W−L» в UI нельзя одной фразой.
- В UI слайдер «Minimum blunder strength: 60%» (`PuzzleGeneratorModal`)
  не отвечает на вопрос «60% чего».
- Композитная метрика смешивает два события — «потеря шанса на победу»
  и «потеря шанса на ничью» — в одно число; в эндшпильных и
  миттельшпильных пазлах они зачастую разной природы (запорол ничью vs
  упустил выигрыш).

### 1.2 Решение

Меняем единую свёртку на две независимые величины **от лица сходившего
(блaндера)**:

```
deltaW = W_до − W_после   ∈ [0..1]   # «насколько упала вероятность победы»
deltaD = D_до − D_после   ∈ [0..1]   # «насколько упала вероятность ничьи»
```

Триггер пазла:

```
if deltaW ≥ threshold_W OR deltaD ≥ threshold_D:
    candidate accepted
```

Пороги:

- **Default** — `0.6` для обоих (= те же 60 п.п., что и сейчас, для
  обратной совместимости поведения генератора и узнаваемости в UI).
- **Backend** (`apps/tactic-worker`): оба порога **жёстко зашиты** как
  `const` в коде, не регулируются ни через ENV, ни через CLI-флаги.
- **Frontend** (`apps/web/src/utils/puzzleGenerator.ts`): оба порога
  регулируются пользователем через `PuzzleGeneratorModal`, default
  0.6 / 0.6.

Метрика и формулы — определены в shared (`packages/shared/src/utils/wdl.ts`,
расширение). Оба генератора (серверный + клиентский) используют одни и
те же функции — никакого копипаста алгоритма.

### 1.3 Что остаётся без изменений

- Источник данных — `UCI_ShowWDL` от Stockfish (W/D/L per-mille, POV
  side-to-move).
- Фильтры `samePv1`, `skipDecided` (`|wdlSigned_до| > 0.95`),
  `gameOver`, опциональный solvability-check (`halfMovesN=6`,
  `winThreshold=0.5`, `failThreshold=0.0`).
- Общий контракт пазла (`solutionMode='play-vs-engine'`, `moves=''`,
  DTO `playVsEngine`, draft/publish-flow KS-2585).
- Утилиты `wdlSigned` / `wdlSignedFromInfo` в shared — остаются (нужны
  для solvability-check и UI win-chance шкалы).

### 1.4 Что отменяется

- `blunderΔ = wdlBefore + wdlAfterForSolver` как триггер пазла.
- `PUZZLE_GEN_DEFAULTS.blunderDelta = 0.6` — удаляется.
- `PUZZLE_GEN_DEFAULTS.minWdlAfterBlunder = 0.5` — пересмотрено (см.
  §3.2).
- CLI-флаги `--blunder-delta`, `--min-wdl-after-blunder` в `generate-puzzles.cli.ts`
  удаляются (порог теперь hardcoded). `--win-threshold`, `--fail-threshold`,
  `--half-moves-n`, `--skip-decided-wdl` — **оставляем** (это не «метрика
  блaндера», а параметры solvability/decided-фильтра; пользователь явно
  заморозил только пороги deltaW/deltaD).

---

## 2. Формулы и POV

### 2.1 Источник: Stockfish UCI_ShowWDL

Stockfish с `UCI_ShowWDL=true` отдаёт `wdl W D L` per-mille (сумма ≈
1000), **POV side-to-move в анализируемой позиции**.

- На `fenBefore` side-to-move = **блaндер**, поэтому `Wdl_before` =
  POV блaндера до зевка.
- На `fenAfter` side-to-move = **решающий** (соперник блaндера),
  поэтому `Wdl_after_raw` = POV решающего после зевка.

### 2.2 Перевод POV для метрики

Чтобы получить `W_после` и `D_после` **от лица блaндера** (для
сравнения с `W_до` и `D_до`), инвертируем POV:

```
W_после_блaндера = L_после_решающего / 1000   # L → W при смене стороны
D_после_блaндера = D_после_решающего / 1000   # D симметрично
L_после_блaндера = W_после_решающего / 1000
```

И тогда:

```
deltaW = (W_до_raw − L_после_raw) / 1000
deltaD = (D_до_raw − D_после_raw) / 1000
```

Оба значения в диапазоне `[−1..+1]`; триггер срабатывает на **положительной**
дельте (вероятность упала).

### 2.3 Mate-fallback

Если Stockfish не отдал WDL (старые версии при mate-оценке), для
дельт нужен явный фоллбэк. Предлагаемая логика в `wdl.ts`:

- `mate в пользу side-to-move` → `{w: 1000, d: 0, l: 0}` POV side-to-move.
- `mate против side-to-move` → `{w: 0, d: 0, l: 1000}`.

Тогда формулы из §2.2 работают без отдельной ветки. Это тот же подход,
что и в `wdlSignedFromInfo` сейчас.

### 2.4 Новые утилиты в shared

В `packages/shared/src/utils/wdl.ts` добавляются:

```ts
/** {w,d,l} per-mille от лица side-to-move. */
export function wdlOrMateFallback(
  wdl: Wdl | null | undefined,
  score: WdlScoreInfo,
): Wdl | null;

/**
 * deltaW от лица блaндера. `before` — Wdl POV блaндера на fenBefore;
 * `afterRaw` — Wdl POV решающего на fenAfter (как отдал Stockfish).
 * Возвращает Δ ∈ [−1..+1], положительное = шанс на победу упал.
 */
export function deltaWFromWdl(before: Wdl, afterRaw: Wdl): number;
export function deltaDFromWdl(before: Wdl, afterRaw: Wdl): number;
```

Существующие `wdlSigned` / `wdlSignedFromInfo` остаются — они нужны
для `solvabilityPasses` (там сравнение со `winThreshold` / `failThreshold`
— signed-метрика естественна и привычна) и для UI win-chance % шкалы.

---

## 3. Псевдокод до / после

### 3.1 До (текущий, ADR-050 §2.1)

```
on each ply (≥ startPly):
  fenBefore, playedUci
  pre  = analyze(fenBefore, multiPV=2)
  wdlBefore = (pre.w − pre.l) / 1000             # signed POV блaндера
  if pv1 == playedUci: drop samePv1
  if |wdlBefore| > 0.95: drop decided
  fenAfter = apply(playedUci)
  if gameOver(fenAfter): drop gameOver
  post = analyze(fenAfter, multiPV=2)
  wdlAfterForSolver = (post.w − post.l) / 1000   # signed POV решающего
  blunderΔ = wdlBefore + wdlAfterForSolver
  if blunderΔ < 0.6: drop notBlunder
  if wdlAfterForSolver < 0.5: drop lowWdlAfterBlunder
  → solvability check (опц.) → accept
```

### 3.2 После (этот ADR)

```
on each ply (≥ startPly):
  fenBefore, playedUci
  pre  = analyze(fenBefore, multiPV=2)
  wdlBefore_raw = pre.wdl                       # {w,d,l} POV блaндера
  if pv1 == playedUci: drop samePv1
  if |wdlSigned(wdlBefore_raw)| > 0.95: drop decided
  fenAfter = apply(playedUci)
  if gameOver(fenAfter): drop gameOver
  post = analyze(fenAfter, multiPV=2)
  wdlAfter_raw  = post.wdl                      # {w,d,l} POV решающего

  deltaW = (wdlBefore_raw.w − wdlAfter_raw.l) / 1000
  deltaD = (wdlBefore_raw.d − wdlAfter_raw.d) / 1000

  # Триггер OR — любая из двух дельт ≥ порог.
  if not (deltaW ≥ THRESHOLD_DELTA_W or deltaD ≥ THRESHOLD_DELTA_D):
      drop deltaTooLow

  # Защита от позиций, где «шанс» решающего — мираж.
  W_after_for_solver = wdlAfter_raw.w / 1000
  D_after_for_solver = wdlAfter_raw.d / 1000
  if deltaW ≥ THRESHOLD_DELTA_W and W_after_for_solver < 0.5:
      drop lowWAfter
  if deltaD ≥ THRESHOLD_DELTA_D
       and (W_after_for_solver + D_after_for_solver) < 0.5:
      drop lowWDAfter

  → solvability check (опц.) → accept

  # KS-3142 / ADR-069 §2.2: после accept определяем жанр пазла.
  objective = determinePuzzleObjective(wdlAfter_raw)
              # 'convertAdvantage' если W_after_for_solver ≥ 0.5,
              # иначе 'saveEquality' (after-фильтр гарантировал W+D ≥ 0.5)
  записать objective в sourceMetadata.objective и в themes-строку
  (тег 'convertAdvantage' или 'saveEquality') — для UI и фильтрации.
```

**Ключевые отличия:**

- Триггер — OR двух независимых дельт, не сумма.
- `minWdlAfterBlunder` (single, signed ≥ 0.5) заменяется двумя
  дифференцированными после-фильтрами:
  - для триггера-по-победе → `W_after_for_solver ≥ 0.5` (решающий
    реально в выигранной позиции);
  - для триггера-по-ничьей → `W_after_for_solver + D_after_for_solver
    ≥ 0.5` (решающий хотя бы не проигрывает = шанс держать ничью).
- Метаданные пазла (`sourceMetadata`) дополняются полями `deltaW`,
  `deltaD`. Поля `wdlBeforeBlunder`, `wdlAfterBlunder`, `blunderDelta`
  у новых пазлов **не пишем**; у legacy-пазлов они останутся (см.
  §5.1).

### 3.3 Drop-stats

В `GeneratorStats.drops` (`apps/tactic-worker/src/puzzle-generator/types.ts`):

- `notBlunder` → переименовать в `deltaTooLow` (семантика «обе дельты
  ниже порога»).
- `lowWdlAfterBlunder` → разбить на два: `lowWAfter` и `lowWDAfter`
  (см. §3.2). Оставить как одно поле тоже допустимо, если backend-исполнитель
  посчитает разделение лишним; в любом случае суммарный инвариант
  `Σ(drops) + inserted = positionsAnalyzed` сохраняется.

---

## 4. Аргументы

### 4.1 За независимые дельты

- Пользователь видит в UI два понятных слайдера: «упала вероятность
  победы» и «упала вероятность ничьи». В каждый можно ткнуть и
  объяснить в одной фразе.
- Эти метрики напрямую соответствуют «зеркальным» сообщениям в
  play-vs-engine summary (KS-2523/2524): UI там уже показывает W/D/L
  как три отдельных числа, метрика теперь однородна.
- OR-триггер ловит сценарий «упустил ничью» (deltaD большой, deltaW
  малый — например W_до=0.05, D_до=0.7 → W_после=0, D_после=0.05). На
  старой свёртке такие пазлы пограничны: `blunderΔ ≈ (0.05 − 0.95) +
  (0.95 − 0.05) = 0.8`, проходил, но не из-за W-сигнала — а потому что
  L взлетел; с новой метрикой это явно «зевок ничьи».

### 4.2 Против (риски и контраргументы)

| Риск | Mitigation |
|---|---|
| OR-триггер с порогом 0.6 на каждой стороне расширяет выборку. Может прибавиться false-positive. | На практике `deltaW ≥ 0.6` И сейчас покрывалось `blunderΔ ≥ 0.6` (если D≈0, blunderΔ = deltaW). Реальный прирост — только сценарий `deltaD≥0.6, deltaW<0.6` (потеря ничьи), это **нужный** новый класс пазлов. |
| `deltaD ≥ 0.6` в проигрышной позиции (W_до=0.02, L_до=0.95) — фильтр `skipDecided` отбросит до триггера. | Фильтр `skipDecided` (`|wdlSigned| > 0.95`) уже есть и сохраняется. На `W=0.02, L=0.95`: `wdlSigned ≈ −0.93` — позиция не drop'ается (не превышает 0.95), но **`D_до = 0.03`**, физически некуда падать на 0.6 → `deltaD < 0.6` → триггер не сработает. |
| Эндшпильные ничейные позиции (D_до ≈ 1.0) при `deltaD ≥ 0.6` без `deltaW`-сигнала — это пазлы «удержи ничью» при W=0. Может ли это породить ложные пазлы? | Нет. Если `D_до=1.0, W_до=0`, ход перешёл в `D_после=0.3` (по перспективе блaндера) — `deltaD = 0.7`, но в `fenAfter` для решающего теперь `W_after=L_было_до_хода=0 → 0.7` (вероятность победы выросла с нуля до 0.7). После-фильтр `(W_after_for_solver + D_after_for_solver) ≥ 0.5` пропустит. Это валидный пазл «не упусти ничью», именно за такими пазлами шёл запрос пользователя. |
| Существующие пазлы в БД хранят `blunderDelta` в `sourceMetadata` — backend `resolveSolutionMode` его читает? | Не использует на runtime: backend читает `wdlAfterBlunder` (для UI шкалы) и пороги `winThreshold/failThreshold/halfMovesN` (с fallback на defaults). `blunderDelta` в meta — только дамп для отладки; новые пазлы пишут `deltaW`/`deltaD`, legacy остаются с `blunderDelta` — оба варианта совместимы. |

### 4.3 Защита от false-positive в эндшпиле (явный ответ на вопрос задачи)

Запрос задачи: «не возрастёт ли false-positive из-за `deltaD ≥ 0.6` в
эндшпилях? Предложить защитный фильтр».

Анализ возможных пограничных позиций:

1. **Чистый эндшпиль (D≈1, W=0, L=0).** Ход переводит в проигрыш:
   `deltaD=0.6+`, `W_after_for_solver≈0.6+`, `D_after_for_solver`
   мал. После-фильтр `W+D ≥ 0.5` пропустит. ✅ Валидный пазл
   «удержи ничью».

2. **Полупроигрышная позиция (W=0.02, D=0.03, L=0.95).** `deltaD ≥ 0.6`
   невозможен (D_до=0.03 физически нечему падать на 0.6). ❌
   Триггер не срабатывает.

3. **Полупроигрышная с ничейными шансами (W=0.05, D=0.6, L=0.35).**
   Ход в проигрыш: `D_после ≈ 0.05`, `deltaD = 0.55` — близко к
   порогу, но не пройдёт (`< 0.6`). При более резком падении
   `deltaD = 0.6+` — пройдёт; после-фильтр `W+D ≥ 0.5`: `W_after =
   0.35 → 0.55, D_after ≈ 0.05`, сумма 0.6 — пропустит. ✅
   Валидный «не упусти ничью при шатком равенстве».

4. **Дебютная теория с малым D и низким W (исключается `startPly=20`,
   к ходу 20 теория исчерпана).** Сценарий нерелевантный.

**Вывод:** дополнительные защитные фильтры **не нужны**. Существующих
двух (`skipDecided ≥ 0.95` + дифференцированный after-фильтр §3.2)
достаточно. Логика «защитного» фильтра из исходной формулировки
запроса (`W_до < 0.05 AND D_до < 0.05` → skip) уже покрыта `skipDecided`
(`|wdlSigned| > 0.95` → drop), потому что в этом случае `L_до ≥ 0.9`,
`|W − L| ≈ 0.9..1.0`.

---

## 5. Изменения по компонентам

### 5.1 Существующие пазлы

Решение: **не пересчитываем, оставляем как есть**. Аргументы:

- Пазлы с `solutionMode='play-vs-engine'`, отобранные по
  `blunderΔ ≥ 0.6`, остаются валидными — отбор был корректен по
  предыдущей метрике.
- В БД у них в `sourceMetadata` лежат поля `wdlBeforeBlunder`,
  `wdlAfterBlunder`, `blunderDelta`. Backend `resolveSolutionMode`
  по-прежнему их читает (`wdlAfterBlunder` нужен фронту для UI), на
  алгоритм генерации это не влияет.
- Новые пазлы будут писать `deltaW`, `deltaD` (с сохранением
  `wdlBefore`/`wdlAfter` raw для UI). Legacy и новые сосуществуют без
  миграции.

### 5.2 Backend `apps/tactic-worker`

**`apps/tactic-worker/src/puzzle-generator/generator-pipeline.ts`**:

- Импортировать `deltaWFromWdl`, `deltaDFromWdl` из `@kingside/shared`.
- В Stage 1 — `wdlBeforeRaw` обязателен (если null от mate-fallback —
  использовать fallback из §2.3).
- В Stage 4 — заменить расчёт `blunderDelta` на пару `deltaW`, `deltaD`.
- Триггер: `if (deltaW < HARD_DELTA_W && deltaD < HARD_DELTA_D)` →
  drop `deltaTooLow`. Константы `HARD_DELTA_W = 0.6`, `HARD_DELTA_D
  = 0.6` — модульные `const`, не передаются снаружи.
- After-фильтр §3.2: разбиение на `lowWAfter` / `lowWDAfter`.
- `sourceMetadata`: писать `deltaW`, `deltaD` вместо `blunderDelta`.
  Поля `wdlBefore`, `wdlAfter` (raw) — сохраняем (используются фронтом
  и api для UI).

**`apps/tactic-worker/src/puzzle-generator/types.ts`**:

- Удалить из `GeneratorOptions` поля `blunderDelta`, `minWdlAfterBlunder`.
- В `defaultGeneratorOptions()` — убрать.
- В `GeneratorStats.drops`: `notBlunder` → `deltaTooLow`,
  `lowWdlAfterBlunder` → `lowWAfter` + `lowWDAfter`.

**`apps/tactic-worker/src/cli/generate-puzzles.cli.ts`**:

- Удалить cases `'blunder-delta'`, `'min-wdl-after-blunder'` (передача
  таких флагов → `unknown CLI option`).
- В стартовом логе убрать `blunderDelta=...`, `minWdlAfterBlunder=...`.

**`apps/tactic-worker/src/puzzle-generator/generator-pipeline.spec.ts`**:

- Обновить ожидания — drop-keys и поля `sourceMetadata`.

**`apps/tactic-worker/scripts/generate-precision-batch.ts`**:

- Проверить, не передаёт ли `--blunder-delta` / `--min-wdl-after-blunder`
  в CLI — убрать если да.

### 5.3 Backend `apps/api/src/puzzle/puzzle.service.ts`

Метод `resolveSolutionMode` — добавить чтение `deltaW` / `deltaD` из
`sourceMetadata` (опц.) и пробрасывать в DTO `playVsEngine`. Существующее
чтение `wdlAfterBlunder` / `wdlBefore` / `wdlAfter` остаётся (нужно для
legacy и UI). Spec-тесты обновить.

### 5.4 Shared `packages/shared`

**`packages/shared/src/types/puzzle-gen.ts`** — `PUZZLE_GEN_DEFAULTS`:

- Удалить `blunderDelta: 0.6`.
- Удалить `minWdlAfterBlunder: 0.5`.
- Добавить `deltaWThreshold: 0.6`, `deltaDThreshold: 0.6`.
- Добавить `minWAfterForSolver: 0.5`,
  `minWPlusDAfterForSolver: 0.5` (для дифф. after-фильтра §3.2).
- Поля `halfMovesN`, `winThreshold`, `failThreshold`, `skipDecidedWdl`,
  `startPly` — остаются как есть.

**`packages/shared/src/utils/wdl.ts`**:

- Добавить `wdlOrMateFallback(wdl, score)` (§2.3).
- Добавить `deltaWFromWdl(before, afterRaw)` (§2.4).
- Добавить `deltaDFromWdl(before, afterRaw)` (§2.4).
- `wdlSigned` / `wdlSignedFromInfo` — оставить (используются в
  solvability/UI).

**`packages/shared/src/types/puzzle.ts`** — DTO `playVsEngine`:

- Добавить опциональные поля `deltaW?: number`, `deltaD?: number`. Legacy
  пазлы их не имеют — фронт отображает `wdlAfterBlunder` как раньше.

### 5.5 Frontend `apps/web`

**`apps/web/src/utils/puzzleGenerator.ts`**:

- `PuzzleGenSettings`: `blunderDelta` → `deltaWThreshold`,
  `deltaDThreshold`.
- `DEFAULT_PUZZLE_GEN_SETTINGS`: оба = 0.6 (из `PUZZLE_GEN_DEFAULTS`).
- Импорт `deltaWFromWdl`, `deltaDFromWdl` из shared.
- В цикле — формула §2.4 + триггер OR + after-фильтр §3.2.
- `SourceMetadata` тип: добавить `deltaW?: number`, `deltaD?: number`.
  Поле `blunderDelta?: number` пометить deprecated, не писать у новых.
- `solvabilityPasses` — без изменений.

**`apps/web/src/components/PuzzleGeneratorModal.tsx`**:

- Один слайдер «Minimum blunder strength» → два:
  - «Min ΔW» 30..90%, step 5%, default 60%.
  - «Min ΔD» 30..90%, step 5%, default 60%.
- Подписи и hint'ы — новые i18n-ключи (`puzzleGenerator.deltaW*`,
  `puzzleGenerator.deltaD*`).
- `loadSettings`: при чтении из LS старый ключ `blunderDelta`
  игнорируется (юзер один раз увидит дефолт 60/60 — приемлемо, как и
  при KS-2585).
- `resetSettings` — через новые ключи.

**`apps/web/src/utils/puzzleGenerator.test.ts`** — обновить тесты под
новые поля настроек и новые драйверы триггера.

**`apps/web/src/components/PuzzleGeneratorModal.test.tsx`** — обновить
тесты на два слайдера.

**`apps/web/src/i18n/locales/{en,ru}/translation.json`** — заменить
ключ `puzzleGenerator.blunderDelta*` на `puzzleGenerator.deltaW*` /
`puzzleGenerator.deltaD*`. Старые ключи удалить (`puzzleGenDraftKeys.
i18n.test.ts` проверит наличие новых).

**Опционально: `apps/web/src/components/puzzle/PlayVsEngineRunner.tsx`**
— UI runner пазла продолжает читать `wdlAfter` / `wdlAfterBlunder` для
шкалы win%, эти поля никуда не делись. Прямых правок не требуется,
если только не решим показать `deltaW`/`deltaD` где-то в summary —
вне scope этого ADR.

### 5.6 Тесты

`apps/tactic-worker/src/puzzle-generator/generator-pipeline.spec.ts` —
сценарии «blunder accepted» / «notBlunder dropped» переписать на
deltaW/deltaD.

`apps/web/src/utils/puzzleGenerator.test.ts` — то же.

`apps/api/src/puzzle/puzzle.service.spec.ts` — `resolveSolutionMode`
читает `deltaW`/`deltaD` опц. + сохраняет fallback на `wdlAfterBlunder`
для legacy.

E2E на «генерация пазла из реальной партии» — поиском не нашёл
интеграционного test'а на полный путь PGN → /precision; в текущем
покрытии генератор тестируется на mock-engine. Отдельной задачи на
интеграционный тест не предлагаю.

---

## 6. Декомпозиция на тикеты

| Ключ | Кто | Summary | Содержание |
|---|---|---|---|
| **A1** | architect | ADR-068 + Partially Supersedes отметка в ADR-050 | Этот документ; правка шапки ADR-050: «Status: Partially Superseded by ADR-068 in §2.1 / §3 #5 (метрика блaндера)». **Выполнено этим коммитом.** |
| **S1** | backend | Shared: новые утилиты дельт + обновление PUZZLE_GEN_DEFAULTS + DTO | `packages/shared/src/utils/wdl.ts` — добавить `wdlOrMateFallback`, `deltaWFromWdl`, `deltaDFromWdl` + тесты. `packages/shared/src/types/puzzle-gen.ts` — удалить `blunderDelta`/`minWdlAfterBlunder`, добавить `deltaWThreshold`/`deltaDThreshold`/`minWAfterForSolver`/`minWPlusDAfterForSolver`. `packages/shared/src/types/puzzle.ts` — `playVsEngine.deltaW?`, `deltaD?` опц. `npm run build` в shared. |
| **B1** | backend | tactic-worker: переписать генератор + CLI + api resolver | `apps/tactic-worker/src/puzzle-generator/generator-pipeline.ts` — новая логика §3.2 (триггер OR, after-фильтр, sourceMetadata). `types.ts` — удалить `blunderDelta`/`minWdlAfterBlunder` из options + переименование drop-keys. Hardcoded `const HARD_DELTA_W=0.6, HARD_DELTA_D=0.6` в pipeline. `cli/generate-puzzles.cli.ts` — убрать `--blunder-delta`, `--min-wdl-after-blunder`. Spec обновить. `apps/api/src/puzzle/puzzle.service.ts:resolveSolutionMode` — добавить чтение `deltaW`/`deltaD`. Spec обновить. |
| **F1** | frontend | puzzleGenerator.ts + PuzzleGeneratorModal: deltaW/deltaD UI | `apps/web/src/utils/puzzleGenerator.ts` — переписать настройки + цикл. `apps/web/src/components/PuzzleGeneratorModal.tsx` — два слайдера. `apps/web/src/utils/puzzleGenerator.test.ts` + `PuzzleGeneratorModal.test.tsx` — обновить. i18n: ключи `puzzleGenerator.deltaW*` / `deltaD*` в en+ru. |

**Зависимости и порядок:**

```
A1 (architect)      ──► merge сразу
                         │
S1 (shared)         ──► merge ПЕРВЫМ (B1 и F1 импортируют новые утилиты)
                         │
B1 (backend)        ──┐
F1 (frontend)       ──┴─► merge параллельно после S1
```

S1 — синхронный блокер для B1/F1 (без `deltaWFromWdl` / `deltaDFromWdl`
в shared они не скомпилируются). B1 и F1 — независимы по файлам, можно
параллелить.

Деплоя отдельным тикетом не требуется: изменения чистые refactor +
переименование локальных констант, никаких миграций БД / ENV / CLI на
проде (CLI запускается локально/админом, флаги `--blunder-delta`
просто перестают приниматься).

---

## 7. Acceptance ADR-068

- [x] Этот документ создан в `docs/adr/068-puzzle-gen-delta-w-delta-d.md`.
- [x] ADR-050 шапка отмечена «Partially Superseded by ADR-068».
- [ ] Тикеты S1, B1, F1 заведены координатором по списку выше
  (координатор делает по этому ADR; architect код не правит).
