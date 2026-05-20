# ADR-050 — Унификация клиентской генерации пазлов с серверной (WDL-зевок, draft/publish flow)

- Статус: **Partially Superseded by ADR-068 (2026-05-20)** — §2.1 (формула
  `blunderΔ = wdlBefore + wdlAfterForSolver ≥ 0.6`) и §3 #5
  (`PUZZLE_GEN_DEFAULTS.blunderDelta` / `minWdlAfterBlunder`) заменены
  парой независимых метрик `deltaW` / `deltaD` с порогами 0.6 / 0.6 и
  дифференцированным after-фильтром. Остальное (источник `UCI_ShowWDL`,
  draft/publish-flow, общий код в `packages/shared`, режим
  `play-vs-engine`) — остаётся актуальным.
- Статус (исторический): Proposed
- Дата: 2026-05-07
- Связанные задачи: KS-2579
- Связанные ADR: ADR-041 (legacy forced-line generator), ADR-044 (play-vs-engine pivot, WDL), ADR-048 (precision section), ADR-046 (puzzle stats)
- Связанные тикеты: KS-2578 (разнесение `/puzzles` lichess vs `/precision` generated), KS-2521 (UCI_ShowWDL в WasmEngineAdapter)
- Авторы: architect

---

## 1. Контекст

Серверная генерация пазлов (`apps/tactic-worker/src/puzzle-generator/`, ADR-044) и клиентская (`apps/web/src/utils/puzzleGenerator.ts`, UI «Генерация из PGN») сейчас **используют разные алгоритмы**:

- **Сервер** ищет **зевок по WDL** (`(W−L)/1000` от Stockfish UCI_ShowWDL): blunderΔ = `wdlBefore + wdlAfterForSolver ≥ 0.6`. Сохраняет позицию **после зевка** в режиме `solutionMode='play-vs-engine'` (`moves=''`, интерактивная игра против движка).
- **Клиент** ищет **уникальный лучший ход** через cp-разницу между N-й и (N+1)-й линиями текущей позиции (gap ≥ 50 cp). Сохраняет PV1 (до 8 ходов) как `moves`, `solutionMode` отсутствует (default `forced-line`).

Это два разных продукта в одной кодовой базе. Пользователь просит унифицировать на серверный путь — генерация на клиенте должна:
1. Использовать WDL-метрику и порог blunderΔ (дефолт 60%).
2. Сохранять пазлы как **draft** (`isPublic=false`) — приватные для автора.
3. Иметь явную кнопку «Опубликовать в /precision» (`isPublic=true`).
4. После публикации пазл попадает в общий список `/precision` (после KS-2578 фильтр там по `source='generated'`).

### 1.1 Сравнение текущих алгоритмов

| Параметр | Серверная (`tactic-worker`, ADR-044) | Клиентская (`puzzleGenerator.ts`) |
|----------|---------------------------------------|------------------------------------|
| Метрика | WDL_signed `(W−L)/1000` от UCI_ShowWDL | cp-based (без UCI_ShowWDL) |
| Триггер | `blunderΔ = wdlBefore + wdlAfterForSolver ≥ 0.6` (между **двумя** позициями: до и после хода) | `gap = |cp(line N) − cp(line N+1)| ≥ 50` (внутри **одной** позиции, multiPV) |
| MultiPV | 2 (для PV1 + sample) | 3 (для расчёта gap между линиями) |
| Что хранится | `fen` после зевка, `moves=''`, `solutionMode='play-vs-engine'`, `sourceMetadata.{blunderMove, wdlBeforeBlunder, wdlAfterBlunder, halfMovesN, …}` | `fen` текущая, `moves=PV1 до 8 полуходов`, `acceptedMoves` (top N), `sourceMetadata.{bestScore, bestMove, secondBestScore, secondBestMove}` |
| solutionMode в БД | `'play-vs-engine'` | (отсутствует → DB default `'forced-line'`) |
| `isPublic` дефолт при сохранении | `true` (`generator-pipeline.ts:377`) | `true` (hardcoded в `puzzle.controller.ts:327`) |
| Solvability-check | да, `halfMovesN=6` SF-vs-SF | нет |
| Дополнительные фильтры | `samePv1` (ход партии = PV1 → drop), `skipDecided` (`|wdlBefore|>0.95` → drop), `minWdlAfterBlunder ≥ 0.5` | `skipHangingCapture`, `skipAttackedByLesser`, `skipUndefendedAfterMove`, `maxSecondCp`, эвристики «обоснованности» хода |
| Тегирование | `computeTags` (drill-предикаты) + `playVsEngine` тех.тег | `classifyThemes` (mate/crushing/advantage/capture/check/endgame…) |
| Рейтинг | `computeStartingRating(row, wdlAfter)` — на основе Elo игроков партии и силы зевка | `estimateRating(fen, pv, isMate)` — эвристика по типу хода (sacrifice/quiet/check/capture) |

### 1.2 Что уже подготовлено

Полностью реюзаем серверный код через перенос алгоритма:

- **`apps/tactic-worker/src/puzzle-generator/score.ts`** содержит чистые функции `wdlSigned`, `wdlSignedFromInfo` — реэкспортируем в shared-пакет (`packages/shared/src/utils/wdl.ts`) и юзаем на клиенте.
- **`apps/tactic-worker/src/puzzle-generator/types.ts:defaultGeneratorOptions`** — все дефолты (`blunderDelta=0.6`, `halfMovesN=6`, `winThreshold=0.5`, `failThreshold=0.0`, `skipDecidedWdl=0.95`, `minWdlAfterBlunder=0.5`) — переносим в shared.
- **`packages/shared/src/types/lessons.ts:PuzzleSolutionMode`** уже есть — `'forced-line' | 'play-vs-engine'`.
- **WasmEngineAdapter** в `apps/web/src/utils/engineAdapter.ts:85-149` уже парсит info-строки regex'ом — нужно (а) включить `setoption name UCI_ShowWDL value true` в `init()`, (б) расширить regex захватом `wdl W D L` (ровно как в backend `apps/tactic-worker/src/stockfish/stockfish.service.ts:330-356`), (в) прокинуть `wdl?: { w, d, l }` в `InfoLine`. Этот вопрос пересекается с KS-2521 (W/D/L отображение в play-vs-engine summary) — координируем.
- **Backend `POST /puzzles/batch`** (`apps/api/src/puzzle/puzzle.controller.ts:307-332`) — сейчас hardcode `isPublic: true`, не принимает `solutionMode`. Нужно расширить.

---

## 2. Решение

### 2.1 Алгоритм клиентской генерации (новый)

Псевдокод (зеркало `tactic-worker/src/puzzle-generator/generator-pipeline.ts:processGame`):

```
для каждой партии:
  replay PGN, на каждом ply ≥ startPly:
    fenBefore = текущая позиция до хода
    playedUci = ход партии
    apply move → fenAfter
    if isGameOver(fenAfter): drop (gameOver)
    if ply < startPly (default 20): пропустить, ход дальше

  pass 1: для всех собранных tasks параллельно (один WASM = последовательно):
    pre = analyze(fenBefore, depth, multiPV=2) → wdlBefore = (W−L)/1000 POV side-to-move
    if pre.PV1 == playedUci: drop (samePv1)
    if |wdlBefore| > 0.95: drop (skipDecided)

  pass 2: для оставшихся:
    post = analyze(fenAfter, depth, multiPV=2) → wdlAfter = (W−L)/1000 POV соперника зевнувшего
    wdlAfterForSolver = -wdlAfter (POV решающего, инверсия)
    blunderΔ = wdlBefore + wdlAfterForSolver       // оба POV side-to-move до/после соответственно
    if blunderΔ < blunderDelta (default 0.6): drop (notBlunder)
    if wdlAfterForSolver < minWdlAfterBlunder (default 0.5): drop (lowWdlAfterBlunder)

  pass 3 (опционально, тяжёлый): solvability check
    if option.solvabilityCheck === true:
      сыграть halfMovesN полуходов SF-vs-SF от fenAfter
      если на любом шаге wdl_for_solver < failThreshold (0.0): drop
      финальный wdl ≥ winThreshold (0.5): pass
      иначе: drop (solvabilityFailed)

  для каждой принятой позиции: записать с
    solutionMode='play-vs-engine'
    moves=''
    acceptedMoves=null
    sourceMetadata = { blunderMove, wdlBeforeBlunder, wdlAfterBlunder, halfMovesN, winThreshold, failThreshold, blunderDelta, depth, ... }
    isPublic=false                  // <- DRAFT, новое поведение
    rating = computeStartingRating(playerRatings || 1500, wdlAfterBlunder)
    themes = computeTagsClient(...) + 'playVsEngine'  // FE-вариант computeTags
```

**Удаляем** legacy логику клиентского генератора:
- `gapThreshold`, `maxSecondCp`, `topSpread`, `multiPv` (ставим фиксированно 2)
- `skipHangingCapture`, `skipAttackedByLesser`, `skipUndefendedAfterMove`
- `acceptedMoves` (для play-vs-engine не нужны)
- `evalGrowth` (не используется)

### 2.2 Параметры в UI

| Параметр | Default | Range | Виден пользователю |
|----------|---------|-------|---------------------|
| `depth` | 14 | 8..22 | да, slider |
| `blunderDelta` | 0.6 (60%) | 0.30..0.90 | да, slider в % с подписью «Минимальная сила зевка» |
| `solvabilityCheck` | false | toggle | да, чекбокс «Строгая проверка решаемости (медленнее)» |
| `halfMovesN` | 6 | (фикс) | нет — внутренний default |
| `winThreshold` / `failThreshold` / `minWdlAfterBlunder` / `skipDecidedWdl` | 0.5/0.0/0.5/0.95 | — | нет — серверные дефолты |
| `startPly` | 20 | (фикс) | нет |

**Solvability-check на WASM Stockfish 1 поток** ≈ 1с/позиция × 6 полуходов = 6с/пазл сверх анализа. На батче 50 позиций — лишние ~5 мин. Поэтому делаем **опциональным**, по умолчанию выключен. Опытные пользователи включат его если хотят чище отбор.

### 2.3 Draft/Publish flow

#### Текущее поведение
- `POST /puzzles/batch` ставит `isPublic: true` для всех записей. UI после сохранения переходит на `/puzzles?mine=true`.

#### Новое
- `POST /puzzles/batch` принимает `isPublic` per-puzzle в payload (default `false`). Hardcoded `true` в `puzzle.controller.ts:327` убираем.
- Клиент шлёт `isPublic: false` для всех новых пазлов.
- После сохранения UI показывает: «N puzzles saved as drafts» + две кнопки:
  - **«Posмотреть мои черновики»** → переход на `/precision?mine=true&visibility=draft` (страница уже умеет фильтр `?mine=true` — добавляем `visibility` фильтр в backend).
  - **«Опубликовать всё в Тренировку точности»** → `PATCH /puzzles/publish-all` (уже есть, ставит `isPublic=true` по `createdBy=me, source='generated'`). После успеха — переход на `/precision`.
- На странице `/precision?mine=true` (или `PuzzleBrowserPage` mine-вкладка) у каждого draft-пазла появляется кнопка «Опубликовать» → `PATCH /puzzles/:id { isPublic: true }` (endpoint уже есть, `puzzle.controller.ts:351-365`).

#### Visibility-фильтр в API
`GET /puzzles/browse` уже принимает `mine`. Добавляем опциональный `visibility=public|draft|all` (default `all` для совместимости). Когда `mine=true` — owner видит и свои drafts, и публичные. Когда `mine=false` — backend всегда добавляет `is_public=true` (страховка).

### 2.4 Где живут результаты после KS-2578

KS-2578 фронт фильтрует:
- `/puzzles` → `?source=lichess`
- `/precision` → `?source=generated`

Сгенерированные через клиентскую генерацию пазлы автоматически попадают в `/precision` (т.к. backend `POST /puzzles/batch` ставит `source: 'generated'` без вариантов, см. `puzzle.controller.ts:323`). Для draft (`isPublic=false`) их видит **только автор** через `?mine=true`. После publish — все пользователи.

### 2.5 WasmEngineAdapter и UCI_ShowWDL

Это пересечение с KS-2521 расширенной декомпозицией. Чтобы не дублировать тикеты — **этот ADR опирается на тикеты UCI_ShowWDL из KS-2521 как зависимости**:
- KS-2521-#3 frontend: `WasmEngineAdapter.init()` отправляет `setoption name UCI_ShowWDL value true`.
- KS-2521-#4 frontend: `parseInfoLine` парсит `wdl W D L`, прокидывает в `InfoLine`/`AnalysisResult`.

После их выкатки `puzzleGenerator.ts` использует `info.wdl` напрямую, без новой инфраструктуры на адаптере. Если KS-2521 ещё не закрыт к моменту работы над этим ADR — копируем regex (он короткий) во временное решение и возвращаемся к unification после.

### 2.6 Что НЕ меняем

- **Серверный pipeline** (`tactic-worker`) — без изменений.
- **БД-схема** `puzzles` — без изменений (`solutionMode`, `is_public`, `source` колонки уже существуют).
- **`POST /puzzles/batch` ограничение 200** записей за вызов — оставляем.
- **`PATCH /puzzles/publish-all`** — оставляем как есть, он публикует всё `createdBy=me, source='generated'`.
- **`computeTags` серверный** — НЕ переносим на клиент целиком (тяжёлые drill-предикаты с зависимостями от `chess.js`). Делаем упрощённую `computeTagsClient` — теги по WDL-bucket'ам (`crushing` ≥ 0.95, `advantage` ≥ 0.5), эндшпилю (≤ 7 фигур), мату, тех.тег `playVsEngine`. Остальные drill-теги (`fork`, `pin` etc.) — серверный pipeline проставляет, клиентская версия может оставить пустыми.
- **Bridge engine** — продолжает работать, его `analyze` уже умеет возвращать любые info-поля движка.

---

## 3. Декомпозиция на тикеты

Все тикеты в **To Do**. Префикс `[Client puzzle gen]`.

| # | Тема | Исп. | Размер | Зависит от |
|---|------|------|--------|------------|
| 1 | Backend: `POST /puzzles/batch` принимает per-puzzle `isPublic` (default `false`) и `solutionMode` (`'forced-line'\|'play-vs-engine'`, default `'forced-line'`). Убрать hardcoded `isPublic: true` в `puzzle.controller.ts:327`. Юнит-тесты на оба значения isPublic + solutionMode | backend | S | — |
| 2 | Backend: shared-DTO `BatchPuzzleItem` (если есть в `packages/shared/src/types/...`) расширить `isPublic?: boolean`, `solutionMode?: PuzzleSolutionMode`. Если нет — добавить. Зеркалить frontend `GeneratedPuzzleData` тип | backend | XS | #1 |
| 3 | Backend: `GET /puzzles/browse` опциональный query `visibility=public\|draft\|all` (default `all`). Поведение: `mine=true` + `visibility=draft` → только `is_public=false`; `mine=true` + `visibility=public` → только `is_public=true`. Юнит-тест | backend | S | — |
| 4 | Shared: вынести `wdlSigned`, `wdlSignedFromInfo`, тип `Wdl` из `apps/tactic-worker/src/puzzle-generator/score.ts` в `packages/shared/src/utils/wdl.ts`. Также вынести `defaultGeneratorOptions` константы (`blunderDelta=0.6`, `halfMovesN=6`, `winThreshold=0.5`, `failThreshold=0.0`, `skipDecidedWdl=0.95`, `minWdlAfterBlunder=0.5`, `startPly=20`) как именованный экспорт `PUZZLE_GEN_DEFAULTS`. Tactic-worker импортирует из shared, не дублирует | backend | S | — |
| 5 | Frontend: переписать `apps/web/src/utils/puzzleGenerator.ts` на WDL-алгоритм (§2.1). Использовать `wdl` поле из `InfoLine` (зависит от UCI_ShowWDL — KS-2521-#3, KS-2521-#4 или временный inline-regex). Удалить legacy фильтры (`skipHanging…`, `gapThreshold`, `maxSecondCp`). Output payload: `solutionMode='play-vs-engine'`, `moves=''`, `isPublic=false`, `sourceMetadata.{blunderMove, wdlBeforeBlunder, wdlAfterBlunder, blunderDelta, halfMovesN}`. Solvability-check как опц.флаг (default off). Полные unit-тесты на: detection blunder при WDL +0.7→−0.7 = blunderΔ 1.4; samePv1 drop; skipDecided drop; minWdlAfterBlunder drop | frontend | M | #4, KS-2521-#3, KS-2521-#4 |
| 6 | Frontend: переписать `PuzzleGeneratorModal` — UI с новыми параметрами (depth slider 8..22, blunderDelta slider 30..90% с подписью «Минимальная сила зевка», toggle «Строгая проверка (медленнее)»). Удалить старые параметры (multiPv, gapThreshold, maxSecondCp, чекбоксы skipHanging/skipAttacked/skipUndefended). Localstorage migration `puzzleGenSettings` — старые ключи игнорируем, fallback на новые defaults. После сохранения: «N saved as drafts» + 2 кнопки «My drafts» (`/precision?mine=true&visibility=draft`) и «Publish all to Precision» (PATCH publish-all, navigate `/precision`) | frontend | M | #5 |
| 7 | Frontend: на `PuzzleBrowserPage` mine-вкладке (или `/precision?mine=true`) — кнопка «Опубликовать» рядом с draft-пазлом → `PATCH /puzzles/:id {isPublic: true}`. Optimistic update (`patchLocally`). Тест в `apps/web/src/hooks/useInfinitePuzzles.test.ts` (или соседний) | frontend | S | #1, #3 |
| 8 | i18n: ключи RU/EN — `puzzleGenerator.{blunderDelta, blunderDeltaLabel, blunderDeltaHint, solvabilityCheck, solvabilityCheckHint, savedAsDrafts, myDrafts, publishAll, publishToPrecision, publishOne}`, удалить устаревшие `gapThreshold/maxSecond/skipHanging…` | frontend | XS | #6, #7 |
| 9 | Layout/CSS: оформление новых slider'ов (depth, blunderDelta) и toggle (solvability) в `PuzzleGeneratorModal`. Кнопка «Publish» в puzzle-card | layout | XS | #6, #7 |
| 10 | QA: e2e — сгенерировать пазл из тестового PGN с явным зевком, проверить что (а) пазл появляется как draft (нет на `/precision` без mine), (б) видно в `/precision?mine=true&visibility=draft`, (в) после Publish all виден на `/precision` без фильтров. Старая логика clientского forced-line больше не работает: пазл сохраняется с `solutionMode='play-vs-engine'`, `moves=''` | qa | S | все остальные |

### Граф зависимостей

```
#1 (BE batch isPublic+solutionMode) ──┐
                                       ├──► #7 (FE publish button)
#3 (BE visibility filter) ─────────────┘
                                       
#4 (shared wdl utils) ──► #5 (FE generator algo) ──► #6 (FE modal UI)
                                                       │
                                                       ├──► #8 (i18n)
                                                       ├──► #9 (CSS)
                                                       ▼
                                                     #10 (qa e2e)
```

Параллелизм: #1 + #3 + #4 параллельно. KS-2521-#3/#4 (UCI_ShowWDL в WasmEngineAdapter) — внешняя зависимость для #5; если они ещё не выкачены, #5 копирует regex в `puzzleGenerator.ts` временно. #2 — мини-тикет на DTO, можно делать в рамках #1.

---

## 4. Открытые вопросы

1. **Solvability-check на WASM 1 поток — слишком медленно?** Если включён, batch на 50 пазлов добавляет ~5 минут. Митигация: опц. флаг (default off). Если есть Bridge engine — ускорится в N раз (multi-thread). Можно показать в UI «With Bridge: ~1 min, with WASM: ~5 min» когда включают solvability.
2. **`computeTagsClient` — упрощённая или полная?** На MVP без drill-тегов (`fork`, `pin`, `hangingPiece`). Бэкенд при пере-индексации (если когда-то будет) проставит правильные. Не блокирует.
3. **Bridge engine path остался?** Да, `BridgeEngineAdapter` уже умеет возвращать `wdl` поле из info — backend `tactic-worker` использует тот же протокол. Принципиально работает с самого начала.
4. **Что делать с уже сгенерированными `forced-line` пазлами пользователя в БД?** Никакой backfill не делаем. Они остаются (`solutionMode=null` → default `'forced-line'`), играются в текущем UI как PuzzlePage forced-line ветка. Через `/precision` они тоже могут появляться (source='generated'), но играются по своей семантике (`PuzzlePage:455` branching). Это допустимо — продукт не ломается.
5. **Стоит ли дать «strict mode» с настройкой halfMovesN/winThreshold/failThreshold?** На MVP — нет, фиксированные дефолты. Если кому-то понадобится тонкая настройка — добавим в advanced settings как extension.

---

## 5. Последствия

**Плюсы**:
- Один алгоритм генерации в проекте — backend и frontend смотрят на пазлы одинаково.
- Пользователь получает понятный draft/publish flow без автоматической публикации.
- Опубликованные пазлы автоматически попадают в `/precision` (через KS-2578 source-фильтр).
- Shared-утилиты `wdl.ts` снижают вероятность дрейфа между кодовыми базами.

**Минусы / риски**:
- Solvability на WASM медленный — пользователь может включить флаг и удивиться 5 минутам. Митигация: подсказка в UI, default off.
- KS-2521 (UCI_ShowWDL) — внешняя зависимость для frontend. Если не выкачен — нужно дублировать regex в puzzleGenerator. Митигация: тикет #5 включает fallback inline-regex.
- Удаление legacy-фильтров клиента (`skipHanging`, etc.) — пользователи с сохранёнными `puzzleGenSettings` localstorage увидят дефолт. Митигация: одноразовая миграция в #6 — старые ключи игнорируются, новые из `PUZZLE_GEN_DEFAULTS`.
- Старые сгенерированные `forced-line` пазлы в БД остаются. UX: они показываются в `/precision` рядом с новыми play-vs-engine. Frontend `PuzzlePage:455` branching это разводит. Принимаем.

**Что не делает этот ADR**:
- Не пишет код — только декомпозиция.
- Не меняет сервер pipeline `tactic-worker`.
- Не вводит новые типы шагов / типы пазлов.
- Не пересекается с user-courses puzzles (ADR-029) — они через `puzzle` step type, не через `/puzzles/batch`.
