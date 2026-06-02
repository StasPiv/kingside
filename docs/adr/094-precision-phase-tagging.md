# ADR-094. Precision — автотегирование фазы партии (debut / middlegame / endgame)

Статус: предложен (2026-06-02, ревизия 2) — аналитический документ
Связано: KS-3561 (M1, фазы), KS-3566 (M2, подвиды эндшпиля),
ADR-080 (precision theme filters — whitelist уже включает
`opening`/`middlegame`/`endgame` + подвиды),
ADR-070 / ADR-041 (puzzle-generator tagging), ADR-079 (auto-pick
по теме), ADR-085 (lichess-puzzler applicability).

> **Ревизия 2 (2026-06-02).** Расширение M2 — подвиды эндшпиля
> (см. §8). Скрин пользователя показал что секция «Эндшпиль»
> разметила 2177 generated-задач зонтичным `endgame`, но 5
> подвидов (pawn/rook/queen/knight/bishop) имеют counter 0 —
> детектор подвида отсутствует. Добавляем `detectEndgameSubtype`
> по составу не-пешечного материала, backfill 2177 эндшпилей.
> Lichess не trogaem.

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

---

## 8. Ревизия 2 — подвиды эндшпиля (KS-3566)

### 8.1 Запрос пользователя

Скрин `/tmp/telegram/326131278_0.jpg`: страница «Темы» precision
показывает `Эндшпиль (2177)` — зонтичный тег работает (M1 §3.1).
Но под ним 4 подвида с counter'ом 0:
- Пешечный эндшпиль (0)
- Ладейный эндшпиль (0)
- Ферзевый эндшпиль (0)
- Коневой эндшпиль (0)

Слоновый эндшпиль присутствует в whitelist
(`PRECISION_THEME_GROUPS.endgame` line 78 `precision-themes.ts`),
на скрине обрезан скроллом. Все 5 подвидов рендерятся UI, но
generated-задачи их не получают.

Запрос: подвиды + смешанные. Lichess не трогать.

### 8.2 Проверено по коду

- **`PRECISION_THEME_GROUPS.endgame`** в `packages/shared/src/
  utils/precision-themes.ts:72-83` уже содержит 10 эндшпильных
  тем: `endgame`, `pawnEndgame`, `rookEndgame`, `queenEndgame`,
  `knightEndgame`, `bishopEndgame`, `queenRookEndgame`,
  `promotion`, `underPromotion`, `advancedPawn`. UI группы готов.
- **i18n** уже содержит RU labels (видны на скрине: «Пешечный
  эндшпиль», «Ладейный эндшпиль», ...). EN — проверить.
- **`computeTags` (M1)** ставит только зонтичный `endgame` — без
  подвида. Расширяем здесь.
- **`opposite-colors-bishops`** — в whitelist precision-themes.ts
  **отсутствует** (комментарий line 69-71 «пропускаем»). M3 если
  потребуется.

### 8.3 Решение — состав не-пешечного материала

Подвид определяется по объединённому множеству типов не-пешечных
не-королевских фигур ОБЕИХ сторон.

```ts
type EndgameSubtype =
  | 'pawnEndgame'
  | 'rookEndgame'
  | 'queenEndgame'
  | 'knightEndgame'
  | 'bishopEndgame'
  | 'queenRookEndgame'
  | null;  // смешанный без специфичного подвида

function detectEndgameSubtype(fen: string): EndgameSubtype {
  const chess = new Chess(fen);
  const pieces = allPieces(chess);  // {type, color}[]
  // Не-пешечные и не-королевские фигуры обеих сторон.
  const heavy = pieces.filter(p => p.type !== 'p' && p.type !== 'k');
  const types = new Set(heavy.map(p => p.type));   // подмножество {q,r,b,n}

  if (types.size === 0) {
    // Только пешки и короли (или вообще K vs K — экзотика).
    return 'pawnEndgame';
  }
  if (types.size === 1) {
    const only = [...types][0];
    if (only === 'r') return 'rookEndgame';
    if (only === 'q') return 'queenEndgame';
    if (only === 'n') return 'knightEndgame';
    if (only === 'b') return 'bishopEndgame';
  }
  if (types.size === 2 && types.has('q') && types.has('r')) {
    return 'queenRookEndgame';   // lichess-стандарт, в whitelist
  }
  // Остальные комбо: R+N, R+B, B+N, Q+N, Q+B и т.д.
  // Без специфичного тега в M2.
  return null;
}
```

**Семантика «чистого» подвида:**
- `pawnEndgame` — только пешки (или вообще без не-пешечного
  материала). Включает асимметрию (K+P vs K).
- `rookEndgame` — у обеих сторон ТОЛЬКО ладьи (среди не-пешечных).
  Асимметрия R+P vs K+P тоже считается ладейным (у одной стороны
  ладьи, у другой нет — но единственный тип НЕ-пешечной = ладья).
- `queenEndgame`, `knightEndgame`, `bishopEndgame` — аналогично.
- `queenRookEndgame` — ровно набор `{q, r}` (q+r vs q, q+r vs r,
  q+r vs q+r, q vs r и т.п. — везде где НЕТ N и B).

**«Смешанные» (M2):** все остальные комбо (R+N, R+B, B+N, Q+B,
Q+N, и т.д.) → `null` → только зонтичный `endgame`, без
подвидового тега. UI таких задач показывает в фильтре «Эндшпиль»
(зонтичный), но НЕ в подсекциях.

Альтернатива (отвергнута для M2): добавить общий
`mixedEndgame`-тэг. Не делаем — нет в whitelist
`precision-themes.ts`, требует S-задачи на расширение, и
семантически «смешанный» — слабая категория для тренировки.
Open Q1.

### 8.4 Асимметрия и edge-cases

| Позиция | types | Подвид |
|---|---|---|
| K+P vs K | ∅ | `pawnEndgame` |
| K vs K | ∅ | `pawnEndgame` (формально; вряд ли встретится после фильтра ENDGAME §3.1) |
| K+R+P vs K+P | {r} | `rookEndgame` |
| K+R vs K+N | {r,n} | `null` (R vs N — смешанный) |
| K+Q+R vs K+R | {q,r} | `queenRookEndgame` |
| K+Q+R+B vs K+R | {q,r,b} | `null` (Q+R+B — смешанный) |
| K+B+B vs K+N | {b,n} | `null` (B+N — смешанный) |
| K+N+N vs K | {n} | `knightEndgame` |
| K+B vs K | {b} | `bishopEndgame` |

### 8.5 Хранение — зонтичный + подвид

`Puzzle.themes` получает **оба** тега:
- `endgame` (всегда, из M1 §3.1).
- Дополнительно подвид если `detectEndgameSubtype` возвращает не
  `null`.

Пример: `"endgame rookEndgame quietMove"` или просто `"endgame"`
для смешанных.

Обоснование:
- Lichess делает так же (puzzle с `pawnEndgame` имеет также
  `endgame`).
- Фильтр «все эндшпили» работает одной галкой `endgame`.
- Фильтр «только пешечный» работает галкой `pawnEndgame`
  (без `endgame`, т.к. ADR-080 фильтр работает на OR/AND).
- Counter ADR-080 §4.3 unnest'ит оба тега независимо — счётчики
  суммируются логично.

### 8.6 Контракт API — без изменений

`PuzzleListItem.themes` уже отдаёт строку. Whitelist
`PRECISION_RELEVANT_THEMES` уже включает все 5 подвидов +
`queenRookEndgame`. Frontend (`PrecisionThemesSheet`) уже умеет
их рендерить (скрин подтверждает).

**Никаких изменений** в:
- `packages/shared/src/utils/precision-themes.ts` (whitelist).
- `apps/api/src/precision/precision.controller.ts` (endpoint
  `/theme-counts` сам подберёт новые counter'ы).
- `apps/web/src/components/precision/PrecisionThemesSheet.tsx`.

### 8.7 Backfill 2177 эндшпилей

CLI-скрипт расширяет `backfill-phase.ts` (B3 из M1) или
отдельный `backfill-endgame-subtype.ts`.

```sql
-- Audit: сколько эндшпилей generated без подвидового тега
SELECT COUNT(*) FROM puzzles
WHERE source = 'generated'
  AND themes ~* '(^| )endgame( |$)'
  AND themes !~* '(^| )(pawnEndgame|rookEndgame|queenEndgame|knightEndgame|bishopEndgame|queenRookEndgame)( |$)';
```

Ожидаемо ≈ 2177 (или меньше — часть может уже иметь подвид из
lichess-теггера если puzzle хибридный, но source='generated' →
все наши, без подвида).

```sql
-- Backfill: для каждой записи определить подвид и дописать
-- (выполняется через Node.js script — нужен Chess parser).
```

Алгоритм CLI:
1. SELECT id, fen, themes для всех generated endgame без подвида.
2. Для каждой: `subtype = detectEndgameSubtype(fen)`.
3. Если `subtype !== null` — `UPDATE themes = trim(themes || ' ' || subtype)`.
4. Если `null` (смешанный) — пропускаем, оставляем только
   зонтичный `endgame`.
5. Batch 500, COMMIT после каждой пачки.
6. Идемпотентно (повторный запуск пропускает уже размеченные —
   за счёт `themes !~ subtype`).

**Lichess НЕ trogaem:** `WHERE source = 'generated'` гарантирует.
У lichess свои оригинальные подвиды (lichess-puzzler tagger).

**Бэкап перед запуском:** `pg_dump --table puzzles --data-only >
/tmp/puzzles-backup-subtype.sql`.

### 8.8 UI — без правок

Frontend `PrecisionThemesSheet` уже рендерит группу «Эндшпиль» с
всеми подвидами (видно на скрине). После backfill counter'ы
автоматически проставятся (через `GET /precision/theme-counts`
ADR-080 §4.3).

Frontend / layout — НЕТ задач.

### 8.9 Что НЕ делаем (M2)

- НЕ вводим `mixedEndgame`-тег (Open Q1).
- НЕ пересчитываем lichess-задачи (§8.7).
- НЕ детектируем `opposite-colors-bishops` (нет в whitelist —
  M3).
- НЕ детектируем `promotion` / `underPromotion` / `advancedPawn`
  по FEN — они требуют анализа линии (продвижение в ходе
  решения), а не позиции. Отдельная задача (M3).
- НЕ переразмечаем уже размеченные подвидом (идемпотентность).

### 8.10 Подзадачи M2

Зависимости: B1-M2 → B2-M2 (backfill) → B3-M2 (audit).
C1-M2 параллельно.

#### KS (B1-M2) — `computeTags`: detectEndgameSubtype при `endgame`-фазе

**Assignee:** backend (tactic-worker).
**Labels:** `puzzle`, `analysis`.
**Зависит:** KS-3562 (M1 detectPhase в `computeTags`).
- В `apps/tactic-worker/src/puzzle-generator/tagging.ts` —
  после установки тега `endgame` (M1) вызвать
  `detectEndgameSubtype(startFen)` по §8.3.
- Если возвращает не-null — `tags.add(subtype)`.
- Если null — ничего не добавлять (только зонтичный `endgame`).
- Unit-тесты на 9 кейсов из таблицы §8.4 + 2 регрессии (K+R+R+P
  vs K+R+P → rookEndgame; K+Q+P vs K+Q+P → queenEndgame).
- Acceptance: тесты зелёные; новые generated эндшпили получают
  подвидовый тег где применимо.

#### KS (B2-M2) — backfill подвидов для 2177 generated эндшпилей

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** B1-M2 (нужна функция `detectEndgameSubtype`).
- CLI-скрипт `apps/tactic-worker/scripts/backfill-endgame-subtype.ts`
  (или расширение существующего backfill-phase.ts из M1 B3).
- Алгоритм §8.7. Batch 500.
- Lichess НЕ trogaем (`WHERE source='generated'`).
- Бэкап до запуска (см. §8.7).
- Acceptance: после прогона SQL audit (§8.7) возвращает 0 для
  записей где подвид определим (смешанные остаются без подвида).
  Spot-check 10 случайных подвидов — соответствуют визуально.

#### KS (B3-M2) — audit распределения подвидов

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** B2-M2.
- SQL:
  ```sql
  SELECT
    CASE
      WHEN themes ~* '(^| )pawnEndgame( |$)'   THEN 'pawn'
      WHEN themes ~* '(^| )rookEndgame( |$)'   THEN 'rook'
      WHEN themes ~* '(^| )queenEndgame( |$)'  THEN 'queen'
      WHEN themes ~* '(^| )knightEndgame( |$)' THEN 'knight'
      WHEN themes ~* '(^| )bishopEndgame( |$)' THEN 'bishop'
      WHEN themes ~* '(^| )queenRookEndgame( |$)' THEN 'queenRook'
      ELSE 'mixed_no_subtype'
    END AS subtype,
    COUNT(*) AS cnt
  FROM puzzles
  WHERE source='generated'
    AND themes ~* '(^| )endgame( |$)'
  GROUP BY 1 ORDER BY 2 DESC;
  ```
- Отчёт в комментарий: какая доля «смешанных без подвида».
  Если перекос (например, 80% mixed) — повод подумать про Q1
  (mixedEndgame тэг или пары типа rookKnightEndgame).
- Acceptance: цифры в комментарии.

#### KS (C1-M2) — i18n проверка для bishopEndgame + queenRookEndgame

**Assignee:** chess-expert (RU) + frontend (EN).
**Labels:** `puzzle`, `i18n`.
- Проверить в `apps/web/src/i18n/locales/{ru,en}/translation.json`:
  - `puzzleTheme.bishopEndgame` — RU «Слоновый эндшпиль»,
    EN «Bishop endgame».
  - `puzzleTheme.queenRookEndgame` — RU «Ферзь и ладья»,
    EN «Queen + rook endgame».
- Если RU видно на скрине (пешечный/ладейный/ферзевый/коневой
  уже есть — KS-3359), то slovariev уже добавлен; проверка
  формальная.
- Acceptance: оба ключа на обоих языках, без fallback на
  camelCase.

**Frontend / layout — НЕТ задач.** UI и whitelist готовы.

### 8.11 Open questions M2

1. **`mixedEndgame` тэг** — добавить общий для всех «не покрытых»
   комбо (R+N, R+B, B+N, и т.д.) или оставить как сейчас
   (только зонтичный `endgame`)? Решение по результату B3-M2
   audit. Если доля «mixed_no_subtype» > 30% — добавить
   `mixedEndgame` (требует расширения `PRECISION_THEME_GROUPS`
   + i18n + миграции tagger).
2. **Конкретные пары** (`rookKnightEndgame`, `rookBishopEndgame`,
   `bishopKnightEndgame`) — добавить если M2 audit покажет
   массовые комбо? Lichess их не имеет — за пределы стандарта.
3. **`opposite-colors-bishops`** — добавить в whitelist
   (`precision-themes.ts`) + детектор (B+B обеих сторон на
   клетках разного цвета)? M3 — после feedback пользователей.
4. **Lichess-сверка** — проверить как lichess-puzzler ставит
   `pawnEndgame` etc и сверить пороги. Сейчас наш алгоритм
   симметричный (учитывает обе стороны) — lichess может быть
   асимметричным (только проигрывающая сторона). M3 если будут
   жалобы на расхождение.
5. **Promotion / underPromotion / advancedPawn** — детектор по
   FEN невозможен (продвижение происходит В ходе линии). Нужен
   анализ moves[]. M3, отдельная задача.
6. **`endgame` без подвида** (смешанный) — оставить как сейчас
   (зонтичный + ничего) ИЛИ добавить `mixedEndgame` сразу в M2
   без audit? Моё — после audit (Q1).

### 8.12 Откат M2

- B1-M2: revert тэгирующего кода — новые generated не получают
  подвид, старые backfill-данные остаются. Не блокирует ничего.
- B2-M2 backfill: revert через бэкап `puzzles-backup-subtype.sql`
  (см. §8.7). Без бэкапа — `UPDATE themes = trim(replace(themes,
  ' pawnEndgame', '')) ...` (5 регексп-замен).
- UI / API — без изменений, отката не требуют.
