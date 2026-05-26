# ADR-080. /precision — фильтры по темам

Статус: принят (2026-05-26, ревизия 2)
Связано: KS-3354 (этот ADR), ADR-076 (chips-bar и bottom-sheet
для рейтинга), ADR-079 (scope-pills + auto-pick),
ADR-069 (objective convertAdvantage/saveEquality),
ADR-070 (puzzle generator с drill-tagging).

**Ревизия 2 (2026-05-26):** по уточнениям пользователя через
координатора —
1. Counter'ы per тема **в M1** (не M2). Подход — один SQL-aggregate
   через `unnest(string_to_array)` + Redis-кеш 60 сек per
   нормализованный фильтр. См. §4.3, новая задача KS-3363 (B2).
2. Auto-pick «Начать тренировку» / «Следующая» — явно учитывают
   выбранные темы. Уточнено в acceptance KS-3357 (B1 pickNext) и
   KS-3361 (F2 frontend).

## 1. Контекст

Пользователь просит фильтр по темам (pin / fork / эндшпиль /
sacrifice ...) в разделе `/precision`. Текущее состояние
оказалось лучше, чем ожидалось:

- **Поле `Puzzle.themes` уже есть.** Тип `String @default("")`,
  space-separated (`"pin fork mateIn3 endgame"`), индекс
  `@@index([themes])` (`packages/db/prisma/schema.prisma:~329`).
- **Generated precision-задачи УЖЕ имеют темы.**
  `computeTags()` в `apps/tactic-worker/src/puzzle-generator/tagging.ts`
  при генерации пишет drill-predicates (`findFork` / `findPin` /
  `findHangingPiece` / `findUndefendedAttack`), objective
  (`convertAdvantage` / `saveEquality`), плюс cp-эвристика
  (mate / crushing / advantage / equality). Минимум 1 непустой
  тэг гарантирован.
- **API уже поддерживает `themes`-фильтр.** `GET /puzzles` и
  `GET /puzzles/browse` принимают массив тем, сейчас работает в
  **AND**-режиме (`WHERE themes LIKE '%theme%' AND ...` per-theme).
  В `PrecisionPage` уже используется через `objective` →
  `themes=[objective]`.
- **Lichess-задачи** имеют оригинальные lichess-теги в том же
  поле.
- **Таксономия `PuzzleTheme`** в `packages/shared/src/types/puzzle.ts`
  — 61 тема, прямой импорт из Lichess.
- **Локализация только для objective** в `apps/web/src/i18n/locales/
  ru/translation.json` (`"convertAdvantage": "Реализуй перевес"`).
  Остальные 59 тем — без RU/EN labels.

Поэтому это не «построить с нуля motif-tagger и backfill 1530
задач», а:
1. Проверить покрытие (`COUNT WHERE themes=''` для generated);
2. Сделать локализацию labels;
3. Добавить UX theme-фильтра в chips-bar;
4. Потенциально расширить семантику фильтра на OR (multi-select).

## 2. Решение

### 2.1 Источник данных — БЕЗ новой схемы и без motif-rewrite

Используем существующее поле `Puzzle.themes` как есть. Никаких
новых таблиц, миграций или enum-полей. Никакого re-write
motif-tagger'а — `computeTags` в tactic-worker уже даёт нужный
объём данных.

### 2.2 Покрытие (audit + опц. backfill)

Перед UI-работой делаем audit:

```sql
SELECT
  source,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE themes = '' OR themes IS NULL) AS empty
FROM puzzles
WHERE source = 'generated'
GROUP BY source;
```

Если empty > 0 (теоретически невозможно после ADR-070, но
исторические записи могут существовать) — запустить re-tag job:

- Для каждой записи с пустыми themes:
  - Читаем `fen` (стартовый FEN до зевка) и первый ход (UCI) из
    `Puzzle.moves` или `playVsEngine.blunderMove`.
  - Вызываем `computeTags({ fen, blunderMoveUci, cpAfterBlunder,
    objective })` из tactic-worker.
  - UPDATE themes.
- Lichess-задачи (`source='lichess'`) трогать НЕ нужно — их темы
  оригинальные.

Если audit покажет 0 пустых для generated — backfill не выполняем.
Заводим тикет audit (KS-3355 B0), backfill (KS-3356 B0.5) — но
последний условный.

### 2.3 Whitelist «релевантных для precision» тем

Не все 61 тема одинаково применимы. Например `oneMove`, `short`,
`long` — это lichess-описание длины решения, для precision нерелевантно
(длина задаётся `halfMovesN`). `master` / `masterVsMaster` — тоже
lichess-метаданные.

Заводим утилиту:

```ts
// packages/shared/src/utils/precision-themes.ts
export const PRECISION_RELEVANT_THEMES: PuzzleTheme[] = [
  // Тактика
  'pin', 'fork', 'skewer', 'discoveredAttack', 'doubleCheck',
  'sacrifice', 'deflection', 'attraction', 'clearance',
  'interference', 'intermezzo', 'xRayAttack', 'hangingPiece',
  'capturingDefender', 'trappedPiece',
  // Маты
  'mate', 'mateIn1', 'mateIn2', 'mateIn3', 'mateIn4', 'mateIn5',
  'backRankMate', 'smotheredMate', 'arabianMate',
  'anastasiaMate', 'bodenMate', 'dovetailMate', 'hookMate',
  // Эндшпиль
  'endgame', 'pawnEndgame', 'rookEndgame', 'queenEndgame',
  'knightEndgame', 'bishopEndgame', 'queenRookEndgame',
  'opposite-colors-bishops', 'promotion', 'underPromotion',
  // Фазы
  'opening', 'middlegame',
  // Превосходство (это objective + общая категория)
  'advantage', 'crushing', 'equality',
  // Прочие важные
  'zugzwang', 'kingsideAttack', 'queensideAttack',
  'attackingF2F7', 'exposedKing', 'defensiveMove', 'quietMove',
  'enPassant', 'castling',
];
```

UI bottom-sheet группирует их по 6 секциям (см. §3.2). Themes из
БД, не входящие в whitelist (например `master`, `oneMove`) — просто
не показываются в фильтре, но если в БД задача имеет такой тег
рядом с релевантным — фильтр по релевантному корректно её найдёт.

### 2.4 Семантика фильтра — OR (multi-select), не AND

Сейчас backend для multi-themes делает AND (`WHERE themes LIKE
'%pin%' AND themes LIKE '%fork%'`). Для precision-UX нужен **OR**:
«покажи задачи с pin ИЛИ fork ИЛИ sacrifice».

AND-семантика остаётся как **legacy для `objective+theme`-комбо**
(сейчас `themes=['convertAdvantage', 'pin']` ищет задачи с обоими
тегами — реализация преимущества через pin). Это важно сохранить.

Решение: расширить `GET /puzzles/browse` новым параметром
`themesMode: 'and' | 'or'` (default `'and'` для backward-compat).
Frontend `/precision` использует `themesMode='or'` когда у
пользователя выбрано ≥ 2 тем.

Альтернатива — два параметра: `themesAnd: string[]` и
`themesOr: string[]`, объединяемые SQL'ом как
`(themes LIKE '%a%' AND themes LIKE '%b%') AND (themes LIKE '%c%' OR
themes LIKE '%d%')`. Это нужно для случая «objective=convertAdvantage
+ тема=pin OR fork». Реализуем сразу — расширяемее и без двух
смешанных семантик в одном массиве.

### 2.5 Локализация

В `apps/web/src/i18n/locales/{ru,en}/translation.json` добавить
ключи `puzzleTheme.<themeKey>` для всех тем из
`PRECISION_RELEVANT_THEMES`. Базовый RU-перевод даёт chess-expert
(коротко, 1-3 слова). Например:

```json
{
  "puzzleTheme": {
    "pin": "Связка",
    "fork": "Вилка",
    "skewer": "Шомпол",
    "mateIn2": "Мат в 2",
    "endgame": "Эндшпиль",
    "sacrifice": "Жертва",
    ...
  }
}
```

EN — короткие английские названия (camelCase → human-readable).

### 2.6 UX — chip + bottom-sheet (по образцу rating-фильтра)

В `PrecisionFilterChipsBar` (ADR-076 / KS-3243) добавляем chip:

- Если фильтр не активен — `[🏷 Темы]` (открывает bottom-sheet).
- Если активен — `[Темы: 3 ✕]` (число выбранных, крестик — сброс).
- Tap по chip — открывает bottom-sheet «Темы».

Bottom-sheet `PrecisionThemesSheet`:

- 6 expandable-секций: Тактика / Маты / Эндшпиль / Фазы /
  Превосходство / Прочее.
- В каждой — checkbox-список тем (`PRECISION_RELEVANT_THEMES`).
- Кнопки «Применить» (close + commit URL) и «Сбросить» (снять все).
- Counter per theme «(N)» рядом с label'ом — обязательный для
  M1 (см. §4.3). Источник — `GET /precision/theme-counts` с
  Redis-кешем; реализуется через один SQL aggregate, не N
  запросов.

URL-state: `?themes=pin,fork,sacrifice` (CSV в одном query,
читаемо). При наличии нескольких — frontend передаёт `themesOr`
в API. Если выбран objective (через chips-bar) + темы — backend
получает `themesAnd=[objective], themesOr=[pin, fork]`.

Backward-compat URL: legacy `?themes=convertAdvantage` (single)
продолжает работать как один theme в `themesAnd`.

### 2.7 Что НЕ делаем

- НЕ заводим отдельный enum `PrecisionTheme` — `PuzzleTheme` shared
  уже подходит. Whitelist — отдельный массив, не type-narrowing.
- НЕ строим motif-tagger v2 (то, что есть в `computeTags`,
  достаточно).
- НЕ добавляем UI-инструмент авторской разметки тем для своих
  generated пазлов — generator уже размечает автоматически.
- НЕ ретроактивно обновляем lichess-задачи (их темы оригинальные).
- НЕ заводим иерархию тем (parent-child) — плоский список с
  группировкой в UI достаточен.

## 3. UX-сценарии

### 3.1 Чип в chips-bar

`[Серверные]` `[Реализуй]` `[+ Темы]` `[Показать решённые]` `[+ Рейтинг]` `[↺ Reset]`

После выбора 3 тем — `[Темы: 3 ✕]` (компактно).

### 3.2 Bottom-sheet «Темы»

```
┌───────────────────────────────┐
│ Темы                       ✕ │
├───────────────────────────────┤
│ ▼ Тактика                     │
│   ☐ Связка                    │
│   ☑ Вилка                     │
│   ☐ Шомпол                    │
│   ...                         │
│ ▶ Маты (3)                    │  ← collapsed, counter «3» = выбрано
│ ▶ Эндшпиль                    │
│ ▶ Фазы                        │
│ ▶ Превосходство               │
│ ▶ Прочее                      │
├───────────────────────────────┤
│ [Сбросить]      [Применить]  │
└───────────────────────────────┘
```

### 3.3 Auto-pick c темами

`GET /precision/next` (ADR-079) — добавляется `themes[]` параметр.
Backend применяет OR-фильтр поверх scope + objective. Если в
выборке 0 — окно рейтинга расширяется как обычно (150 → 300 → 500
→ ∞). Если даже при ∞ нет — 404 с reason `no_puzzles_for_themes`
(UI говорит «По выбранным темам задач нет, измените фильтр»).

## 4. API

### 4.1 Расширение `GET /puzzles/browse` (и `GET /puzzles`)

```
GET /puzzles/browse?source=generated
                  &themesAnd=convertAdvantage   (повторяется)
                  &themesOr=pin                 (повторяется)
                  &themesOr=fork
                  &scope=...&hideSolved=...
```

- `themesAnd[]` — все темы должны присутствовать (старая
  семантика, сохраняется для objective).
- `themesOr[]` — хотя бы одна тема должна присутствовать.
- Обе совмещаются: `(themesAnd[0] AND ... AND themesAnd[N]) AND
  (themesOr[0] OR ... OR themesOr[M])`.
- Legacy `themes[]` (без mode) → `themesAnd[]` (back-compat).

Реализация на postgres — серия `LIKE '%word%'` через
`PuzzleRepository.browse`. Индекс `@@index([themes])` не помогает
LIKE-запросам, но 1530 generated + миллион lichess справляются
за ~100ms (мы и сейчас живём с этим). Для масштаба M2 — миграция
на `text[]` + GIN-индекс (отдельный ADR).

### 4.2 Расширение `GET /precision/next` (ADR-079)

Добавляем `themesAnd[]` / `themesOr[]` параметры (та же
семантика). 404 `no_puzzles_for_themes` если ничего не подходит.

### 4.3 Новый endpoint `GET /precision/theme-counts`

Возвращает counter за каждую тему whitelist'а под текущие
**другие** фильтры (scope + objective + rating-range + hideSolved).
Используется bottom-sheet'ом для UX «(N) рядом с label'ом».

```
GET /precision/theme-counts?scope=server|drafts|published
                          &objective=all|convertAdvantage|saveEquality
                          &hideSolved=true
                          &blundererEloMin=...&blundererEloMax=...
```

- Auth: `OptionalJwtGuard` (гость → `scope=server`, без my-фильтра).
- Response: `{ counts: Record<PuzzleTheme, number> }` — только
  whitelist'овые темы (PRECISION_RELEVANT_THEMES, ~50 ключей).

**Эффективная реализация — один SQL aggregate:**

```sql
WITH filtered AS (
  SELECT themes
  FROM puzzles
  WHERE source IN ('lichess', 'generated')   -- по scope
    AND <scope filters: mine + visibility>
    AND <objective filter: themes LIKE '%objective%' если задан>
    AND <hideSolved filter через NOT EXISTS attempts>
    AND <rating-range>
)
SELECT
  theme,
  COUNT(*) AS cnt
FROM filtered,
LATERAL unnest(string_to_array(themes, ' ')) AS theme
WHERE theme = ANY($1::text[])   -- whitelist
GROUP BY theme;
```

Один запрос на bottom-sheet open. На индексе по `themes` — не
помогает (LIKE), но `unnest` на ~1.5M строк (lichess + generated) +
выборка после фильтров укладывается в ~150ms (выборка после
scope+objective+rating обычно ≤ 50K строк).

**Redis-кеш 60 секунд** по ключу, нормализованному из фильтров:

```
key = sha1("theme-counts:" + JSON.stringify({
  userId: userId ?? 'guest',
  scope, objective, hideSolved,
  blundererEloMin, blundererEloMax,
}))
```

TTL 60 сек — балансирует свежесть (новые задачи появляются редко)
и нагрузку (пользователь часто открывает/закрывает sheet).

**Нет counter'ов для тем вне whitelist'а** — UI их всё равно не
показывает. Возврат — только нужные ключи, чтобы не раздувать
payload.

**Гость:** без `hideSolved` (нет привязки к attempts), но
остальные фильтры применяются. Cache key с `userId='guest'`.

### 4.4 Никаких других новых endpoint'ов

Никаких других изменений в API сверх §4.1–4.3.

## 5. Лимиты и безопасность

- `themesOr[]` ≤ 10 элементов (соответствует UI ограничению).
  Превышение — 400.
- `themesAnd[]` ≤ 5 (там обычно 1-2 — objective + редкий
  второй фильтр).
- Whitelist на стороне backend — принимаем только known
  `PuzzleTheme` values, unknown → 400 (защита от инъекций в LIKE).
- Без auth — все endpoints, гость может фильтровать.

## 6. Риски

1. **AND vs OR семантика — путаница в backward-compat.** Migration
   фронта на новый формат — одновременная. Старые ссылки с
   `?themes=` мапятся на `themesAnd[]`. Тестировать ручной QA на
   3 типичных URL-комбинациях.
2. **i18n для 50+ тем.** Если chess-expert не успеет дать все
   переводы — fallback на английский camelCase из enum (читаемо
   для всех, не блокирует).
3. **Counter'ы per theme дорогие при наивной реализации.**
   N×COUNT — нет. Реализация в M1 — один SQL aggregate через
   `unnest(string_to_array)` + LATERAL JOIN + GROUP BY + Redis
   кеш 60 сек. Ожидаемый p95 ≤ 200 ms на 1.5M строк. Если на
   практике превысит — переход на GIN-индекс по `text[]` (M2,
   отдельный ADR с миграцией формата хранения themes).
4. **LIKE-запросы не масштабируются.** Сейчас работает на ~1.5K
   generated + 1M lichess за приемлемое время (≤200ms p95). При
   росте до 10M lichess потребуется GIN-индекс на `text[]`-поле
   — отдельный ADR. Не блокер.
5. **Backfill может вернуть 0 пустых.** Это значит B0.5 не нужен.
   Audit (B0) даёт ответ за минуту, дальнейшие решения по
   результату.
6. **Темы generated-задач могут оказаться неравномерными.**
   Например, 80% — `crushing` (cp ≥ 500). Это диагностируется
   на M2 (counter'ы) и решается калибровкой `computeTags`
   (отдельная задача).
7. **Lichess-темы и наши drill-теги пересекаются**
   (`pin` есть у обоих). Семантически идентичны, фильтр работает
   единообразно.

## 7. Реализация — follow-up задачи

Зависимости: B0 → (опц. B0.5 если нужно) → B1 → S1 → C1 → F1 → F2 → L1.

### KS-3355 (B0) — audit покрытия themes

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
**Описание:** SQL-запрос на staging+prod БД:
`SELECT source, COUNT(*) AS total, COUNT(*) FILTER (WHERE themes
= '' OR themes IS NULL) AS empty FROM puzzles GROUP BY source;`.
Результат — отчётом в задачу. Если для `source='generated'`
empty > 0 — создать KS-3356 (B0.5). Если 0 — закрыть.
**Acceptance:**
- Отчёт по каждому source.
- Решение по запуску B0.5.

### KS-3356 (B0.5, условный) — backfill пустых themes для generated

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** KS-3355 (только если есть пустые).
**Описание:** CLI-job в `scripts/` или admin-endpoint. Для каждой
generated-задачи с пустыми themes — пересчитать через
`computeTags()` из tactic-worker (импортировать функцию). Batch по
100, COMMIT после каждой пачки.
**Acceptance:**
- После запуска `COUNT WHERE themes='' AND source='generated' = 0`.
- Тест на 10 случайных пересчётов — `themes != ''`.

### KS-3357 (B1) — backend `themesAnd[]` / `themesOr[]` в browse + precision/next

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
**Описание:**
- Расширить `PuzzleRepository.browse` и `PrecisionService.pickNext`:
  принимать `themesAnd: string[]` и `themesOr: string[]`. SQL —
  серия `LIKE '%word%'` через AND/OR-conjunction.
- Backward-compat: legacy `themes[]` мапится в `themesAnd[]`.
- Whitelist на backend — только known `PuzzleTheme` values, иначе
  400.
- Лимиты: `themesOr ≤ 10`, `themesAnd ≤ 5`.
- **`pickNext` (ADR-079) с темами:** `themesAnd`+`themesOr`
  применяются СНАЧАЛА, потом расширение rating-окна
  (150→300→500→∞) идёт уже внутри подмножества подходящих по
  темам. Если даже при window=∞ выборка пустая — 404
  `no_puzzles_for_themes` (отдельный код от
  `no_puzzles_available` без тем — фронт показывает разный текст).
**Acceptance:**
- Тест AND: `themesAnd=['pin','fork']` → задачи с обоими.
- Тест OR: `themesOr=['pin','fork']` → задачи с хотя бы одним.
- Тест комбо: `themesAnd=['convertAdvantage'] + themesOr=['pin','fork']`.
- Тест backward-compat: legacy `themes=['pin']` работает как
  `themesAnd=['pin']`.
- Тест валидации: неизвестная тема → 400.
- **Тест pickNext с темами:** rating=1500 + `themesOr=['pin']` —
  возвращает задачу с pin в окне 1350..1650 или расширенном.
- **Тест pickNext с темами без подходящих:**
  `themesOr=['hookMate']` (редкая тема, 0 задач при scope=drafts)
  → 404 `no_puzzles_for_themes`.

### KS-3363 (B2) — endpoint `GET /precision/theme-counts`

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** KS-3358 (нужен whitelist).
**Описание:**
- Реализовать §4.3: один SQL aggregate через
  `unnest(string_to_array(themes, ' '))` + LATERAL JOIN +
  `WHERE theme = ANY(whitelist)` + GROUP BY.
- Применяет фильтры из query: scope (mine+visibility), objective
  (как `themesAnd`), hideSolved, blundererEloMin/Max.
- Redis-кеш 60 сек по sha1-ключу из нормализованных фильтров.
- Возвращает только whitelist'овые темы (~50 ключей), пропуски
  заполняются нулями на frontend'е по полному списку whitelist'а.
- `OptionalJwtGuard` (гость → key с `userId='guest'`, без
  hideSolved-фильтра).
**Acceptance:**
- Тест: один запрос с разнородным набором тем — возвращает
  корректные counter'ы (сравнить с N×COUNT отдельно).
- Тест: повторный вызов в течение минуты — из кэша (через mock
  Redis).
- Тест: scope=drafts — counts только по своим draft'ам.
- Тест: фильтр objective=convertAdvantage — counts включают
  только задачи с этим objective.
- Производительность: ≤ 200 ms на 1.5M строк в БД на staging.

### KS-3358 (S1) — shared whitelist + utility

**Assignee:** backend (shared owner).
**Labels:** `puzzle`, `analysis`.
**Описание:**
- `packages/shared/src/utils/precision-themes.ts`:
  `PRECISION_RELEVANT_THEMES: PuzzleTheme[]` (см. §2.3).
- Группировка для UI: `PRECISION_THEME_GROUPS:
  Record<'tactics'|'mates'|'endgame'|'phase'|'advantage'|'misc',
  PuzzleTheme[]>`.
- Расширить request-types для `themesAnd`/`themesOr`.
**Acceptance:**
- TS-сборка без ошибок.
- Каждая тема ровно в одной группе.
- Union каждой группы = `PRECISION_RELEVANT_THEMES`.

### KS-3359 (C1) — локализация i18n для тем

**Assignee:** chess-expert (RU labels) + frontend (EN labels +
интеграция).
**Labels:** `puzzle`, `analysis`, `i18n`.
**Зависит:** KS-3358.
**Описание:**
- `apps/web/src/i18n/locales/ru/translation.json` — добавить
  `puzzleTheme.<key>` для каждой темы из
  `PRECISION_RELEVANT_THEMES`.
- `apps/web/src/i18n/locales/en/translation.json` — то же.
- Fallback в коде: `t('puzzleTheme.' + key, key)` (если перевода
  нет — выводим английский camelCase).
- Группировки тоже локализуются (`puzzleThemeGroup.tactics`,
  и т.д.).
**Acceptance:**
- Все темы whitelist'а имеют RU + EN перевод.
- Fallback не срабатывает при штатной работе.

### KS-3360 (F1) — theme-chip + `PrecisionThemesSheet` с counter'ами

**Assignee:** frontend.
**Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** KS-3357, KS-3358, KS-3359, KS-3363, KS-3243 (chips-bar).
**Описание:**
- В `PrecisionFilterChipsBar` добавить chip `[+ Темы]` / `[Темы: N
  ✕]` (N — число выбранных).
- Новый компонент `apps/web/src/components/precision/PrecisionThemesSheet.tsx`:
  bottom-sheet с 6 collapsible-секциями + multi-select checkboxes
  + кнопки «Применить» / «Сбросить».
- При open sheet — `GET /precision/theme-counts` с текущими
  фильтрами. Отображение `[Связка (84)]`; темы с count=0 —
  серым (disabled checkbox, нельзя выбрать).
- Counter'ы re-fetch'атся при изменении других фильтров (scope,
  objective, rating, hideSolved) пока sheet открыт. Дебаунс
  300 ms.
- Tap по chip → открыть sheet. «Применить» → commit URL.
**Acceptance:**
- Можно выбрать одну тему — URL `?themes=pin`.
- Можно выбрать несколько — URL `?themes=pin,fork,sacrifice`.
- Reset очищает.
- Сетка переоткладывается при изменении выбора.
- Counter'ы отображаются и обновляются при смене других фильтров.
- Темы с count=0 disabled.

### KS-3361 (F2) — URL-state + backward-compat + auto-pick с темами

**Assignee:** frontend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** KS-3360.
**Описание:**
- Чтение `?themes=pin,fork` → передача в API как `themesOr` если
  ≥ 2 тем, иначе `themesAnd`.
- objective из chips (`?objective=convertAdvantage`) передаётся
  в `themesAnd` отдельно (для семантики «реализация преимущества
  через pin/fork»).
- **Кнопка «Начать тренировку» (ADR-079 KS-3344) и «Следующая»
  на странице solve (KS-3345)** включают текущие выбранные темы
  в `GET /precision/next` (`themesAnd`/`themesOr` те же что в
  browse-фильтре). Параметр `return` URL-кодирует все query
  включая `themes=`, чтобы «Следующая» сохраняла контекст.
- При 404 `no_puzzles_for_themes` — toast с подсказкой
  «По выбранным темам задач больше нет — измените фильтр или
  снимите часть тем». Никакого скрытого расширения фильтра.
- При 404 `no_puzzles_available` (без тем) — старый toast
  ADR-079.
**Acceptance:**
- URL `?objective=convertAdvantage&themes=pin,fork` корректно
  фильтрует.
- «Начать тренировку» с выбранными темами `pin,fork` → открывает
  задачу с одним из них.
- «Следующая» учитывает текущие темы из `return` URL.
- При темах без подходящих задач — toast `no_puzzles_for_themes`,
  URL не меняется.
- Backward-compat: legacy `?themes=convertAdvantage` (без `objective`)
  работает.

### KS-3362 (L1) — CSS bottom-sheet группировок + theme-chip

**Assignee:** layout.
**Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** KS-3360.
**Описание:**
- CSS для `PrecisionThemesSheet`: collapsible-sections (rotate
  arrow на open), checkbox-list, sticky bottom-bar c
  «Применить»/«Сбросить».
- CSS для chip `[Темы: N]` — compact, accent при активном
  фильтре.
- Mobile safe-area для sheet.
**Acceptance:**
- На viewport 360×844 — sheet помещается, секции скроллятся
  вертикально.
- Sticky bottom-bar не перекрывает контент.
- Counter «N» в chip читается без переноса.

## 8. M2 (отложено)

- KS-XXXX: GIN-индекс на `text[]`-поле themes — если LIKE
  начнёт тормозить (отдельный ADR с миграцией формата хранения).
  Триггер — если `theme-counts` стабильно превышает 300 ms p95.
- KS-XXXX: иерархия тем (parent-child) — если 50+ тем
  окажется неудобно.
- KS-XXXX: theme-info tooltip в bottom-sheet (короткое описание
  + пример).
- KS-XXXX: применение theme-фильтра к разделу `/puzzles` (lichess
  каталог) — сейчас фильтр там есть, но UX другой.
- KS-XXXX: «recently used» themes-секция вверху sheet — для часто
  переключаемых пользователем.

## 9. Откат

- Backend параметры `themesAnd`/`themesOr` — additive, удаление
  безопасно (legacy `themes` остаётся).
- Frontend chip + sheet — за компонентом, revert F1/F2 убирает
  UI.
- Если M2 потребует миграцию формата themes → `text[]` — отдельный
  ADR с двух-фазным rollout (read both, write new).
