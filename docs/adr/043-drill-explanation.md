# ADR-043: Разбор неправильных ответов в drill'ах (визуальный контекст)

**Дата:** 2026-05-06
**Статус:** Предложено
**Задача:** KS-2453
**Связанные:**
- [ADR-035 Tactical pattern drills](./035-tactical-pattern-drills.md) — каталог drill-типов, answer-shape, predicate'ы.
- KS-2452 — терминология «защищают»/«атакуют» в `count-attackers` (в работе; влияет на текст разбора).
- KS-2367 / KS-2369 — `meta.attackerColor` для `count-attackers`.
- KS-2397 — `meta.expectedMoves` для `find-all-checks`.
- KS-2319 / KS-2323 — авто-переход после feedback (текущие задержки 0/1500 мс).
- KS-2330 — локальная история drill'ов (back/forward).

---

## 1. Контекст

### 1.1 Что есть сейчас

После submit'а `/api/tactic-drill/attempt` фронт получает `TacticDrillAttemptResponse`:

```ts
{
  attemptId: string;
  solved: boolean;
  correctAnswer: AnswerData;       // эталон в discriminated-union формате
  metrics?: { TP, FP, FN, iou };   // только для shape='squares'
}
```

`DrillRunner` рендерит:
1. `DrillFeedbackOverlay` — полупрозрачная зелёная/красная заливка поверх ВСЕЙ доски (`drill-feedback--correct|incorrect`). Не указывает, **что именно** было правильно.
2. `highlightedSquares` — подсветка клеток `correctAnswer` мягким жёлтым:
   - `shape='square'` → `[correctAnswer.square]`
   - `shape='squares'` → `correctAnswer.squares`
   - `shape='move'`   → `[correctAnswer.from, correctAnswer.to]`
   - `shape='number'` → `[meta.highlightedSquare]` (только target)
3. Текст «Correct!» / «Not quite» (`drills.feedback.correct|incorrect`).
4. Авто-переход через `setTimeout`: 0 мс при правильном, 1500 мс при неверном.

### 1.2 Чего не хватает (жалобы пользователя)

После неверного ответа пользователь не понимает **что он пропустил** и **почему ответ был именно такой**:

- `count-attackers`: «нашёл 5 из 6 атакующих» — **какую конкретно фигуру проглядел**, по какой линии она бьёт?
- `find-pin`: какая фигура связывает, куда уходит линия связки до anchor'а?
- `find-hanging-piece` / `find-loose-piece`: какая фигура висит, какие у неё (нет) защитников?
- `find-undefended-attack` / `find-fork`: какой ход, какие цели после хода становятся под боем?
- `find-all-checks` (multi-step внутри FindAllChecksRunner): какие шахи остались не найдены?

Подсветить «правильную клетку» жёлтым — недостаточно: drill учит **видеть линию атаки/защиты**, а не «угадай клетку». Нужен визуальный разбор: стрелки атак, подсветка пропущенных пунктов, короткое объяснение.

### 1.3 Scope ADR

Только дизайн контракта `DrillExplanation`, схема его вычисления (фронт vs. БД), UI-поведение, декомпозиция на тикеты. Никаких миграций / кода / компонентов.

---

## 2. Инвентаризация drill-типов и поверхность изменений

### 2.1 Drill-типы и текущая визуальная подача feedback'а

Источник: `packages/shared/src/types/tactic-drill.ts` (TacticDrillType union); UI: `apps/web/src/components/drills/DrillRunner.tsx`; predicate'ы: `apps/api/src/tactic-drill/predicates/*`.

| # | drillType | answerShape | side-to-move | meta из БД | Что подсвечивается сейчас при feedback |
|---|---|---|---|---|---|
| 1 | `count-attackers` | `number` | n/a | `highlightedSquare`, `attackerColor` | только target-клетка (`meta.highlightedSquare`) |
| 2 | `find-loose-piece` | `square` | важна | — | `[correctAnswer.square]` |
| 3 | `find-hanging-piece` | `move` | важна | — | `[correctAnswer.from, correctAnswer.to]` |
| 4 | `find-all-checks` | `squares` | важна | `expectedCount`, `expectedMoves: {from,to}[]` | `correctAnswer.squares` (target-клетки шахов); ходы есть в `meta.expectedMoves`, но не визуализируются |
| 5 | `find-pin` | `square` | n/a | — | `[correctAnswer.square]` (только pinned-клетка; ни attacker, ни anchor) |
| 6 | `find-fork` | `move` | важна | — | `[correctAnswer.from, correctAnswer.to]` |
| 7 | `find-undefended-attack` | `move` | важна | — | `[correctAnswer.from, correctAnswer.to]` |

### 2.2 Что хочется показывать (целевая визуализация)

Для каждого типа определяем «единицу разбора» — линию/клетку/стрелку, которая показывает **причину**, а не только конечный объект ответа.

| drillType | Линии-стрелки (attack/defense/move) | Доп. подсветки | Что писать в текстовом списке |
|---|---|---|---|
| `count-attackers` | Стрелка от каждой атакующей фигуры к target-клетке (цвет — по `attackerColor`). Если drill — про **defenders** (KS-2452, своя фигура на target): стрелки от защитников к своей фигуре. | Target-клетка остаётся подсвечена жёлтым; клетки атакующих/защитников — зелёным. Если пользователь дал число < корректного — пропущенные атакующие выделить отдельным цветом (красным). Если дал больше — лишних не показываем (он их не указывал, нечего выделять). | «Атакующие: Nc3, Bb2, Re1 (3)» — список SAN/координат. При неверном: «Пропустил: Bb2». |
| `find-loose-piece` | Линий нет (loose = по определению **без атакующих**). Дополнительная стрелка не несёт смысла. | Подсветка `correctAnswer.square` зелёным (правильная) + `userAnswer.square` красным если не совпадает. | «Без защитников: чёрный конь на f6». |
| `find-hanging-piece` | Стрелка `correctAnswer.from → correctAnswer.to` (взятие). Опц. вторая стрелка от другой нашей атакующей фигуры → target, если есть несколько атакующих (визуализирует «безответный размен»). | Target-клетка зелёным; `userAnswer.to`/`from` красным при ошибке. | «Висящая: чёрный слон на c5; берёт Nxc5». |
| `find-all-checks` | Стрелки `from→to` для каждого правильного шаха из `meta.expectedMoves`. Найденные пользователем — зелёные; пропущенные (`expectedMoves \ userAnswer.squares`) — оранжевые/«missed»; FP пользователя (выбрал не-шах) — красные. | Target-клетки шахов подсвечены; если шах от двух фигур (battery) — обе стрелки в одну клетку. | «Шахи: Nf6+, Bd3+, Qxh7+ (3). Пропустил: Qxh7+». |
| `find-pin` | Стрелка-линия `attacker → pinned → anchor` (3 точки на одной прямой). Визуализирует «почему связано». | Pinned-клетка зелёным; attacker и anchor — синим («контекст»). | «Связана: чёрный конь на e5 (атакует Bb2, за ним Кe8)». |
| `find-fork` | Стрелка хода `from→to` синим («сделай ход»). От `to` — стрелки ко **всем новым целям** вилки (целевые фигуры противника, которые после хода под боем и не были до). | `to`-клетка зелёным, цели вилки — оранжевым. | «Ход Nd5 создаёт вилку: атака на Qb6 и Re7». |
| `find-undefended-attack` | Стрелка хода `from→to` синим. От нашей атакующей (`to` или другая фигура нашей стороны после хода) — стрелка к **новой** висящей фигуре противника. | `to`-клетка зелёным; новая висящая — красным/«target». | «Ход Nf3 атакует чёрного слона c6 без защитников». |

Эти соответствия — **методическая основа**; финальные цвета и формулировки уточняет `chess-expert` ревью (см. §6).

### 2.3 Текущая поверхность фронта — что трогаем

- `DrillRunner.tsx` — один общий `highlightedSquares` массив, нет стрелок, нет деления «правильное / пропущенное / лишнее».
- `DrillBoard.tsx` — сейчас прокидывает в `MemoChessboard` `squareStyles` (один стиль на клетку), `arrows` НЕ прокидывает (проп есть в `react-chessboard v5`, см. `MemoChessboard` `prevOpts.arrows !== nextOpts.arrows`, но drill-обёртка его не использует).
- `DrillFeedbackOverlay.tsx` — полупрозрачная заливка поверх всей доски; идею «короткий бинарный сигнал» сохраняем, но добавляем рядом панель-разбор.
- `FindAllChecksRunner.tsx` (KS-2326) — отдельный multi-step runner со своим feedback. Туда тоже нужен разбор пропущенных шахов.
- Hook `useBoardHighlights` — уже работает с `arrows` в типе `ArrowData = { startSquare, endSquare, color }`. Тот же тип используем.

### 2.4 Текущая поверхность backend

- `tactic_drills.answer` (JSONB) — эталон, отдаётся только в `/attempt` через `correctAnswer`.
- `tactic_drills.meta` (JSONB nullable) — UI-context: `highlightedSquare`, `attackerColor`, `expectedCount`, `expectedMoves`. Расширяемо без миграции схемы (Json-поле).
- `recordAttempt` (`tactic-drill.service.ts:456`) возвращает `correctAnswer` + `metrics`. Поля `explanation` / `userAnswerEcho` сейчас нет.

---

## 3. Решение: где считать `DrillExplanation`

### 3.1 Варианты

**A. Считать на фронте по FEN + correctAnswer + userAnswer (chess.js).**
Плюсы:
- Никаких миграций БД, никаких полей в JSONB.
- Не увеличивает payload `/attempt`.
- Логика рядом с UI — изменение визуала (+ новая стрелка, + новый цвет) не требует backfill'а БД.
Минусы:
- Дублирует часть логики predicate'ов (для `find-pin` нужно повторно найти линию attacker→anchor; для `find-fork` — повторно посчитать «новые цели»). Дубль контролируемый: predicate'ы возвращают только итоговый ответ, а explanation-engine — линии и контекст; алгоритмы пересекаются, но не идентичны.
- Для curated drill'ов (KS-DRILL-CURATED, E5) с авторскими комментариями — фронт не сможет вывести «потому что королевский фланг ослаблен»; такой текст должен прийти из БД.

**B. Считать на backend, отдавать в `/attempt` поле `explanation`.**
Плюсы:
- Единое место правды (predicate уже знает attacker/anchor для `find-pin`, indexer'у легко записать это в `meta`).
- На guest-flow данные всё равно нужны клиенту → так или иначе через сеть.
Минусы:
- Расширение payload каждого `/attempt`, увеличение трафика.
- Все «по FEN+answer выводимо» drill-типы добавляют в БД дублирующиеся поля.
- Backfill: 7 типов × десятки тысяч позиций — миграция данных.

**C. Гибрид (выбран):** explanation вычисляется **на фронте** для всех 7 типов в MVP. БД-поле `meta.explanation` (JSONB) добавляется как опциональный override для curated drill'ов в v2 (комментарии автора). Без миграций, без backfill'а — просто читаем `meta.explanation` если оно есть, иначе фронт считает локально.

### 3.2 Что меняется в shared / API

Никаких полей в `TacticDrillAttemptResponse` **не добавляем**. Эталон `correctAnswer` уже есть. `meta` уже отдаётся в `TacticDrillDto` через `/next` и далее в response submit'а доступен через тот же `drill` объект, который держит фронт-state. Backend остаётся без изменений на MVP.

В `TacticDrillDto.meta` — расширяемое JSONB-поле, добавление `explanation?: DrillExplanation` в v2 не требует миграции. На MVP — не используем.

### 3.3 Контракт `DrillExplanation` (фронт)

Файл: `apps/web/src/components/drills/explanation/types.ts` (новый, владелец — frontend).

```ts
/** Роль линии-стрелки. Цвет/толщина задаются на уровне рендера по role. */
export type ArrowRole =
  | 'correct-attack'    // правильная атака (зелёная)
  | 'missed-attack'     // пропущенная пользователем (оранжевая)
  | 'wrong-attack'      // false-positive пользователя (красная)
  | 'correct-move'      // правильный ход целиком (синяя жирная)
  | 'pin-line'          // attacker→pinned→anchor (синяя сплошная)
  | 'defense'           // защитник→защищаемая фигура (для defenders-варианта count-attackers)
  | 'threat-target';    // от атакующей фигуры к новой жертве (find-undefended-attack/fork)

export type SquareRole =
  | 'target'            // целевая клетка (`count-attackers.highlightedSquare`)
  | 'correct'           // правильный объект ответа
  | 'missed'            // пропущенная пользователем единица ответа
  | 'wrong'             // FP пользователя
  | 'context';          // контекстная клетка (anchor у find-pin)

export interface DrillExplanationArrow {
  from: string;         // 'e2'
  to: string;           // 'e4'
  role: ArrowRole;
}

export interface DrillExplanationHighlight {
  square: string;
  role: SquareRole;
}

/**
 * Один пункт текстового разбора. `tone` диктует цвет/иконку (зелёная
 * галочка / оранжевый «missed» / красный «wrong»). `key` — i18n-ключ;
 * `params` — подстановки (clue: SAN, цвет, координаты).
 */
export interface DrillExplanationNote {
  key: string;          // 'drills.explanation.countAttackers.missed'
  params?: Record<string, string | number>;
  tone: 'success' | 'missed' | 'wrong' | 'info';
}

export interface DrillExplanation {
  /** Стрелки в порядке отрисовки (последняя поверх). */
  arrows: DrillExplanationArrow[];
  /** Подсветки клеток. Если на одну клетку несколько ролей — побеждает по приоритету `wrong > missed > correct > target > context`. */
  highlights: DrillExplanationHighlight[];
  /** Список пунктов для текстовой панели справа от доски (или снизу на mobile). */
  notes: DrillExplanationNote[];
}
```

### 3.4 Сигнатура engine

```ts
// apps/web/src/components/drills/explanation/explainDrill.ts
export function explainDrill(input: {
  drill: TacticDrillDto;
  correctAnswer: AnswerData;
  userAnswer: AnswerData;
  solved: boolean;
}): DrillExplanation;
```

Внутри — `switch (drill.drillType)` на 7 веток. Для каждой ветки используется `chess.js` для геометрических вычислений:
- `count-attackers`: `chess.attackers(target, attackerColor)` → массив исходных клеток → стрелки.
- `find-pin`: повтор алгоритма `findPinAnchor` на фронте (или экспорт в shared, см. §5.3).
- `find-fork`: `chess.move(correctMove); chess.attackers(...)` → новые цели; `chess.undo()`.
- и т. д.

Pure function, без сетевых вызовов, full unit-test coverage.

---

## 4. UI-контракт

### 4.1 Когда показывать разбор

- **Всегда после submit'а** (правильно/неправильно). Smart-default: правильный ответ — короткая полоска «Correct! ✓ + 1 пункт» (один пункт «правильный ответ — Nc3»), неверный — полная панель со стрелками и списком missed/wrong.
- Не блокировать пользователя — управление переходом сохраняется как сейчас (KS-2319/KS-2323), но **delay при неверном ответе нужно увеличить** с 1500 мс до **3500 мс** (минимум 3 сек на считывание стрелок + 0.5 сек запас). При наличии уже работающей KS-2330 «Назад/Вперёд» пользователь может вернуться и пересмотреть.
- Кнопка «Показать решение» **не нужна** — разбор показывается сразу. Но добавляем кнопку «Дальше» (manual override), которая прерывает auto-next-таймер и сразу грузит следующий drill — чтобы пользователь не ждал, если уже всё рассмотрел.
- При `prefers-reduced-motion: reduce` — auto-next остаётся 0 мс (как сейчас); пользователь сам тыкает «Дальше». Иначе анимации стрелок отключены, но статика рендерится.

### 4.2 Layout

Desktop (≥ 768px):
```
+----------------+  +-----------------------+
|                |  | Correct! / Not quite  |
|   DrillBoard   |  |                       |
|   (со стрел-   |  | • Атакующие: Nc3, Bb2 |
|    ками и под- |  | • Пропустил: Bb2 ←⚠  |
|    светками)   |  |                       |
|                |  | [Дальше →]            |
+----------------+  +-----------------------+
```

Mobile (< 768px):
```
+--------------------+
|                    |
|     DrillBoard     |
|     (со стрелками) |
|                    |
+--------------------+
| Correct! / Not quite |
| • ...              |
| [Дальше →]         |
+--------------------+
```

Реализация — отдельный компонент `DrillExplanationPanel`, рендерится в `DrillRunner` справа от `DrillBoard` (flex-row на ≥ 768px, flex-column на mobile). Класс — стилизация в `apps/web/src/styles/drills.css`.

### 4.3 Стрелки в DrillBoard

`DrillBoard` сейчас **не** прокидывает `arrows` в `MemoChessboard.options`, хотя `react-chessboard v5` это поддерживает (`prevOpts.arrows`). Расширяем `DrillBoardProps`:

```ts
export interface DrillBoardProps {
  // ...существующее
  /**
   * Стрелки feedback'а / разбора. Каждый элемент — { startSquare,
   * endSquare, color }. Цвет задаётся вызывающим (DrillRunner маппит
   * ArrowRole → CSS-цвет согласно теме).
   */
  arrows?: { startSquare: string; endSquare: string; color: string }[];
}
```

Внутри — добавить в `options`:
```ts
...(arrows && arrows.length > 0 && { arrows })
```

`squareStyles` остаётся как есть, но внутри `DrillRunner` теперь **не один цвет на клетку** — нужен mapping `SquareRole → CSSProperties`:
```ts
const ROLE_STYLE: Record<SquareRole, CSSProperties> = {
  target:  { backgroundColor: 'rgba(255, 230, 0, 0.45)' },   // нынешний жёлтый
  correct: { backgroundColor: 'rgba(34, 197, 94, 0.40)' },   // зелёный
  missed:  { backgroundColor: 'rgba(249, 115, 22, 0.45)' },  // оранжевый
  wrong:   { backgroundColor: 'rgba(220, 38, 38, 0.45)' },   // красный
  context: { backgroundColor: 'rgba(99, 102, 241, 0.30)' },  // синий
};
```

Цвета финальные — на ревью `layout` (consistency с темой).

### 4.4 Existing `DrillFeedbackOverlay` — оставить или удалить

Решение: **оставить полупрозрачную заливку** (короткий бинарный сигнал «correct/incorrect» в первые 200–300 мс), но **уменьшить непрозрачность** и/или сократить длительность анимации, чтобы не мешала чтению стрелок. Контракт DOM `data-testid="drill-feedback"` сохраняем — есть тесты.

### 4.5 FindAllChecksRunner

Мульти-step runner внутри drill'а (`find-all-checks`) делает свой feedback per-move. Туда вписываем:
- При `solved` шахе — стрелка зелёная сохраняется до конца сессии drill'а.
- При окончании сессии (все попытки исчерпаны или таймаут) — поверх позиции прорисовываются:
  - все найденные шахи (зелёные стрелки) — уже есть;
  - **новые**: пропущенные `meta.expectedMoves \ found` — оранжевые;
  - FP пользователя (попытки сделать не-шах) — красные;
  - текстовый список пропущенных в той же `DrillExplanationPanel`.

---

## 5. Алгоритмы explanation per-type

Все алгоритмы — на `chess.js` без обращения к backend. Ниже — короткое описание каждой ветки `explainDrill`.

### 5.1 `count-attackers`

```ts
const chess = new Chess(drill.fen);
const attackers = chess.attackers(meta.highlightedSquare, meta.attackerColor); // ChessJsSquare[]
// arrows: каждый attacker → target
// highlights: target='target', каждый attacker.square='correct' (если правильно) или
//             если неверно: лишних нет (число), пропущенные = все attackers (без user-info какие именно).
// notes: 'drills.explanation.countAttackers.list' { count, list: SAN-ы }
```

**Ограничение**: number-shape не позволяет понять, **какие именно** атакующие пользователь «увидел». Нельзя выделить «пропустил Bb2». Best-effort: показываем все стрелки и пишем «правильное число — 3, ваш ответ — 2». Это **сознательное ограничение MVP**; если хочется per-attacker feedback — нужен новый shape (`squares` с массивом атакующих), что = новый drill-тип. Решено: остаёмся на `number`, разбор показывает все атакующие.

KS-2452 (defenders-вариант): если на target своя фигура — стрелки от defenders к target, текст «защищающие».

### 5.2 `find-loose-piece`

`shape='square'`. Простой случай:
- correct.square → highlight 'correct'
- user.square (если не совпадает) → highlight 'wrong'
- Линии attackers/defenders нет (loose = нет защитников; рисовать пустоту бессмысленно).
- Note: «Без защитников: <piece-type> на <square>» (i18n key + params).

### 5.3 `find-pin`

Нужно повторить `findPinAnchor` (`apps/api/src/tactic-drill/predicates/find-pin.ts`) на фронте. Варианты:
- **(a)** Скопировать алгоритм в `apps/web/src/components/drills/explanation/findPinLine.ts`.
- **(b)** Вынести pure-helper в `packages/shared/src/chess/pin.ts`. Текущий `findPinAnchor` зависит только от `chess.js`, т. е. портируем без переписывания.

Решение: **(b)** — выносим в shared, переиспользуем backend и frontend. Это **отдельный backend-тикет** (KS-2454-shared-pin), потому что меняется shared package и backend predicate.

Результат: `[attacker, pinned, anchor]` тройка → стрелка-линия (пакетируется как 2 стрелки `attacker→pinned` + `pinned→anchor` тем же цветом, либо одна стрелка через MemoChessboard custom если расширим API; на MVP — 2 стрелки).

### 5.4 `find-hanging-piece` (shape='move')

- correct.from → correct.to — синяя стрелка (правильный ход).
- user move (если не совпадает): user.from → user.to — красная стрелка.
- Note: «Висит: <piece-type> на <to>; берёт <SAN>».

Доп.: `chess.attackers(correct.to, ourColor)` — если у нас несколько атакующих, показываем все («можно взять и Nxc5, и Bxc5» — выбран именно тот, что проще). На MVP — только эталонную пару, остальные attacker-стрелки опционально (вторая итерация).

### 5.5 `find-fork`

- correct.from → correct.to — синяя стрелка.
- После применения хода: `chess.move(correct); const newTargets = computeForkTargets(chess, ...); chess.undo();`. Каждая новая цель → стрелка от `correct.to` (forker-клетки) к target-клетке, оранжевый.
- Note: «Ход <SAN> создаёт вилку: <list of targets>».

`computeForkTargets` — снова повтор части predicate'а `find-fork`. Выносим в shared (см. §5.3 решение). Тикет — общий с pin (KS-2454-shared-tactical-helpers).

### 5.6 `find-undefended-attack`

- correct.from → correct.to — синяя.
- После применения: новая висящая фигура противника (= в `threatsAfter \ threatsBefore`). Стрелка от нашей атакующей фигуры (это та, что встала на `correct.to`) к новой висящей. Цвет — оранжевый, role 'threat-target'.
- Note: «Ход <SAN> делает <piece> на <square> висящим».

Тот же подход: shared helper.

### 5.7 `find-all-checks`

Сложнее всего. `meta.expectedMoves` = массив `{from, to}[]`. `userAnswer.shape = 'squares'` — массив `to`-клеток.

Маппинг:
- Для каждого expected move: если `move.to ∈ user.squares` → стрелка зелёная, found.
- Если `move.to ∉ user.squares` → стрелка оранжевая, missed.
- Если в `user.squares` есть клетки, не входящие в `{ move.to }` — это FP. Стрелки рисовать **некуда** (нет from). Подсветить клетку красным как 'wrong'.
- Notes: список missed-ходов с SAN.

Tricky: `expectedMoves` может содержать battery — две разные `from` в одну `to`. Тогда стрелки от разных from в одну to — обе валидны. Рендерим обе.

---

## 6. Декомпозиция на тикеты

Зависимости показаны стрелкой `→` (B зависит от A: «A → B»).

### 6.1 chess-expert-ревью методики (без кода)

**KS-2454** (chess-expert) — Ревью разбора: какие именно стрелки/подсветки/тексты для каждого из 7 drill-типов методически правильны. Не решаем «синий или зелёный» — отдаём финальные роли (`ArrowRole`/`SquareRole`) и формулировки заметок (i18n key'ев). На вход — этот ADR §2.2. На выход — обновление §2.2 либо отдельный документ `docs/architecture/drill-explanation-methodology.md`. Блокирует frontend-implementation.
**Метки:** `puzzle`, `i18n`

### 6.2 shared helpers (backend-тикет, владелец — backend)

**KS-2455** (backend) — Вынести pure-helper'ы из `apps/api/src/tactic-drill/predicates/find-pin.ts` (`findPinAnchor`), `find-fork.ts` (computeForkTargets), `find-undefended-attack.ts` (computeNewThreats) в `packages/shared/src/chess/`. Уровень — pure-функции на `chess.js`, без NestJS, без зависимостей от prisma. Тесты предикатов backend перевести на новые helper'ы. Без новых полей в БД.
**Метки:** `puzzle`, `prisma` (нет миграции, но shared касается), `tests`

### 6.3 frontend explanation engine

**KS-2456** (frontend) — Создать `apps/web/src/components/drills/explanation/`:
- `types.ts` (DrillExplanation, ArrowRole, SquareRole, ...)
- `explainDrill.ts` (router по drillType)
- `byType/*.ts` — 7 файлов, по одному на drill-тип
- Полное unit-test покрытие (Vitest), table-driven по фикстурам drill'ов из `__fixtures__/`.

Зависит от: KS-2454 (методика), KS-2455 (для pin/fork/undefended-attack — иначе придётся дублировать алгоритмы; можно начать без, см. fallback в §3.4).
**Метки:** `puzzle`, `tests`

### 6.4 frontend UI: DrillExplanationPanel + интеграция

**KS-2457** (frontend) — Компонент `DrillExplanationPanel` (правая колонка / нижний блок на mobile): рендерит notes + кнопку «Дальше». `DrillBoard` расширить пропом `arrows`. `DrillRunner` — состыковать explainDrill с DrillBoard и DrillExplanationPanel, заменить flat `highlightedSquares` на role-based mapping. Увеличить `autoNextDelayIncorrectMs` default до 3500 мс (или сделать его параметром). Manual «Дальше» прерывает таймер. Storybook / ручной dev-страница для каждого типа.

Зависит от: KS-2456.
**Метки:** `puzzle`, `mobile`

### 6.5 layout / стили

**KS-2458** (layout) — Цветовые токены ролей (`--drill-role-correct`, `--drill-role-missed`, `--drill-role-wrong`, `--drill-role-context`) в `drills.css`. Гарантия read-доступа в светлой/тёмной теме (контраст ≥ AA). Адаптив layout колонка ↔ строка на 768px.

Зависит от: KS-2457 (markup).
**Метки:** `puzzle`, `mobile`

### 6.6 i18n

**KS-2459** (frontend) — RU/EN ключи для `drills.explanation.*` (формулировки notes по drill-типам). Список ключей задаёт KS-2454-EXPERT.

Зависит от: KS-2454.
**Метки:** `puzzle`, `i18n`

### 6.7 FindAllChecksRunner интеграция

**KS-2460** (frontend) — Вписать `DrillExplanationPanel` в `FindAllChecksRunner.tsx` (его собственный финальный экран). Стрелки missed/FP по правилам §5.7.

Зависит от: KS-2457, KS-2456.
**Метки:** `puzzle`

### 6.8 content (опционально, v2)

**KS-2461** (content; не создавался — отложен в v2) — Если решено хранить авторские комментарии для curated drill'ов: одноразовый CSV → JSONB-backfill в `tactic_drills.meta.explanation`. Не входит в MVP. Открыть **только после** запуска MVP и оценки спроса.
**Метки:** `puzzle`

### 6.9 Граф зависимостей

```
KS-2454 (expert) ───┬──► KS-2456 (engine) ──► KS-2457 (UI) ──► KS-2458 (CSS)
                    │                              │
                    │                              ├──► KS-2460 (FACR)
                    ├──► KS-2459 (i18n)             │
                    │                              │
KS-2455 (shared) ───┘                              │
(может стартовать параллельно KS-2454)              │
                                                   ▼
                            (опционально, v2: KS-2461 content)
```

---

## 7. Нерешённые вопросы / future work

1. **Per-attacker feedback в `count-attackers`**. На MVP — невозможно (shape='number'). В v2 можно ввести parallel drill `mark-attackers` (shape='squares') — тренирует тот же навык глубже.
2. **Авторские текстовые комментарии**. JSONB-override `meta.explanation` в БД — отложено в KS-2454-CONTENT после MVP.
3. **Анимация стрелок** (sequential reveal: сначала ход, потом цели вилки). На MVP — статичный render всего сразу. Анимации — отдельный layout/UX-тикет, не блокируют запуск.
4. **Doubled drill: «как НЕ надо» при wrong answer**. Если пользователь сделал «явно плохой» ход (зевок), показать почему — на MVP не делаем.
5. **Доступность (a11y)**. Стрелки на доске — визуальная только модальность. Текстовые notes покрывают содержание, но порядок стрелок невнятен скрин-ридеру. Отдельный a11y-pass — после MVP.

---

## 8. Что НЕ делаем

- Не меняем БД-схему `tactic_drills` / `tactic_drill_attempts`.
- Не меняем response `/api/tactic-drill/attempt` (полей не добавляем).
- Не трогаем rating / sprint логику.
- Не пишем новые drill-типы.
- Не трогаем `webhook-server.py`, `.claude/agents/*`, `CLAUDE.md`.

---

## 9. Связанные изменения вне drill'ов

- `KS-2452` (терминология defenders/attackers) — вливается в формулировки notes для `count-attackers`. Если KS-2452 ещё в работе на момент старта KS-2454-EXPERT — синхронизироваться по тексту.
- `KS-2330` (back/forward в истории) — `DrillExplanationPanel` должен корректно ререндериться при возврате к историческому drill'у (история уже хранит `feedback.correctAnswer`; explainDrill — pure → автоматически работает).
