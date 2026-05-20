# ADR-069 — Puzzle objective: различать «реализуй перевес» и «спасение в ничью»

- Статус: Accepted
- Дата: 2026-05-20
- Связанные задачи: KS-3142 (этот аудит/план), KS-3139 (пример 39. d6),
  KS-3140 (фикс after-фильтра, без которого save-equality пазлы не генерились).
- Связанные ADR: ADR-068 (алгоритм с `deltaW`/`deltaD`), ADR-044
  (play-vs-engine pivot), ADR-050 (унификация генератора). ADR-068
  обновляется (см. §8) на ссылку из `wdlAfter` в `objective`.
- **Follow-up:** ADR-070 (KS-3156) — добавляет ортогональную ось
  `puzzlePhase: 'preventive' | 'reactive'`. Полная матрица пазлов
  становится 2×2 (фаза × objective). Реактивная фаза (`fenAfter`,
  solver = противник) — то, что описано в этом ADR; превентивная
  фаза (`fenBefore`, solver = зевнувший) — добавлена ADR-070.
- Авторы: architect

---

## 1. Контекст

После ADR-068 + KS-3140 puzzle-генератор отбирает оба класса пазлов:

| Жанр | После хода (POV solver'а) | Smbol |
|---|---|---|
| **«Реализуй перевес»** (convert) | `W_after ≥ 0.5`, D_after любая | 👑 |
| **«Спасение в ничью»** (save equality) | `W_after < 0.5`, `W_after + D_after ≥ 0.5` (after-фильтр §3.2 ADR-068) | ⚖️ |

Пример **save-equality**: KS-3139 / ход `39. d6` — белые из 1000/0/0
загнали себя в 0/952/48; solver удерживает ничью (форс-вариант), а не
выигрывает.

### 1.1 Проблема

1. **UI runtime — `apps/web/src/components/puzzle/PlayVsEngineRunner.tsx`:**
   - Hint в начале пазла уже различает goal через `selectBlunderGoalKey`
     (строки 354-363) — i18n-ключ `puzzle.engine.blunderGoal.advantage |
     equality | defense`. **Это runtime-эвристика, не сохраняется в БД.**
   - Финальные/in-progress тексты hard-coded под «преимущество»:
     - `puzzle.engine.win` = «Преимущество удержано» (строка 1374),
     - `puzzle.engine.loseWdl` = «Преимущество потеряно» (1380),
     - `summary.preservedHeader` = «Преимущество удержано»,
     - `summary.lostHeader` = «Преимущество потеряно»,
     - `summary.linePreserved` / `lineLost` = «Шансы на победу: X% → Y%».
   - Для save-equality пазла «потеря преимущества» — смысловая ошибка
     (преимущества не было — solver удерживал ничью).
2. **Фильтрация:** `/puzzles` (`PuzzleBrowserPage`) и `/precision`
   (`PrecisionPage`) фильтруют через `themes` (`THEME_FILTER_WHITELIST`,
   строки 36-60). Объективы не выделены отдельными тегами → пользователь
   не может выбрать «дай мне только защитные».
3. **Метаданные в БД:** `sourceMetadata.playVsEngine` хранит
   `wdlAfter`, `deltaW`, `deltaD`, `blunderMove`, `fenBeforeBlunder` —
   объектив не сохраняется. Backend `resolveSolutionMode` его не отдаёт.
4. **Семантическая ловушка:** `blunderTrigger = 'W'` ≠ «convert-advantage».
   Триггер по `W` означает «у блaндера упала P(победа)» — это случается
   и при `wdlBefore=1.0 → wdlAfter=0/0/0.95` (convert) и при
   `wdlBefore=1.0 → wdlAfter=0/952/48` (save-equality). Объектив
   определяется **состоянием после хода в POV солвера**, не триггером.

### 1.2 Решение

1. Ввести типизированный **`objective: 'convertAdvantage' | 'saveEquality'`**
   как явное поле в `playVsEngine` DTO.
2. Вычислять `objective` в момент генерации по `wdlAfterRaw`
   (один источник истины, утилита в shared).
3. Хранить **в двух местах** (без миграции БД):
   - в `sourceMetadata.objective` (string в JSON) — для DTO и UI;
   - в `themes`-строке как тег `convertAdvantage` / `saveEquality` — для
     фильтров (используют существующий механизм `?themes=…` через LIKE).
4. UI: текстовые ключи `puzzle.engine.{win,loseWdl,summary.*}`
   дифференцировать по `objective`; добавить badge в карточке пазла
   и summary.
5. Фильтрация: расширить `THEME_FILTER_WHITELIST` двумя новыми чипами.
6. Legacy-пазлы: одноразовый backfill-CLI (тикет D1) для
   `solutionMode='play-vs-engine'` пазлов в БД — проставить тег и
   `objective` по `meta.wdlAfter`.

---

## 2. Модель данных

### 2.1 Тип

```ts
// packages/shared/src/types/puzzle.ts
export type PuzzleObjective = 'convertAdvantage' | 'saveEquality';

// playVsEngine DTO:
playVsEngine?: {
  // ... existing fields ...
  /**
   * KS-3142 / ADR-069. Жанр пазла со стороны solver'а:
   *   - 'convertAdvantage' — нужно реализовать перевес (W_after ≥ 0.5);
   *   - 'saveEquality'     — нужно удержать ничью (W_after < 0.5,
   *                          гарантировано after-фильтром W+D ≥ 0.5).
   *
   * Опц.: legacy-пазлы (до KS-3142) поля не имеют. Backend
   * `resolveSolutionMode` делает fallback-вычисление из `wdlAfter`
   * (если оно есть) или из `wdlAfterBlunder` (signed: ≥ 0.5 →
   * convertAdvantage, иначе saveEquality).
   */
  objective?: PuzzleObjective;
};
```

**Почему ровно два значения, не три:**

Третий вариант — `defense` (солвер хуже, спасает проигранную) — не
генерится текущим алгоритмом: after-фильтр `W_after + D_after ≥ 0.5`
гарантирует, что solver либо в выигрыше, либо в балансе. Если порог
понизят в будущем — добавим третье значение тогда. На стороне UI
runtime `selectBlunderGoalKey` сейчас умеет возвращать `defense`
(KS-3035) как fallback — это историческая эвристика для редких
пограничных случаев; оставляем её только в UI runtime-хинте,
объективом в БД не делаем.

### 2.2 Правило определения

В `packages/shared/src/utils/puzzle-gen-core.ts` рядом с
`evaluateBlunder` — новая чистая функция:

```ts
import type { Wdl } from './wdl.js';
import type { PuzzleObjective } from '../types/puzzle.js';

/**
 * KS-3142 / ADR-069 §2.2. Определение жанра пазла по WDL solver'а
 * сразу после блaндера.
 *
 *  - `wdlAfterRaw.w / 1000 ≥ THRESHOLD_CONVERT` → 'convertAdvantage'.
 *  - иначе → 'saveEquality' (предполагается, что вход уже прошёл
 *    after-фильтр W+D ≥ 0.5 в `evaluateBlunder`).
 *
 * THRESHOLD_CONVERT — `0.5` (тот же, что `minWPlusDAfterForSolver`
 * по умолчанию в `PUZZLE_GEN_DEFAULTS`). Если в будущем `evaluateBlunder`
 * примет разные пороги — передавать параметром.
 */
export function determinePuzzleObjective(
  wdlAfterRaw: Wdl,
): PuzzleObjective {
  const wAfter = wdlAfterRaw.w / 1000;
  return wAfter >= 0.5 ? 'convertAdvantage' : 'saveEquality';
}
```

Чистая, тестируемая, никакого I/O — общая для backend (`tactic-worker`)
и frontend (`puzzleGenerator.ts`).

### 2.3 Где хранить

| Куда | Что | Зачем |
|---|---|---|
| `sourceMetadata.objective` (JSON-string в `puzzles.source_metadata`) | `'convertAdvantage'` \| `'saveEquality'` | DTO для UI, источник истины. |
| `themes` (TEXT через пробел в `puzzles.themes`) | тег `convertAdvantage` или `saveEquality` | Фильтрация через существующий `?themes=…` LIKE-механизм (`apps/api/src/puzzle/puzzle.controller.ts:266-281`). Без новой колонки/индекса. |

Никаких миграций Prisma не требуется. JSON-поле и текстовый список
тегов поддерживают расширение «бесшовно».

### 2.4 Что делать с legacy-пазлами

Сейчас в БД лежат `solutionMode='play-vs-engine'` пазлы без `objective`
и без тегов `convertAdvantage`/`saveEquality`. Два пути:

| Подход | Плюсы | Минусы |
|---|---|---|
| **A. Backfill-CLI** (тикет D1) | Старые пазлы попадают под фильтр; единое поведение | Один прогон по БД, +SQL UPDATE |
| **B. Fallback в backend `resolveSolutionMode`** | Без CLI | Фильтрация по тегам не покажет старые пазлы (тегов нет); только UI-надписи будут корректными |

**Рекомендация: оба.** Backend всегда делает fallback (на случай новых
сценариев / частичной миграции), backfill — для полной фильтрации.
Backfill — простой одноразовый CLI в `apps/tactic-worker/src/cli/`
(уже есть инфраструктура CLI там).

---

## 3. UI runtime — `PlayVsEngineRunner.tsx`

### 3.1 Hint (уже работает частично)

`selectBlunderGoalKey(baselineWdl)` (строки 354-363) — оставить как
**fallback**, но приоритет отдать `puzzle.playVsEngine?.objective`:

```ts
const objective =
  puzzle.playVsEngine?.objective ??
  // Fallback: вычисляем эвристикой по WDL (для legacy без objective).
  selectBlunderGoalKey(baselineWdl);
const goalText = t(`puzzle.engine.blunderGoal.${objective}`);
```

`selectBlunderGoalKey` возвращает `'advantage' | 'equality' | 'defense'`
— это **i18n-ключи** (исторически), не `objective`. Чтобы согласовать,
проще всего:

- Переименовать ключи: `blunderGoal.convertAdvantage` /
  `blunderGoal.saveEquality` / `blunderGoal.defense`. Это правка в
  `translation.json` (en+ru) + 1 строчка в коде.
- Или сохранить старые ключи и сделать mapping `objective →
  i18n-key` в одном месте. **Этот вариант проще, выберем его.**

### 3.2 Тексты — дифференцировать

Дублирующиеся ключи под convertAdvantage / saveEquality:

| Текущий ключ (ru) | Новые ключи |
|---|---|
| `puzzle.engine.win` = «Преимущество удержано» | `engine.win.convertAdvantage` = «Преимущество удержано» <br> `engine.win.saveEquality` = «Ничья удержана» |
| `puzzle.engine.loseWdl` = «Преимущество потеряно» | `engine.loseWdl.convertAdvantage` = «Преимущество потеряно» <br> `engine.loseWdl.saveEquality` = «Ничья упущена» |
| `summary.preservedHeader` = «Преимущество удержано» | `summary.preservedHeader.convertAdvantage` = «Преимущество удержано» <br> `summary.preservedHeader.saveEquality` = «Ничья удержана» |
| `summary.lostHeader` = «Преимущество потеряно» | `summary.lostHeader.convertAdvantage` = «Преимущество потеряно» <br> `summary.lostHeader.saveEquality` = «Ничья упущена» |
| `summary.linePreserved` = «Шансы на победу: X% → Y%» | `summary.linePreserved.convertAdvantage` = «Шансы на победу: X% → Y%» <br> `summary.linePreserved.saveEquality` = «Шансы на ничью: X% → Y%» |
| `summary.lineLost` = «Шансы на победу: X% → Y% (−Δ%)» | `summary.lineLost.convertAdvantage` = «Шансы на победу: X% → Y% (−Δ%)» <br> `summary.lineLost.saveEquality` = «Шансы на ничью: X% → Y% (−Δ%)» |

В английских переводах симметрично:
- `Held the advantage` → для convert / `Held the draw` → для save.
- `Lost the advantage` → / `Failed to hold the draw`.
- `Winning chances` → / `Drawing chances`.

Реализация: в коде на каждом use-site читаем `objective` и формируем
суффикс ключа. Лучше — хелпер `pickByObjective(objective, advText,
eqText)` или `t(`engine.win.${objective}`)`. Конкретику решит F1.

### 3.3 Badge в карточке (catalog + summary)

Маленький pill рядом с темами в `PuzzleBrowserCard` / в `PuzzlePage`
header / в summary `PlayVsEngineRunner` (там, где сейчас «You held the
advantage» итд):

```
┌─────────────┐
│ ⚖️ Save draw │   — для saveEquality, цвет акцент-yellow
└─────────────┘
┌─────────────────────┐
│ 👑 Convert advantage │  — для convertAdvantage, цвет accent-green
└─────────────────────┘
```

i18n-ключи `puzzle.objective.convertAdvantage` / `saveEquality`
(короткие тексты для pill). Компонент `<PuzzleObjectiveBadge
objective={…} />` — переиспользуем во всех местах.

Для legacy без objective — badge не рисуем (вернётся undefined). После
backfill все увидят badge.

### 3.4 Эвал-бар / шкала «win chances»

`EvalBar` рисует одно число, разворачивая `W − L`. Для save-equality
это всё ещё корректно — «упало с 0% до −80%» — но юзеру понятнее было
бы «шанс ничьи 95% → 30%». Возможный шаг — переключать ось у `EvalBar`
по `objective`. **Вне scope этого ADR**: вопрос требует UX-эксперимента,
а основная задача (надписи + фильтрация) решается без этого. Оставляем
как отдельный кандидат на follow-up.

---

## 4. Фильтрация

### 4.1 PuzzleBrowserPage (`/puzzles`)

`apps/web/src/pages/PuzzleBrowserPage.tsx:36-60` — `THEME_FILTER_WHITELIST`.
Добавляем два значения:

```ts
const THEME_FILTER_WHITELIST: readonly string[] = [
  // ... existing themes ...
  'convertAdvantage',
  'saveEquality',
  // ...
];
```

i18n-ключи `puzzleBrowser.themes.convertAdvantage` /
`puzzleBrowser.themes.saveEquality` (en+ru). Чипы рендерятся
автоматически.

Backend не правим: `?themes=convertAdvantage` уже работает через LIKE
по `themes`-строке (см. `puzzle.controller.ts:266-281`).

### 4.2 PrecisionPage (`/precision`)

`apps/web/src/pages/PrecisionPage.tsx` использует тот же
`useInfinitePuzzles({themes})`. Текущий UI там — табы по сложности.
Минимальное добавление: новый segment-control «Тип» с двумя кнопками
`👑 Convert / ⚖️ Save` (multi-select chip). Конкретику UI решает F2.

### 4.3 Stats / mistakes

`PuzzleMistakesPage`, `PuzzleStatsPage` — фильтры темы уже наследуются
оттуда, отдельно ничего не требуется (если хотим показывать стату по
типу — см. §5).

---

## 5. Метрики / аналитика

**Вопрос задачи:** считать ли success rate отдельно по
`convertAdvantage` vs `saveEquality`?

**Аргументы:**
- Защитные пазлы объективно сложнее (нужен форс-вариант, не
  «лучшая» атака). Объединять их в одну метрику с convert
  искажает рейтинговую динамику.
- `precision_attempts` уже хранит puzzle_id; объектив можно подтягивать
  JOIN'ом с `puzzles.source_metadata` или денормализовать в attempts.

**Рекомендация:** отдельно стат-разделение **отложить** на follow-up
тикет (опц. M1). Сейчас достаточно правильных надписей в UI и
фильтрации. Расчёт «success rate by objective» — отдельная задача
дизайна (новый блок в `/precision/stats`), которая не относится к
текущему запросу.

---

## 6. Связь с алгоритмом генерации

### 6.1 Backend (`apps/tactic-worker/src/puzzle-generator/generator-pipeline.ts`)

Сейчас в Stage 6 (строки 448-525):
- собирается `tags` через `computeTags(...)`,
- добавляется тег `'playVsEngine'`,
- записывается `sourceMetadata`.

Изменение:

```ts
import { determinePuzzleObjective } from '@kingside/shared';

// ... в Stage 6 (after solvability):
const objective = determinePuzzleObjective(sc.wdlAfterRaw);
const tags = computeTags({ ... });
tags.push('playVsEngine');
tags.push(objective);   // 'convertAdvantage' | 'saveEquality'

// sourceMetadata:
{
  // ... existing fields ...
  objective,
}
```

### 6.2 Frontend (`apps/web/src/utils/puzzleGenerator.ts`)

Клиентский генератор — Stage 6 аналогичен. Добавить тот же импорт
и записать в `sourceMetadata.objective` + в `themes`.

### 6.3 API (`apps/api/src/puzzle/puzzle.service.ts:resolveSolutionMode`)

```ts
// Чтение поля:
const objective = parseObjective(meta.objective)
  // fallback для legacy:
  ?? inferObjectiveFromWdl(meta.wdlAfter, meta.wdlAfterBlunder);

return {
  solutionMode: 'play-vs-engine',
  playVsEngine: { /* existing */, ...(objective ? { objective } : {}) },
};
```

`inferObjectiveFromWdl` — fallback-эвристика: если есть `wdlAfter`
(raw), считаем по `determinePuzzleObjective`; если только signed
`wdlAfterBlunder` — `>= 0.5 → convertAdvantage`, иначе `saveEquality`.

---

## 7. Декомпозиция на тикеты

| Ключ | Кто | Summary |
|---|---|---|
| **A1** | architect | ADR-069 + правка ADR-068 §3.2 (см. §8). **Выполнено этим коммитом.** |
| **S1** | backend | Shared: `determinePuzzleObjective` в `packages/shared/src/utils/puzzle-gen-core.ts` + тип `PuzzleObjective` + опциональное поле `objective` в DTO `playVsEngine` (`types/puzzle.ts`). Тесты `puzzle-gen-core.test.ts`. `npm run build` shared. |
| **B1** | backend | tactic-worker: `generator-pipeline.ts` Stage 6 — вычислять `objective`, писать в `sourceMetadata.objective` и в `themes`. Клиент: `apps/web/src/utils/puzzleGenerator.ts` — то же. API: `apps/api/src/puzzle/puzzle.service.ts:resolveSolutionMode` — читать `objective` из meta или fallback из `wdlAfter`/`wdlAfterBlunder`, отдавать в DTO. Spec обновить (`generator-pipeline.spec.ts`, `puzzleGenerator.test.ts`, `puzzle.service.spec.ts`). |
| **F1** | frontend | UI runtime в `PlayVsEngineRunner.tsx`: переключение текстов по `objective` (`puzzle.engine.{win,loseWdl,summary.preservedHeader,lostHeader,linePreserved,lineLost}` × `{convertAdvantage,saveEquality}`). `selectBlunderGoalKey` остаётся как fallback; приоритет — `puzzle.playVsEngine?.objective`. Компонент `<PuzzleObjectiveBadge>` (pill для карточек и summary). i18n en+ru. Тесты `PlayVsEngineRunner.test.tsx`. |
| **F2** | frontend | Фильтр: `THEME_FILTER_WHITELIST` в `PuzzleBrowserPage.tsx` дополнить `convertAdvantage` / `saveEquality`. Переводы `puzzleBrowser.themes.convertAdvantage` / `saveEquality`. На `/precision` (`PrecisionPage.tsx`) — segment-control / chip-фильтр «Тип» (по теме). Тесты `PuzzleBrowserPage.test.tsx`, `PrecisionPage.test.tsx`. |
| **D1** | backend | Backfill-CLI: `apps/tactic-worker/src/cli/backfill-puzzle-objective.cli.ts` — пройти все `puzzles WHERE solution_mode='play-vs-engine'`, прочитать `source_metadata.wdlAfter` (или `wdlAfterBlunder` fallback), посчитать `objective`, записать в `source_metadata.objective` + добавить тег в `themes`. Dry-run-flag. Без миграции схемы. |

Опционально (вне scope этого ADR, оставлено как follow-up):

| Ключ (предложение) | Кто | Summary |
|---|---|---|
| M1 | backend | `precision_attempts` denormalize / JOIN с puzzle.objective; новый блок «Success by objective» в `/precision/stats`. |
| U1 | layout/frontend | `EvalBar` переключает ось «win%» ↔ «draw%» по `objective`. |

### 7.1 Зависимости

```
A1 (architect)      ──► merge сразу (этот коммит)
                         │
S1 (shared)         ──► merge ПЕРВЫМ — B1, F1, F2 импортируют тип/утилиту
                         │
B1 (backend)        ──┐
F1 (frontend UI)    ──┤ — независимые по файлам, параллельно после S1
F2 (frontend filter)──┘
                         │
D1 (backfill)       ──► после B1 (нужна та же определяющая формула,
                         чтобы новые/legacy пазлы оставались согласованы)
```

S1 — синхронный блокер для B1/F1/F2. B1/F1/F2 идут параллельно. D1
делается после B1, но не блокирует деплой фронта (legacy-пазлы до
backfill просто не попадают под фильтр по тегу — backend fallback в
`resolveSolutionMode` всё равно вернёт `objective` для UI).

### 7.2 Деплой

- Backend (`apps/api`, `apps/tactic-worker`) — обычный деплой через
  `deploy({scope:'api'})`.
- Frontend — обычный билд.
- D1 (backfill) — запуск CLI на проде вручную (через
  `deploy({scope:'tactic-worker'})` + `npm run cli -- backfill-objective`
  или эквивалент, оформит devops).

---

## 8. Правка ADR-068

ADR-068 §3.2 псевдокод сейчас заканчивается на `→ solvability check
(опц.) → accept`. Добавляется явная ссылка:

> После accept: `objective = determinePuzzleObjective(wdlAfterRaw)`
> (см. ADR-069 §2.2). Записывается в `sourceMetadata.objective` и в
> `themes` для фильтрации UI.

Минимальная правка в шапке: уточнить, что генератор после ADR-068
производит **два жанра** пазлов (convert/save), и явное различие
введено ADR-069. Это делается этим же коммитом.

---

## 9. Acceptance ADR-069

- [x] Этот документ создан в `docs/adr/069-puzzle-objective-convert-vs-save.md`.
- [x] ADR-068 §3.2 дополнено явной ссылкой на ADR-069 §2.2.
- [ ] Тикеты S1, B1, F1, F2, D1 заведены координатором по списку §7
  (architect код не правит).
