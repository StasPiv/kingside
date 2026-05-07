# ADR-046 — Редизайн `/puzzles/stats`: разделение режима play-vs-engine от тем

- Статус: Proposed
- Дата: 2026-05-07
- Связанные задачи: KS-2490
- Связанные ADR: ADR-044 (puzzle play-vs-engine), ADR-032 (mistakes-diary relocation)
- Связанные тикеты: KS-2466 (frontend strategy.playVsEngine), KS-2484 (`/puzzles/play-vs-engine` page), KS-2485 (точка входа), KS-1928 (mistakes diary in puzzle namespace)
- Авторы: architect

---

## 1. Контекст

После релиза play-vs-engine (ADR-044, KS-2466/2484/2485) пользователь сообщил две проблемы на `/puzzles/stats`:

1. «Половина ссылок не работает / открывается непонятно что».
2. Технический marker режима `playVsEngine` появляется в блоке «Дневник ошибок» как обычная тематическая категория — рядом с «Разгром», «knightMove», «rookMove», «Связка». На прод-скриншоте `playVsEngine` стоит первой строкой со счётчиком «4 ошибки» и кнопкой «Потренировать» → `/puzzles/mistakes-practice?theme=playVsEngine`.

Цель ADR — описать, что именно сейчас не работает, и предложить дизайн с разделением **режима решения** (forced-line / play-vs-engine) от **тематической метки** (mate, fork, разгром, knightMove …).

### 1.1. Что показывает страница сейчас

Источник: `apps/web/src/pages/PuzzleStatsPage.tsx` (242 строки).

Блоки сверху вниз:

| Блок | Источник данных | Интерактивные элементы |
|------|-----------------|------------------------|
| H1 + back link | — | `← Back to Puzzles` → `/puzzles` |
| Summary cards (6 шт) | `GET /puzzles/stats/me` | нет |
| Rating chart (SVG, 30 дней) | `GET /puzzles/stats/rating-history?days=30` | нет |
| MistakesDiaryBlock | `GET /puzzle/mistakes/aggregates?limit=5` | «Потренировать» (5 шт) → `/puzzles/mistakes-practice?theme=<X>`; «Смотреть всё» → `/puzzles/mistakes` |
| Recent Attempts (20 + пагинация) | `GET /puzzles/attempts?take=100` | `#<shortId>` → `openPuzzleAnalysis(puzzleId)` (см. §1.2) |

### 1.2. Поведение `openPuzzleAnalysis` (Recent Attempts)

Код в `PuzzleStatsPage.tsx:78–109`:

```
async openPuzzleAnalysis(puzzleId)
  → GET /puzzles/{puzzleId}
  → конвертирует puzzle.moves (UCI) в SAN через chess.js
  → строит [FEN "..."] PGN
  → navigate('/analysis', { state: { pgn, title } })
  → catch → navigate(`/puzzle/${puzzleId}`)
```

Замечание: PGN строится из **решения пазла**, а не из ответа пользователя. Для пользователя выглядит как «открыли страницу анализа с правильной линией», вне связи с его попыткой. Для зачёта это полезно, для ошибки — скорее запутывает (нет видимости «вот тут я ошибся»).

---

## 2. Что не работает / непонятно работает

### 2.1. КРИТИЧНО: Recent Attempts → /analysis для play-vs-engine ломается

У puzzle с `solutionMode='play-vs-engine'` поле `moves` равно пустой строке (ADR-044 §3.3).

Прохождение `openPuzzleAnalysis`:

1. `puzzle.moves = ''` → `''.split(/\s+/).filter(Boolean) = []`.
2. Цикл UCI→SAN не выполняется ни разу, `sanMoves = []`.
3. `pgn = '[FEN "..."]\n\n'` (без ходов).
4. `navigate('/analysis', { state: { pgn, title } })`.

Пользователь попадает на `/analysis` с **только** позицией начала пазла, без всякого контекста. Это и есть «непонятно что» из жалобы.

Случай частый: на скриншоте `playVsEngine` фигурирует с 4 ошибками, и эти 4 пазла в Recent Attempts тоже play-vs-engine.

### 2.2. Дублирующее семантическое назначение тега `playVsEngine`

Согласно ADR-044 §4.2 и `apps/tactic-worker/src/puzzle-generator/generator-pipeline.ts:361`, `playVsEngine` — **технический marker режима**, который ставится всегда для нового pipeline. Он одновременно:

- решает задачу UI-фильтра `/puzzles/play-vs-engine?themes=playVsEngine` (где он семантически = «фильтр режима», а не «тема»);
- попадает в `Puzzle.themes` строку (`'playVsEngine fork mate ...'`), а оттуда — в `user_mistakes.themes` через `MistakesService.recordPuzzleMistake` (см. `apps/api/src/puzzle/mistakes.service.ts:65–66`).

`MistakesService.getAggregates` группирует через `UNNEST(themes)` (строка 158), считая каждый тег отдельно. Поэтому одна неудачная попытка в play-vs-engine пазле создаёт `+1` к каждому из {`playVsEngine`, `mate`, `fork`, `endgame`, …} — и **дублирует учёт**: пользователь видит одни и те же ошибки и под `playVsEngine`, и распределённые по реальным темам.

### 2.3. Перевод темы `playVsEngine` отсутствует

`t('puzzleBrowser.themes.playVsEngine', 'playVsEngine')` фолбэчит на сам идентификатор. На UI пользователь видит «playVsEngine» латиницей в кириллическом контексте («Разгром», «Связка»). Косметика, но в выпуклом виде — на скриншоте.

### 2.4. «Тренировать» для playVsEngine ведёт на `/puzzles/mistakes-practice?theme=playVsEngine`

Маршрут технически работает: `MistakesService.getRecommendations` (строки 207–254) отдаёт `PuzzleStep` с `selection.mode='filter'` и `themes: ['playVsEngine']`. `PuzzleStep` через L-06 находит любой puzzle с этим тегом — то есть любой play-vs-engine пазл.

Но семантически — это **не «тренировка темы»**, это «играй в режим play-vs-engine с фильтром по своим ошибкам». Существует отдельная страница `/puzzles/play-vs-engine` (KS-2484) — каноничная точка входа. Дублирование точек входа путает.

### 2.5. Recent Attempts ведут на /analysis даже для forced-line

Не критично, но странно: пользователь думает «открою свой пазл», а попадает на анализ с правильным решением. Если хочет повторить пазл — должен дойти до `/puzzle/:id` через fallback (catch). На fallback срабатывает только при ошибке `GET /puzzles/{id}` — для рабочих пазлов всегда открывается `/analysis`.

Лучше бы: основной клик → `/puzzle/:id` (повтор), отдельная кнопка → `/analysis` (для интересующих позиций).

### 2.6. Нет точки входа в play-vs-engine из stats

`/puzzles/play-vs-engine` упоминается только из `PuzzleBrowserPage` (вкладка). На stats-странице нет ни ссылки, ни счётчика «вы решили N play-vs-engine пазлов». Раздел статистики не отражает что у режима есть отдельный путь — пользователь, который зашёл на stats после KS-2466 первый раз, видит только `playVsEngine` в дневнике ошибок.

### 2.7. `#<shortId>` Recent Attempts слабо информативен

`#bc940c` — обрубок UUID. Для тематического распознавания пазла бесполезен. Полезнее: тег пазла («Разгром, mate#3»), решение «✓/✗», тайминг. Сейчас тег вообще не показывается в Recent Attempts.

### 2.8. Графики рейтинга — единый, без разделения режимов

`GET /puzzles/stats/rating-history` возвращает единую серию по `user.ratingPuzzle`. ADR-044 §5.4 явно решил **не вводить отдельный рейтинг** для play-vs-engine — Glicko-2 update единый по `solved`. Это решение не пересматриваем; но пользователю не очевидно, что прогресс на графике — суммарный. Опционально показать «X из последних N attempts — play-vs-engine» под графиком.

### 2.9. Сводка интерактивных элементов

| Элемент | Куда ведёт | Работает | Замечания |
|---------|------------|----------|-----------|
| Back to Puzzles | `/puzzles` | ✓ | — |
| Summary cards | — | n/a | статичные |
| Rating chart | — | n/a | статичный SVG |
| Mistakes diary `Потренировать` для **реальной темы** | `/puzzles/mistakes-practice?theme=<X>` | ✓ | — |
| Mistakes diary `Потренировать` для `playVsEngine` | `/puzzles/mistakes-practice?theme=playVsEngine` | ⚠ работает технически | дублирует `/puzzles/play-vs-engine`, путает |
| Mistakes diary `Смотреть всё` | `/puzzles/mistakes` | ✓ | показывает `playVsEngine` как тему — повтор §2.2 |
| Recent Attempts `#<shortId>` для forced-line | `/analysis` (с PGN решения) | ⚠ | открывает решение, не повтор; запутывает |
| Recent Attempts `#<shortId>` для play-vs-engine | `/analysis` (с пустым PGN) | ✗ | **сломано** — пустой анализ из-за `moves=''` |

«Половина ссылок» из жалобы — это §2.1 (Recent Attempts на play-vs-engine) + §2.2/§2.4 (playVsEngine как тема в дневнике).

---

## 3. Решение

Три уровня изменений: backend (источник правды), frontend (UX), вспомогательный backfill (чистка данных).

### 3.1. Backend: `playVsEngine` не должен считаться темой ошибок

**Что**: ввести whitelist/blacklist для режим-маркеров в `MistakesService.recordPuzzleMistake`. Технический тег `playVsEngine` (и любой будущий маркер режима — `forced-line`-маркер мы не ставим, но если появится `play-vs-engine-mate` или `coop-puzzle` — они тоже отфильтруются) не записывается в `user_mistakes.themes`.

Решение в `recordPuzzleMistake`:

```
const MODE_TAG_BLACKLIST = new Set(['playVsEngine']);
const themes = puzzle.themes
  .split(' ')
  .filter(Boolean)
  .filter(t => !MODE_TAG_BLACKLIST.has(t));
```

Альтернатива — фильтровать в `getAggregates` SQL'ом (`AND theme NOT IN (...)`). Это менее правильное место: теги уже **записаны** как «темы», просто скрываются на чтении. Если потом появится другой view (`getRecommendations`, `recordGameMistake`), фильтр придётся повторять.

Решение в `recordPuzzleMistake` (на записи) — единый источник правды.

**Покрывает**: §2.2, частично §2.3, §2.4.

**Риск**: исторические `user_mistakes` записи уже содержат `playVsEngine`. Нужен backfill — см. §3.6.

### 3.2. Backend: API stats разбить на режимы

**Что**: расширить `GET /puzzles/stats/me` полем `byMode`:

```ts
{
  // существующие поля
  rating: number;
  solveRate: number;
  // ...
  byMode: {
    'forced-line': { totalAttempted: number; totalSolved: number; lastAttemptAt: string | null };
    'play-vs-engine': { totalAttempted: number; totalSolved: number; lastAttemptAt: string | null };
  };
}
```

Источник: JOIN `puzzle_attempts` × `puzzles` по `puzzle_id`, GROUP BY `puzzle.solution_mode`.

Это даёт UI-блок на stats: «Forced-line: X/Y, play-vs-engine: A/B». Пользователь видит, что у режима есть свои счётчики.

**Покрывает**: §2.6, §2.8 (опц).

### 3.3. Backend: Recent Attempts отдают `solutionMode`

**Что**: в `GET /puzzles/attempts` каждая запись отдаёт `puzzle.solutionMode` (сейчас в DTO есть `puzzle: { fen, moves }`, добавить `solutionMode`). Frontend использует для роутинга (см. §3.4).

**Покрывает**: §2.1.

### 3.4. Frontend: рестрактуризация `/puzzles/stats`

Новый layout сверху вниз:

```
1. H1 + back link
2. Summary cards (как есть)
3. Rating chart (как есть) [+ опционально подпись по §3.7]
4. Modes breakdown (НОВОЕ, по §3.2)
   ┌──────────────────────────┬──────────────────────────┐
   │ Forced-line               │ Play vs Engine           │
   │ X solved / Y attempted    │ A solved / B attempted   │
   │ Last: дата                │ Last: дата               │
   │ [Решать]                  │ [Решать]                 │
   │ → /puzzles                │ → /puzzles/play-vs-engine│
   └──────────────────────────┴──────────────────────────┘
5. MistakesDiaryBlock (фильтр playVsEngine на фронте — §3.5)
6. Recent Attempts (рефакторинг ссылок — §3.5)
```

**Покрывает**: §2.6.

### 3.5. Frontend: чинит ссылки

**5.a. MistakesDiaryBlock**:
- Дополнительная защита: на клиенте дополнительно фильтровать `playVsEngine` из списка тем (на случай если backend ещё не выкачен или legacy-данные). Простой `.filter(agg => agg.theme !== 'playVsEngine')`.
- Этот же фильтр в `PuzzleMistakesPage` (`/puzzles/mistakes`).

**5.b. PuzzleMistakesPracticePage** (`/puzzles/mistakes-practice?theme=<X>`):
- Если query `theme === 'playVsEngine'` → редирект на `/puzzles/play-vs-engine` (с заменой URL без записи в history). Это страховка для старых ссылок и пользовательских bookmark'ов.

**5.c. Recent Attempts ссылки**:
- Базовое поведение клика по `#<shortId>` — `navigate('/puzzle/:id')` (повтор пазла). Это понятно: «открыть пазл». Для play-vs-engine добавить `?source=play-vs-engine` (как в `PlayVsEnginePuzzlesPage.tsx:143`), чтобы PuzzlePage знал контекст.
- Анализ — отдельная иконка/ссылка «📊 Анализ» рядом, видимая только для forced-line attempts (где moves не пустые). Для play-vs-engine иконка скрыта (нечего анализировать).
- Отображать: тег первой темы пазла (`<theme-tag>`), результат ✓/✗, время, рейтинг-delta, дату. Идентификатор `#<shortId>` — не убираем, но он визуально вторичный (мелкий, серый).

**Покрывает**: §2.1, §2.2 (защита), §2.4, §2.5, §2.7.

### 3.6. Backfill: существующие user_mistakes с тегом playVsEngine

**Что**: SQL-миграция (или одноразовый CLI):

```sql
UPDATE user_mistakes
SET themes = array_remove(themes, 'playVsEngine')
WHERE 'playVsEngine' = ANY(themes);

DELETE FROM user_mistakes
WHERE themes = '{}'::text[];
```

Второй DELETE — для случаев, где у пазла единственным тегом был `playVsEngine` (теоретически невозможно по generator-pipeline.ts, но защита от мусора).

Идемпотентная.

**Покрывает**: чистка после §3.1.

### 3.7. (Опционально) Подпись под графиком рейтинга

«Включает попытки во всех режимах. Forced-line: X. Play vs Engine: Y.» — короткая строка под SVG. Не обязательно для MVP редизайна, но снимает §2.8.

### 3.8. Что НЕ делаем

- Не вводим отдельный рейтинг для play-vs-engine (зафиксировано в ADR-044 §5.4).
- Не отказываемся от тех.тега `playVsEngine` в `Puzzle.themes`. Он по-прежнему нужен для UI-фильтра `/puzzles/play-vs-engine` через L-06 contract (его использует `PlayVsEnginePuzzlesPage` через `?solutionMode=play-vs-engine` параметр API, и он же — в `PuzzleStep` recommendations). Меняем только то, как этот тег **попадает в дневник ошибок**.
- Не ломаем `/puzzles/mistakes-practice?theme=playVsEngine` для legacy-bookmark'ов — даём редирект (§5.b).

---

## 4. Последствия

**Плюсы**:
- Пользователь больше не видит технический marker режима в списке тем.
- Recent Attempts для play-vs-engine — рабочая ссылка (повтор пазла), не пустой `/analysis`.
- Stats-страница даёт явный обзор по режимам и точку входа в play-vs-engine.
- Учёт ошибок становится корректным: одна попытка = одна запись, не дублируется через тех.тег.

**Минусы / риски**:
- Backfill `user_mistakes` чистит исторические данные — если в будущем понадобится отчёт «сколько ошибок было до и после релиза play-vs-engine» — `playVsEngine` тег из исторических записей пропадёт. Митигация: данные отчёта по `puzzle.solution_mode` через JOIN — это надёжнее, чем тег.
- API stats `byMode` требует JOIN `puzzle_attempts × puzzles` на каждый запрос. На текущем объёме (стандартный пользователь — десятки попыток в день) — приемлемо. Если станет узким местом — кэш на 5–10 минут.

---

## 5. Декомпозиция на тикеты

Все тикеты создаются в **To Do**, координатор проставляет порядок и старт. Префикс — **`[Puzzle stats redesign]`**.

| # | Тема | Исполнитель | Размер | Зависит от |
|---|------|-------------|--------|------------|
| 1 | Backend: фильтр `playVsEngine` (и mode-маркеры в общем виде) в `MistakesService.recordPuzzleMistake`; unit-тест на запись записывает только реальные темы | backend | S | — |
| 2 | Backend: SQL-миграция `array_remove(themes, 'playVsEngine')` в `user_mistakes`, удаление пустых записей; идемпотентная | backend | S | #1 |
| 3 | Backend: `GET /puzzles/stats/me` расширить полем `byMode` (`forced-line` / `play-vs-engine`: totalAttempted, totalSolved, lastAttemptAt); shared-DTO + unit-тест агрегации | backend | M | — |
| 4 | Backend: `GET /puzzles/attempts` отдавать `puzzle.solutionMode` в каждой записи; обновить shared-DTO | backend | XS | — |
| 5 | Frontend: на `PuzzleStatsPage` блок `Modes breakdown` с двумя карточками (forced-line / play-vs-engine), линки на `/puzzles` и `/puzzles/play-vs-engine`; рендерится только при `byMode.play-vs-engine.totalAttempted > 0` | frontend | S | #3 |
| 6 | Frontend: `MistakesDiaryBlock` + `PuzzleMistakesPage` дополнительно фильтруют `playVsEngine` из списка тем (защита + переходный период до выкатки backend-fix) | frontend | XS | — |
| 7 | Frontend: `PuzzleMistakesPracticePage` при `theme === 'playVsEngine'` редиректит на `/puzzles/play-vs-engine` (через `<Navigate replace>`) | frontend | XS | — |
| 8 | Frontend: рефакторинг Recent Attempts — основной клик ведёт на `/puzzle/:id` (для play-vs-engine добавлять `?source=play-vs-engine`); отдельная иконка «Анализ» только для forced-line (puzzle.solutionMode); показывать первую тему как тег рядом с shortId | frontend | M | #4 |
| 9 | Frontend (опц): подпись под графиком рейтинга «Includes both modes. Forced-line: X. Play vs Engine: Y.» | frontend | XS | #3 |
| 10 | i18n: добавить перевод `puzzleBrowser.themes.playVsEngine` (RU «Игра против движка», EN «Play vs Engine») — на случай если тег где-то ещё всплывёт; также строка для нового блока «Modes breakdown» | frontend | XS | — |
| 11 | QA: e2e регресс — `/puzzles/stats` для пользователя с обоими режимами; проверить что `playVsEngine` исчез из дневника, recent attempts ссылки работают, modes-breakdown отображается | qa | S | #5–8 |

### Граф зависимостей

```
#1 (backend filter) ──► #2 (backfill SQL)
#3 (backend stats byMode) ──► #5 (frontend modes block) ──┐
#4 (attempts.solutionMode) ──► #8 (recent attempts links) ─┤
#6 (frontend defensive filter) ───────────────────────────┤
#7 (redirect playVsEngine theme) ─────────────────────────┤
#9 (chart caption, opt) ──────────────────────────────────┤
#10 (i18n) ───────────────────────────────────────────────┘
                                                            │
                                                            ▼
                                                          #11 (qa e2e)
```

Параллелизм: #1+#3+#4+#6+#7+#10 могут идти параллельно. #2 после #1. #5 после #3. #8 после #4. #11 финальный.

---

## 6. Открытые вопросы

1. **Удалять ли `playVsEngine` из `Puzzle.themes`?** Сейчас тех.тег пишется в `Puzzle.themes` строку (см. ADR-044 §4.2). Альтернативное решение — вообще не писать его в `themes`, а использовать только `Puzzle.solutionMode` для всех проверок. Это чище концептуально, но требует поменять `PlayVsEnginePuzzlesPage` (он сейчас не зависит от тега, он фильтрует через `?solutionMode=play-vs-engine` query) и сам `generator-pipeline.ts:361`. **Решение**: оставляем тег в `Puzzle.themes` для обратной совместимости фильтра, фильтруем только при попадании в `user_mistakes`. Если в будущем выяснится, что тег нигде не используется — можно убрать отдельным ADR.

2. **Backfill в момент миграции или отдельным CLI?** Простой UPDATE безопасен, но затрагивает все строки `user_mistakes` (на текущем объёме — единицы тысяч максимум, ок). Можно делать прямо в Prisma migration файле. Решение оставлено backend на тикете #2.

3. **Подпись под графиком (§3.7) — опционально или обязательно?** Не блокирует фикс, делаем как «nice-to-have» #9. Если frontend в #5 уже рендерит modes-breakdown, подпись избыточна — пользователь и так видит распределение.

4. **Чувствительные `Recent Attempts` для форсированных пазлов** — открывать `/puzzle/:id` (повтор) или `/analysis` (показ решения)? Решение: основной клик → `/puzzle/:id`, отдельная иконка → `/analysis` (только для forced-line). Это правит §2.5 + не ломает «открыть решение для разбора», просто переносит в явный отдельный action.
