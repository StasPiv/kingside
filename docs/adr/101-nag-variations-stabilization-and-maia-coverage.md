# ADR-101. Variations: переменная длина по стабилизации + покрытие Maia-вероятных ходов

Статус: предложен (KS-3608).
Дата: 2026-06-02.
Supersedes: ADR-100 §4 (фиксированная длина 3 полухода + узкий Maia-trap).
Связано: ADR-100 §3 (правила NAG), ADR-066 (`classifyMove`), `packages/shared/src/utils/wdl.ts`, KS-3601/3603/3607.

## 1. Контекст

ADR-100 §4 фиксировал длину variation в 3 полухода и добавлял Maia-trap только в одном узком случае (Maia top-1 ≠ SF top-1, prob≥0.25, classify(maiaTop) ∈ {mistake,blunder}, не сыгран). Проблемы:

1. **Жёсткая длина**: тактический мотив часто захватывает 5-7 полуходов (форсированная связка с разменом); 3-полуходная линия обрывается «посреди фразы». Обратное — спокойные позиции не нуждаются в 3 полуходах: первый best-ход + ответ соперника уже передают идею, третий ход лишний.
2. **Maia top-1 редко появляется**: текущее правило срабатывает только когда сам пользователь промахнулся, а Maia top-1 это «другая» (плохая) альтернатива. Не покрывается **самое полезное** — «соперник в этой позиции часто играет X, и тогда нужно ответить Y».
3. **Нет согласованности «глубже» с precision-метрикой**: длину выбирали константой, а не через тот же `classifyMove`. Естественная стыковка — обрывать линию там, где `classifyMove` следующего полухода = `best`/`good` стабильно подряд (= позиция «успокоилась»).

## 2. Решение (краткое)

1. **Переменная длина variation** через стабилизацию WDL. Линия растёт по best-ходам обеих сторон, пока `expectedScoreFromWdl` стабилен подряд N полуходов или достигнут глобальный cap. Дополнительно — forcing-move heuristic (не обрывать на checks/captures).
2. **Расширенное покрытие Maia**: при построении любой линии для каждого хода соперника проверяем «человеческую альтернативу». Если Maia top-1 соперника ≠ SF best соперника **И** classify(maiaTop) ≠ `best` — добавляем sub-variation «как часто играют» + наш SF-best ответ.
3. **Лимиты разрастания дерева**: max 4 уровня вложенности, max 2 variations на узле, max 8 полуходов в любой линии. Защита от взрывного роста.
4. **Все WDL-операции** — через helpers `packages/shared/src/utils/wdl.ts` и `classifyMove` из shared. Единый источник истины с precision-модулем.

## 3. Алгоритм переменной длины

### 3.1. Базовая идея

Стартовая точка variation — первый ход линии (например, sfBest при `?`/`??` главного хода). После этого мы строим продолжение по best-ходам обеих сторон до условия стабилизации.

Стабилизация позиции = «дальнейшая игра обеих сторон не сдвигает win-probability значимо».

### 3.2. Pseudo-code

```ts
import { expectedScoreFromWdl, wdlSigned, invertWdl } from '@kingside/shared/utils/wdl';

const STABILIZED_LOSS_E_THRESHOLD = 0.03;   // 3% win-probability — «не сдвинулось»
const STABILIZED_CONSECUTIVE_PLIES = 2;     // подряд столько раз — линия стабильна
const MAX_LINE_LENGTH_PLIES = 8;            // глобальный cap
const MIN_LINE_LENGTH_PLIES = 1;            // первый ход всегда показываем
const DECIDED_WDL_SIGNED_ABS = 0.95;        // |E - 0.5| > 0.45 — позиция решена

/**
 * Растим линию из startFen начиная с firstMoveUci.
 * Возвращает массив UCI-ходов длиной 1..MAX_LINE_LENGTH_PLIES.
 *
 * `engineGetBestLine(fen)` — функция-обёртка над Stockfish:
 *   возвращает { bestUci, wdlAfterBest (POV того же игрока) }.
 *   В оркестраторе это будет batch-вызов SF с `multipv 1` на каждой
 *   позиции (или re-use, если позиция уже посчитана).
 */
function buildStabilizedLine(
  startFen: string,
  firstMoveUci: string,
  engineGetBestLine: (fen: string) => { bestUci: string; wdlAfter: Wdl } | null,
  applyMoveToFen: (fen: string, uci: string) => string,
): string[] {
  const line: string[] = [firstMoveUci];
  let currentFen = applyMoveToFen(startFen, firstMoveUci);

  // Стабилизация измеряется на E (expectedScore) того игрока, который
  // ходит на startFen (= автор первого хода в линии).
  // На fenAfter side-to-move меняется, поэтому invertWdl при сравнении.
  let lastE: number | null = null;
  let stableCount = 0;

  while (line.length < MAX_LINE_LENGTH_PLIES) {
    const sf = engineGetBestLine(currentFen);
    if (!sf) break; // SF не дал линию (mate / stalemate / cancel)

    // POV-инверсия: sf.wdlAfter дан POV соперника текущего хода;
    // приводим к POV исходного игрока (того, кто ходил первым в линии).
    // Чётность глубины: на чётных шагах (после ответа соперника) POV
    // совпадает с исходным; на нечётных — инвертирован один раз.
    const playerPovWdl = (line.length % 2 === 0)
      ? invertWdl(sf.wdlAfter)  // только что ходил соперник — invert для player POV
      : sf.wdlAfter;             // только что ходил player — already player POV
    const eNow = expectedScoreFromWdl(playerPovWdl);

    // Stop A: decided position — позиция уже решена.
    if (Math.abs(wdlSigned(playerPovWdl)) > DECIDED_WDL_SIGNED_ABS) {
      // Добавляем текущий best, чтобы зафиксировать «и побеждаем», и stop.
      line.push(sf.bestUci);
      break;
    }

    // Stop B: стабилизация — E не сдвинулась.
    if (lastE !== null && Math.abs(eNow - lastE) < STABILIZED_LOSS_E_THRESHOLD) {
      stableCount += 1;
      if (stableCount >= STABILIZED_CONSECUTIVE_PLIES && line.length >= MIN_LINE_LENGTH_PLIES) {
        // Stop A-варианта: forcing-move heuristic.
        // Если последний ход — check или capture, продлеваем ещё на 1 ход.
        const lastIsForcing = isCheckOrCapture(currentFen, sf.bestUci);
        if (!lastIsForcing) break;
        // Иначе — добавляем best и продолжаем (даём шанс ещё одной паре).
        stableCount = 0;
      }
    } else {
      stableCount = 0;
    }

    // Сделать best и шагнуть.
    line.push(sf.bestUci);
    currentFen = applyMoveToFen(currentFen, sf.bestUci);
    lastE = eNow;
  }

  return line;
}

function isCheckOrCapture(fen: string, uci: string): boolean {
  // через chess.js: разобрать ход, проверить флаги SAN ('+', '#', 'x').
  // Реализация в утилите `apps/web/src/lib/review/moveFlags.ts`.
}
```

### 3.3. Пороги — обоснование

- `STABILIZED_LOSS_E_THRESHOLD = 0.03` — соответствует ~6% разницы в `winPct` (через Lichess CP→Win-formula). Меньше — позиция «стоит на месте», глубже копать незачем.
- `STABILIZED_CONSECUTIVE_PLIES = 2` — минимум одна пара ходов в стабильности (1 полуход — слишком мало для вывода «позиция успокоилась», нужно подтверждение хотя бы на следующем полуходе).
- `MAX_LINE_LENGTH_PLIES = 8` — 4 полные хода каждой стороны. Эмпирически — тактические мотивы реже растягиваются дольше; цена SF-batch'а растёт линейно.
- `DECIDED_WDL_SIGNED_ABS = 0.95` — `|W − L|/1000 > 0.95` означает ~97.5% уверенности в одном исходе. Дальше линию тянуть — mate-mop-up, не информативно.

### 3.4. Forcing-move heuristic

При стабилизации проверяем последний ход:
- `+` (check), `#` (mate) — продлеваем ещё на 1 ход (сторона на ходу вынуждена отвечать на угрозу).
- `x` (capture) — обычно ответный размен, продлеваем.

Это эвристика — не идеальная, но дешёвая и закрывает 80% «преждевременного обрыва тактики». Если в будущем понадобится точнее — переходим на «не обрывать пока есть лучший ход с большим преимуществом над вторым best» (требует MultiPV>=2 на каждой позиции, дороже).

Реализация `isCheckOrCapture` — через `chess.js`: парсим UCI → SAN → ищем флаги.

### 3.5. Граничные случаи

- **Mate-line**: SF возвращает mate-in-N, `expectedScoreFromWdl` = 1.0 (или 0.0). Сразу stop A (decided). Линия короткая — это OK, mate-фраза самодостаточна.
- **Stalemate / draw by repetition**: engineGetBestLine возвращает `null` (нет легального хода). Линия завершается.
- **Cancel пользователем** во время построения: оркестратор передаёт `null` из engineGetBestLine, линия завершается на текущей длине.
- **Min length = 1**: даже если стабилизация наступила на первом же полуходе (Stockfish считает «всё, лучшего нет»), линия = [firstMoveUci]. Это нормально — иногда показать один ход достаточно (например, единственный спасающий ресурс).

## 4. Покрытие Maia-вероятных ходов

### 4.0. Принцип однородности

**В разборе партии нет понятий «свой» и «соперник»** (уточнение пользователя через координатора). Все полуходы трактуются единообразно — правило Maia-альтернативы применяется к **любому** полуходу в любой линии, без деления по сторонам.

### 4.1. Текущее покрытие (ADR-100 §4)

- §4.1 «как надо было»: SF-best линия при `?`/`??` главного хода — без участия Maia.
- §4.2 «Maia-trap»: Maia top-1 как side-variation, только если в основной партии не сыграли именно его, и Maia top-1 классифицируется как `mistake`/`blunder`.

Этого мало. Самый частый use-case — «в этой позиции часто играют X, как реагировать» — не покрыт.

### 4.2. Новое: Maia-альтернатива на каждом полуходе линии

При построении любой линии (через §3 алгоритм) для **каждого** полухода (любого, без различения сторон) проверяем:

```ts
// На позиции перед очередным полуходом:
const sfBest = engineGetBestLine(fen).bestUci;
const maiaPolicy = maiaPredict(fen, elo).policy;
const maiaTop = topProbabilityMove(maiaPolicy);

if (
  maiaTop !== sfBest
  && maiaPolicy[maiaTop] >= MAIA_ALT_MIN_PROB  // 0.20
  && classifyMove({ wdlBefore, wdlAfter: wdlAfterMaiaTop }) !== 'best'
) {
  // Добавляем sub-variation: maiaTop + продолжение через тот же
  // buildStabilizedLine (рекурсивно), но с пониженным cap.
}
```

Sub-variation — это полноценная линия, построенная тем же §3 алгоритмом, но с **уменьшенным cap'ом** (`MAX_LINE_LENGTH_PLIES = 4` для sub-variation, чтобы не разрасталось).

Правило применяется и к ходам в основной партии (до любых variations), и к ходам внутри variations — везде одинаково.

### 4.3. Пороги Maia

- `MAIA_ALT_MIN_PROB = 0.20` (раньше было 0.25 в §4.2 ADR-100; смягчаем до 0.20 — покрываем больше ходов, при сохранении значимости).
- `classify(maiaAlt) ≠ 'best'` — если Maia top-1 совпадает с SF top-1 семантически (хоть и не буквально по uci — может быть transposition, но это редкость), не плодим variation. Если classify = `'good'`/`'inaccuracy'`/`'mistake'`/`'blunder'` — variation полезен.

### 4.4. Suppression — natural через `maiaTop !== sfBest`

Если на каком-либо полуходе Maia top-1 совпадает с SF best — variation тождествен главной линии, не добавляем. Это уже обработано первым условием `maiaTop !== sfBest`.

Отдельной логики «не добавлять для своего/чужого хода» нет (§4.0 — однородный фрейм). Если для конкретного полухода в основной партии maiaTop ≠ sfBest и classify ≠ best — Maia-альтернатива всегда добавляется (с учётом лимитов §5).

## 5. Лимиты разрастания дерева

| Параметр | Значение | Обоснование |
|---|---|---|
| `MAX_LINE_LENGTH_PLIES` (main line) | 8 | Тактические мотивы редко длиннее. |
| `MAX_LINE_LENGTH_PLIES` (sub-variation) | 4 | Sub-variations — иллюстрация ответа, не полная линия. |
| `MAX_NESTED_DEPTH` | 4 | Sub-sub-variation допустим (например, «вот альтернатива» → «но если она опровергается ещё одним неожиданным ходом»), но 5-й уровень — уже неподьёмно. |
| `MAX_VARIATIONS_PER_NODE` | 2 | Тот же лимит что в ADR-100 §4.3. |
| `MAX_TOTAL_VARIATIONS_PER_MOVE` (включая вложенные) | 12 | Soft cap, чтобы итоговая PGN не разрослась до неприлично большой при сложных позициях. Реализация — счётчик в оркестраторе, при достижении skip остальные кандидаты с приоритетом по `maiaTopProb desc`. |

## 6. Открытые вопросы

Нет. Прежний открытый вопрос (Maia-альтернатива на «good-ходах игрока» отдельно от «ходов соперника») снят как артефакт ошибочного фрейма: в разборе нет понятия «свой/чужой», см. §4.0. Правило §4.2 применяется ко всем полуходам однородно.

## 7. Производительность

### 7.1. Стоимость переменной длины

Каждая variation — `buildStabilizedLine` делает 1..8 SF-вызовов (на каждой позиции `multipv 1`). В худшем случае partition'но:

- 80 полуходов × ~2 variations × 8 SF-runs/variation = 1280 доп. SF-runs.
- При `depth 18` × 200-400 мс = 4-8 минут доп. Это **слишком**.

Mitigation — снизить depth для variation-building:
- `LINE_DEPTH = 14` (вместо 18) — на 30-50% быстрее, точность качественно достаточна для построения «спокойной линии».
- Total: 1280 × 100-200 мс = 2-4 мин. Всё ещё много.

**Дальнейшее сжатие**:
- В среднем variation длиннее 3 полуходов не бывает (стабилизация наступает быстро) → реальный multiplier 3-4×, не 8×. Реальная оценка: 80 × 1.5 variations (не на каждом ходе) × 3.5 plies × 100-200 мс = ~84-168 с. Это допустимо для 80-полуходной партии (на типичной 40-полуходной — половина, 40-80 с).
- Cache: позиции в дереве часто повторяются (transposition). Кэш в Map<fen, sfResult>. Кэш-hit для variations легко 30-50% (одни и те же лучшие линии).

С кэшем и реальным распределением длин — total addition к base из ADR-100 §7 (25-40 с) = **+30-60 с p50**. Total review = **~60-100 с p50** для 80-полуходной партии. Приемлемо.

### 7.2. Покрытие Maia-альтернатив

На каждом полуходе партии (80 шт для 80-полуходной) — 1 Maia inference уже есть (от ADR-100). При совпадении maiaTop=sfBest — variation не добавляем (no extra SF). При различии и classify ≠ best — нужен `wdlAfterMaiaTop` (1 доп. SF-run). Это ~+20-30 доп. SF-runs на партию, незначительно.

Sub-variation от Maia-альтернативы (длина 1..4 полухода) — те же ~3.5 SF-runs в среднем. Sub-variations добавляются примерно к 25-35% полуходов = ~20-28 sub-variations × 3.5 = ~80-100 SF-runs. С кэшем (transposition hit ~30-50%) — 40-70. **~8-15 с доп.**

### 7.3. Итоговый бюджет

Worst-case ~+50-60% времени поверх ADR-100 §7 (за счёт однородного покрытия — обработка вдвое большего числа полуходов чем в раннем варианте «только соперник»). p50 на партию 80 полуходов = **~70-110 с** (вместо ~25-40 с в ADR-100). На стандартной 40-полуходной — ~35-55 с.

Soft cap §5 (`MAX_TOTAL_VARIATIONS_PER_MOVE = 12` с приоритетом по `maiaTopProb desc`) защищает от взрывного роста на позициях с большим числом «человеческих» альтернатив.

Прогресс-модалка (ADR-100 §6) обрабатывает это штатно — пользователь видит «N из M», cancel работает.

## 8. Соответствие precision-метрике

Все WDL-операции — через те же helpers, что использует `classifyMove`:
- `expectedScoreFromWdl` для стабилизации.
- `wdlSigned` для decided check.
- `invertWdl` для POV-смены при шаге через ответ соперника.
- `classifyMove` для критерия Maia-альтернативы.

Сантипешковых порогов нигде не добавляется. Регрессионный тест (KS-3607 §4) сохраняется.

## 9. Декомпозиция

### Этап (frontend, 1.5-2 дня) — ADR-101 в `buildAnnotations`

**KS-XXXX: Variations с переменной длиной + расширенное покрытие Maia.**

1. Утилита `apps/web/src/lib/review/buildStabilizedLine.ts`:
   - Сигнатура `buildStabilizedLine(startFen, firstMoveUci, engineGetBestLine, maxLength?)` → `string[]` (UCI).
   - Реализация §3 псевдокода с константами §3.3.
   - Зависимость `chess.js` для `applyMoveToFen` и `isCheckOrCapture` (через флаги SAN).
   - Unit-тесты:
     - стабилизация наступает после 2 ровных пар → линия = 4 полухода.
     - decided position (`|wdlSigned| > 0.95`) → линия обрывается с фиксацией последнего best.
     - forcing-move (check/capture) → продлевается ещё на 1.
     - mate-line → короткая линия с мат-ходом.
     - cap на MAX_LINE_LENGTH_PLIES = 8 уважается даже без стабилизации.

2. Утилита `apps/web/src/lib/review/moveFlags.ts`:
   - `isCheckOrCapture(fen, uci): boolean` через chess.js.
   - Unit-тесты на типичные позиции.

3. Доработка `apps/web/src/lib/review/buildAnnotations.ts`:
   - Заменить генерацию `subline: input.sfBestPv.slice(1, 3)` (§4.1 ADR-100) на `subline: await buildStabilizedLine(fenAfterFirstMove, firstMove, engineGetBestLine).slice(1)`.
   - Заменить §4.2 Maia-trap: вместо одного полухода — `buildStabilizedLine` с cap = 4 (sub-variation cap).
   - Новое §4.2: для **каждого** полухода (без различения сторон) — и в основной партии, и внутри построенных variations — проверка `maiaTop !== sfBest && classify(maiaAlt) !== 'best' && maiaProb >= 0.20` → добавить sub-variation через `buildStabilizedLine`. Реализация — обходим основную партию и каждую построенную линию, обогащаем variations'ами.
   - Лимиты §5: `MAX_NESTED_DEPTH=4`, `MAX_TOTAL_VARIATIONS_PER_MOVE=12`, soft-cap с приоритетом по `maiaTopProb desc`.

4. Доработка оркестратора (`reviewWorker.ts` / `useGameReview.ts`):
   - Понизить depth для variation-building до `LINE_DEPTH = 14` (через `setOption('UCI_LimitStrength')` нет — просто отдельный `go depth 14`). Для main-NAG классификации depth остаётся 18.
   - Кэш `Map<fen, { bestUci, wdlAfter, sfBestPv }>` для positions в variations (avoid redundant SF-runs на transposition'ах).
   - При cancel — прерывание всех текущих SF/Maia инференсов, частичные результаты отбрасываются.

5. Тесты (Vitest):
   - `buildStabilizedLine.test.ts` — см. п.1.
   - `moveFlags.test.ts` — см. п.2.
   - `buildAnnotations.test.ts` дополнить:
     - вариант с переменной длиной (mock engineGetBestLine).
     - Maia-альтернатива добавляется на любом полуходе (без различения сторон) при разных classification.
     - лимит `MAX_TOTAL_VARIATIONS_PER_MOVE` уважается.
     - симметрия: тот же polyhod в позициях с белыми и чёрными на ходу обрабатывается единообразно.
   - Regression: precision-consistency (KS-3607 §4) не сломан.

**Acceptance:**
- Variation в дубле имеет переменную длину (1-8 полуходов), стабилизирующуюся по WDL.
- На любом полуходе линии (без различения сторон) где Maia top-1 ≠ SF best и классифицируется не как best — добавляется sub-variation с Maia-альтернативой и её продолжением (через тот же `buildStabilizedLine`).
- Лимиты §5 соблюдаются (max nested depth, max variations per node, soft cap per move).
- p50 анализа партии (40 полуходов) укладывается в ~35-55 с, p95 (80 полуходов) — в ~70-110 с.
- Регрессионный тест с precision проходит.
- Vitest зелёный.

### Backend / Layout — без изменений

- Backend: endpoint `POST /analyses/:id/duplicate-annotated` (KS-3602) уже принимает любой `pgn`. Длина variations не влияет.
- Layout: модалка прогресса (KS-3604) уже учитывает variable time через прогресс-бар. Стилей менять не нужно.

## 10. Что НЕ входит

- Разделение «свои/чужие» ходы в разборе (см. §4.0 — однородный фрейм, KS-3609 won't fix).
- Сложная forcing-move heuristic через MultiPV (см. §3.4, простая через chess.js достаточно).
- Cross-engine quality tagging (trap-blunder подсветка) — отдельная future-фича.
- Auto-комментарии текстом («maia favourite», «punishing move») — отложено.
- IndexedDB-кэш transpositions между разными запусками — только in-memory cache в рамках одного review.
- Adaptive depth (понижение для тяжёлых позиций) — пока depth константный.

## 11. Резюме

Variations переходят с фиксированной длины 3 полухода на **переменную длину по WDL-стабилизации**: линия растёт по best-ходам обеих сторон, пока `expectedScore` не стабилизировался 2 хода подряд (порог 3%), или позиция не decided (`|wdlSigned| > 0.95`), или достигнут cap 8 полуходов. Forcing-move heuristic (check/capture) продлевает на 1.

Maia top-1 теперь добавляется как sub-variation **на каждом полуходе** любой линии (включая основную партию) единообразно, без разделения «свой/чужой» — когда maiaTop ≠ sfBest и не классифицируется как `best` (порог prob = 0.20). Sub-variation тоже строится через тот же алгоритм стабилизации с cap = 4.

Лимиты: max 4 уровня вложенности, max 12 variations на ход (soft cap с приоритетом по Maia prob). Стоимость +50-60% к ADR-100 §7 бюджету; p50 на 80-полуходную партию ~70-110 с — приемлемо.

Открытых вопросов нет.
