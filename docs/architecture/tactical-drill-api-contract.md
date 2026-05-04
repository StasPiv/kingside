# Tactical drills — API contract и спецификация валидатора (KS-2224)

**Дата:** 2026-05-03
**Статус:** Финальный (E1 ADR-035, после KS-2223 methodology)
**Источник:** [ADR-035](../adr/035-tactical-pattern-drills.md) §2 (drill-типы), §4 (схема данных), §6 (endpoints) + [tactical-drills-methodology.md](./tactical-drills-methodology.md) (8 типов, threshold 0.7 IoU, RU/EN формулировки)
**Блокирует:** KS-DRILL-DB, KS-DRILL-PREDICATES, KS-DRILL-API (E2)

---

## 1. Назначение и зона ответственности

Полная спецификация контрактов между backend и frontend для drill-системы:

- **Shared TypeScript-типы** — копируется в `packages/shared/src/types/tactic-drill.ts` при реализации (backend в KS-DRILL-DB, см. §10).
- **JSON-shape поля `answer`** для каждого из 4 answer-shape (`square` / `squares[]` / `number` / `move`) — discriminated union.
- **Спецификация валидатора** — логика сравнения `userAnswer` с эталоном для каждого shape, scoring formula для `squares[]` (Jaccard 0.7 IoU из methodology §6).
- **REST-контракты** — тела request/response для 7 endpoints из ADR-035 §6.2.

**Что не в этом документе:**
- Схема Prisma — в KS-DRILL-DB. Drift между этим документом и Prisma-моделью допустим только если документ обновится первым (single source of truth).
- Реализация предикатов на chess.js — KS-DRILL-PREDICATES.
- Реализация валидатора — KS-DRILL-API (TS-логика по этому документу).
- Формула сложности 1–5 — KS-2225 (отдельный design-doc).

---

## 2. Базовые типы (proposal для `packages/shared/src/types/tactic-drill.ts`)

Архитектор создаёт **proposal в этом документе**. Backend в KS-DRILL-DB копирует TS-код из §2 в `packages/shared/src/types/tactic-drill.ts` дословно (с возможными адаптациями import path'ов), добавляет `export * from './types/tactic-drill.js';` в `packages/shared/src/index.ts`.

> **Примечание по ownership.** `packages/` — read-only для архитектора (правила в `CLAUDE.md`: «Архитектор … НЕ меняет код»). Поэтому файл `packages/shared/src/types/tactic-drill.ts` в этом тикете не создаётся; эта обязанность передана backend в KS-DRILL-DB.

```ts
/**
 * KS-2224 (ADR-035 §2.1, §4 / methodology §2-3).
 *
 * Контракты drill-системы: типы drill, answer-shape, attempt и sprint score.
 * Единый источник истины для:
 *   - apps/api/tactic-drill (controller'ы, validator)
 *   - apps/web (drill page, palette, lobby)
 *   - индексер apps/api/scripts/index-tactic-drills.ts
 */

// ─── Каталог drill-типов ─────────────────────────────────────────────────

/**
 * 8 drill-типов из methodology §2. Расширение в v2 — отдельным PR с
 * обновлением methodology и этого union'а.
 */
export type TacticDrillType =
  | 'find-hanging-piece'
  | 'find-loose-piece'
  | 'find-pin'
  | 'find-fork'
  | 'find-mate-in-one-square'
  | 'count-attackers'
  | 'find-all-checks'
  | 'find-undefended-attack';

/**
 * Группировка drill-типов по навыковому слою (methodology §2.1).
 * Используется в lobby для секционирования и в analytics.
 */
export type TacticDrillSkillLayer = 'overview' | 'pattern' | 'calculation';

export const DRILL_TYPE_LAYER: Record<TacticDrillType, TacticDrillSkillLayer> = {
  'count-attackers':         'overview',
  'find-loose-piece':        'overview',
  'find-hanging-piece':      'overview',
  'find-all-checks':         'pattern',
  'find-pin':                'pattern',
  'find-fork':               'pattern',
  'find-mate-in-one-square': 'calculation',
  'find-undefended-attack':  'calculation',
};

/**
 * Порядок прохождения для строгого режима lobby (methodology §4).
 * После прохождения всех 8 — порядок снимается, открыт свободный выбор.
 */
export const DRILL_TYPE_ORDER: TacticDrillType[] = [
  'count-attackers',
  'find-loose-piece',
  'find-hanging-piece',
  'find-all-checks',
  'find-pin',
  'find-fork',
  'find-mate-in-one-square',
  'find-undefended-attack',
];

// ─── Answer-shape ────────────────────────────────────────────────────────

/**
 * 5 форматов ответа. Discriminator — поле `shape` в каждом варианте.
 * Связь shape ↔ drill-type фиксирована в DRILL_TYPE_ANSWER_SHAPE ниже.
 *
 * `'moves'` (множественное) добавлен в KS-2324 для `find-all-checks`
 * (бывший shape='squares' отменён). Не путать с `'move'` (единичный
 * для `find-mate-in-one-square` после KS-2320 и `find-undefended-attack`).
 */
export type AnswerShape = 'square' | 'squares' | 'number' | 'move' | 'moves';

/**
 * Связь drill-type → ожидаемый answer-shape (methodology §2,
 * ADR-035 §2.1).
 *
 * Для `find-mate-in-one-square` — `'move'` (KS-2320, отмена KS-2223 §8.3).
 * Strict-uniqueness drop работает по полной паре `(from, to)`.
 */
export const DRILL_TYPE_ANSWER_SHAPE: Record<TacticDrillType, AnswerShape> = {
  'find-hanging-piece':      'move',   // KS-2335 (раньше было 'square')
  'find-loose-piece':        'square',
  'find-pin':                'square',
  'find-fork':               'square',
  'find-mate-in-one-square': 'move',   // KS-2320 (раньше было 'square')
  'count-attackers':         'number',
  'find-all-checks':         'moves',  // KS-2324 (раньше было 'squares')
  'find-undefended-attack':  'move',
};

/**
 * Шахматная клетка в нотации `<file><rank>`, file ∈ a..h, rank ∈ 1..8.
 * Совпадает с chess.js типом, но в shared не зависим от chess.js (он —
 * клиентская валидация). Backend проверяет regex /^[a-h][1-8]$/.
 */
export type Square = string;

/** Дискриминированное объединение для поля `answer` (эталон) и `userAnswer`. */
export type AnswerData =
  | AnswerSquare
  | AnswerSquares
  | AnswerNumber
  | AnswerMove
  | AnswerMoves;

/** shape='square' — одна правильная клетка. */
export interface AnswerSquare {
  shape: 'square';
  /** Например `'e4'`. */
  square: Square;
}

/**
 * shape='squares' — множество клеток-ответов.
 *
 * До KS-2324 использовался `find-all-checks`, с KS-2324 переведён на shape='moves'.
 * В v1 `'squares'` не используется ни одним drill-типом, оставлен в union'е
 * для возможного будущего применения и обратной совместимости валидатора
 * (старые `tactic_drill_attempts` могут содержать `userAnswer` в этом формате).
 *
 * Порядок в массиве не важен — валидатор сравнивает как множество.
 * Дубли в `squares` — невалидный ответ (валидатор отклонит).
 */
export interface AnswerSquares {
  shape: 'squares';
  /** Например `['e4', 'f6', 'g7']`. */
  squares: Square[];
}

/** shape='number' — целое 1–4 для `count-attackers`. */
export interface AnswerNumber {
  shape: 'number';
  /** Целое 1..4. Backend валидирует диапазон. */
  value: number;
}

/**
 * shape='move' — одна пара from→to.
 *
 * Применимо к: `find-undefended-attack`, `find-mate-in-one-square` (KS-2320).
 */
export interface AnswerMove {
  shape: 'move';
  from: Square;
  to: Square;
  /**
   * Опционально — promotion piece (`'q'|'r'|'b'|'n'`). Для drill v1 не
   * используется (промоушены отбраковываются генератором), оставлено
   * на v2.
   */
  promotion?: 'q' | 'r' | 'b' | 'n';
}

/**
 * shape='moves' — множество пар from→to (KS-2324).
 *
 * Применимо к: `find-all-checks` (multi-check drill).
 *
 * Порядок в массиве не важен — валидатор сравнивает как множество пар.
 * Уникальность по `(from, to)`: дубли — невалидный ответ. Promotion в v1
 * не поддерживается, эталон без поля `promotion`.
 *
 * Scoring — IoU 0.7 (methodology §6.2), но единица сравнения — пара
 * `(from, to)`, не клетка.
 */
export interface AnswerMoves {
  shape: 'moves';
  /** Массив уникальных пар. Например `[{from:'a4',to:'e4'},{from:'b5',to:'f6'}]`. */
  moves: Array<{ from: Square; to: Square }>;
}

// ─── DTO drill (для GET /next, /sprint/start) ────────────────────────────

/**
 * Drill-задача, отдаваемая клиенту. **Ключевое:** поле `answer` НИКОГДА
 * не присутствует — иначе клиент читает devtools и обходит проверку.
 * Эталон хранится только на backend в `tactic_drills.answer` JSONB.
 */
export interface TacticDrillDto {
  /** UUID. */
  id: string;
  drillType: TacticDrillType;
  /** FEN исходной позиции (без предварительного хода — в отличие от Puzzle). */
  fen: string;
  /**
   * Чья сторона на ходу. Для drill'ов где `side-to-move` неважна
   * (`find-pin`, `find-loose-piece`, `count-attackers`) — `null`,
   * frontend не показывает индикатор хода.
   */
  sideToMove: 'w' | 'b' | null;
  /** Ожидаемый формат ответа (для UI: один клик / много / число / from→to). */
  answerShape: AnswerShape;
  /** Сложность 1..5 (см. KS-2225 формула). */
  difficulty: number;
  /**
   * Метаданные для UI:
   *   - highlightedSquare: для `count-attackers` показать выделенную клетку
   *   - expectedCount: для `squares` — сколько правильных клеток ожидается
   *     (frontend показывает прогресс «3/5 выбрано»). Для всех остальных —
   *     undefined.
   */
  meta?: {
    highlightedSquare?: Square;
    expectedCount?: number;
  };
}

// ─── DTO эталона (только server-side, в БД) ──────────────────────────────

/**
 * Эталон, хранится в `tactic_drills.answer` (JSONB). НЕ выходит за пределы
 * backend'а. Включается в response **только** в `/api/tactic-drill/attempt`
 * после submit'а — для feedback (показать правильный ответ).
 *
 * См. §3 — JSON-shape для каждого варианта.
 */
export type TacticDrillAnswer = AnswerData;

// ─── Attempt (POST /attempt и /sprint/submit) ────────────────────────────

export interface TacticDrillAttemptRequest {
  /** UUID drill'а. */
  drillId: string;
  /** Что кликнул пользователь. */
  userAnswer: AnswerData;
  /** Сколько мс ушло от показа задачи до submit'а. */
  timeMs: number;
  /**
   * Режим: `'drill'` (одиночный) | `'sprint'` (микс) | `'lessons-embed'`
   * (drill в составе урока — KS-DRILL-LESSON-STEP, v2.x).
   */
  mode: 'drill' | 'sprint' | 'lessons-embed';
  /** Только для `mode='sprint'` — UUID активной sprint-сессии. */
  sessionId?: string;
}

/**
 * Ответ на submit. `solved` определяется по правилам §4 валидатора.
 * `correctAnswer` отдаётся для feedback-overlay (зелёная подсветка
 * правильных клеток + красная — выбранных пользователем неверных).
 */
export interface TacticDrillAttemptResponse {
  attemptId: string;
  solved: boolean;
  /** Эталон. Подсвечивается на доске после submit. */
  correctAnswer: AnswerData;
  /**
   * Метрики (для shape='squares' — TP/FP/FN; для остальных undefined).
   * См. §4.
   */
  metrics?: {
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    /** IoU = TP / (TP + FP + FN). Округление до 2 знаков. */
    iou: number;
  };
}

// ─── Sprint session (mixed-types режим) ──────────────────────────────────

export interface TacticDrillSprintStartRequest {
  /**
   * Длительность сессии в мс. Допустимо `180000` (3 мин) или `300000`
   * (5 мин). Backend валидирует whitelist.
   */
  durationMs: 180000 | 300000;
  /**
   * Подмножество drill-типов для sprint'а. Пустой массив = все 8.
   * Используется для режима «sprint только по checks» и т.п.
   */
  types: TacticDrillType[];
}

export interface TacticDrillSprintStartResponse {
  sessionId: string;
  /** Первая задача sprint'а — без `answer`. */
  drill: TacticDrillDto;
  startedAt: string; // ISO
  durationMs: number;
}

export interface TacticDrillSprintSubmitResponse {
  /** Результат текущей задачи (как в `/attempt`). */
  attempt: TacticDrillAttemptResponse;
  /**
   * Следующая задача или `null` если сессия закончилась (по времени или
   * после submit'а). При `null` смотри `final` ниже.
   */
  next: TacticDrillDto | null;
  /** Заполнено только когда `next === null`. */
  final?: {
    scoreId: string;
    score: number;       // правильных задач
    accuracy: number;    // [0..1]
    avgPrecision: number; // среднее IoU по shape='squares' задачам [0..1]
  };
}

/** Запись лидерборда. */
export interface TacticDrillSprintScoreItem {
  userId: string;
  username: string;
  /** Например `'3min-mixed'` или `'5min-checks-only'`. */
  mode: string;
  score: number;
  accuracy: number;
  createdAt: string; // ISO
}

// ─── Stats ───────────────────────────────────────────────────────────────

/** Per-drill-type breakdown статистики юзера (GET /stats/me). */
export interface TacticDrillStatsItem {
  drillType: TacticDrillType;
  attempts: number;
  solved: number;
  /** [0..1]. */
  accuracy: number;
  /** Среднее timeMs по успешным попыткам. */
  avgTimeMs: number;
  /** Среднее IoU для shape='squares' (только если drillType='find-all-checks'). */
  avgIou?: number;
}

export interface TacticDrillStatsResponse {
  total: {
    attempts: number;
    solved: number;
    accuracy: number;
  };
  byType: TacticDrillStatsItem[];
  /** Какие drill-типы юзер прошёл хотя бы раз (для unlock-логики lobby). */
  unlocked: TacticDrillType[];
}
```

---

## 3. JSON-shape `answer` (БД и проводной формат)

В БД поле `tactic_drills.answer` — JSONB с одной из 4 форм. Frontend получает `userAnswer` от пользователя в той же форме (через дискриминатор `shape`). Backend сравнивает `userAnswer` против `answer` по правилам §4.

### 3.1 `shape: 'square'`

```json
{ "shape": "square", "square": "e4" }
```

**Применимо к:** `find-loose-piece`, `find-pin`, `find-fork`.

(`find-mate-in-one-square` переведён на `shape: 'move'` в KS-2320 — см. §3.4.
`find-hanging-piece` переведён на `shape: 'move'` в KS-2335 — см. §3.4.)

**Инвариант для эталона** (генератор обязан соблюдать):
- `find-loose-piece` / `find-fork`: ровно одна правильная клетка.
- `find-pin`: одна связанная фигура.

Если в позиции технически возможно несколько клеток-ответов — генератор её **отбрасывает**, не сохраняя в `tactic_drills`. Это сохраняет однозначность сравнения.

### 3.2 `shape: 'squares'`

```json
{ "shape": "squares", "squares": ["e4", "f6", "g7"] }
```

**Применимо к:** в v1 — никаким drill-типом. Бывший потребитель `find-all-checks` переведён на `shape: 'moves'` в KS-2324 (см. §3.6). Этот раздел оставлен для исторических attempts и возможного будущего применения.

**Инварианты:**
- Минимум 2 элемента, максимум 7 (methodology §6.3).
- Уникальность: дубли — невалидный эталон (валидация при INSERT).
- Порядок не имеет значения (валидатор сравнивает как множество).

В `userAnswer.squares` пользователь может прислать клетки в любом порядке; дубли от пользователя — backend нормализует через `Set` перед сравнением.

### 3.3 `shape: 'number'`

```json
{ "shape": "number", "value": 3 }
```

**Применимо к:** `count-attackers`.

**Инварианты:**
- `value` — целое в `[1, 4]`.
- Backend валидирует диапазон при INSERT и в `userAnswer`.

### 3.4 `shape: 'move'`

```json
{ "shape": "move", "from": "d1", "to": "h5" }
```

**Применимо к:** `find-undefended-attack`, `find-mate-in-one-square` (KS-2320, ранее был `'square'`), `find-hanging-piece` (KS-2335, ранее был `'square'`).

**Инварианты эталона:**
- `from` и `to` — валидные клетки `[a-h][1-8]`.
- В позиции ход `from→to` законный (chess.js validate).
- Ровно один такой ход в позиции (генератор отбрасывает позиции с несколькими).
  - Для `find-mate-in-one-square` strict-uniqueness считается по полной паре `(from, to)`: позиции с двумя разными фигурами на одну `to`-клетку — drop (см. ADR-035 §2.2.1(e)).
  - Для `find-hanging-piece` (KS-2335): сначала predicate ищет ровно одну висящую вражескую фигуру (как раньше), затем требует ровно один **легальный capture-ход** на её клетку. Случаи «2+ наших атакующих одну висящую» и «единственный атакующий связан / взятие открывает шах своему королю» — drop.
- В v1 поле `promotion` отсутствует у эталона (генератор отбрасывает позиции с промоушеном).

### 3.5 `shape: 'moves'` (KS-2324)

```json
{
  "shape": "moves",
  "moves": [
    { "from": "a4", "to": "e4" },
    { "from": "b5", "to": "f6" },
    { "from": "h2", "to": "h6" }
  ]
}
```

**Применимо к:** `find-all-checks` (multi-check drill, ранее был `shape: 'squares'`).

**Инварианты эталона:**
- 2 ≤ `moves.length` ≤ 7 (как и раньше; единица — пара, не клетка).
- Каждая пара `(from, to)` — валидные клетки `[a-h][1-8]`.
- В позиции ход `from→to` законный и даёт шах (`m.san.includes('+')`).
- Уникальность по `(from, to)`: дубли — невалидный эталон. Battery-ходы (две разные `from` на одну `to`) — это **разные** пары, обе входят в эталон.
- В v1 поле `promotion` отсутствует у пар; позиции, где хотя бы один шах с промоушеном, drop'аются генератором.
- Позиции, где среди шахов есть мат-в-1, drop'аются (уходят в `find-mate-in-one-square`, см. ADR §2.2).

В `userAnswer.moves` пользователь присылает пары в любом порядке; дубли — backend нормализует через `Set<string>` (где key = `${from}${to}`) перед сравнением.

### 3.6 Сводная таблица drill-type → answer-shape → пример

| drill-type | shape | пример эталона |
|---|---|---|
| `find-hanging-piece` | `move` | `{ shape: 'move', from: 'e2', to: 'e5' }` *(KS-2335)* |
| `find-loose-piece` | `square` | `{ shape: 'square', square: 'b7' }` |
| `find-pin` | `square` | `{ shape: 'square', square: 'd4' }` |
| `find-fork` | `square` | `{ shape: 'square', square: 'f5' }` |
| `find-mate-in-one-square` | `move` | `{ shape: 'move', from: 'd1', to: 'h5' }` *(KS-2320)* |
| `count-attackers` | `number` | `{ shape: 'number', value: 3 }` |
| `find-all-checks` | `moves` | `{ shape: 'moves', moves: [{from:'a4',to:'e4'},{from:'b5',to:'f6'}] }` *(KS-2324)* |
| `find-undefended-attack` | `move` | `{ shape: 'move', from: 'd1', to: 'a4' }` |

---

## 4. Спецификация валидатора

Валидатор — TypeScript-функция в `apps/api/src/tactic-drill/tactic-drill-validator.service.ts` (создаётся в KS-DRILL-API). Контракт: принимает `(answer: AnswerData, userAnswer: AnswerData) → ValidationResult`.

```ts
interface ValidationResult {
  solved: boolean;
  metrics?: { truePositive: number; falsePositive: number; falseNegative: number; iou: number };
}
```

### 4.1 Общие правила (для всех shape)

1. **Discriminator-mismatch.** Если `userAnswer.shape !== answer.shape` — `solved=false`, метрик нет, **нормализуется в backend как 400** на уровне DTO-валидации (class-validator на `TacticDrillAttemptRequest`). До валидатора такие случаи доходить не должны, но защита от bug-а.
2. **Поле эталона `answer` всегда валидно** (генератор гарантирует). Валидатор не проверяет `answer` повторно.
3. **`userAnswer` валидируется** на уровень формата (regex клеток, диапазон number, типы) до вызова валидатора. Валидатор работает с уже валидным userAnswer.

### 4.2 `shape: 'square'`

```ts
solved = (answer.square === userAnswer.square);
metrics = undefined;
```

Точное совпадение строки (case-sensitive: эталон всегда `lowercase`, frontend нормализует userAnswer в `lowercase` перед отправкой). Никакого tolerance.

### 4.3 `shape: 'number'`

```ts
solved = (answer.value === userAnswer.value);
metrics = undefined;
```

Точное равенство целых.

### 4.4 `shape: 'move'`

```ts
solved = (
  answer.from === userAnswer.from &&
  answer.to === userAnswer.to
  // promotion в v1 не используется
);
metrics = undefined;
```

Ровно совпадение from + to. В v1 promotion отбрасывается генератором → не входит в сравнение.

### 4.5 `shape: 'squares'` — Jaccard / IoU

**Threshold = 0.7** (methodology §6.2).

Алгоритм:

```ts
const expected = new Set(answer.squares);    // эталон, нормализован при INSERT
const got      = new Set(userAnswer.squares); // нормализуется в backend (dedup, lowercase)

let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;

for (const sq of got) {
  if (expected.has(sq)) truePositive++;
  else falsePositive++;
}
for (const sq of expected) {
  if (!got.has(sq)) falseNegative++;
}

const denominator = truePositive + falsePositive + falseNegative;
const iou = denominator === 0 ? 1 : truePositive / denominator;
const solved = iou >= 0.7;

return {
  solved,
  metrics: {
    truePositive,
    falsePositive,
    falseNegative,
    iou: Math.round(iou * 100) / 100,
  },
};
```

#### 4.5.1 Edge-cases

| Случай | userAnswer | expected | result |
|---|---|---|---|
| Пустой ответ | `[]` | `['e4', 'f6']` | TP=0, FP=0, FN=2, IoU=0, **fail** |
| Все правильные + одна ошибка | `['e4', 'f6', 'a1']` | `['e4', 'f6']` | TP=2, FP=1, FN=0, IoU=2/3≈0.67, **fail** |
| Большинство правильных | `['e4', 'f6']` | `['e4', 'f6', 'g7']` | TP=2, FP=0, FN=1, IoU=2/3≈0.67, **fail** |
| Все правильные | `['e4', 'f6', 'g7']` | `['e4', 'f6', 'g7']` | TP=3, FP=0, FN=0, IoU=1.0, **pass** |
| Дубли в userAnswer | `['e4', 'e4', 'f6']` | `['e4', 'f6']` | После dedup userAnswer=`['e4', 'f6']` → TP=2, FP=0, FN=0, IoU=1.0, **pass** |
| Эталон пустой (не должно случаться) | `[]` | `[]` | TP=0, FP=0, FN=0 → IoU=1 (по соглашению `0/0=1`), **pass** |

#### 4.5.2 Метрика для статистики

Для drill `find-all-checks` `avgIou` per user (поле `TacticDrillStatsItem.avgIou`) считается как среднее `iou` по всем попыткам этого юзера на этот drill-type. Вычисляется на запросе `GET /stats/me`, не материализуется в БД. После KS-2324 единица сравнения — пара `(from, to)`, формула та же.

### 4.6 `shape: 'moves'` — Jaccard / IoU по парам (KS-2324)

**Threshold = 0.7** (methodology §6.2). Тот же что для `'squares'`, но единица сравнения — пара `(from, to)`.

Алгоритм:

```ts
const moveKey = (m: { from: string; to: string }) => `${m.from}${m.to}`;

const expected = new Set(answer.moves.map(moveKey));
const got      = new Set(userAnswer.moves.map(moveKey));

let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;

for (const k of got) {
  if (expected.has(k)) truePositive++;
  else falsePositive++;
}
for (const k of expected) {
  if (!got.has(k)) falseNegative++;
}

const denominator = truePositive + falsePositive + falseNegative;
const iou = denominator === 0 ? 1 : truePositive / denominator;
const solved = iou >= 0.7;

return {
  solved,
  metrics: {
    truePositive,
    falsePositive,
    falseNegative,
    iou: Math.round(iou * 100) / 100,
  },
};
```

#### 4.6.1 Edge-cases (специфика для `moves`)

Те же, что в §4.5.1, но единица — пара. Дополнительно:

| Случай | userAnswer | expected | result |
|---|---|---|---|
| Battery: совпало 2 пары на одну `to` | `[{a4,e4},{b5,e4}]` | `[{a4,e4},{b5,e4},{h2,h6}]` | TP=2, FP=0, FN=1, IoU=2/3≈0.67, **fail** |
| Та же `to`-клетка, но другой `from` | `[{a4,e4}]` | `[{b5,e4}]` | TP=0, FP=1, FN=1, IoU=0, **fail** (раньше при `squares` это было бы `pass`) |

Это сужение по сравнению с прежним shape='squares': пользователь должен указать **правильную фигуру**, а не просто клетку. Это by design — логично для нового UX «сделать ход».

#### 4.6.2 Live-feedback semantics (для multi-step UX)

Backend-валидатор работает на финальном submit'е. Live-feedback per-move во время drill — **на стороне frontend**, по локальной копии эталона `expected`:

| Действие пользователя | Frontend-state | Visual feedback |
|---|---|---|
| Ход `m`, `expected.has(moveKey(m))`, не было в `found` | добавить в `found` | зелёный (correct), пометить (from, to) галочкой в боковой панели |
| Ход `m`, `expected.has(moveKey(m))`, уже в `found` | без изменений | жёлтый (already found), без штрафа |
| Ход `m`, `!expected.has(moveKey(m))` | без изменений | красный (not a check / wrong), `attempts++` для статистики |

После каждого хода — automatic `chess.undo()`, доска возвращается в исходное состояние. Полный flow — methodology §11.

Чтобы клиент мог делать live-проверку, эталон **должен** прийти к нему. Это нарушение принципа из §7 «эталон не отдавать в `/next`». Решение: для `find-all-checks` (shape='moves') — допускаем отдачу `answer.moves` через специальный endpoint `GET /api/tactic-drill/checks/expected?drillId=...` после старта drill (с rate-limit + audit), либо встраиваем в `TacticDrillDto` ТОЛЬКО для этого drill-type. Это компромисс ради UX. Backend-имплементатор выбирает (предпочтительно — отдельный endpoint, защищённый sessionId). См. §5.x.

---

## 5. REST endpoints — request/response shapes

Семь endpoints из ADR-035 §6.2. Полные тела и status codes.

### 5.1 `GET /api/tactic-drill/types`

Список drill-типов с локализованными названиями (для lobby).

**Auth:** optional (для гостей возвращаем без `unlocked`).

**Response 200:**
```ts
interface TacticDrillTypesResponse {
  types: {
    id: TacticDrillType;
    layer: TacticDrillSkillLayer;
    answerShape: AnswerShape;
    /** i18n-ключ — frontend подставляет через t('review.drill.prompt.<id>'). */
    promptKey: string;
    /**
     * Доступен ли этот drill юзеру:
     *   - для гостя — все 8 unlocked (онбординг без записи прогресса)
     *   - для зарегистрированного — только до первого пройденного по
     *     §4 methodology, плюс все ранее открытые
     */
    unlocked: boolean;
  }[];
}
```

### 5.2 `GET /api/tactic-drill/next?type=<id>&difficulty=<n>`

Одна задача без эталона.

**Query:**
- `type` (required) — `TacticDrillType`.
- `difficulty` (optional) — `1..5`. Если не задан — backend выбирает по уровню юзера (KS-2225).

**Auth:** optional (гости получают любую задачу без cooldown'а).

**Response 200:** `TacticDrillDto` (без `answer`).
**Response 404:** `{ "error": "no drills available" }` — если все задачи в cooldown (см. ADR-035 §3.2 cooldown 30 дней).

### 5.3 `POST /api/tactic-drill/attempt`

Submit одной попытки в drill mode.

**Auth:** required (гости не пишутся в `tactic_drill_attempts`, для них endpoint возвращает результат без записи — см. §6).

**Request:** `TacticDrillAttemptRequest` с `mode: 'drill'`.
**Response 200:** `TacticDrillAttemptResponse`.
**Response 400:** `userAnswer.shape` не совпадает с `drill.answerShape` или нарушает формат.
**Response 404:** `drillId` не существует.

### 5.4 `POST /api/tactic-drill/sprint/start`

Начать sprint-сессию.

**Auth:** required (sprint без записи бессмыслен — нет очков).

**Request:** `TacticDrillSprintStartRequest`.
**Response 200:** `TacticDrillSprintStartResponse`.
**Response 409:** уже есть активная sprint-сессия у юзера (force-finish старой через retry с `?force=true` — TBD frontend).

### 5.5 `POST /api/tactic-drill/sprint/submit`

Submit задачи в активной sprint-сессии. Backend сравнивает userAnswer, обновляет Redis-сессию, отдаёт следующую задачу или итог.

**Request:** `TacticDrillAttemptRequest` с `mode: 'sprint'`, `sessionId` обязателен.
**Response 200:** `TacticDrillSprintSubmitResponse`.
**Response 410 Gone:** sessionId истёк (TTL Redis 10 мин).

### 5.6 `GET /api/tactic-drill/sprint/leaderboard?mode=<mode>&limit=100`

Топ скоринговых записей.

**Query:**
- `mode` (required) — например `'3min-mixed'`.
- `limit` (optional) — default 100, max 500.

**Response 200:**
```ts
interface TacticDrillLeaderboardResponse {
  mode: string;
  entries: TacticDrillSprintScoreItem[];
  /** Позиция текущего юзера в leaderboard (если в топ-N — undefined). */
  myRank?: number;
  myScore?: TacticDrillSprintScoreItem;
}
```

### 5.7 `GET /api/tactic-drill/stats/me`

Per-user breakdown. **Auth:** required.

**Response 200:** `TacticDrillStatsResponse`.

---

## 6. Гостевой режим

Все интерактивные drill (одиночный + sprint) **доступны без auth** — это снимает порог входа для маркетинга. Особенности:

| Endpoint | Гость | Авторизованный |
|---|---|---|
| `GET /next` | задача без cooldown'а | задача с cooldown 30 дней |
| `POST /attempt` | возвращает `TacticDrillAttemptResponse`, **не пишет** в `tactic_drill_attempts` | пишет |
| `POST /sprint/start` | 401 (sprint требует auth для лидерборда) | OK |
| `GET /stats/me` | 401 | OK |

Cookie/session не используется. Backend различает по наличию JWT в Authorization header.

---

## 7. Защита эталона от утечки

`TacticDrillDto` **никогда** не содержит поля `answer`. Backend serializer'ом исключает это поле из выдачи (Nest `class-transformer` `@Exclude`). Эталон отдаётся клиенту только в `TacticDrillAttemptResponse.correctAnswer` — после submit'а.

Это критично: иначе клиент смотрит DevTools → Network → `/next` response и обходит проверку. Покрыть тестом:

```ts
it('GET /next response не содержит поле answer', async () => {
  const res = await request(app).get('/api/tactic-drill/next?type=find-fork');
  expect(res.body).not.toHaveProperty('answer');
  expect(res.body).toHaveProperty('id');
  expect(res.body).toHaveProperty('answerShape');
});
```

---

## 8. Соответствие методике (KS-2223)

| Требование methodology | Где зафиксировано в API contract |
|---|---|
| 8 drill-типов | `TacticDrillType` (§2) |
| Группировка по слоям | `DRILL_TYPE_LAYER` (§2) |
| Порядок прохождения | `DRILL_TYPE_ORDER` (§2), `unlocked` в `/types` response |
| Финальные RU/EN формулировки | `promptKey` (§5.1) — в i18n-ключах frontend (KS-DRILL-I18N) |
| `find-mate-in-one-square` строго `square` | `DRILL_TYPE_ANSWER_SHAPE` (§2), §3.5 sample, §4.2 валидатор |
| Threshold 0.7 IoU | §4.5 валидатор формула + edge-cases |
| Контроль сложности через N | `meta.expectedCount` в `TacticDrillDto` (§2) |
| Локализация фигур через Unicode | вне scope этого API contract — это frontend (KS-DRILL-I18N), здесь только `promptKey` |

---

## 9. Открытые вопросы (для KS-2225 и далее)

1. ~~**Difficulty формула** — KS-2225.~~ ✅ **Закрыто** в [`tactical-drills-methodology.md`](./tactical-drills-methodology.md) §9 (chess-expert + architect, KS-2225). Кандидат «ply из исходной партии» отброшен; финальные факторы — `pieceCount`, `attackerDensity`, `distractorCount` per-type, `materialBalance`, `mobilityRatio`, `typeSpecific`. Cold-start через минимальную версию v1 (3 фактора), полная формула — target-state после 5000 решений per-drill-type.
2. **`/next` без `type`** — нужно ли поддерживать «дай мне любую задачу adapted к уровню»? Сейчас контракт требует `type` (UI всегда знает на какой drill-карточке кликнул юзер). В sprint-режиме backend сам выбирает `type` из `sprintSession.types` пула — это покрывается.
3. **Pagination для `/sprint/leaderboard`** — пока только `limit`, без `offset`. Достаточно ли для топ-500? Если в v2 захочется «моё место с соседями» — добавить `?aroundUserId=<id>&radius=10`.
4. **`promotion` для shape='move'** — отложено в v2 (генератор отбрасывает). Тип `AnswerMove.promotion` объявлен в §2 как optional, чтобы не пришлось менять контракт при включении в v2.
5. **Bulk endpoint `/api/tactic-drill/next-batch?count=10`** — для prefetch'а на frontend (загрузить 10 задач одной HTTP-сессией, чтобы drill-mode не делал 10 раундов API). В v1 не делаем; контракт в v2 расширим без breaking change.

---

## 10. Чек-листы для реализации

### KS-DRILL-DB (backend)

- [ ] Скопировать §2 в `packages/shared/src/types/tactic-drill.ts` (с адаптацией import path'ов на `.js`-расширения, как в существующих типах).
- [ ] Добавить `export * from './types/tactic-drill.js';` в `packages/shared/src/index.ts`.
- [ ] Создать миграцию Prisma по ADR-035 §4 (`tactic_drills`, `tactic_drill_attempts`, `tactic_drill_sprint_scores`).
- [ ] CHECK-constraint на JSON-shape в `tactic_drills.answer` (минимум — что `answer.shape ∈ {square,squares,number,move}`; полная валидация — на уровне backend перед INSERT).

### KS-DRILL-PREDICATES (backend)

- [ ] Реализовать 8 предикатов на chess.js (ADR-035 §2.1 «Algo» колонка, обновлённая в KS-2223 §8 правках).
- [ ] Каждый предикат возвращает `AnswerData` — готовый эталон в формате §3.
- [ ] Юнит-тесты на конкретных FEN'ах для каждого drill-type.
- [ ] Generator-функция, которая для (FEN + drill-type) → `AnswerData | null` (null если позиция не подходит).

### KS-DRILL-API (backend)

- [ ] Module `apps/api/src/tactic-drill/`.
- [ ] Validator service — реализация §4.
- [ ] 7 controllers по §5 с DTO-валидацией.
- [ ] Защита `answer` от leak в `/next` (serializer + e2e-тест §7).
- [ ] Гостевой режим §6.

---

## 11. Связанные документы

- [ADR-035](../adr/035-tactical-pattern-drills.md) — основной ADR.
- [tactical-drills-methodology.md](./tactical-drills-methodology.md) — методика E0 (KS-2223).
- KS-2225 (KS-DRILL-DIFFICULTY) — формула сложности, расширение `meta.difficulty`.
- KS-DRILL-I18N — frontend i18n-ключи (`review.drill.prompt.*`).
- KS-DRILL-LOBBY — lobby UI с `unlocked`-логикой.
