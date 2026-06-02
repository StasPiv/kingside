# ADR-094. Precision — автотегирование фазы партии (debut / middlegame / endgame)

Статус: предложен (2026-06-02) — аналитический документ
Связано: KS-3561 (этот ADR), ADR-080 (precision theme filters —
whitelist уже включает `opening`/`middlegame`/`endgame`),
ADR-070 / ADR-041 (puzzle-generator tagging), ADR-079 (auto-pick
по теме), ADR-085 (lichess-puzzler applicability).

## 1. Контекст

Пользователь просит алгоритм авторазметки тем для precision-задач.
Старт — две простые фазы: **«дебют»** и **«эндшпиль»**. Сигналы
тривиальные и видны прямо из FEN: номер хода и число фигур.
Lichess-алгоритм мотив-тэггинга не подходит (KS-3402 / ADR-085 —
требует главного варианта, не наш сценарий).

## 2. Проверено по коду

- **`Puzzle.themes: String @default("")`** — space-separated
  string в `packages/db/prisma/schema.prisma:309`. Индекс
  `@@index([themes])`. Это «общий бак» для тегов, разделяется
  lichess-задачами и generated.
- **`computeTags()`** в `apps/tactic-worker/src/puzzle-generator/
  tagging.ts` уже выставляет тег `endgame` при `total ≤ 7 фигур`
  (line 134-139, TB-граница). **`opening` и `middlegame`
  отсутствуют.**
- **ADR-080 §2.3 PRECISION_RELEVANT_THEMES** включает в whitelist
  `'opening', 'middlegame', 'endgame', 'pawnEndgame',
  'rookEndgame'...` — фильтр их уже умеет показывать, но генератор
  их (кроме `endgame`) пока не ставит → counter всегда 0.
- **i18n labels** в `apps/web/src/i18n/locales/ru/translation.json`
  уже есть: `puzzleTheme.opening = "Дебют"`, `middlegame =
  "Миттельшпиль"`, `endgame = "Эндшпиль"` (line ~1841 и др.).
- **`Puzzle.sourceMoveNum`** есть у generated (номер хода в
  партии-источнике). Можно использовать, но FEN сам содержит
  fullmove counter — единый сигнал для lichess и generated.
- **`allPieces(chess)`** в `apps/tactic-worker/src/predicates/
  types.ts:92` возвращает массив `{type, color, square}` — удобно
  считать ферзей и не-пешечный материал.
- **Lichess-задачи** имеют свои оригинальные `opening`/
  `middlegame`/`endgame` теги (lichess-puzzler tagger). Не трогаем
  (ADR-080 §2.7).

## 3. Решения

### 3.1 Алгоритм фазы

Считаем по **стартовой FEN puzzle** (`Puzzle.fen`, позиция ДО
зевка). FEN всегда содержит:
- `fullmoveNumber` (6-е поле, 1-based — номер полного хода).
- Расстановку фигур (1-е поле) → `allPieces(chess)`.

```ts
type Phase = 'opening' | 'middlegame' | 'endgame';

function detectPhase(fen: string): Phase {
  const chess = new Chess(fen);
  const pieces = allPieces(chess);  // {type, color}[]

  // Не считаем королей в "общем материале".
  const nonKing = pieces.filter(p => p.type !== 'k');
  const total = nonKing.length;
  const queens = nonKing.filter(p => p.type === 'q').length;
  const nonPawn = nonKing.filter(p => p.type !== 'p').length;
  const fullmove = Number(fen.split(' ')[5] ?? '1');

  // ENDGAME первым — он "перебивает" дебют (быстрый размен).
  // Условия (ИЛИ):
  //   (а) TB-граница: ≤ 7 фигур с королями = ≤ 5 нон-кинг.
  //       Это сохраняет совместимость с существующим computeTags.
  //   (б) Классический эндшпиль: ферзей нет AND не-пешечного
  //       материала ≤ 6 (например, R+B+P vs R+N+P).
  if (total <= 5) return 'endgame';
  if (queens === 0 && nonPawn <= 6) return 'endgame';

  // OPENING: первые ~12 ходов и материал ещё богатый.
  // Порог fullmove ≤ 12 (24 полухода) — стандартный для
  // "позиция вышла из дебюта".
  if (fullmove <= 12) return 'opening';

  return 'middlegame';
}
```

**Пороги — обоснование:**
- `total ≤ 5` нон-кинг = `≤ 7 с королями` — совпадает с текущим
  `computeTags` (line 138, `total <= 7` — там считались `allPieces`
  включая королей).
- `queens === 0 AND nonPawn ≤ 6` — классический critерий
  "размен ферзей + основные фигуры разменены". Покрывает R+R+P
  vs R+R+P, B+N vs B+N, R+B vs R+N и т.п.
- `fullmove ≤ 12` — типичный конец дебютной теории. Альтернативы
  10 / 15 — Open Q1.
- **Взаимоисключающие**: каждый puzzle получает РОВНО одну фазу.
  Endgame проверяется первым (быстрый размен после короткой партии
  → endgame, не opening).

### 3.2 Хранить в БД, не считать на лету

**Решение: хранить** (добавлять тег в `Puzzle.themes`).

Обоснование:
- `themes` уже индексирован, фильтрация ADR-080 уже работает.
- `theme-counts` endpoint (ADR-080 §4.3) делает `unnest` по
  themes — on-the-fly FEN-парсинг 1.5M пазлов невозможен.
- Generator уже пишет другие теги в `themes` (см. `computeTags`).
- On-the-fly имеет смысл только для UI-бейджа на одной задаче —
  но 5 мс это не оправдывает дополнительной ветки.

### 3.3 Контракт API — без изменений

`PuzzleListItem.themes` и `PuzzleDetail.themes` уже передаются
из `Puzzle.themes` (строка/массив, ADR-080). Никаких новых полей.
Фронт показывает фазу через тот же chips/sheet, что и другие темы
(ADR-080 §2.6, бейдж группы «Фазы»).

### 3.4 Backfill для существующих generated

`computeTags` уже стоит в pipeline генерации (новые puzzles
получают phase сразу). Для существующих — отдельный SQL/script.

```sql
-- Шаг 1: audit — сколько generated без фаз
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE themes ~* '(^| )(opening|middlegame|endgame)( |$)') AS with_phase,
  COUNT(*) FILTER (WHERE themes !~* '(^| )(opening|middlegame|endgame)( |$)') AS without_phase
FROM puzzles
WHERE source = 'generated';
```

Backfill в `apps/tactic-worker` (CLI или admin-endpoint):
1. SELECT `id, fen, themes` WHERE `source='generated'` AND
   `themes NOT ~ '(opening|middlegame|endgame)'`.
2. Для каждой записи: `phase = detectPhase(fen)`.
3. `UPDATE themes = trim(themes || ' ' || phase)`.
4. Batch 500 + COMMIT.

**Lichess-задачи (source='lichess') — НЕ трогаем.** У них уже
есть оригинальные теги фаз (lichess-puzzler). Наш алгоритм мог
бы дать другой ответ — несовместимость с тысячами других тегов
lichess-датасета. Семантика «фаза по lichess» приемлема.

**Идемпотентность:** запускаемый повторно скрипт пропускает
puzzles, у которых уже есть фаза (поэтому фильтр в WHERE).

### 3.5 Расширяемость

Будущее (M2+, отдельные ADR):
- **Детальные эндшпили**: `pawnEndgame` / `rookEndgame` /
  `queenEndgame` / `knightEndgame` / `bishopEndgame` /
  `queenRookEndgame` (уже в whitelist ADR-080 §2.3). Реализация:
  при `phase === 'endgame'` дополнительно классифицировать по
  доминирующему типу не-пешечной фигуры.
- **Opening по ECO**: использовать `Puzzle.openingTags` (есть для
  lichess) или ECO-индекс для generated (через
  archive-service.openings). Тогда `opening` ставится не по
  fullmove, а по совпадению с известным дебютом.
- **Размен ферзей внутри puzzle-линии**: позиция может ОЙКТАТЬ
  на эндшпиль ВНУТРИ решения. Сейчас тег ставится по стартовой
  FEN. Для consistency решаем "phase — это фаза стартовой
  позиции puzzle, не финальной". Документировать.
- **`middlegame` как explicit тег**: ставим ВСЕГДА (а не
  "если ни opening, ни endgame не сработали"), потому что
  counter'у нужна positive выборка. Альтернатива (не ставить
  middlegame, derive как "нет opening и нет endgame") — ломает
  counter ADR-080 §4.3.

### 3.6 Что НЕ делаем (M1)

- НЕ trogaem lichess-задачи (§3.4).
- НЕ вводим детальные эндшпили (`pawnEndgame` и т.п.) — M2.
- НЕ парсим ECO/дебютную теорию для `opening` — fullmove ≤ 12 —
  достаточный сигнал для MVP.
- НЕ пересчитываем фазу post-game (по финальной позиции puzzle).
- НЕ добавляем UI-инструмент ручной правки тегов (Open Q5).
- НЕ меняем API contract (§3.3).

## 4. Подзадачи

Зависимости: B1 (computeTags) → B2 (audit) → B3 (backfill, если
audit покажет пропуски) → C1 (i18n проверка, параллельно).

### KS (B1) — `computeTags`: добавить opening / middlegame, расширить endgame

**Assignee:** backend (tactic-worker).
**Labels:** `puzzle`, `analysis`.
- В `apps/tactic-worker/src/puzzle-generator/tagging.ts` —
  заменить блок «Endgame» на универсальный `detectPhase()` по §3.1.
- Алгоритм: ENDGAME первым (TB ≤5 нон-кинг ИЛИ queens=0 AND
  nonPawn≤6), затем OPENING (fullmove ≤12), затем MIDDLEGAME.
- Каждый puzzle получает ровно один phase-tag.
- Unit-тесты на 6 типичных FEN:
  - стартовая позиция → `opening`.
  - после 1.e4 → `opening`.
  - midgame (fullmove=20, материал почти полный) → `middlegame`.
  - размен ферзей на 20-м ходу + малый материал → `endgame`.
  - K+P vs K → `endgame`.
  - быстрый размен (fullmove=8, total=6) → `endgame`
    (endgame перебивает opening).
- Acceptance: тесты зелёные; новые generated puzzles в БД
  получают одну из трёх фаз.

### KS (B2) — audit распределения фаз для generated

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
- SQL-запрос (§3.4 шаг 1) на dev и prod (read-only).
- Отчёт в комментарий задачи: total / with_phase / without_phase.
- Дополнительно: распределение opening / middlegame / endgame
  для тех, у кого фаза уже есть (т.е. `endgame` от текущего
  tagger).
- Решение: запускать ли B3 (если `without_phase > 0`).
- Acceptance: цифры в комментарии + go/no-go по B3.

### KS (B3) — backfill phase для существующих generated (условный)

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** B1 (логика), B2 (выявил пропуски).
- CLI-скрипт в `apps/tactic-worker/scripts/` или admin-endpoint:
  `backfill-phase.ts`.
- Цикл по generated puzzles без phase-тега (§3.4 алгоритм).
- Batch 500, COMMIT после каждой пачки, лог progress.
- Идемпотентно: повторный запуск пропускает уже размеченные.
- Lichess-задачи (`source='lichess'`) ИГНОРИРУЕМ.
- Acceptance: после прогона `without_phase = 0` для generated;
  spot-check 10 случайных пазлов — фаза соответствует визуально.

### KS (C1) — i18n проверка для opening / middlegame / endgame

**Assignee:** chess-expert (RU) + frontend (EN-fallback).
**Labels:** `puzzle`, `analysis`, `i18n`.
- Проверить что в `apps/web/src/i18n/locales/ru/translation.json`
  и `en/translation.json` есть `puzzleTheme.opening` /
  `middlegame` / `endgame` (уже видны в RU, см. §2; проверить EN).
- Если EN отсутствует — добавить (`"opening": "Opening"`,
  `"middlegame": "Middlegame"`, `"endgame": "Endgame"`).
- Acceptance: оба языка содержат все три ключа.

**Frontend / layout НЕТ задач** — UI отображения тем уже работает
через PrecisionThemesSheet (ADR-080), новые теги автоматически
заполняются в группе «Фазы» (ADR-080 §3.2).

## 5. Риски

1. **Пороги "вкусовые"** (fullmove ≤ 12, nonPawn ≤ 6) — могут
   оказаться не оптимальными. Митигация: после B2/B3 смотрим
   распределение, если перекос (например, 90% middlegame) —
   калибровка отдельной задачей. Не блокер для M1.
2. **Конфликт с lichess-тегами**: lichess-tagger ставит свои
   `opening`/`endgame` по другим правилам. Наш алгоритм НЕ
   трогает lichess-задачи (§3.4), но семантика "opening" в БД
   получается слегка разной для generated и lichess. Митигация:
   документировано (§3.4); пользователь видит единый чекбокс
   "Дебют" — для UI разница не видна.
3. **Backfill UPDATE на больших таблицах**: batch=500 +
   `WHERE themes !~ '...'` отсекает уже обработанные. Lock-time
   per batch ≈ 100ms на 1.5K generated — приемлемо.
4. **Размен ферзей внутри linе**: puzzle стартует в миттельшпиле,
   но решение приводит к эндшпильной позиции. Фаза остаётся
   `middlegame` (по старту). Это правильно — пользователь
   тренирует "переход из миттельшпиля в эндшпиль", это не сам
   эндшпиль. M2 — отдельный тег `endgameTransition` если
   потребуется.
5. **`fullmove` для generated**: проверить что `Puzzle.fen` у
   generated действительно содержит корректный fullmove
   (берётся из FEN партии-источника). Если 100% случаев = 1
   (FEN normalised) — порог `≤12` всегда true, все generated
   станут `opening`. Митигация: в B1 unit-тест на реальную
   generated FEN из staging.

## 6. Открытые вопросы

1. **Порог opening** — fullmove ≤ 12 (моё) vs 10 vs 15? Если
   B2 покажет перекос — калибровать.
2. **Эндшпиль `queens=0 AND nonPawn≤6`** — порог 6 (моё) vs 5
   (строже, классический "лёгкий эндшпиль") vs 7?
3. **`middlegame` ставим explicit** (моё, §3.5) vs derive
   "ни opening, ни endgame"? Counter ADR-080 §4.3 требует
   positive тег.
4. **Lichess-задачи** — НЕ trogaem (моё, §3.4) vs пересчитать
   нашим алгоритмом для consistency? Lichess-теги могут
   отличаться семантически.
5. **UI-инструмент** ручной правки тега фазы (для chess-expert) —
   M2 или M1? Если auto-алгоритм ошибся для конкретной задачи,
   как поправить?
6. **Использовать `Puzzle.sourceMoveNum`** вместо FEN-fullmove
   для generated? Они эквивалентны (sourceMoveNum =
   fenAtSource.fullmove), FEN-парсинг универсальнее (работает и
   для lichess если решим пересчитывать) — моё за FEN.
7. **`endgameTransition`** (puzzle переходит в endgame по ходу
   линии) — M2 (моё) или сразу?

## 7. Откат

- B1 — additive, новый код в `computeTags`. Revert убирает
  phase-тег у новых generated; existing уже размеченные
  останутся (нужен ручной cleanup, но не критично — теги
  игнорируются если фильтр их не использует).
- B3 backfill — `UPDATE themes` дописывает phase, не удаляя
  существующие теги. Revert невозможен без бэкапа `themes`-
  поля до backfill. Митигация: до запуска B3 сделать
  `pg_dump puzzles --table puzzles --data-only > backup.sql`.
- API contracts не меняются — откат не нужен.
