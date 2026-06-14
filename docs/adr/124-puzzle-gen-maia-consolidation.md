# ADR-124: Консолидация конвейера генерации пазлов и Maia weak-choice в общие пакеты

**Статус:** Предложено (проектирование KS-4100, Part 2). Реализация — backend (packages + tactic-worker) и frontend (apps/web) после согласования координатором.
**Дата:** 2026-06-14
**Задача:** KS-4100 (проектирование). Связано: KS-4098 (browser-entry + batch, готово), KS-4096 (клиентская метрика), KS-3577 (браузерная Maia), KS-4097 (закрыта — ложная посылка «Maia только серверная»).
**Связанные ADR:** ADR-104 (precision Maia-фильтр), ADR-106 (Maia weak-choice метрика), ADR-070 (shared puzzle-gen pipeline).

---

## 1. Контекст

### 1.1 Поправка к посылке задачи (сверено с кодом, не по памяти)

Формулировка KS-4100 говорит, что «клиентский и серверный генераторы всё ещё держат **отдельные пайплайны**». По факту кода это **уже не так** — значительная часть консолидации сделана в KS-4098 и раньше (ADR-070):

**Уже общее (дублирования НЕТ):**
- **Pipeline генерации** — `packages/shared/src/utils/puzzle-gen-pipeline.ts`: `replayPgnToSteps`, `analyzePlyForBlunder`, `buildPuzzlesFromCandidate`, `processGameForPuzzles` с DI-интерфейсом движка `PuzzleGenEngine`. Клиент (`ClientPuzzleGenEngine` в `apps/web/src/utils/puzzleGenerator.ts`) и сервер (`apps/tactic-worker/.../generate-puzzles.cli.ts`) **оба** оборачивают этот pipeline.
- **Ядро поиска зевков** — `packages/shared/src/utils/puzzle-gen-core.ts`: `evaluateBlunder` (ΔW/ΔD), `determinePuzzleObjective`, solvability-проверки. Общее.
- **Pure-математика weak-choice** — `packages/maia-core/src/weak-choice.ts`: `computeWeakChoiceProb`, `buildMaiaSearchMoves`. Клиент берёт её из `@kingside/maia-core/browser`, сервер — из корня. Формула не дублируется.
- **WDL-утилиты** — `packages/shared/src/utils/wdl.ts`: `expectedScoreFromWdl`, `wdlOrMateFallback`. Общее.

**Реально ещё дублируется (это и есть остаток Part 2):**

| # | Что | Клиент | Сервер | Природа дубля |
|---|-----|--------|--------|----------------|
| **D1** | Maia-3 движок + препроцессинг тензоров | `apps/web/src/lib/maia/engine.ts` + `tensor.ts` (собственная копия, импортирует локальный `./tensor`, **свой дубль интерфейса `InferenceProvider`**) | `packages/maia-core/src/engine.ts` + `tensor.ts` | Полная копия inference-математики (наследие KS-3577). `lib/maia` — НЕ обёртка над maia-core, а параллельная реализация. |
| **D2** | Оркестрация weak-choice (Maia policy → SF MultiPV `searchmoves` → expectedScores → `computeWeakChoiceProb`) | `apps/web/src/utils/maiaWeakChoice.ts::computeMaiaAnnotation` | `apps/tactic-worker/src/maia/maia-annotation.service.ts::annotate` | Один 5-шаговый алгоритм, две копии glue-кода. Pure-функции общие, но связка между ними скопирована. |

Вывод: задача — не «вынести всё ядро» (оно вынесено), а **устранить D1 и D2** и зафиксировать провайдерные швы, чтобы класс расхождений вроде `maiaWeakChoiceProb=null` (KS-4096) больше не воспроизводился.

### 1.2 Существующие провайдерные швы

- **`InferenceProvider`** (`packages/maia-core/src/engine.ts`) — onnxruntime-seam Maia. Клиент даёт `onnxruntime-web`, сервер — `node-provider.ts` (`onnxruntime-node` + `loadModelFromFs`). Дубль того же интерфейса лежит в `lib/maia/engine.ts` — лишний.
- **`PuzzleGenEngine.analyze(fen, multiPV, ctx)`** (`packages/shared`) — seam Stockfish для генерации. НЕ покрывает потребности weak-choice (нет `searchMoves`/`depth`). Для D2 нужен отдельный узкий seam.
- **Хост Maia-инференса**: клиент — singleton `predictMoves` (`lib/maia/index.ts`, IndexedDB + web worker); сервер — `MaiaAnnotationService.getEngine()` (ленивый singleton, fs-модель). И в `apps/api` есть третий потребитель `position-comment/maia.service.ts` (forced-line фильтр) — уже на maia-core, вне scope.

### 1.3 Ограничения проекта

Один разработчик, ограниченные ресурсы сервера. Срочности нет (фронт разблокирован KS-4098). Значит: минимум новых сущностей, без нового пакета, миграция фазами с тестовыми гардами, каждая фаза отгружается независимо.

---

## 2. Решение

### 2.1 Где размещать (границы пакетов)

**Не создавать новый пакет.** Разнести по двум существующим по ответственности:

- **`@kingside/shared`** — остаётся домом pipeline генерации (`puzzle-gen-pipeline.ts`, `puzzle-gen-core.ts`, `wdl.ts`). Не трогаем, кроме инварианта firstMovePV1 (см. §2.4).
- **`@kingside/maia-core`** — становится **единственным** домом: (а) Maia-3 движка и тензоров (D1), (б) **оркестрации weak-choice** (D2). Он уже владеет движком, pure-математикой weak-choice, node-провайдером и `/browser`-входом — оркестрации логично жить рядом.

Обоснование: третий пакет добавил бы граф зависимостей и сборку ради одной функции; швы «browser vs node» уже существуют и работают (esbuild-бандл `browser.mjs`, external `chess.js`). Меньше движущихся частей для одного разработчика.

### 2.2 Провайдерные интерфейсы (абстракции движков)

Один код оркестрации, реализации движков подставляются хостом:

1. **`InferenceProvider`** (уже есть в maia-core) — onnxruntime-seam Maia. После миграции остаётся ровно один (дубль в `lib/maia` удаляется). Клиент → onnxruntime-web, сервер → `node-provider`.

2. **`MaiaPolicySource`** (новый, узкий, в maia-core) — абстрагирует ХОСТ Maia-инференса от оркестрации:
   ```ts
   interface MaiaPolicySource {
     predictMoves(fen: string, eloSelf: number, eloOpponent: number): Promise<PredictResult>;
   }
   ```
   Класс `Maia` уже удовлетворяет ему как есть. Клиент передаёт singleton из `lib/maia`, сервер — `MaiaAnnotationService`-движок, тесты — мок.

3. **`WeakChoiceAnalysisEngine`** (новый, узкий, в maia-core) — Stockfish-seam именно для weak-choice (с `searchMoves` + WDL), которого нет в `PuzzleGenEngine`:
   ```ts
   interface WeakChoiceAnalysisEngine {
     analyzeWithWdl(
       fen: string,
       opts: { depth: number; multiPV: number; searchMoves: string[] },
     ): Promise<Array<{ pv: string[]; score: WdlScoreInfo; wdl?: Wdl | null }>>;
   }
   ```
   Клиент адаптирует `EngineAdapter.analyze(fen, depth, multiPV, _, _, searchMoves)`; сервер — `StockfishService.analyzePositionWdl(fen, {depth}, multiPV, …, searchMoves)`.

   *Прим.:* `WeakChoiceAnalysisEngine` и `PuzzleGenEngine` пока НЕ объединяем — разные сигнатуры, объединение тронуло бы рабочий pipeline-seam без выгоды в рамках Part 2. Возможное будущее слияние в единый `ChessAnalysisEngine` (superset) — отдельной задачей, отмечено как нерешённое (§5).

4. **Консолидированная оркестрация** (новая, в maia-core, чистая — без платформенных зависимостей):
   ```ts
   function annotateWeakChoice(args: {
     fen: string;
     firstMovePV1: string;
     maia: MaiaPolicySource;
     engine: WeakChoiceAnalysisEngine;
     elo: number;
     sfDepth?: number;
     multiPvCap?: number;
   }): Promise<{ weakChoiceProb: number; metricVersion: number; elo: number } | null>;
   ```
   Внутри — ровно 5 шагов, сейчас скопированных в D2. Доступна и из `@kingside/maia-core/browser` (без node-провайдера — инвариант KS-4096/4102: фронт НЕ должен тянуть корневой `@kingside/maia-core`).

### 2.3 Как клиент и сервер подставляют реализации

| Слой | Клиент (`apps/web`) | Сервер (`apps/tactic-worker`) |
|------|---------------------|-------------------------------|
| Maia-движок | `Maia` из `@kingside/maia-core/browser` + провайдер onnxruntime-web + IndexedDB (`storage.ts`) | `Maia` из `@kingside/maia-core` + `node-provider` + `loadModelFromFs` |
| `MaiaPolicySource` | singleton `lib/maia` | `MaiaAnnotationService`-движок |
| `WeakChoiceAnalysisEngine` | адаптер над `EngineAdapter` (WASM/Bridge) | адаптер над `StockfishService.analyzePositionWdl` |
| Оркестрация | `maiaWeakChoice.ts` → тонкая обёртка над `annotateWeakChoice` | `MaiaAnnotationService.annotate` → тонкая обёртка над `annotateWeakChoice` |

После миграции `lib/maia` сжимается до **хост-слоя браузера** (нельзя вынести в платформенно-нейтральный пакет): `index.ts` (сборка `Maia` из maia-core + провайдер + singleton), `storage.ts` (IndexedDB), `maia.worker.ts`/`workerEngine.ts` (web worker), `uciToSan.ts` (UI-util). Удаляются `engine.ts` и `tensor.ts` (копии maia-core).

### 2.4 Инвариант firstMovePV1 (корень `null`-кейса)

В KS-4096 2 из 13 client-generated пазлов не имели `sourceMetadata.firstMovePV1` → аннотация падала `no-solution-uci`. Это **не клиентский патч**, а инвариант общего pipeline: `buildPuzzlesFromCandidate` (`packages/shared`) ОБЯЗАН всегда заполнять `sourceMetadata.firstMovePV1` для обеих фаз (reactive: `pv1BeforeUci`/`firstMoveAfterUci`; preventive: `preventiveCorrectMoveUci`). Чинить — один раз в shared, тогда исправляется и клиент, и сервер. Координатор формулировал это как «frontend — гарантировать firstMovePV1»; архитектурно правильнее закрыть в shared-пайплайне (consumed обоими).

---

## 3. Разнесение работ

**Backend (packages + сервер):**
1. `@kingside/maia-core`: добавить интерфейсы `MaiaPolicySource`, `WeakChoiceAnalysisEngine` и функцию `annotateWeakChoice`; экспортировать из корня и из `/browser`. Unit-тест на моках движков (golden-вектор weakChoiceProb).
2. `@kingside/shared`: гарантировать `sourceMetadata.firstMovePV1` в `buildPuzzlesFromCandidate` (инвариант §2.4) + тест.
3. `apps/tactic-worker`: `MaiaAnnotationService.annotate` делегирует в `annotateWeakChoice` через адаптер `StockfishService` → `WeakChoiceAnalysisEngine`. Гард: `maia-annotation.service.spec.ts` зелёный.
4. Сверка дрейфа D1: diff `packages/maia-core/src/{engine,tensor}.ts` против `apps/web/src/lib/maia/{engine,tensor}.ts`; расхождения (если есть) свести В maia-core ПЕРЕД удалением клиентской копии. Гард: `maia-core/engine.test.ts`.

**Frontend (apps/web):**
5. `lib/maia`: удалить `engine.ts` + `tensor.ts`; `index.ts` строит `Maia` из `@kingside/maia-core/browser` (провайдер onnxruntime-web + IndexedDB `storage.ts` сохраняются). Web worker и `uciToSan.ts` остаются.
6. `utils/maiaWeakChoice.ts::computeMaiaAnnotation` → тонкая обёртка: адаптер `EngineAdapter` → `WeakChoiceAnalysisEngine`, `predictMoves` → `MaiaPolicySource`, вызов `annotateWeakChoice`. 5-шаговое тело удалить.
7. Проверка production vite-сборки: фронт НЕ тянет корневой `@kingside/maia-core`/node-provider (инвариант KS-4096/4102). Гард: `precision-consistency.test.ts` + сборка.

**QA:** паритет-тест — одинаковые `fen`+`firstMovePV1`+policy+WDL дают идентичный `weakChoiceProb` на клиенте и сервере (риск D2 — параллельная оркестрация; после слияния — один код).

---

## 4. План миграции без регрессий (порядок фаз)

- **Фаза 0 (backend):** сверка дрейфа D1 (шаг 4). Если копии идентичны — удаление безопасно; если дрейф — сначала свести в maia-core. Блокирует фронт-фазу 3.
- **Фаза 1 (backend, packages):** интерфейсы + `annotateWeakChoice` в maia-core (шаг 1) + инвариант firstMovePV1 (шаг 2). Потребители ещё не тронуты — нулевой риск регрессии.
- **Фаза 2 (backend):** делегирование сервера (шаг 3). Гард — существующий spec.
- **Фаза 3 (frontend):** сведение `lib/maia` к maia-core (шаг 5) + делегирование `maiaWeakChoice` (шаг 6) + проверка сборки (шаг 7). Зависит от фаз 0–1.
- **Фаза 4 (cleanup):** удалить мёртвые дубли (`InferenceProvider` в `lib/maia`), убедиться в едином источнике.

Каждая фаза самостоятельно отгружаема и покрыта тестом. Опора — `@kingside/maia-core/browser` уже существует (KS-4098), поэтому фронт-сторона — это редирект импортов + тонкие адаптеры, а не новая инфраструктура.

---

## 5. Последствия и нерешённое

**Плюсы:** единый источник Maia-движка и оркестрации weak-choice → класс багов «расхождение клиент/сервер» (KS-4096) устранён конструктивно; без нового пакета; малая поверхность правок; миграция низкого риска при фазовом порядке.

**Цена:** в `apps/web` остаётся неустранимый тонкий хост-слой (IndexedDB, web worker, onnxruntime-web lazy-import) — это браузерные API, в платформенно-нейтральный пакет не выносятся. Это не дубль логики, а платформенный адаптер.

**Риск:** дрейф D1 между двумя копиями движка — обязательная сверка в Фазе 0 до удаления.

**Нерешённое (вне Part 2):**
- Объединять ли `WeakChoiceAnalysisEngine` и `PuzzleGenEngine` в единый `ChessAnalysisEngine` (superset с опциональными `searchMoves`/`depth`) — потенциально, отдельной задачей.
- Третий потребитель Maia `apps/api/position-comment/maia.service.ts` (forced-line фильтр) — уже на maia-core, в этой консолидации не участвует.
- Web worker для Maia на клиенте сейчас опционален (main-thread инференс); вынос инференса в worker — отдельная задача (упомянута в `lib/maia/engine.ts`).
