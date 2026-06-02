# ADR-097. Maia inline в Stockfish-линиях: вероятность рядом с оценкой

Статус: предложен (KS-3587, продолжение KS-3582/3584/3585/3586).
Дата: 2026-06-02.
Supersedes (частично): ADR-096 — заменяет основной режим показа Maia («отдельная подсекция в engine-panel»). ADR-096 §6 (perf), §8.4-8.5 (ELO range, localStorage), §11 (нон-цели) и общая мотивация остаются в силе.
Связано: ADR-073 (mobile bottom-sheet), KS-3577 (Maia infrastructure), KS-3579 (кнопка), KS-3584/3585/3586 (текущие задачи реализации/ревёрта).

## 1. Контекст и причина пересмотра

ADR-096 принял решение рендерить Maia **отдельной подсекцией** под Stockfish-блоком в `engine-panel` с собственным списком top-5 ходов и селектором ELO. Прототип реализован в KS-3584 (DOM) + KS-3585 (CSS), результат:

- **Desktop** — engine-panel вытянулся вертикально, Maia визуально «прилеплена» снизу (см. KS-3586).
- **Mobile** — таб «Движок» суммарно содержит: метаданные движка + контролы (multipv/⚙/Start) + 3 строки Stockfish + шапка Maia (заголовок + ELO-селект) + 5 строк Maia + кнопка KS-3579. Не помещается ни в одну snap-точку bottom-sheet (ADR-073). KS-3587 завели на «как чинить mobile UX».
- **Семантически** — у Stockfish и Maia **разный набор «top-N» ходов**: Maia top-5 человеческих ≠ Stockfish top-5 объективно лучших. Пользователь видит два списка с разными ходами и должен глазами искать пересечение «вот этот e2-e4 в Stockfish и в Maia — одно и то же».

Пользователь предложил инвертировать связку: показывать **Maia-вероятность каждого Stockfish-кандидата в скобках после CP-оценки**. Получаем компактную форму:

```
+0.32 (45.0%)  1. e4 e5 2. Nf3 Nc6 …
+0.18 (22.1%)  1. d4 d5 2. c4 e6 …
-0.05 (8.5%)   1. Nf3 Nf6 …
```

`(45.0%)` — вероятность, что человек выбранного ELO сыграет **первый ход этой линии** (по версии Maia). Семантика естественная: «насколько объективно силён ход × насколько часто его играют люди такого уровня».

## 2. Решение (краткое)

Принимаем **inline-вероятности**:

1. Каждая Stockfish-линия в `engine-panel` дополняется `(XX.X%)` после блока eval. Источник — `policy[firstMoveUci]` от Maia для текущего FEN под выбранным ELO.
2. Селектор ELO — **в шапке engine-panel** (рядом с MultiPV-контролами и `⚙`).
3. Отдельная Maia-секция (`MaiaAnalysisSection` из KS-3584) **удаляется**. Mobile-задача KS-3587 (отдельная вкладка / аккордеон / новый snap) **становится неактуальной**.
4. Кнопка KS-3579 («Получить рейтинг позиции») **остаётся как есть** — она решает другую задачу (батч 14 ELO + поиск минимального ELO совпадения).
5. Селектор ELO и его значение хранятся в localStorage (ADR-096 §8.5).
6. Один Maia-инференс на FEN (debounce 250 мс), результат — мапа `uci → probability`, рендер вытаскивает probability по первому ходу каждой PV.

Mobile-проблема (KS-3587) решается автоматически: новой секции нет, движок занимает столько же места что и до KS-3584. Только в шапке появляется ещё один control (ELO-селект).

## 3. UX-сценарий

### 3.1. Layout engine-panel (desktop + mobile, единая структура)

Текстовый макет «как стало»:

```
┌─ Engine ──────── [⚙] [Lines − 3 +] [Maia 1500 ▾] [Stop] ▾ ─┐
│ ▸ Stockfish (depth 24, wasm)                                │
│   +0.32 (45.0%) │ e2e4 e7e5 g1f3 b8c6 …                     │
│   +0.18 (22.1%) │ d2d4 d7d5 c2c4 e7e6 …                     │
│   -0.05 ( 8.5%) │ g1f3 g8f6 c2c4 …                          │
│                                                             │
│ [Получить рейтинг позиции]   ← KS-3579 как раньше           │
└─────────────────────────────────────────────────────────────┘
```

Отличия от текущего ADR-096 layout:
- Нет блока `Human moves (Maia)` под Stockfish-линиями — удалён.
- В шапке появляется `[Maia 1500 ▾]` — селект ELO (label «Maia», значение — текущий ELO).
- В каждой Stockfish-линии после eval — `(XX.X%)` через пробел, моноширинно (выравнивание колонкой).

### 3.2. Сценарии пользователя

**A. Просмотр позиции в стартовом состоянии.**
1. `/analysis` открывается, Stockfish стартует. Engine-panel шапка содержит ELO-селект (default — из профиля, fallback localStorage, fallback 1500).
2. Stockfish-линии рендерятся как сейчас — пока Maia не загрузилась, `(--%)` или просто пустой `(…)` placeholder в скобках.
3. Maia догружается в фоне (lazy ONNX ~3-5 МБ). Первый прогон: `policy` приходит → `(45.0%)` подставляется в каждую линию.

**B. Смена FEN (next/prev/прыжок по дереву ходов).**
1. Stockfish получает новый FEN → новые PV (как сейчас).
2. Maia — debounce 250 мс → один прогон `predictMoves(fen, elo, elo)` → новая `policy`.
3. Пока новые цифры в полёте — старые `(X%)` рендерятся приглушённо (opacity 0.5) на новых SF-линиях. Полная синхронизация после прихода Maia-результата (~0.3-0.5 с).

**C. Смена ELO.**
1. Пользователь выбирает в селекте 1900 → localStorage записывается → триггер пересчёта.
2. SF-линии те же, `(X%)` обновляются после прогона.

**D. Maia не загрузилась / ошибка.**
1. SF-линии рендерятся без скобок (или с `(—)`). Inline-tooltip / маленькая иконка-предупреждение в шапке возле ELO-селекта: «Maia недоступна» + retry.
2. Stockfish-функционал не страдает.

**E. Mobile.**
1. Та же структура, та же шапка с ELO-селектом (контролы шапки уже оборачиваются на узких экранах через `flex-wrap`).
2. Никакой новой вкладки / snap-уровня / аккордеона. Bottom-sheet ADR-073 работает как до KS-3584.

### 3.3. Что с «ходами Maia, которых нет у Stockfish»

Эти ходы **не показываем в основном режиме**. Аргументы:
- Если ход слабый по оценке Stockfish — он либо есть в Multi-PV (например, при `MultiPV=5`), либо отброшен SF как явно проигрывающий. Если пользователь хочет увидеть «что часто играют не-best-ходом» — увеличивает MultiPV до 5/7/10, видит больше линий и их probability.
- Для глубокого human-анализа есть KS-3579 (батч-сценарий) и future-фичи (см. §7).
- Это сильно упрощает MVP и убирает источник информационного шума.

## 4. Технические детали

### 4.1. Источник данных

Maia уже возвращает `policy: { move: string, probability: number }[]` — распределение по **всем легальным ходам** позиции (`apps/web/src/lib/maia/engine.ts:153`). Нужен один прогон `predictMoves(fen, elo, elo)` на FEN.

Преобразование в мапу:
```ts
const policyByMove: Record<string, number> =
  Object.fromEntries(policy.map((m) => [m.move, m.probability]));
```

Рендер:
```ts
const firstUci = extractBestUci(line.pv); // существующий хелпер
const p = policyByMove[firstUci];          // undefined если Maia ещё не пришла
const probLabel = p == null ? '' : `(${(p * 100).toFixed(1)}%)`;
```

### 4.2. Hook

Существующий `useMaiaAnalysis` из KS-3584 **переработать** (не выбрасывать целиком):
- State: `{ elo, policyByMove, status, error, setElo }`.
- Эффект на смену `fen`/`elo` с debounce 250 мс → `predictMoves(fen, elo, elo)` → `policyByMove`.
- Возврат: `{ getProbability(uci) → number | undefined, elo, setElo, status }`.

То есть удаляем «список top-5», оставляем механику инференса + lookup'а. Это меньше работы чем писать с нуля, и KS-3584 не выбрасывается полностью.

### 4.3. UI-вставка

В `pages/analysis/AnalysisSidebar.tsx`:

1. Удалить `<MaiaAnalysisSection>` (две инстанциации — desktop и mobile).
2. В шапке engine-panel — рядом с `engine-multipv-controls` и `engine-settings-btn` добавить `<MaiaEloSelect value={maia.elo} onChange={maia.setElo} status={maia.status} />`.
3. В `stockfish-line` после `<span className="stockfish-eval">` добавить `<span className="stockfish-maia-prob">{probLabel}</span>`.
4. Сделать одно и то же в desktop-блоке (≈ строки 396-416) и mobile-блоке (≈ строки 613-633).

### 4.4. CSS

- Удалить из `engine.css` стили `.maia-section`, `.maia-section-*`, `.maia-line*` (вся надстройка из KS-3585).
- Добавить:
  - `.maia-elo-select` — стиль селекта в шапке panel (compact, согласован с `engine-multipv-controls`).
  - `.stockfish-maia-prob` — inline-span после eval, monospace, фиксированной ширины (~60 px), цвет `var(--c-text-secondary)`.
  - `.stockfish-maia-prob--stale` — opacity 0.5 при «в полёте».
- Темизация — через токены палитры, обе темы сразу (учёт урока KS-3581).

### 4.5. Производительность

Та же, что в ADR-096 §6: один worker-прогон на FEN, debounce 250 мс, total p50 0.5-0.75 с. Не зависит от количества SF-линий — мы только мапим уже посчитанную `policy`.

### 4.6. Когда Maia не успела к смене SF-линий

SF может прислать новые PV до того, как новый Maia-инференс закончился. Поведение:
- `getProbability(uci)` возвращает `undefined` для нового ходa, если он не был в старой `policy` (вероятно — это случай, потому что новая позиция = новые легальные ходы).
- Рендер: пустые скобки `(…)` или `(--)` со `stockfish-maia-prob--stale`.
- Через ~0.5 с приходит новая policy, цифры подставляются.

Это не баг — это честное отображение того, что Maia ещё считает. На UX не влияет: пользователь видит SF-оценки мгновенно, Maia догоняет.

## 5. Влияние на ADR-073 (mobile bottom-sheet)

**Нулевое.** Engine-tab возвращается к размеру, который был до KS-3584. Все 3 snap-точки (peek 44 px, half ~40%, full ~60%) продолжают работать как описано в ADR-073 §4. Никаких новых `data-snap` значений, никаких новых вкладок, никаких аккордеонов.

KS-3587 (отдельная вкладка / новый snap / аккордеон) — **закрывается как неактуальный**: проблема решена изменением UX-модели, а не CSS-механикой.

## 6. Migration-план (KS-3584/3585/3586)

### Что делать с уже сделанным

- **KS-3584** (frontend, DOM/hook/компонент) — частичный ревёрт:
  - Удалить `MaiaAnalysisSection.tsx` и его тесты.
  - Удалить рендер `<MaiaAnalysisSection>` в `AnalysisSidebar.tsx` (desktop + mobile).
  - **Hook `useMaiaAnalysis` оставить**, переработать API: вместо `lines: MaiaLine[]` — `getProbability(uci) → number | undefined` (см. §4.2). i18n-ключи `analysis.maia.title` удалить, остальные (`elo`/`loading`/`error`/`retry`) — оставить, добавить новые если надо для шапки.
  - Cleanup vitest'ов компонента, оставить тесты hook'а (адаптировать под новый API).

- **KS-3585** (layout, стили `.maia-section`) — полный ревёрт:
  - Удалить из `engine.css` всё что касается `.maia-section*`, `.maia-line*`. Добавить новые `.maia-elo-select` и `.stockfish-maia-prob` (см. §4.4).

- **KS-3586** (layout, desktop-fix max-height) — **отменяется как самостоятельная задача**. После ревёрта KS-3584 проблема исчезает сама собой. Если remained артефакты с `.analysis-panel-body--scroll` — почистить в рамках задачи `[B. layout]` нового цикла.

- **KS-3587** (этот тикет) — закрывается координатором сразу после принятия ADR-097.

### Сроки и риски

- Ревёрт + переделка укладывается в одну итерацию frontend (1 день) + layout (0.5 дня) — суммарно меньше чем новый цикл «как было запланировано в KS-3584/3585/3586/3587».
- Риск регрессии — низкий: удаляем недавно добавленный код, возвращаемся к layout близкому к pre-KS-3584 + одна inline-вставка.

## 7. Открытые вопросы к пользователю

1. **Формат скобок при отсутствии данных** — `(…)`, `(--)` или вообще скрывать колонку до прихода Maia? Дефолт: `(--)` (приглушённый, без layout-сдвига).
2. **Высокая цифра ≠ хороший ход.** Если Maia говорит «90% что человек сыграет h2h4», а Stockfish даёт `-1.20` — пользователь видит `(90.0%)`. Это **по-задуманию**, не аномалия: показываем «насколько человеческий ход», не «насколько хороший». Подтвердить, что не делать никакой цветовой подсветки «низкая SF + высокая Maia = blunder trap». Это интересная фича, но отдельная.
3. **«Ходы Maia, которых нет у Stockfish»** — оставляем под кнопкой KS-3579 (fallback-список от 2400 уже это даёт) или хочешь отдельный future-режим «human-only top-N»?
4. **Селект ELO** на mobile в шапке panel — он точно поместится? Я предполагаю да (контролы уже оборачиваются), но если шапка перегружена — могу предложить вынести selector в `EngineSettingsModal` (за `⚙`) как trade-off за компактность. Хочешь сразу в шапку или в модалку?
5. **Кнопка KS-3579** — переподтверди, что остаётся. (Я склоняюсь — да, она решает другую задачу.)

## 8. Декомпозиция

### Этап A — frontend (1 день)

**KS-XXXX: Maia inline в Stockfish-линиях + ELO-селект в шапке engine-panel.**

1. Переработать `useMaiaAnalysis.ts`:
   - State: `{ elo, policyByMove, status, error }`.
   - Эффект на смену `fen`/`elo` с debounce 250 мс → `predictMoves(fen, elo, elo)` → `policyByMove`.
   - Public API: `{ getProbability(uci) → number | undefined, elo, setElo, status }`.
   - Сохранить чтение ELO из профиля → localStorage → 1500.
   - Cleanup воркера при unmount.
   - Тесты адаптировать (debounce, смена elo, error path).

2. Новый компонент `apps/web/src/components/analysis/MaiaEloSelect.tsx`:
   - Props: `{ value, onChange, status }`.
   - Рендер `<select>` 1100..2400 шаг 100. Label «Maia».
   - При `status === 'error'` — маленькая иконка-предупреждение с tooltip «Maia недоступна».

3. Удалить:
   - `apps/web/src/components/analysis/MaiaAnalysisSection.tsx` + тесты.
   - Импорт и рендер `<MaiaAnalysisSection>` в `AnalysisSidebar.tsx` (desktop + mobile).
   - i18n-ключ `analysis.maia.title` (если он не используется больше).

4. Добавить в `AnalysisSidebar.tsx`:
   - В шапку desktop `analysis-panel-title-right` рядом с `engine-multipv-controls` — `<MaiaEloSelect ... />`.
   - В шапку mobile `analysis-mobile-engine-controls` — то же.
   - В рендере каждой `stockfish-line` (desktop + mobile) — `<span className="stockfish-maia-prob">{probLabel}</span>` после eval, перед PV.

5. i18n: `analysis.maia.elo` (Label «Maia»), `analysis.maia.unavailable` («Maia недоступна»), сохранить `analysis.maia.loading`/`error`/`retry` если ещё нужны.

6. Vitest: hook (`policyByMove` lookup, undefined для неизвестного uci), компонент `MaiaEloSelect`, snapshot stockfish-линии с probability.

**Acceptance:**
- В каждой Stockfish-линии после eval — `(XX.X%)` из Maia.
- ELO селект в шапке panel, дефолт из профиля.
- Смена ELO — пересчёт через ~0.5 с.
- Maia ошибка не блокирует Stockfish.
- Vitest зелёный.
- Mobile bottom-sheet ADR-073 — без регрессии.

### Этап B — layout (0.5 дня)

**KS-XXXX: Стили для inline Maia-probability и ELO-селекта.**

1. Удалить из `engine.css` всю надстройку `.maia-section*`, `.maia-line*`, `.maia-section--*` modifiers.
2. Удалить `.analysis-panel-body--scroll` модификатор если он остался только под Maia-секцию (если используется в других местах — оставить).
3. Добавить:
   - `.maia-elo-select` — compact `<select>` в шапке panel, по стилю `engine-multipv-controls` (rounded, padding, hover). Обе темы.
   - `.stockfish-maia-prob` — inline-span после eval, monospace, фиксированная ширина (~60 px), цвет `var(--c-text-secondary)`, выравнивание справа.
   - `.stockfish-maia-prob--stale` — opacity 0.5.
4. Responsive: на mobile шапка `analysis-mobile-engine-controls` уже использует `flex-wrap` — проверить что ELO-селект помещается; если нет — снизить размер или сократить label «Maia» → «M».
5. Темизация — через токены палитры, обе темы.

**Acceptance:**
- Engine-panel занимает столько же высоты что и до KS-3584 (Maia-секции нет).
- ELO-селект в шапке выглядит как родной control.
- На mobile все 3 snap-точки ADR-073 работают.
- Светлая и тёмная темы согласованы.
- Build clean.

### Этап C — закрытие старых тикетов

- KS-3586 (layout desktop-fix max-height) → координатор закрывает с пометкой «решено через ревёрт KS-3584» — отдельная работа не нужна.
- KS-3587 (этот тикет) → координатор закрывает после принятия ADR-097.
- KS-3584 / KS-3585 переоткрывать не нужно — частичный ревёрт делается в рамках Этапа A/B новых задач.

## 9. Что НЕ входит

- Cross-engine «human-blunder trap» подсветка (низкий Stockfish eval + высокая Maia probability) — future.
- Maia winProbability eval-bar — future (как в ADR-096 §10 Этап E).
- Quality grading отдельных Maia-ходов — future.
- Multi-ELO одновременно (например, две колонки `(1500%)` и `(2200%)`) — отдельная задача, обсуждаемо после MVP.
- Изменения KS-3579 кнопки — не трогаем.
- Server-side Maia — не делаем.

## 10. Резюме

Замена «отдельной Maia-секции» (ADR-096) на **inline-вероятность Maia в каждой Stockfish-линии**. Один селект ELO в шапке engine-panel, один Maia-инференс на FEN, lookup probability по первому ходу PV. Это решает три задачи одним изменением:

1. Mobile-overflow (KS-3587 закрывается без отдельной вкладки / нового snap).
2. Desktop max-height (KS-3586 решается ревёртом).
3. Семантическая ясность: пользователь видит «насколько ход объективно силён × насколько часто его играют» в одной строке, без сравнения двух разнородных списков.

Стоимость переделки — ~1.5 дня (frontend + layout), меньше чем альтернативные пути доработки текущей секции. KS-3579 кнопка остаётся как есть. Hook `useMaiaAnalysis` переиспользуется (меняется только API). Mobile UX автоматически становится корректным без изменений ADR-073.
