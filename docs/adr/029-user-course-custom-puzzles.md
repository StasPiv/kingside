# ADR-029: Custom puzzle в шагах пользовательских курсов

**Дата:** 2026-04-25
**Статус:** Предложено
**Задача:** KS-1907
**Связанные:**
- [ADR-026 User courses](./026-user-courses.md) — фича-родитель, whitelist шагов, edit/play режимы
- KS-1875 (Board Editor для text-step diagrams) — паттерн редактирования FEN, переиспользуем
- KS-1906 (Board Editor для endgame_drill) — параллельная задача, тот же паттерн
- `apps/web/src/components/lessons/editor/fields/PuzzleFields.tsx` — текущий редактор puzzle-шага
- `apps/web/src/components/lessons/steps/PuzzleStep.tsx` — текущий runner
- `apps/api/src/lessons/puzzle-resolver.controller.ts` — `POST /api/lessons/puzzle-step/resolve`

---

## 1. Контекст

### 1.1 Что есть сейчас

В пользовательских курсах (ADR-026) шаг типа `puzzle` поддерживает два
режима выбора задач:

```ts
export type PuzzleStepSelection =
  | { mode: 'ids'; puzzleIds: string[] }
  | { mode: 'filter'; themes: PuzzleTheme[]; ratingMin?: number; ratingMax?: number; limit: number };
```

Оба режима ссылаются на **существующие задачи в системной puzzle-БД**
(импортированные из Lichess open puzzle data). Резолв — через
`POST /api/lessons/puzzle-step/resolve`, который возвращает
`PuzzleDto[]` с готовыми FEN, ходами решения и системным рейтингом.

`PuzzleStep` (runner) рендерит `PuzzleBoard`, проверяет ход против
`puzzle.moves` и пишет попытку в `PuzzleAttempt` через
`puzzleApi.submitAttempt`. Попытка влияет на `User.ratingPuzzle` через
Glicko-2 (`PuzzleRatingService`).

### 1.2 Чего хочет пользователь

Дать автору пользовательского курса возможность **сочинять собственные
задачи**: произвольная позиция (Board Editor → FEN) + последовательность
ходов решения. Это не подбор из готового, а **новая авторская сущность**.

Use-cases:
- Иллюстрация конкретного приёма (мат в 1, ловушка в дебюте) с позицией
  и ходом, которые именно автор хочет показать.
- Задачи на нестандартные темы, которых нет в Lichess open puzzle.
- Авторская методическая последовательность (например, серия задач
  «открытое нападение в курсе по тактике уровня 1»).

### 1.3 Что в скоупе ADR

- Расширение типа payload, контракт хранения, валидация.
- Контракт прохождения (frontend-only flow без серверной puzzle-логики).
- Влияние/невлияние на рейтинг.
- UI-эскиз редактора custom puzzle.
- План реализации (задачи без оценок сроков — это зона координатора).

### 1.4 Что вне скоупа

- Новая таблица `custom_puzzles` в puzzle-БД и переиспользование между
  курсами. Custom puzzle живёт **только в payload user-course-шага** —
  не самостоятельная сущность.
- Темы, рейтинг, leaderboard для custom puzzle — нет.
- Импорт custom puzzle между курсами (fork) — отложено вместе с fork
  курсов (ADR-026 §2.8).
- Сменa существующего `PuzzleStep` для preconstant puzzles — обратная
  совместимость, новый код-путь параллельно.

---

## 2. Расширение типа `PuzzleStepPayload`

### 2.1 Решение: третий вариант discriminated union, не объединение с `ids`

В `packages/shared/src/types/lessons.ts`:

```ts
export type PuzzleStepSelection =
  | { mode: 'ids'; puzzleIds: string[] }
  | { mode: 'filter'; themes: PuzzleTheme[]; ratingMin?: number; ratingMax?: number; limit: number }
  | { mode: 'custom'; customPuzzles: CustomPuzzle[] };

export interface CustomPuzzle {
  /** Стартовый FEN. Валидируется chess.js. */
  fen: string;
  /**
   * Последовательность ходов решения в UCI: `['e2e4','e7e5',...]`.
   * Нечётный индекс = ход «противника» (после хода ученика).
   * Чётный индекс = ход ученика. Это согласовано с порядком ходов в
   * preconstant Lichess puzzle и существующей логикой `PuzzleStep`,
   * см. §5.
   */
  solutionMoves: string[];
  /** Какой цвет внизу при рендере доски. По умолчанию — сторона ученика. */
  orientation?: 'white' | 'black';
  /**
   * Опциональные авторские теги (для UI-подсказки, не валидируются как
   * `PuzzleTheme` enum). Хранятся as-is, в leaderboard/recommendations
   * не идут.
   */
  themes?: string[];
  /** Опциональная авторская подпись, рендерится над доской. */
  caption?: string;
}
```

### 2.2 Почему отдельный режим, не объединение

Координатор спросил: «`list` и `custom` объединить?». **Нет.** Аргументы:

1. **Семантически разные источники истины.** `ids` ссылается на запись
   в `puzzles` таблице (рейтинг, темы, source). `custom` — самодостаточен,
   все данные в payload. Разделение по mode явно фиксирует, **где
   читать** данные — клиенту понятнее, тестам проще.
2. **Контракт runner'а зависит от mode** (см. §5). При `mode='ids'` /
   `'filter'` — серверная резолюция через `/puzzle-step/resolve`. При
   `mode='custom'` — резолюция отсутствует, payload идёт напрямую в UI.
   В одном объединённом режиме код был бы условным `if (puzzleIds)
   else if (customPuzzles) else if (filter)` — это и есть
   discriminated union, просто без явного `mode`-поля. Делаем явно.
3. **Валидация на BE проще** при явном discriminator: один DTO-класс
   на режим, class-validator делает остальное.

### 2.3 Можно ли смешивать `filter`/`ids` + `customPuzzles` в одном шаге?

**Нет, в MVP.** Один шаг = один режим. Если автор хочет «3 моих задачи +
3 из Lichess по теме mateIn1» — это два отдельных puzzle-шага в уроке.
Это согласовано с UX: автор видит в редакторе одну форму на шаг, а
не «и то, и это».

Расширение «mixed mode» возможно позже без ломки контракта: добавить
четвёртый вариант `{ mode: 'mixed'; sets: PuzzleStepSelection[] }`.
Откладываем до явного запроса.

### 2.4 Решение про формат хранения ходов: UCI

Альтернативы:
- **PGN** — человекочитаемо, но требует парсинга для проверки;
  избыточно для линейной последовательности (не нужны варианты,
  комментарии, NAG).
- **SAN** — `Nf3`, `e4` — короче, но зависит от позиции; невалиден без
  контекста доски, и при изменении предыдущего хода SAN последующих
  меняется.
- **UCI** — `e2e4`, `g1f3`, с promotion `e7e8q` — позиционно-независим,
  легко сериализуется, прямо ложится в `chess.js.move({from, to,
  promotion})` (что уже использует `PuzzleStep`). **Принимаем.**

Все три формата у нас уже используются в проекте (PGN — в
`archive_games`, SAN — в WS-протоколе, UCI — в puzzles и chess.js).
Для custom puzzle UCI выбираем как **тот же формат, что и
`puzzle.moves`** — runner по нему уже умеет.

### 2.5 Лимиты

В `apps/api/src/lessons/user-courses/user-courses-limits.ts`:

| Параметр | Значение | Обоснование |
|---|---|---|
| `customPuzzles.length` | 1..20 | Симметрично `filter.limit` для пользовательских (ADR-026 §2.2) |
| `solutionMoves.length` | 1..40 | Соответствует `POSITION_PLY_LIMIT` системного archive (ADR-013) — глубже задачи в учебных целях редкость |
| `fen` длина | 30..100 символов | Базовая sanity, реальный chess.js парсинг — отдельный валидатор |
| `themes.length` | 0..5 | Авторские теги, не enum |
| `themes[i]` длина | 1..30 символов | |
| `caption` длина | 0..200 символов | |

---

## 3. Валидация решения

### 3.1 Что должна гарантировать валидация

Custom puzzle — **авторский контент**, и автор может ошибиться: ввести
невалидный FEN, нелегальный ход, несовпадение чьего хода ожидается.
Это нужно ловить **до публикации курса**, иначе студент откроет
сломанный шаг.

### 3.2 Решение: валидация на BE через chess.js, тот же путь что для endgame_drill

В `apps/api/src/lessons/dto/`:
- `custom-puzzle.validators.ts` — кастомные class-validator декораторы.
- Внутри `puzzle-step.dto.ts` (или новый `custom-puzzle-step.dto.ts`) —
  DTO с `@ValidateNested({ each: true }) @Type(() => CustomPuzzleDto)`.

Алгоритм валидатора:

1. **FEN.** `new Chess(fen)` — если бросает, 400 с сообщением «invalid FEN».
2. **`solutionMoves` legality.** Применяем ходы по очереди:
   ```ts
   const game = new Chess(payload.fen);
   for (const uci of payload.solutionMoves) {
     const move = game.move({ from: uci.slice(0,2), to: uci.slice(2,4), promotion: uci[4] });
     if (!move) throw new BadRequestException(`Illegal move: ${uci}`);
   }
   ```
3. **Длина и шейп ходов.** UCI 4–5 символов, `[a-h][1-8][a-h][1-8]([qrbn])?`.
4. **Не-вырожденность.** `solutionMoves.length >= 1`. Без хода это не
   задача, а позиция.
5. **Конечный статус позиции.** Ничего не проверяем дополнительно —
   автор имеет право задать решение «выигрыш материала», «выигрыш
   темпа», не обязательно мат. Если автор хочет именно мат — он сам
   делает последний ход матующим.

### 3.3 Что сознательно НЕ валидируем на BE

- **Уникальность решения.** В позиции может быть несколько матов в 1;
  автор выбрал один из них. Принимаем как заявленное решение, не
  требуем «единственный кратчайший вариант». Альтернативные ходы
  ученика → засчитываем как ошибку (как у preconstant Lichess
  puzzle — только заявленный главный вариант).
- **Соответствие тегам/темам.** Автор пишет `themes: ['fork']`, а в
  позиции вилки нет. Это эстетическая ответственность автора.
- **Сложность/рейтинг.** У custom puzzle нет рейтинга по построению (§4).

### 3.4 Дублирование валидации на FE

В редакторе автор видит ошибку **сразу** при вводе хода:
- Drag-n-drop в редакторе ходов проходит через тот же `chess.js` —
  невалидный ход не запишется в `solutionMoves`.
- При попытке сохранить шаг с пустым `solutionMoves` — кнопка «Сохранить»
  отключена с подсказкой «Запишите хотя бы один ход решения».

BE-валидация остаётся как защита от прямых API-вызовов и от случаев,
когда фронт-валидатор и серверный разошлись по версиям.

---

## 4. Влияние на puzzle-рейтинг (Glicko-2)

### 4.1 Решение: вариант **A — рейтинг не меняется**

Custom puzzle **не влияет** на `User.ratingPuzzle` / `ratingPuzzleDev`.
В runner'е (см. §5) при `mode='custom'` **не вызывается**
`puzzleApi.submitAttempt`.

### 4.2 Почему не B (автор задаёт сложность 1–5 → условный rating)

- **Нет калибровки.** Авторская «сложность 4 из 5» у одного автора и
  у другого — разные. Glicko-2 опирается на **сравнимые** рейтинги
  пары (player rating vs puzzle rating); несравнимый puzzle rating
  ломает обновление.
- **Открывает абуз-вектор.** Автор может поставить себе или другу
  «сложность 5» в курсе из тривиальных задач, накрутив puzzle-рейтинг.
  Защита (модерация авторских рейтингов) непропорциональна выигрышу.
- **Усложняет UI.** Автор сейчас не оценивает сложность задач, нет
  методики. Заводить — отдельный продуктовый вопрос.

### 4.3 Почему не C (default rating 1500)

- **Никакого сигнала о реальной сложности**: в текущей схеме custom
  puzzle с `rating=1500` относится к ученику с `ratingPuzzle=1100` как
  «хардовая», а тот же по факту тривиальный мат в 1 — как «лёгкая для
  его уровня». Изменение рейтинга на эта неточность вводит шум, а не
  сигнал.
- **Не решает абуз C.** Автор может натренировать свой `ratingPuzzle`
  на собственных лёгких custom puzzle — каждая решённая «1500 vs ваш
  1100» прибавит rating points.
- **Glicko-2 устойчив к шуму, но ломается systematically biased
  входами.** Курс из 50 «1500 default» задач у автора с уровнем 800
  — это смещённая выборка, которая исказит ratingPuzzle ученика без
  реального сигнала о его силе.

### 4.4 Что фиксируется в UI

В UI студент видит на шаге с custom puzzle подсказку:
**«Авторская задача — рейтинг не меняется»**. Это снимает ожидание,
которое могло бы возникнуть после opt-in от preconstant Lichess puzzle.

В шапке шага (компонент `PuzzleStep`) сейчас стоит счётчик
«Solved 1 • Failed 0 • Need 2». Под ним добавляется строка-подсказка
по локали `lessons.puzzle.customNoRating`.

### 4.5 Что фиксируется в shared-типе

В `CustomPuzzle` поле рейтинга **не добавляем**. Если в будущем продукт
решит ввести авторскую сложность (вариант B расширения) — это
обратимое расширение типа, без миграции payload'ов.

### 4.6 Mistakes-дневник

`Mistake` (KS-1802) сейчас пишется для **системных** puzzle (`mode='ids'`
/ `'filter'`) через `MistakesService.recordPuzzleMistake(puzzleId)`.
Параметр `puzzleId` — UUID из таблицы `puzzles`.

У custom puzzle UUID нет, в puzzle-БД она не существует. Решение:
**custom puzzle в Mistakes не пишется.** Аргументы:
- Mistakes-дневник методически опирается на агрегацию по теме (`fork`,
  `pin`, `mateIn2`), которая стабильна в puzzle-БД. Авторские теги
  custom puzzle не enum, не сравнимы между авторами.
- Без `puzzleId` запись в `Mistake` либо требует расширения схемы
  (`custom_puzzle_ref` UUID — куда? контент в чужом payload), либо
  будет полу-сиротой без обратной ссылки на содержание.

В будущем, если custom puzzle станет первоклассной сущностью (отдельная
таблица), Mistakes можно будет включить по тому же puzzleId-механизму.

---

## 5. Режим прохождения (новый код-путь в `PuzzleStep`)

### 5.1 Текущая логика runner'а (preconstant)

Поток (`apps/web/src/components/lessons/steps/PuzzleStep.tsx`):

1. На mount: `selectionKey = JSON.stringify(payload.selection)`.
2. `resolvePuzzles(payload)` → `lessonsApi.resolvePuzzleStep` →
   `POST /api/lessons/puzzle-step/resolve` → `PuzzleDto[]`.
3. `PuzzleDto` содержит: `id`, `fen`, `moves` (UCI string), `themes`,
   `rating`.
4. `currentMoves = puzzle.moves.split(' ')` — линейный список UCI.
   Первый элемент = setup-ход (применяется автоматически с задержкой
   300 ms), далее ученик ходит за противоположную сторону.
5. На каждый drag — сравниваем с `currentMoves[moveIndex]`. Совпало —
   делаем ход + автоход противника `currentMoves[moveIndex+1]`.
6. По завершении — `puzzleApi.submitAttempt(puzzle.id, {result, ...})`,
   что инициирует Glicko-2 update.

### 5.2 Контракт нового код-пути для `mode='custom'`

В тот же `PuzzleStep` добавляется ветка по `payload.selection.mode`:

```
if (mode === 'ids' || mode === 'filter')
  → существующий путь: resolvePuzzles → PuzzleDto[]
if (mode === 'custom')
  → новый путь: payload.selection.customPuzzles напрямую
```

Адаптер: маппинг `CustomPuzzle → PuzzleDto`-совместимый shape для
переиспользования всей нижестоящей механики (board + drag + match):

```ts
function customToInMemoryPuzzle(c: CustomPuzzle, idx: number): InMemoryPuzzle {
  return {
    id: `custom:${idx}`,           // строковый id, не UUID
    fen: c.fen,
    moves: c.solutionMoves.join(' '),
    themes: c.themes ?? [],
    rating: null,                  // явно null, не number
    isCustom: true,                // дискриминатор для submitAttempt-skip
    orientation: c.orientation,
  };
}
```

Тип `InMemoryPuzzle` — расширение существующего `PuzzleDto`:

```ts
export type InMemoryPuzzle = PuzzleDto & {
  /** true для custom puzzle — submitAttempt skipped, rating не идёт. */
  isCustom?: boolean;
  /** Прокинутый author orientation; иначе computed из fen.turn(). */
  orientation?: 'white' | 'black';
};
```

`PuzzleDto.rating` сейчас `number` — расширим до `number | null`. Это
**не ломает** систему, потому что rating используется только в
`PuzzleRatingService.applyRatingChange`, который у нас вообще не
вызывается при `isCustom=true`.

### 5.3 Поведение при ошибке

Текущий runner: при первой ошибке счётчик `failed++`, переход к
следующей задаче набора. Custom puzzle ведёт себя **идентично** —
консистентно с user expectation.

Альтернатива «дать вторую попытку» — отвергаем: добавляет режим
который у preconstant нет, путаницу UX. Если автор хочет «более
прощающий» режим — это отдельная фича `payload.allowRetry: boolean`,
вне скоупа ADR-029.

### 5.4 Учёт попытки (без рейтинга)

`submitAttempt` **не вызывается** при `isCustom=true`. Но **счётчик
шага** (`completedStepsCount` в `UserLessonPlayProgress`) инкрементится
тем же путём, что для preconstant: `onStepDone()` →
`POST /api/lessons/user-progress/lessons/:id/step` со state `done`.

Это значит:
- В `PuzzleAttempt` записи о custom puzzle нет.
- В `UserLessonPlayProgress.stepsState` запись есть (как у любого шага).
- В `Mistake` записи нет (см. §4.6).
- На карточке курса в `/lessons` шаг отмечен пройденным как обычно.

### 5.5 Счётчик задач набора и `minSolved`

`payload.minSolved` (по умолчанию = `customPuzzles.length`) работает
без изменений: это поле на уровне `PuzzleStepPayload`, не
`PuzzleSelection`. Шаг done когда `solved >= minSolved`.

### 5.6 Setup-ход (первый ход в `solutionMoves`)

В preconstant Lichess puzzle первый ход в `puzzle.moves` — setup
(применяется автоматически), ученик играет за противоположную сторону.
**Для custom puzzle это запутывает автора** — он расставил позицию,
ввёл первый ход, ожидая что **этот ход делает ученик**, а не противник.

**Решение: для custom puzzle считаем что первый ход в
`solutionMoves` — это ход ученика, не setup.** Это отличие от
preconstant, и runner'у нужно знать. Сделаем через явное поле в
`InMemoryPuzzle`:

```ts
export type InMemoryPuzzle = PuzzleDto & {
  isCustom?: boolean;
  /** Custom puzzle: первый ход в moves — ход ученика, не setup. */
  firstMoveIsUser?: boolean;
};
```

В runner'е блок «применить setup-ход с задержкой 300 ms» пропускается
при `firstMoveIsUser=true`. `boardOrientation` берётся из
`customPuzzle.orientation` напрямую (или из `fen.turn()`, если
автор не указал).

### 5.7 Что НЕ меняется в runner'е

- `PuzzleBoard` — без изменений.
- `chess.js`-проверка ходов — без изменений, тот же
  `from/to/promotion`.
- UI — иконка «Correct!» / «Not quite — try the next one» — без
  изменений.
- Подсказка «авторская задача — рейтинг не меняется» — добавляется в
  header puzzle-шага, скрывается при `!isCustom`.

---

## 6. UI-эскиз редактора custom puzzle

### 6.1 Где живёт

`apps/web/src/components/lessons/editor/fields/PuzzleFields.tsx` сейчас
показывает форму для двух режимов через `<select value={mode}>`.
Расширяем до трёх вариантов: `ids` / `filter` / `custom`.

При `mode='custom'` форма **полностью отличается** от первых двух —
вместо текстовых полей показываем визуальный редактор задачи.

### 6.2 Wireframe (desktop, ~720px width)

```
┌─ Selection mode ───────────────────────────────────────────────┐
│ [ Custom ▼ ]                                                   │
└────────────────────────────────────────────────────────────────┘

┌─ Custom puzzle 1 of 3 ─────────────────────────────────────────┐
│                                                                │
│   ┌─────────────────────┐  ┌─ Editor mode ─────────────────┐  │
│   │                     │  │ ( ) Set position              │  │
│   │   [chessboard]      │  │ (•) Record solution           │  │
│   │   8 × 8              │  └───────────────────────────────┘  │
│   │                     │                                     │
│   │                     │  Solution moves (UCI):              │
│   │                     │  1. e2e4   ← Your turn (White)      │
│   │                     │  2. e7e5   ← Opponent              │
│   │                     │  3. d2d4   ← Your turn              │
│   │                     │  [+ Add via board]    [↶ Undo last] │
│   │                     │                                     │
│   └─────────────────────┘  Next expected: White to move       │
│                                                                │
│   FEN:                                                         │
│   [rnbq…/8/PPPP… w KQkq - 0 1] [✎ Edit on board]              │
│                                                                │
│   Orientation:  ( ) Auto from FEN  (•) White  ( ) Black        │
│                                                                │
│   Caption (optional):  [_____________________________________] │
│                                                                │
│   Tags (optional):    [fork, pin]                              │
│                                                                │
│   [⌫ Delete this puzzle]                                       │
└────────────────────────────────────────────────────────────────┘

[+ Add custom puzzle]   [Min solved: 3 of 3 ▼]
```

### 6.3 Поведение

#### Editor mode toggle

- **Set position** — каждый клик/drag меняет позицию (работает Board
  Editor из KS-1875: добавление/удаление фигур, чистка доски, кнопки
  «Стартовая», «Очистить», смена «кто ходит»). При выходе из этого
  режима FEN фиксируется в payload.
- **Record solution** — доска принимает только **легальные ходы**
  (`chess.js.move({from, to})`). Каждый сделанный ход добавляется в
  `solutionMoves`. Доска показывает позицию **после последнего хода**.
  Ходим за обе стороны по очереди (как при анализе партии в
  workshop).

Переключатель — отдельная кнопка/радио, потому что drag-логика разная
(в Set Position drag перемещает фигуру в любую клетку, в Record
Solution — только если ход легален).

#### Список ходов справа

- Каждый ход — строка с UCI и подписью «Your turn (White)» /
  «Opponent (Black)» исходя из чётности и стороны игрока.
- «↶ Undo last» — удаляет последний ход из `solutionMoves`, доска
  откатывается к предыдущей позиции.
- Клик по конкретному ходу в списке (для будущего расширения,
  не в MVP) — может перейти к редактированию с этой точки.

#### Indicator чьего хода ждём

Под списком ходов: «Next expected: White to move» / «Black to move» —
вычисляется из текущей позиции (`chess.js.turn()`). Это та же
информация, что чётность `solutionMoves.length`, но рассчитанная
через chess.js — точнее (учитывает первый ход).

#### Кнопка «Reset solution»

В шапке editor mode — стирает `solutionMoves`, доска возвращается к
исходному FEN. Не стирает FEN.

#### Множественные custom puzzle в одном шаге

Кнопка «+ Add custom puzzle» в footer'е добавляет вторую/третью
авторскую задачу. Каждая в своей коллапсируемой карточке. Min solved —
как у preconstant.

### 6.4 Что переиспользуется из существующего

- **Board Editor** (модалка из KS-1875) для FEN. Открывается по
  кнопке «✎ Edit on board». Tabs FEN/Board Editor — те же.
- **PuzzleBoard** для drag-n-drop — тот же компонент, только без
  highlight «correct/incorrect» (это runner-only).
- **Стили** карточек — `.editor-step__fields`, `.editor-step__nested`.

### 6.5 Чего нет в MVP редактора

- **Drag-n-drop reorder** custom puzzle внутри шага — добавим если
  пользователь явно попросит. Сейчас ↑/↓ кнопками.
- **Preview prохождения** — кнопка «Try as student» в редакторе,
  открывающая ту же `PuzzleStep` runner-версию. Полезно, но
  отделимо: пользователь может включить публичный режим, открыть
  курс и попробовать сам.
- **Импорт из PGN** — paste PGN → автоматическое заполнение FEN +
  solutionMoves. Удобно, но MVP можно без; после явного запроса
  введём.

---

## 7. План реализации

Список задач с зависимостями, без оценок сроков.

### Backend

| Код | Описание | Зависит от |
|---|---|---|
| BE-1 | Расширить `PuzzleStepSelection` в shared: добавить `'custom'` вариант + `CustomPuzzle` интерфейс. Реэкспорт. | — |
| BE-2 | DTO `CustomPuzzleDto` + `custom-puzzle.validators.ts` (chess.js-валидация FEN и solutionMoves через class-validator). | BE-1 |
| BE-3 | Регистрация custom-варианта в discriminator существующего `puzzle-step.dto.ts`. | BE-2 |
| BE-4 | Лимиты в `user-courses-limits.ts` (см. §2.5). | BE-3 |
| BE-5 | Расширение `PuzzleDto.rating` до `number \| null` в shared + соответствующая правка `puzzle-resolver.service` (для custom — null, никогда не вызывается, но тип чистый). | BE-1 |
| BE-6 | Unit-тесты валидаторов: легальный FEN+ходы → 200; нелегальный ход → 400; пустой `solutionMoves` → 400; FEN невалидный → 400. | BE-2 |
| BE-7 | E2E-тест user-courses: создать шаг с custom puzzle → получить через GET → пройти через POST step → счётчик шагов курса инкрементится, `PuzzleAttempt` запись отсутствует, `User.ratingPuzzle` без изменений. | BE-3..6 |

### Frontend — editor

| Код | Описание | Зависит от |
|---|---|---|
| FE-E1 | `CustomPuzzleField.tsx` — компонент одной custom puzzle (доска + список ходов + поля FEN/orientation/caption/tags). Использует `PuzzleBoard` + Board Editor модалку. | BE-1 (типы) |
| FE-E2 | `PuzzleFields.tsx` — добавить вариант `mode='custom'` в `<select>`, рендер `CustomPuzzleField[]`. | FE-E1 |
| FE-E3 | i18n-ключи `editor.step.puzzle.custom.*` в en/ru locales. | FE-E2 |
| FE-E4 | Тесты: создание custom puzzle с одной задачей, добавление двух, undo последнего хода, reset solution, переключение режима набирает/сбрасывает payload. | FE-E1..E3 |

### Frontend — runner

| Код | Описание | Зависит от |
|---|---|---|
| FE-R1 | Расширить `PuzzleStep.tsx`: при `mode='custom'` вместо `resolvePuzzles` использовать `customToInMemoryPuzzle()` маппинг. | BE-1 (типы), BE-5 |
| FE-R2 | `firstMoveIsUser` — пропустить setup-ход для custom puzzle. | FE-R1 |
| FE-R3 | Skip `submitAttempt` при `isCustom=true`. Подсказка «Авторская задача — рейтинг не меняется» в header'е шага. | FE-R1 |
| FE-R4 | i18n `lessons.puzzle.customNoRating` в en/ru. | FE-R3 |
| FE-R5 | Тесты: custom puzzle решается → `onStepDone()` вызван, `puzzleApi.submitAttempt` НЕ вызван, header показывает подсказку про рейтинг. Ошибка → counter failed++, переход к следующей. | FE-R1..R3 |

### Документация

| Код | Описание | Зависит от |
|---|---|---|
| D-1 | Дополнить `docs/features/user-courses.md` (§3.5b «Задача» + §6 «Очки и рейтинг») разделом про custom puzzle. Раздел в RU и EN версиях. | FE-R1..R5 (после релиза) |

### Отвергнуты как не-MVP

- **Импорт PGN → custom puzzle** (FE-E5).
- **«Try as student» preview в редакторе** (FE-E6).
- **Mistakes-дневник для custom puzzle** (BE-8) — требует расширения
  `Mistake` схемы или отдельной таблицы.
- **Авторская сложность 1–5** (BE-9, FE-E7) — обсуждается отдельно
  если продукту нужна.

---

## 8. Что точно не меняется

- **Существующий поток для preconstant puzzle** (`mode='ids'`,
  `'filter'`) — без изменений. Custom — параллельная ветка.
- **`puzzles` таблица в системной БД** — без изменений. Custom в
  таблицу не пишется.
- **`PuzzleAttempt` / `MistakeSpec` / `User.ratingPuzzle`** — без
  изменений по shape; для custom просто не пишется/не читается.
- **API контракт `/api/archive/...`** — без изменений (custom puzzle
  никак не пересекается с архивом).

---

## 9. Открытые вопросы (из ADR-029 не закрываем)

1. **PGN-импорт.** Удобство существенное; добавим если пользователь
   попросит явно после первого использования custom puzzle.
2. **Preview прохождения в редакторе.** Удобство для автора. Зависит
   от того, насколько часто авторы будут публиковать заведомо
   сломанные задачи. После релиза посмотрим в стате (если будет
   статистика «опубликован сломанный шаг» — введём preview).
3. **Авторская сложность 1–5 без влияния на рейтинг (только метка).**
   Возможно, как UX-помощь студенту — «лёгкая / средняя / сложная»
   рядом с шагом. Не влияет на Glicko, не валидируется. Не блокер для
   MVP.
4. **Mistakes-дневник для custom.** Пока скипаем (§4.6). Если в
   будущем custom puzzle станет первоклассной сущностью с UUID —
   подключим тем же кодом.
