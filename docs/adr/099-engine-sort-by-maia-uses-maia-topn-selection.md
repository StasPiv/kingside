# ADR-099. Sort=maia: выборка top-N от Maia + Stockfish evaluation через `searchmoves`

Статус: предложен (KS-3591 продолжение).
Дата: 2026-06-02.
Расширяет / частично пересматривает: ADR-098 (контрол сортировки остаётся, **набор ходов в режиме `sortMode='maia'`** пересматривается).
Связано: ADR-097 (Maia inline), KS-3593 (frontend sort), KS-3594 (layout), KS-3588 (`useMaiaAnalysis` `getProbability`).

## 1. Контекст и причина пересмотра

ADR-098 ввёл переключатель `sortMode ∈ {stockfish, maia}` с предположением: «состав линий не меняется, sort только переупорядочивает top-N от Stockfish». Дыра, которую обнаружил пользователь:

- Stockfish при `MultiPV=3` выдаёт 3 объективно лучших по eval хода.
- Maia-вероятность считается для **всех** легальных ходов, но рендерится только для тех, что попали в Stockfish-набор.
- Если человеческий top-1 (например, `h2h3` с probability 38%) объективно слабее третьего Stockfish-хода — он **не попадает в MultiPV=3** и в режиме `sort=maia` остаётся **невидимым**. Пользователь видит «среди топ-3 Stockfish самый человеческий — вот этот», но не видит «самый человеческий вообще».

Это противоречит цели режима «sort by Maia»: пользователь ожидает увидеть «5 наиболее вероятных ходов человека ELO=X» (с eval), а не «5 объективно лучших ходов, переставленных по человеческой вероятности».

## 2. Решение (краткое)

В режиме `sortMode='maia'` **набор анализируемых ходов выбирает Maia, а не Stockfish**:

1. Maia считает `policy` для всех легальных ходов под выбранным ELO.
2. Берём top-`MultiPV` ходов по probability desc.
3. Stockfish получает команду `go searchmoves <m1> <m2> … <mN> multipv N depth …` — eval'ит **только** эти N ходов.
4. Результат — N линий (по одной на каждый указанный ход) с eval от Stockfish и prob от Maia. Рендер в порядке prob desc.

В режиме `sortMode='stockfish'` поведение **без изменений**: обычный `go depth N` с `MultiPV=N`, Stockfish сам выбирает top-N лучших ходов.

Выбор подхода — **#2 из предложенных координатором** (`go searchmoves`). Подходы #1 (поднять MultiPV до 10) и #3 (гибрид с `(--)`) отвергнуты — см. §3.

## 3. Сравнение подходов

|  | **#1. Поднять MultiPV до большого N + пересечение** | **#2. `go searchmoves <Maia top-N>` (выбран)** | **#3. Гибрид: SF top-N + Maia-only ходы с `(--)`** | **#4. Параллельные `go` для Maia-only ходов** |
|---|---|---|---|---|
| Покрытие Maia top-N | не гарантировано (даже N=10 может не включить нужный) | **100%** | частичное (Maia-only ходы без eval) | 100% |
| Stockfish CPU | **высокая** (multipv=10 на WASM ~3-5× медленнее) | **та же что MultiPV=N** (Stockfish считает столько же линий, просто root-search ограничен) | как сейчас (multipv=N) | очень высокая (N+M `go` запросов) |
| Пользовательский MultiPV | перетирается невидимо, надо восстанавливать | переиспользуется как «сколько Maia top брать» | без изменений | сложно совмещать |
| Изменения в `useStockfish` | минимальные (изменить значение setoption) | средние (новый prop `searchmoves`, изменение `buildGoCommand`) | нет | большие (queue нескольких go) |
| Изменения в external engine bridge | минимальные | средние (smoke на поддержку searchmoves в bridge) | нет | большие |
| UX-завершённость | пользователь видит N линий с eval, но иногда не самые человеческие | пользователь видит N самых человеческих с eval | пользователь видит micro-set с прочерками — выглядит как баг | то же что #2 |
| Время инференса (на смену FEN) | SF медленнее на 3-5× | то же что обычный multipv=N | то же | сильно больше |
| Migration в KS-3593 | малая (только setoption) | средняя (новый flow для searchmoves) | малая | большая |

**Отбрасываем #1** — невидимая мутация пользовательского MultiPV + не гарантирует покрытия + лишний CPU. Если хочется «сразу видеть и SF top и Maia top» — это другая фича (см. §10 not-in-scope).

**Отбрасываем #3** — `(--)` в eval-колонке делает половину строк бесполезными. Пользователь не сможет понять «насколько плох ход» и не примет решение.

**Отбрасываем #4** — N отдельных `go` запросов = N циклов init/cancel/depth. Sequential — медленно (~N×400 мс), параллельных Stockfish-инстансов у нас нет.

**Выбираем #2** — `go searchmoves`. Это стандартный UCI-механизм, поддерживается ВСЕМИ Stockfish-сборками (включая WASM 16/17/18). Один `go`, N линий, никакого оверхеда против обычного multipv. Единственная цена — slightly больше кода в hook'е.

## 4. UX и UI

### 4.1. Что показывает пользователь

```
sortMode='stockfish' (default):
┌─ Engine ─── [⚙] [Lines − 3 +] [Maia 1500 ▾] [Stop] ▾ ─┐
│   Eval ↓     Maia%      Line                          │
│   +0.32      (45.0%)    e2e4 e7e5 g1f3 …               │ ← SF top-3, eval desc
│   +0.18      (22.1%)    d2d4 d7d5 c2c4 …               │
│   -0.05      ( 8.5%)    g1f3 g8f6 c2c4 …               │
└──────────────────────────────────────────────────────────┘

sortMode='maia':
┌─ Engine ─── [⚙] [Lines − 3 +] [Maia 1500 ▾] [Stop] ▾ ─┐
│   Eval       Maia% ↓    Line                          │
│   -0.42      (38.0%)    h2h3 …                         │ ← Maia top-3, prob desc
│   +0.32      (24.5%)    e2e4 e7e5 …                    │
│   +0.18      (22.1%)    d2d4 d7d5 …                    │
└──────────────────────────────────────────────────────────┘
```

В обоих режимах — `MultiPV=3` (пользовательский). Меняется **набор ходов**, не количество.

### 4.2. Eval недоступен (Stockfish ещё не посчитал)

При смене позиции / mode / MultiPV / ELO — Stockfish стартует с нуля. До прихода первой `info`-строки для каждого хода в `searchmoves`-наборе:

- В Eval-колонке для этой линии — `…` (приглушённый dot-dot-dot) или `--`.
- Через ~200-800 мс (зависит от depth) eval приходит, заменяется численным значением.

То же поведение что сейчас для обычного multipv: до depth 1 линий не видно вообще; добавляем для каждой Maia top-N плейсхолдер-row сразу при переключении в mode=maia.

### 4.3. Eval недоступен (Maia ещё не пришла)

При смене FEN/ELO Maia пересчитывает `policy` ~250-500 мс. Пока новый `policyByMove` не пришёл:

- Mode=maia не может определить набор ходов для `searchmoves`.
- **Поведение:** оставляем предыдущий набор линий (если он был для прошлого FEN). Старые eval помечаются `--stale` (через KS-3588 modifier). Когда Maia пришла → новый набор → новый `searchmoves` → новые eval.
- Альтернатива — на полсекунды показывать пустой список → отвергнуто, это «прыжки» в UI.

### 4.4. Maia ошибка (`status='error'`)

`policyByMove` пустой постоянно. Mode=maia не может выбрать набор ходов.

**Fallback** (как уже зашито в KS-3593 §4.5 ADR-098): mode=maia де-факто рендерит как mode=stockfish (Stockfish top-N с eval desc, prob колонка `(--)`). Кнопка `Maia%` остаётся кликабельной, tooltip «Maia недоступна — порядок Stockfish».

В новом дизайне это означает: пока Maia не пришла, **не отправляем `searchmoves`**. Используем обычный `go depth N` с `multipv N` (SF top-N).

### 4.5. User-control MultiPV

`MultiPV=N` — единый user-control в обоих режимах:
- mode=stockfish: «top-N лучших по eval».
- mode=maia: «top-N самых вероятных у человека».

Изменение MultiPV → перезапуск анализа с новым N в обоих режимах. Пользователь видит знакомое поведение «больше линий → больше ходов в списке».

Edge case: Maia вернула меньше N ходов с `probability > 0` (теоретически возможно при огромных позициях с нулевой массой на хвосте, на практике — нет). Решение: брать всё что есть, не дотягивать. Если набор пуст — fallback на mode=stockfish (см. §4.4).

## 5. Технические детали

### 5.1. UCI команда

```
position fen <FEN>
go searchmoves e2e4 d2d4 g1f3 h2h3 multipv 4 depth 24
```

Stockfish ответит `info depth … multipv 1 score cp +32 pv e2e4 e7e5 …`, `info depth … multipv 2 …` и так далее — по одной info-строке на каждый ход из `searchmoves`. Лимит — то же `multipv` значение.

Поддержка:
- **WASM Stockfish 16/17/18:** ✅ полностью.
- **External engine bridge** (`useExternalEngine`): требует smoke. UCI-стандарт — да, но конкретная реализация bridge может фильтровать команды. Заводим как риск (см. §7).

### 5.2. Изменения в `useStockfish` / `useEngine`

Текущая сигнатура `useEngine`:

```ts
useEngine({
  source: 'wasm' | 'external',
  externalConfig,
  depth,
  multiPv,
  infinite,
  autoStart,
});
```

Добавляем опциональный prop:

```ts
useEngine({
  ...
  searchmoves?: string[] | null,  // UCI ходы; если задан — go searchmoves ..., иначе обычный go
});
```

Изменения в `buildGoCommand` (`useStockfish.ts`):

```ts
function buildGoCommand(
  depth: number,
  infinite: boolean,
  movetime: number | undefined,
  searchmoves: string[] | null | undefined,  // новый параметр
): string {
  const moves = searchmoves && searchmoves.length > 0
    ? ` searchmoves ${searchmoves.join(' ')}`
    : '';
  if (typeof movetime === 'number' && movetime > 0) {
    return `go movetime ${movetime}${moves}`;
  }
  if (infinite) return `go infinite${moves}`;
  return `go depth ${depth}${moves}`;
}
```

При смене `searchmoves` (через memo + deps в эффекте) — `stop` + `go` с новой командой (тот же паттерн что и при смене MultiPV).

### 5.3. Изменения в `useExternalEngine`

Аналогично — прокидываем `searchmoves` в команду `go`. Если bridge не поддерживает — деградируем для external до режима «как mode=stockfish» (см. §7 риски).

### 5.4. Composition в `AnalysisSidebar`

```ts
const maia = useMaiaAnalysis(currentFen);
const { sortMode, setSortMode } = useEngineSortMode();

// Набор searchmoves только в режиме maia + когда Maia дала данные.
const maiaTopMoves = useMemo(() => {
  if (sortMode !== 'maia') return null;
  if (maia.status !== 'ready') return null;          // wait или error → null
  const allMoves = maia.getAllMoves?.();              // нужно расширить API hook'а
  if (!allMoves || allMoves.length === 0) return null;
  return allMoves
    .slice()
    .sort((a, b) => b.probability - a.probability)
    .slice(0, multiPv)
    .map((m) => m.move);
}, [sortMode, maia.status, maia.policyByMove, multiPv]);

const engine = useEngine({
  source: ...,
  depth,
  multiPv,
  searchmoves: maiaTopMoves,  // null → обычный go (mode=stockfish или Maia не готова)
});
```

Расширение `useMaiaAnalysis` API:

```ts
{
  // существующее:
  elo, setElo, status, getProbability,
  // новое:
  getAllMoves(): { move: string; probability: number }[] | undefined,
  // или прямой доступ к policyByMove
  policyByMove: Record<string, number>,
}
```

Рекомендую отдать `policyByMove` напрямую — он уже там лежит, не плодим API.

### 5.5. Изменения в `sortLines` util (KS-3593)

Утилита `sortLines` **остаётся**, но её роль сужается:
- mode=stockfish: SF возвращает уже отсортированный набор (по eval desc) — sortLines применяется для tiebreak-стабильности.
- mode=maia: SF возвращает N линий в `multipv 1..N` порядке (соответствует порядку в `searchmoves`-команде, который у нас prob desc) — sortLines не обязателен, но безопасен.

То есть `sortLines` теперь — финальная страховка от race'ов / порядка info-строк. По существу всё больше похоже на простой `.sort()` по prob → eval → multipv.

### 5.6. Производительность

- mode=stockfish: без изменений.
- mode=maia: тот же `multipv N` для SF (одинаковая нагрузка), плюс Maia inference (один прогон ~300-500 мс в воркере).
- Дополнительно при смене mode/FEN/ELO/MultiPV — один SF `stop` + `go` с новой командой. Уже делается сейчас при смене MultiPV.
- Cold-switch mode (`stockfish → maia` или обратно): пользователь увидит ~300-500 мс пустого/устаревшего списка пока SF переcчитывает. Acceptable.

## 6. Поведение mode=stockfish — без изменений

Подтверждение: в `sortMode='stockfish'` UCI-команда такая же как сейчас (`go depth N` с `multipv N`, без `searchmoves`). KS-3593 sortLines в этом режиме применяется только для tiebreak-стабильности и совместимости с tiebreak логикой.

## 7. Риски

| # | Риск | Вероятность | Импакт | Mitigation |
|---|---|---|---|---|
| 1 | External engine bridge не поддерживает `searchmoves` | средне | средне | Smoke в Этапе R перед интеграцией. Если не поддерживает — для external деградировать в mode=maia до режима «как stockfish» с tooltip «Maia-режим недоступен для внешнего движка». |
| 2 | Race: пользователь быстро переключает mode → flood `stop`/`go` | средне | низко | Debounce 250 мс на смену `searchmoves` (как сейчас на MultiPV в `useEngine.ts:ENGINE_OPTION_DEBOUNCE_MS`). |
| 3 | Maia вернула набор с дублями / нелегальными ходами | низко | низко | `clampMultiPvToLegalMoves` уже фильтрует. Дополнительно `validateUciOnFen(fen, uci)` через chess.js перед `searchmoves`. |
| 4 | Пустой `searchmoves` (Maia вернула пустой policy для terminal-позиции) | низко | низко | null → fallback на mode=stockfish. |
| 5 | Маленький `MultiPV=1` + mode=maia — пользователь видит ровно один ход, теряет смысл сравнения | низко | низко | Это сознательный выбор пользователя (он мог поднять MultiPV до 3-5). Не блокируем. |
| 6 | depth=24 при mode=maia дольше начинает «отдавать» линии — у SF меньше альфа-бета отсечений в `searchmoves` | средне | низко | По данным Stockfish — searchmoves не сильно влияет на speed (отсечения работают внутри указанных корневых ходов). На практике — измерить в Этапе R. Если деградация >50% — снизить depth для mode=maia до 20. |
| 7 | KS-3593 (frontend sort) уже в work / merged — нужна правка/ревёрт | средне | низко | Sort-DOM (заголовки колонок) и `useEngineSortMode` остаются. `sortLines` упрощается. Меняется только источник набора линий и `useEngine` принимает новый prop. |

## 8. Migration текущих задач

### 8.1. KS-3593 (frontend sort)

- **Hook `useEngineSortMode`** — остаётся как есть (persisted state).
- **Утилита `sortLines`** — остаётся, но логика чуть другая:
  - mode=stockfish: sort по eval desc (как было) — нужна для tiebreak.
  - mode=maia: sort по prob desc (как было) — но входной массив **уже отфильтрован Maia top-N**, дубли с SF top-N отсутствуют. Sort стабилизирует порядок.
- **DOM-row `.stockfish-lines-header`** — остаётся.
- **Интеграция в `AnalysisSidebar`** — добавляется логика выборки `maiaTopMoves` и проброс в `useEngine({ searchmoves })`.
- **Тесты** — добавить test «при mode=maia использует Maia top-N как набор», «при Maia error — fallback на SF top-N (searchmoves=null)».

Объём дополнительных правок: ~0.5 дня frontend поверх KS-3593.

### 8.2. KS-3594 (layout)

**Без изменений.** Стили заголовков колонок и колонок данных продолжают работать. Eval-плейсхолдер `…` или `--` пока SF не пришёл — может потребовать одного дополнительного стиля `.stockfish-eval--pending`, оценить при реализации.

### 8.3. Координация

Если KS-3593 уже мерджит в main — лучше:
- Завершить KS-3593 как есть (sort переупорядочивает текущий набор) — это работающий MVP без покрытия Maia-only ходов.
- Параллельно начать новый тикет «расширение sort=maia: выборка от Maia + searchmoves» — он поверх KS-3593.

Если KS-3593 не начат — оптимальнее объединить (см. декомпозицию §9).

## 9. Декомпозиция

### Этап R (architect/backend, 0.5 дня) — research/smoke

**KS-XXXX: Smoke `go searchmoves` для wasm Stockfish и external bridge.**

1. WASM Stockfish: локальный browser-тест — отправить `go searchmoves e2e4 d2d4 multipv 2 depth 10` после `position startpos`, проверить что приходят ровно 2 `info`-строки с eval по указанным ходам.
2. External engine bridge (если у нас есть прод-инстанс): тот же smoke через bridge UI или прямой WebSocket. Зафиксировать поддерживается ли.
3. Замер времени: depth 24 с `searchmoves N=3` vs `multipv 3` — есть ли регрессия по скорости.
4. Отчёт в комментарии к KS-XXXX. Решение по фоллбэку для external (если не поддерживается).

**Acceptance:** есть однозначный ответ да/нет по обоим engine'ам.

### Этап F1 (frontend, 0.5-1 день) — useEngine `searchmoves` prop

**KS-XXXX: `useEngine` / `useStockfish` / `useExternalEngine` — опциональный `searchmoves: string[] | null` prop.**

1. `useStockfish.ts`: `buildGoCommand` принимает `searchmoves`, добавляет к команде. Effect на смену `searchmoves` — `stop` + `go` (как для MultiPV).
2. `useExternalEngine.ts`: то же (если smoke в R показал поддержку; иначе skip с warning).
3. `useEngine.ts`: пробрасывает `searchmoves` дальше.
4. Debounce 250 мс на смену `searchmoves` (тот же `ENGINE_OPTION_DEBOUNCE_MS`).
5. Тесты: unit на `buildGoCommand`, integration на `useStockfish` (mock worker) — смена `searchmoves` приводит к новой UCI-команде.

**Acceptance:** `useEngine({ searchmoves: ['e2e4', 'd2d4'] })` приводит к `go depth N searchmoves e2e4 d2d4 multipv 2 ...`. Тесты зелёные.

### Этап F2 (frontend, 0.5 дня) — интеграция в AnalysisSidebar

**KS-XXXX (или дополнение к KS-3593): использовать Maia top-N как источник `searchmoves` в mode=maia.**

1. Расширить `useMaiaAnalysis` API: вернуть `policyByMove: Record<string, number>` напрямую (не ломая `getProbability`).
2. В `AnalysisSidebar.tsx`:
   - `const maiaTopMoves = useMemo(...)` — выборка top-`multiPv` ходов от Maia (см. §5.4).
   - `useEngine({ ..., searchmoves: maiaTopMoves })`.
3. Обновить тесты: snapshot mode=maia с Maia ready → searchmoves передан. mode=maia + Maia error → searchmoves=null, fallback на обычный go.
4. Eval-плейсхолдер `--` пока SF не пришёл (можно через существующий `formatEval` для пустой линии).

**Acceptance:** при `sortMode='maia'` ходы в линиях — Maia top-N (не пересечение с SF top-N). При `maia.status === 'error'` — список как mode=stockfish.

### Этап L (layout, опционально, 0.5 дня)

**KS-XXXX (если потребуется): стиль `.stockfish-eval--pending` для плейсхолдера `--` пока SF eval не пришёл.**

Маленький, может быть присоединён к KS-3594 или к F2.

## 10. Открытые вопросы к пользователю

1. **External engine bridge** (если используется кем-то в проде) — кейс «он не поддерживает searchmoves»: деградируем mode=maia до «SF top-N с tooltip» или принципиально требуем поддержку? Дефолт: деградируем с tooltip.
2. **Что показывать пока SF ещё не отдал eval** — `--`, `...`, спиннер, или вообще не рендерим строку? Дефолт: `--` приглушённым (минимум визуального шума).
3. **`go searchmoves` + ELO/profile-driven default** — никаких изменений в init-логике ELO (профиль → localStorage → 1500). Подтвердить.
4. **MultiPV=1 + mode=maia** — пользователь видит только 1 строку, теряется сравнение. Допустить и оставить как «осознанный выбор» или показать tooltip «MultiPV=1 в режиме Maia малоинформативен, увеличьте до 3+»? Дефолт: оставить без подсказки.
5. **Замер speed-деградации (Этап R пункт 3):** если SF при `searchmoves` медленнее на >30% — снижать depth для mode=maia? Дефолт: не снижать, измерить и решить по факту.
6. **Сейчас KS-3593/3594 в каком статусе?** Если уже мерджи в main — нужен ли merge-этап (новый тикет поверх) или подождать до запуска и сделать всё одним релизом? (Это вопрос координации, не дизайна.)

## 11. Что НЕ входит

- Параллельный показ «SF top-N + Maia top-N» как двух колонок / двух наборов — отдельная фича (если когда-нибудь понадобится).
- `searchmoves` для других целей (puzzle, лесон) — только engine-panel `/analysis`.
- Изменение pre-warm Maia (это уже работает).
- Цветовая разметка blunder-trap (Maia high + SF low) — future (ADR-097 §9).
- Замена pull-model на push-model для engine info — не нужно.

## 12. Резюме

В режиме `sortMode='maia'` набор анализируемых ходов выбирает **Maia** (top-`MultiPV` по policy), а Stockfish получает eval для них через UCI `go searchmoves`. Это закрывает дыру «человеческий top-1 невидим если не в SF top-N» без значимых costs: то же количество SF-линий, тот же CPU, стандартный UCI-механизм.

`useEngine` получает опциональный prop `searchmoves`. `useMaiaAnalysis` расширяется доступом к `policyByMove`. `sortLines` упрощается (входной набор уже корректен). KS-3594 (layout) — без изменений. KS-3593 (frontend) — финализируется + поверх делается интеграция.

Главный риск — поддержка `searchmoves` в external engine bridge. Решается smoke-этапом R перед F1/F2; при отсутствии поддержки — деградация mode=maia до «SF top-N» для external (wasm работает корректно).
