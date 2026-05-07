# ADR-047 — Play-vs-engine: live eval bar и post-game review ходов

- Статус: Proposed
- Дата: 2026-05-07
- Связанные задачи: KS-2503
- Связанные ADR: ADR-044 (puzzle play-vs-engine), ADR-041 (blunder detection)
- Связанные тикеты: KS-2466 (PlayVsEngineRunner), KS-2471 (UCI→SAN, blunder hint), KS-2473 (sequential WASM analyze), KS-2486 (workshop link)
- Авторы: architect

---

## 1. Контекст

`PlayVsEngineRunner` (KS-2466, ADR-044) реализует решение пазлов в режиме play-vs-engine: пользователь играет до N полуходов против локального WASM Stockfish, выигрывает по WDL ≥ winThreshold и проигрывает по WDL < failThreshold. Жалоба пользователя — два UX-дефекта:

1. **Нет градусника (eval bar) во время игры**. Хотя компонент `<EvalBar>` уже подключён в JSX (`PlayVsEngineRunner.tsx:678`), градусник пуст до первого хода и не обновляется во время фазы `thinking`.
2. **Post-game разбор работает не как классификация, а как «лучший ход для последнего полухода»**. Текущий блок `bestmoveHint` (строки 634–660) **всегда** для последнего user-хода рендерит фразу «You played X, the best move was Y», независимо от величины cp-loss. Если `played != best` (хоть на 5 cp) — UI выглядит как «ты ошибся», что и порождает жалобу «всегда последний ход помечается как ошибочный». Остальные ходы вообще не отображаются.

ADR описывает: где данные уже собираются, что нужно дописать, как переиспользовать существующий WASM Stockfish, и каким должен быть UX.

### 1.1 Что уже есть в коде

| Компонент / поле | Файл | Что хранит / делает |
|------------------|------|---------------------|
| `WasmEngineAdapter` | `apps/web/src/utils/engineAdapter.ts:85–149` | Единый worker `/stockfish/stockfish-18-single.js`, метод `analyze(fen, depth, multiPv) → AnalysisResult`. |
| `engineRef` + `engineQueueRef` | `PlayVsEngineRunner.tsx:239–252` | Один WASM-инстанс на компонент, **сериализованная** очередь `queueAnalyze` (KS-2473 — без сериализации stdin движка ломается). |
| `EvalBar` | `apps/web/src/components/EvalBar.tsx` | Принимает `EvalLine[]` и `isBlackTurn`, рендерит шкалу. На пустом массиве показывает `0.0`. |
| `evalLines` | `PlayVsEngineRunner.tsx:222` | `useState<EvalLine[]>([])` — изначально пустой. Заполняется в `runEngineCycle:362` после хода пользователя. |
| `userBestLog` | строки 234, 503 | Массив `{halfMove, fenBefore, playedUci, bestUci}` — **PV1 в позиции до user-хода**. Заполняется pre-analyze в `onPieceDrop` (фоновая `void async`). |
| `bestmoveLog` | строки 229, 367 | Массив `{halfMove, sideToMove, bestUci, fen, wdlPov}` — состояние **после user-хода**, POV соперника. |
| `playedSans` | строка 219 | SAN-строки всех применённых ходов (user + engine) — для Workshop-ссылки. |
| `bestmoveHint` | строки 634–660 | UI-подсказка ТОЛЬКО для последнего user-хода. **Корень жалобы №2**. |

### 1.2 Что НЕ сохраняется (нужно добавить)

- **`wdlBefore`** (или `cpBefore`) — оценка позиции **до** user-хода. У нас её можно получить из `pre.lines[0].score` (см. строки 500–507), но в `userBestLog` сохраняется только `bestUci` без score. Без `wdlBefore` нельзя посчитать cp-loss = eval_before − eval_after.
- **`evalAtStart`** — оценка стартовой позиции пазла. Сейчас pre-analyze стартового FEN не делается → eval-bar пуст до первого хода.
- **`fenAfterUserMove`** — FEN после user-хода (в `bestmoveLog.fen` — да, оно есть). Это используется для UI-«перепрыгнуть в эту позицию».

### 1.3 Что в проекте отсутствует целиком

- **Авто-классификация хода** (`good/inaccuracy/mistake/blunder`). Проверено `apps/web/src/**` и `apps/api/src/**` — есть только ручные NAG-аннотации через `NagPalette` (review/components/NagPalette.tsx). Workshop / AnalysisPage классификации не делает. В backend в `puzzle-generator/generator-pipeline.ts` есть детектор зевков по WDL-delta, но это серверная генерация пазлов, не review user-ходов.
- **Post-game список ходов с метками**. `bestmoveHint` показывает только последний ход.

---

## 2. Решение

### 2.1 Live eval bar (пункт 1 жалобы)

**Что**: при mount `PlayVsEngineRunner` (и при смене `puzzle.id`) делать первичный analyze стартового FEN и сразу выставлять `evalLines`. Тогда градусник показывает оценку «начальной выигранной позиции» (`wdlAfterBlunder ≈ +0.5..+1.0`) уже до первого user-хода.

```
useEffect(() => {
  void (async () => {
    await ensureEngine();
    const initial = await queueAnalyze(puzzle.fen);
    setEvalLines(toEvalLines(initial));
    // НЕ обновляем latestWdlUser — он уже инициализирован params.wdlAfterBlunder
    // и должен сохраниться как «исходный перевес» до первого хода.
  })();
}, [puzzle.id]); // тот же deps что и существующий reset-effect
```

Отдельный effect (а не интеграция в существующий reset) — чтобы первый pre-analyze не блокировал сброс state. `engineQueueRef.current` гарантирует что initial-analyze завершится до первого pre/post-analyze в `onPieceDrop`.

**Поведение во время `thinking`**: после pre-analyze в `onPieceDrop` (строки 497–511) результат записывается в `userBestLog`, но **НЕ** в `evalLines`. Это намеренно: пока соперник не сделал ход, старая оценка (после хода соперника) — наиболее свежая для пользователя. Имеет смысл также обновлять `evalLines` после pre-analyze (тогда юзер видит «куда движется eval» сразу после своего хода), но это minor — можно решить в тикете.

**Что показывает bar**:
- Стартовая позиция: ≈ +0.5..+1.0 (зависит от `wdlAfterBlunder`).
- После user-хода: обновляется через post-analyze в `runEngineCycle`.
- После engine-хода: обновляется через final-analyze (если halfMovesPlayed >= N) или возвращаемся в `thinking` с актуальным eval после хода соперника.

**Mobile layout**: текущий CSS (apps/web/src/styles/puzzle.css `.puzzle-engine-runner__layout`) разводит EvalBar и доску через flex. На mobile EvalBar занимает узкую вертикальную полосу слева от доски. Layout не меняем — eval-bar просто перестаёт быть пустым.

**Покрывает**: жалобу №1 (eval bar пустой).

### 2.2 Post-game review (пункт 2 жалобы)

**Что**: после win/lose заменить single-move `bestmoveHint` на **полный список user-ходов с классификацией**. Каждый ход — карточка с меткой и cp-loss, клик на карточку перебрасывает board в позицию до этого хода.

#### 2.2.1 Классификация — формула

Lichess-стиль классификации по cp-loss (см. lichess-org/lila `EvalEffort`/`Glyph` логику):

| Метка | Условие | UI-индикатор |
|-------|---------|--------------|
| `best` | `playedUci === bestUci` | ✓ зелёный |
| `good` | cp-loss < 50 | • нейтральный серый |
| `inaccuracy` | 50 ≤ cp-loss < 100 | ⁉ жёлтый |
| `mistake` | 100 ≤ cp-loss < 200 | ? оранжевый |
| `blunder` | cp-loss ≥ 200 | ?? красный |

Альтернатива по WDL-delta (как в ADR-041 §2.1 для генерации):

| Метка | Условие |
|-------|---------|
| `best` | played == best |
| `good` | wdl-loss < 0.1 |
| `inaccuracy` | 0.1 ≤ wdl-loss < 0.2 |
| `mistake` | 0.2 ≤ wdl-loss < 0.4 |
| `blunder` | wdl-loss ≥ 0.4 |

**Решение MVP**: cp-loss с порогами 50/100/200. Причина: cp-метрика стандартная (lichess, chess.com, Workshop в будущем тоже на ней), пользователь привык к ней. WDL — внутренняя метрика для логики win/lose режима; для UX-классификации лучше cp.

`scoreToCP` уже есть в `engineAdapter.ts:74` — переиспользуем (для mate возвращает `±10000 - (dist-1)*100`).

#### 2.2.2 Что нужно сохранять дополнительно

Расширить `UserBestSnapshot`:

```ts
type UserBestSnapshot = {
  halfMove: number;
  fenBefore: string;
  playedUci: string;
  playedSan: string;          // ← добавить, для UX без повторной конверсии
  bestUci: string;
  bestSan: string;            // ← добавить
  cpBefore: number;           // ← добавить (POV user, scoreToCP(pre.lines[0].score))
  cpAfter?: number;           // ← добавить (POV user; берём из bestmoveLog после хода)
};
```

`cpBefore` пишется в `onPieceDrop` при pre-analyze (`scoreToCP(preBest.score)` — POV user, потому что в `fenBefore` ходит юзер).

`cpAfter` пишется в `runEngineCycle` (строка 367, там уже сохраняется `wdlPov`): `cpAfterFromEngine = scoreToCP(best.score)` (POV соперника), `cpAfter = -cpAfterFromEngine` (POV user, инверсия). Записывается в **существующую** запись `userBestLog[i]`, не в новую запись `bestmoveLog`.

Это требует поменять структуру записи: либо хранить в одной мапе по `halfMove`, либо обновлять последнюю запись `userBestLog`. Проще — `Map<number, UserMoveAnalysis>` ключом `halfMove`, заполняется по частям.

#### 2.2.3 Без новых WASM-запросов

Вся информация уже собирается по ходу игры. Post-game review **не делает дополнительных analyze** — только агрегирует pre+post analyze, которые уже были выполнены.

Один edge case: pre-analyze для последнего user-хода (на котором сразу финал) может не успеть завершиться до win/lose, если он отстаёт по очереди от post-analyze. Для этого хода `cpBefore` будет undefined. Решение: классификация выдаёт `good` (по умолчанию, без меток-замечаний) — нельзя рисовать «mistake» без данных. Альтернатива — fallback на запрос **после** win/lose (queueAnalyze свободен после финала). Решаем в тикете.

#### 2.2.4 UI: `PostGameReview` блок

Заменяет текущий `bestmoveHint` (строки 752–778). Структура:

```
┌─────────────────────────────────────────────────────┐
│ Result: You held the advantage / You lost ...       │
│ Final WDL: +0.65                                     │
├─────────────────────────────────────────────────────┤
│ Your moves:                                          │
│  ✓ 1. Bxf4    (best)                          [⤴]   │
│  • 2. Re1     (good, +0 cp)                   [⤴]   │
│  ⁉ 3. Kh1     (inaccuracy, lost 60 cp)        [⤴]   │
│  ?? 4. Qd2    (blunder, lost 220 cp)          [⤴]   │
│       Best was: 4. Qxe4                              │
├─────────────────────────────────────────────────────┤
│ [Open in Workshop]   [Next puzzle]                   │
└─────────────────────────────────────────────────────┘
```

- Каждый ход — `<button data-half-move={n} data-classification={k}>`.
- Клик → board перерисовывается в позицию `fenBefore` хода (board становится snapshot, `enabled=false`). Повторный клик на тот же ход / клик «Сбросить» → возврат к финальной позиции.
- Для меток ≠ `good`/`best` под ходом мелким текстом «Best was: <bestSan>». Для `best` ничего не приписываем.
- Раскраска через CSS-классы `puzzle-engine-runner__review-move--{best,good,inaccuracy,mistake,blunder}`.

`Open in Workshop` уже есть (строки 726–744) — оставляем без изменений. `[Next puzzle]` уже есть (строка 783).

**Mobile**: review-list рендерится **под** доской (вертикально), не сбоку. Eval-bar остаётся слева/справа. Прокрутка списка в overflow.

#### 2.2.5 Снос текущего `bestmoveHint`

Вычисление `bestmoveHint` (634–660) и его рендер (752–778) удаляются. Они были «подсказкой для последнего хода» — теперь все ходы попадают в `PostGameReview`, и последний — просто последняя строка списка.

**Покрывает**: жалобу №2 («всегда последний помечается ошибочным»).

### 2.3 Переиспользование существующих компонентов

Нужно ли вызывать `parseAnnotatedPgn` / Workshop annotations? **Нет**:

- Workshop annotations (NagPalette, NodeAnnotations в `apps/web/src/review/types.ts`) — **ручные** аннотации пользователя. Они не делают классификацию, они её **хранят и сериализуют в PGN-NAG**.
- `serializeToAnnotatedPgn` в `AnalysisPage.tsx:518` — берёт ручные NAG-и из state и пишет в PGN. Не подходит для авто-разбора.
- В `apps/api/src` тоже нет автоклассификации (Grep подтвердил).

То есть **классификация — новая функция**, чисто frontend, локальная для play-vs-engine. Если позже Workshop захочет автоклассификацию (отдельная задача/ADR), функцию `classifyMove(cpBefore, cpAfter, played, best) → MoveClassification` стоит положить в `apps/web/src/utils/moveClassification.ts` для переиспользования.

`apps/web/src/utils/moveClassification.ts` — новый файл, единственное публичное API:

```ts
export type MoveClassification = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export interface ClassifyMoveInput {
  cpBefore: number;       // POV ходящего
  cpAfter: number;        // POV ходящего, после своего хода (инвертирован от eval соперника)
  playedUci: string;
  bestUci: string;
}

export function classifyMove(i: ClassifyMoveInput): MoveClassification {
  if (i.playedUci === i.bestUci) return 'best';
  const loss = Math.max(0, i.cpBefore - i.cpAfter);
  if (loss < 50)  return 'good';
  if (loss < 100) return 'inaccuracy';
  if (loss < 200) return 'mistake';
  return 'blunder';
}
```

Юнит-тесты — отдельно. Без зависимостей от React.

### 2.4 Что НЕ делаем

- **Не сохраняем классификацию в БД** (`PuzzleAttempt.metadata` JSONB — задел из ADR-044 §5.4). Для текущей жалобы избыточно — UX «здесь и сейчас». Если потом понадобится статистика «доля blunder per user» — отдельный тикет.
- **Не вводим depth=18+** для analyze. Текущий `analyzeDepth=12` (строка 191) — компромисс скорость/точность. Глубже = плавнее ход в реальном времени тормозится. На review-стадии можно раз догонять до 18 — отложим до отдельной задачи, если 12 окажется шумным.
- **Не меняем сам алгоритм win/lose** в `runEngineCycle` — он работает корректно по ADR-044 §5.2, проблема только в UI-постмортеме.
- **Не переиспользуем server-side blunder-detector** из `tactic-worker`. Он живёт на бэкенде, а тут локальный WASM на клиенте — overhead сетевого вызова не оправдан.

---

## 3. Декомпозиция на тикеты

Все тикеты создаются в **To Do**. Префикс — `[Puzzle play-vs-engine]`.

| # | Тема | Исполнитель | Размер | Зависит от |
|---|------|-------------|--------|------------|
| 1 | Frontend: utility `apps/web/src/utils/moveClassification.ts` (`classifyMove`, типы `MoveClassification`); юнит-тест на каждый класс + edge cases (mate cp ±10000, played=best, отсутствие cpBefore) | frontend | XS | — |
| 2 | Frontend: расширить `UserBestSnapshot` полями `playedSan, bestSan, cpBefore`; в `onPieceDrop` сохранять `cpBefore = scoreToCP(preBest.score)` POV user; SAN'ы конвертируются через существующий `uciToSan` | frontend | S | #1 |
| 3 | Frontend: в `runEngineCycle` после post-analyze сохранять `cpAfter` POV user (`-scoreToCP(best.score)`) в **ту же запись** `userBestLog[halfMove]`; перейти от массива к `Map<number, UserMoveAnalysis>` (или дополнять последнюю запись) | frontend | S | #2 |
| 4 | Frontend: первичный pre-analyze стартового FEN при mount → `setEvalLines(...)`; eval-bar перестаёт быть пустым; smoke-тест что после mount evalLines.length > 0 | frontend | XS | — |
| 5 | Frontend: новый компонент `PostGameReview` (`apps/web/src/components/puzzle/PostGameReview.tsx`): принимает `analyses: UserMoveAnalysis[]`, рендерит список с классификацией; iconography через emoji или CSS-классы | frontend | M | #1, #3 |
| 6 | Frontend: в `PlayVsEngineRunner` заменить `bestmoveHint` (634–778) на `<PostGameReview>`; оставить блок result-label и кнопку Next/Workshop | frontend | S | #5 |
| 7 | Frontend: клик по записи в `PostGameReview` → board показывает snapshot `fenBefore`, `enabled=false`; повторный клик / кнопка «Reset view» → возврат к финальной позиции; не пересоздавать engine | frontend | S | #6 |
| 8 | Frontend: i18n строки `puzzle.engine.review.{best, good, inaccuracy, mistake, blunder, lostCp, bestWas, yourMoves, resetView}` — RU/EN; удалить устаревшие `bestmoveAt`, `bestmoveDiff` (если нигде не используются) | frontend | XS | #5 |
| 9 | Layout: CSS для `.puzzle-engine-runner__review-move--{best,good,inaccuracy,mistake,blunder}` — цвета согласно §2.2.4; mobile — review-list под доской | layout | S | #6 |
| 10 | QA: e2e — пройти play-vs-engine с разной точностью (best, blunder, mixed); проверить что классификация совпадает с ожидаемой; проверить что клик по ходу меняет позицию доски | qa | S | #7, #9 |

### Граф зависимостей

```
#1 (classifyMove) ──► #2 (cpBefore) ──► #3 (cpAfter)
                                          │
#4 (initial pre-analyze) ─────────────────┤
                                          ▼
                                        #5 (PostGameReview)
                                          │
                                          ▼
                                        #6 (replace bestmoveHint)
                                          │
                                          ▼
                                        #7 (board snapshot click)
                                          │
                                          ├──► #8 (i18n)
                                          ├──► #9 (layout/CSS)
                                          ▼
                                        #10 (qa e2e)
```

Параллелизм: #1+#4+#8 можно стартовать сразу. #2 после #1. #3 после #2. #5 после #1 и #3. #6 после #5. #7+#9 после #6. #10 финальный.

---

## 4. Открытые вопросы

1. **Pre-analyze для последнего user-хода может не успеть завершиться до win/lose** (§2.2.3). Два варианта: (a) показывать его как `good` без cp-loss (плохо — даёт ложно-успокаивающий сигнал, если ход на самом деле был бландером); (b) после win/lose доделать analyze, обновить запись и rerender. Лучше (b) — дополнительный analyze стартует только когда engine свободен, ничего не блокирует. Решает frontend в #5/#6.

2. **WDL vs cp как метрика классификации** (§2.2.1). Принят cp с lichess-порогами 50/100/200. После #10 (qa e2e) можно валидировать на нескольких пазлах — если пользователь жалуется что classifier «слишком строгий/мягкий», подкручиваем пороги в #1 (одна константа).

3. **Нужно ли live-обновлять eval bar во время `thinking`** (после pre-analyze, до хода соперника)? Изначально pre-analyze пишется только в `userBestLog`. Если пушить и в `evalLines` — пользователь увидит «куда движется eval» сразу после своего хода. С другой стороны, между pre и post оценки может быть разница (pre — POV user в позиции до хода, post — POV соперника после хода → инверсия). Если выводить и то и другое — eval-bar дёргается. Решение: **писать ТОЛЬКО post в evalLines**, pre не пушим. Eval-bar обновляется ровно один раз за полуход (после post-analyze). Чище.

4. **Сохранять `MoveClassification` в backend `PuzzleAttempt.metadata`?** ADR-044 §5.4 уже зарезервировал JSONB поле. Мы могли бы при `submitAttempt` слать массив classifications. Но: (а) данные нечистые (cp depend on depth/engine version, могут разниться между клиентами); (б) пока нет потребителя этих данных. Откладываем — отдельный тикет если понадобится статистика.

5. **`/analysis` ссылка с auto-аннотациями?** Сейчас Workshop-link открывает чистый PGN без NAG. Можно было бы прокинуть `?annotations=` с уже посчитанной классификацией. Но Workshop ожидает PGN-NAG (`!`, `?`, `?!`...) или собственные annotations через `parseAnnotatedPgn`. Чтобы прокинуть — нужно конвертировать `MoveClassification` → NAG-номера и собрать AnnotatedPgn. Объём — отдельный тикет, не блокирует MVP. Зафиксировано как опц. follow-up.

---

## 5. Последствия

**Плюсы**:
- Eval-bar становится честным с первого момента (видно «исходный перевес»).
- Классификация ходов перестаёт ложно сигналить «ты сыграл не так» там где cp-loss мизерный.
- Пользователь видит **все** свои ходы с метками, а не только последний. Лучшее обучающее значение.
- Функция `classifyMove` переиспользуема в Workshop / forced-line postmortem (если появится в будущем).
- Никаких лишних WASM-запросов — всё на уже собранных данных.

**Минусы / риски**:
- Pre-analyze для последнего user-хода может опаздывать (open question 1). Митигация — fallback analyze после win/lose.
- При `analyzeDepth=12` точность cp-классификации на сложных позициях ограничена. Если порог 50 cp окажется шумным — корректировка одной константой.
- Размер JSX в `PlayVsEngineRunner.tsx` уже большой (805 строк). Тикет #5 выносит `PostGameReview` в отдельный файл — компонент уменьшается, не растёт.
