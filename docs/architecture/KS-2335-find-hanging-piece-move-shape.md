# KS-2335 · find-hanging-piece → answer-shape `move`

Документ описывает проектное решение по смене семантики drill-типа
`find-hanging-piece` с «кликни клетку висящей фигуры» на «возьми её ходом».
Изменение затрагивает predicate, shared-типы, банк, i18n и frontend.

Параллели и опора:
- KS-2320 — аналогичный переход `find-mate-in-one-square` `'square' → 'move'`.
- KS-2324 / KS-2325 — переход `find-all-checks` `'squares' → 'moves'`.
- KS-2333 — индикатор стороны на ходу для side-sensitive типов
  (`find-hanging-piece` уже включён в `SIDE_SENSITIVE_DRILL_TYPES` фронта).

---

## 1. Жалоба пользователя и причина изменения

Пользователь:
> «В этом типе паззлов вопрос звучит "Какая фигура противника висит".
> Неправильная формулировка. И в этом типе задач лучше сделать ход.
> Этим ходом надо взять НЕЗАЩИЩЁННУЮ фигуру. Это правильная формулировка.»

Семантическая суть навыка — не «увидеть клетку», а «найти бьющий ход».
Текущая формулировка путает с `find-loose-piece` (та же находка цели,
без хода). Drill теряет ценность тренировки навыка «вижу слабость → беру».

## 2. Текущее состояние

### 2.1 Predicate (`apps/api/src/tactic-drill/predicates/find-hanging-piece.ts`)

Алгоритм:
1. `our = chess.turn()`, `enemy = oppColor(our)`.
2. Перебрать все вражеские фигуры кроме короля.
3. Кандидаты: `attackers(sq, our) ≥ 1` и `attackers(sq, enemy) === 0`.
4. Если кандидатов ровно 1 — `valid: true, answer: { shape: 'square', square }`,
   иначе drop.

### 2.2 Контракт shared

`packages/shared/src/types/tactic-drill.ts`:
```ts
'find-hanging-piece': 'square'
```
DTO от backend'а на этот тип отдаёт `answerShape: 'square'`, эталон в БД
`{ shape: 'square', square: 'e5' }`.

### 2.3 Frontend

`DrillRunner.handleSquareClick` для `answerShape === 'square'` сразу
сабмитит `{ shape: 'square', square }` по клику. Side-to-move
индикатор берётся из FEN (KS-2333).

### 2.4 Лобби и i18n

- `drills.instructions.findHangingPiece` (RU/EN): «Какая фигура противника висит?» / «Which enemy piece is hanging?»
- `drills.typeDescriptions.findHangingPiece`: «Найдите фигуру противника, которую никто не защищает — её можно безнаказанно взять.»
- `DRILL_INSTRUCTION['find-hanging-piece']` в shared: то же по смыслу, но в формате per-type под Telegram-overlay.
- `DRILL_HINT['find-hanging-piece']`: «Зависшая = под боем И без защитников.»

## 3. Новая семантика

Drill звучит как «возьми незащищённую фигуру противника одним ходом».
Ответ — **ход** `{from, to}`, который:
1. Является **взятием** фигуры противника, у которой нет защитников
   (висящей).
2. Этот ход **легален** (не оставляет нашего короля под шахом —
   автоматически отфильтровывается `chess.moves({ verbose: true })`).
3. **Уникален** в позиции — должен быть ровно один такой ход.

Strict-uniqueness теперь по полной паре `(from, to)`, не по `to`-клетке.
То же правило, что в KS-2320 для `find-mate-in-one-square`: если
несколько наших фигур атакуют одну висящую — ответ не определён, drop.

### 3.1 Случаи, которые становятся drop'ами

Позиции, валидные сейчас, но отбрасываемые после изменения:

| Случай | Сейчас | После KS-2335 | Причина |
|---|---|---|---|
| 1 висящая фигура, 1 атакующий ходит легально | valid | valid | основной кейс |
| 1 висящая фигура, 1 атакующий — но взятие открывает шах нашему королю | valid | drop | ход нелегален → 0 capture-ходов |
| 1 висящая фигура, 2+ наших атакующих (Q×e5 и N×e5) | valid | drop | ответ неоднозначный |
| 1 висящая фигура, единственный атакующий — пешка с promotion (взятие на 8/1 ряду с превращением) | valid | drop | promotion в v1 не поддержан (как в `find-undefended-attack`) |
| 2+ висящих фигур | drop | drop | без изменений |

Ожидаемая усадка банка: ~20-40% (по аналогии с KS-2320; точнее покажет
re-index). Для целевого объёма 2000 (ADR-035 §6.3) потребуется
прогонять архив дольше / шире — план в §5.

## 4. Изменения по слоям

### 4.1 Shared (`packages/shared/src/types/tactic-drill.ts`)

```diff
 export const DRILL_TYPE_ANSWER_SHAPE: Record<TacticDrillType, AnswerShape> = {
-  'find-hanging-piece':      'square',
+  'find-hanging-piece':      'move',  // KS-2335 (раньше было 'square')
   'find-loose-piece':        'square',
   ...
 };
```

`DRILL_INSTRUCTION` и `DRILL_HINT` для `'find-hanging-piece'` —
переписать (тексты в §4.5).

Контракт `TacticDrillAnswer = AnswerData` остаётся discriminated union'ом,
для `find-hanging-piece` теперь сериализуется как
`{ "shape": "move", "from": "e2", "to": "e5" }`.

### 4.2 Predicate (`apps/api/src/tactic-drill/predicates/find-hanging-piece.ts`)

Возвращаемый тип меняется `SquareResult → MoveResult`. Псевдокод:

```ts
import type { AnswerMove } from '@kingside/shared';
import { allPieces, oppColor, tryLoadChess, type MoveResult } from './types';

export function findHangingPiece(fen: string): MoveResult {
  const chess = tryLoadChess(fen);
  if (!chess) return { valid: false, reason: 'invalid_fen' };

  const our = chess.turn();
  const enemy = oppColor(our);

  // 1) Найти кандидаты-цели (как сейчас).
  const targets: string[] = [];
  for (const p of allPieces(chess)) {
    if (p.color !== enemy) continue;
    if (p.type === 'k') continue;
    const attackers = chess.attackers(p.square, our);
    const defenders = chess.attackers(p.square, enemy);
    if (attackers.length >= 1 && defenders.length === 0) {
      targets.push(p.square);
    }
  }
  if (targets.length !== 1) {
    return { valid: false, reason: `expected exactly 1 hanging target, found ${targets.length}` };
  }
  const target = targets[0];

  // 2) Собрать все ЛЕГАЛЬНЫЕ ходы-взятия этой цели.
  const captures = chess.moves({ verbose: true }).filter(m =>
    m.to === target &&
    m.captured !== undefined &&
    !m.promotion // v1: promotion не поддерживается, как в find-undefended-attack
  );

  // 3) Strict-uniqueness по (from, to). Если 2+ атакующих — drop.
  if (captures.length !== 1) {
    return {
      valid: false,
      reason: `expected exactly 1 capture move, found ${captures.length}`,
    };
  }

  const m = captures[0];
  const answer: AnswerMove = { shape: 'move', from: m.from, to: m.to };
  return { valid: true, answer };
}
```

Замечания:
- `chess.moves({ verbose: true })` возвращает только легальные ходы.
  Случай «единственный атакующий связан и не может взять» автоматически
  обрабатывается: `captures.length === 0` → drop с понятной причиной.
- En-passant к hanging-логике не применим: ep капчит пешку на клетке,
  отличной от `to` (пешка стоит на `to ± 1` ранге), а `attackers()`
  у нас считается на клетке цели. Если когда-то всплывёт edge-case —
  фильтр `m.to === target` уже исключает несовпадение.
- Поле `m.captured` гарантировано определено для взятия; фильтр на него
  оставлен ради ясности, чтобы не перепутать с обычным ходом на цель
  (на занятой клетке стоит наша же фигура — невозможно по правилам).

### 4.3 Спеки predicate'а

`find-hanging-piece.spec.ts` переписать — текущие assert'ы на
`{ shape: 'square' }` сломаются. Целевое покрытие:

- (A) 1 атакующий, легальное взятие → `{ shape: 'move', from, to }`.
- (B) 1 цель, 2+ наших атакующих (Q+N бьют e5) → drop с причиной
  `expected exactly 1 capture move, found 2`.
- (C) 1 атакующий, но он связан → drop, `found 0`.
- (D) 1 атакующий, но взятие приводит к шаху (король за фигурой по
  линии) → drop, `found 0`.
- (E) Единственный атакующий — пешка с превращением → drop.
- (F) 2+ висящих фигур → drop (до этапа 2 не доходит).
- (G) Side-to-move берётся из FEN (`b - - 0 1` → ищем висящие у белых).
- (H) Невалидный FEN → `invalid_fen`.

### 4.4 Validator (`tactic-drill-validator.service.ts`)

**Без изменений.** Ветка `case 'move'` уже сравнивает `from` и `to`
(используется `find-mate-in-one-square` и `find-undefended-attack`).
Привилегий promotion в v1 не передаётся.

### 4.5 Indexer (`indexer-pipeline.ts`)

**Без изменений в коде.** `predicatesForPosition()` хранит результаты
generic'ом через `r.answer`, БД-колонка `answer JSONB` не типизирована.
После замены predicate'а pipeline сам начинает класть `move`-эталоны.

Дифликалти: `fTypeSpecificV1` для `find-hanging-piece` сейчас работает
с `answer.shape === 'square'`. **Поправить:** перевести логику на
`answer.shape === 'move'` и считать distractor-base от количества
вражеских не-королевских фигур (логика та же — distractor-proxy через
число потенциальных целей; используем `answer.to` вместо `answer.square`
там, где нужна клетка цели). Альтернатива — упростить до тех же
бакет-чисел, не привязываясь к клетке. Решение оставить **за backend'ом
при реализации** — оба варианта дают одинаковый bucket-распределение в
v1.

### 4.6 Re-index банка

Существующие записи `tactic_drills WHERE drill_type = 'find-hanging-piece'`
**несовместимы с новой логикой**: их `answer` — `{shape:'square',square}`,
а DTO теперь декларирует `answerShape: 'move'`. Любой submit пользователя
после deploy'а будет давать validator-mismatch (`answer.shape !== userAnswer.shape`),
все попытки = `solved: false`.

План:
1. **Truncate** `WHERE drill_type = 'find-hanging-piece'` (миграция
   данных, не схемы — выполняется backend'ом одной транзакцией перед
   запуском индексатора). Ssort удаляет так же связанные `tactic_drill_attempts`?
   — нет, `attempts` хранят `drillId`-FK. По правилам Prisma `onDelete`
   их поведение — backend проверяет (если `Cascade` — снесутся; если
   `Restrict` — придётся сначала чистить attempts). Если строгий вариант
   тяжёл, допустимо **soft-delete**: пометить старые drill'ы флагом
   `archived = true` (не используется в `/next`) и оставить historical
   attempts. Backend выбирает по фактическому состоянию схемы и объёму.
2. **Re-index**:
   ```bash
   ARCHIVE_DATABASE_URL=... DATABASE_URL=... \
     npm run index:tactic-drills --workspace=@kingside/api -- \
       --types=find-hanging-piece \
       --per-type-target=2000 \
       --difficulty-version=v1
   ```
   `runIndexer` сам фильтрует `types`, остальные drill-типы не трогает.
3. Если архив исчерпан до 2000 — расширить `--max-games=inf` (default)
   и/или дождаться следующих TWIC-импортов (incremental scheduler
   подхватит автоматически).

QA-критерий после re-index'а: `SELECT COUNT(*), AVG(difficulty)
FROM tactic_drills WHERE drill_type='find-hanging-piece' GROUP BY 1;`
— ≥ 500 записей в каждом из bucket 2-4, ≥ 100 в bucket 1 и 5.

### 4.7 i18n

`apps/web/src/i18n/locales/{ru,en}/translation.json`:

```diff
 "instructions": {
-  "findHangingPiece": "Какая фигура противника висит?",
+  "findHangingPiece": "Возьмите незащищённую фигуру противника",
   ...
 },
 "typeDescriptions": {
-  "findHangingPiece": "Найдите фигуру противника, которую никто не защищает — её можно безнаказанно взять.",
+  "findHangingPiece": "Найдите фигуру противника без защитников и заберите её одним ходом.",
   ...
 },
```

Английский:
```diff
-  "findHangingPiece": "Which enemy piece is hanging?",
+  "findHangingPiece": "Capture the undefended enemy piece",
-  "findHangingPiece": "Spot the enemy piece that no one defends — free to take.",
+  "findHangingPiece": "Find an undefended enemy piece and capture it in one move.",
```

`drills.types.findHangingPiece` («Висящая фигура» / «Hanging piece») —
**не меняется**, это название типа.

`packages/shared/src/types/tactic-drill.ts`:

```diff
 'find-hanging-piece':      {
-  ru: 'Найди фигуру под боем без защиты — клетка с зависшей фигурой.',
-  en: 'Find a piece under attack with no defenders — click the hanging piece square.',
+  ru: 'Возьми ходом фигуру противника без защитников.',
+  en: 'Capture an undefended enemy piece in one move.',
 },
```

`DRILL_HINT` остаётся прежним по смыслу — определение «висящая = под
боем И без защитников» актуально:

```diff
 'find-hanging-piece':      {
-  ru: 'Зависшая = под боем И без защитников.',
-  en: 'Hanging = attacked AND undefended.',
+  ru: 'Зависшая = под боем И без защитников. Возьми её.',
+  en: 'Hanging = attacked AND undefended. Take it.',
 },
```

### 4.8 Frontend (`apps/web/src/components/drills/DrillRunner.tsx`)

Кода менять **не нужно**. Пути для `answerShape === 'move'` уже
существуют:
- `handleSquareClick` — click→click ввод (`pickedFrom` → submit).
- `handlePieceDrop` — drag-and-drop ввод хода.
- Подсветка `pickedFrom` через `highlightedSquares`.
- `effectiveSideToMove` берётся из FEN (KS-2333 уже включил
  `find-hanging-piece` в `SIDE_SENSITIVE_DRILL_TYPES`).

Фронт автоматически «переключится» на move-ветку, как только сервер
начнёт отдавать `answerShape: 'move'` для этого типа.

**Тесты:** `DrillRunner.test.tsx` содержит сценарии для каждого
answer-shape. Сценарии для `'find-hanging-piece'` сейчас идут через
square-ветку — нужно перевести их на move-ветку (либо поменять
fixture'ы drill-типа, либо переписать кейсы под новый shape). Конкретный
объём правок — у frontend'а после прогона юнит-тестов.

### 4.9 Что не меняется

- `tactic-drill.controller.ts` (REST endpoints) — generic над shape.
- `tactic-drill-sprint.service.ts` — generic.
- `daily-tactic-drill*.ts` — Telegram daily использует `drillTypeLabel`,
  которое осталось «Висящая фигура / Hanging piece». Картинка-overlay
  показывает FEN+caption, sub шейп для overlay сейчас не критичен (в
  ADR §11 imageUrl рендерится без подсветки правильного ответа). Если
  фронт-overlay рисовал стрелку для `square`-shape — теперь его нужно
  рисовать для `move`-shape (стрелка from→to). Отдельная задача
  marketing'а или backend'а — **проверить и при необходимости
  поправить генератор картинок**, не блокирующее основной выпуск.

## 5. План внедрения (по этапам)

### Этап 1 — Backend (1 ticket)

1. Поменять `DRILL_TYPE_ANSWER_SHAPE['find-hanging-piece']` на `'move'`
   в shared.
2. Переписать `find-hanging-piece.ts` predicate (новый алгоритм + тип
   `MoveResult`).
3. Переписать `find-hanging-piece.spec.ts` под все случаи §4.3.
4. Поправить `fTypeSpecificV1` в `difficulty.ts`: case
   `find-hanging-piece` теперь ожидает `answer.shape === 'move'`.
5. Обновить `DRILL_INSTRUCTION` и `DRILL_HINT` в shared (RU+EN).
6. Привести в порядок doc-комментарии в predicate'е и `tactic-drill-api-contract.md`
   (§3 таблица shape↔type — добавить пометку про KS-2335).
7. Удалить устаревший упоминания «squares only» вокруг find-hanging-piece
   в spec'ах валидатора (если есть).
8. Запустить `npm run test --workspace=@kingside/api` — все тесты
   зелёные.

**Acceptance backend-тикета:**
- `find-hanging-piece.spec.ts` — все 8 кейсов §4.3 проходят.
- `tactic-drill-validator.service.spec.ts`, `tactic-drill.service.spec.ts`,
  `tactic-drill-sprint.service.spec.ts` — без регрессий.
- `validate-drill-positions` (KS-2312) на ручном fixture с
  hanging-позицией возвращает `valid: true` с `move`-ответом.

### Этап 2 — Re-index банка (тот же backend-тикет, шаг после p.1-8)

1. Удалить (или archive=true) существующие drill'ы:
   `DELETE FROM tactic_drills WHERE drill_type = 'find-hanging-piece';`
   (Backend выбирает `DELETE` vs `archive` исходя из onDelete-поведения
   `tactic_drill_attempts.drill_id_fkey`. Если `Restrict` — сначала
   `DELETE FROM tactic_drill_attempts WHERE drill_id IN (...)`, либо
   принять решение оставить attempts с soft-archived drill'ами.)
2. Прогнать индексатор только по этому типу:
   `npm run index:tactic-drills -- --types=find-hanging-piece --per-type-target=2000`.
3. Проверить распределение бакетов (запрос §4.6).

**Запускает:** backend ручным RunTask на проде после code-merge'а.
DevOps выпиской автодеплоя не участвует.

### Этап 3 — Frontend (1 ticket)

1. Обновить `apps/web/src/i18n/locales/{ru,en}/translation.json`:
   `drills.instructions.findHangingPiece`,
   `drills.typeDescriptions.findHangingPiece` (тексты §4.7).
2. Прогнать `DrillRunner.test.tsx` — поправить тесты, где fixture
   возвращал `find-hanging-piece` с `answerShape: 'square'`. Переписать
   на `'move'` + сценарий click→click либо drag-and-drop.
3. Прогнать `DrillsLobbyPage.test.tsx`, `drills.i18n.test.tsx` —
   проверить отсутствие падений из-за нового текста.
4. Проверить вручную (Playwright или dev-сервер): зайти на
   `/drills/find-hanging-piece`, увидеть формулировку «Возьмите
   незащищённую фигуру противника», ответить ходом → feedback зелёный
   при правильном ходе, красный при неверном; стрелка правильного
   хода в feedback-overlay видна (это уже реализовано в DrillRunner
   через `highlightedSquares = [c.from, c.to]`).

**Acceptance frontend-тикета:**
- Все unit-тесты `apps/web` зелёные.
- Скриншот `/drills/find-hanging-piece` (Playwright) с новой
  формулировкой и доской.
- Ручная проверка: правильный ход → success, любой другой ход → fail
  с красной подсветкой и стрелкой правильного ответа.

### Зависимости

- Frontend-тикет может стартовать **только после merge backend-тикета**:
  до этого `/tactic-drill/types` всё ещё отдаёт `'square'`, и тесты
  фронта (которые ходят через мокированный API) сломаются на новой
  i18n / новом shape одновременно.
- Re-index можно делать после merge'а — пользователю решающего значения
  не имеет (старые drill'ы не работают сразу после merge'а, фронт
  показывает «Не удалось отправить ответ» из-за shape-mismatch). Поэтому
  **shape-смена + re-index должны идти одной выкладкой**.

## 6. Открытые вопросы

1. **Telegram daily-overlay картинка** — рисует ли она ответ-стрелку
   для shape='move' для find-hanging-piece? Если нет — нужна отдельная
   задача marketing/backend. Не блокирующее.
2. **Поведение `tactic_drill_attempts.drill_id_fkey`** при удалении
   старых drill'ов — backend проверяет на этапе re-index'а.

## 7. Acceptance общий

- Карточка в лобби `find-hanging-piece` рассказывает «найди и возьми».
- В drill'е вопрос — «Возьмите незащищённую фигуру противника».
- Ответ принимается как ход (click→click или drag).
- Validator корректно сравнивает по `(from, to)`.
- Банк перезаполнен новой логикой ≥ 2000 позиций (или зафиксирован
  меньший объём с пометкой о расширении на следующих TWIC-импортах).
- Все тесты api+web зелёные.
