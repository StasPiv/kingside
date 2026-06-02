# ADR-098. Переключение сортировки Stockfish-линий: Stockfish (default) ↔ Maia

Статус: предложен (KS-3591).
Дата: 2026-06-02.
Расширяет: ADR-097 (Maia inline). Не меняет — только добавляет sort-режим к рендеру `engine-panel`.
Связано: KS-3588 (inline Maia), KS-3589 (стили), KS-3590 (фикс селекта + удаление KS-3579).

## 1. Контекст

После KS-3588 каждая `.stockfish-line` содержит inline `(XX.X%)` от Maia. Сами линии Stockfish считает в порядке `eval desc` (top-N MultiPV). Пользователь хочет переключаться между сортировкой по Stockfish и по Maia-вероятности, чтобы быстро смотреть «что наиболее популярно у людей моего ELO» без перебора глазами.

Состав линий **не меняется** — это всё те же top-N от Stockfish. Меняется только порядок отображения.

## 2. Решение (краткое)

1. **Контрол:** кликабельные заголовки колонок над списком линий — `Eval · Maia% · Line`. Активная колонка помечена стрелкой `↓` (или `▾`).
2. **Дефолт:** Stockfish (eval desc).
3. **Сохранение режима:** localStorage `analysis.engine.sortMode` ∈ `{'stockfish' | 'maia'}`.
4. **При смене позиции:** сортировка применяется к новому набору линий каждый раз, режим сохраняется.
5. **При отсутствии Maia** (`status='error'` или для конкретного хода `policyByMove[uci] === undefined`): сортировка по Maia → ходы с `(--)` уходят в конец (стабильно), остальные — по prob desc. Кнопку **не дизаблим**: пользователь должен иметь возможность переключиться обратно на Stockfish.
6. **Tiebreaker** при равенстве primary-метрики: secondary = другая метрика, tertiary = `multipv` (исходный порядок Stockfish — стабильно).
7. **Mobile:** та же строка заголовков, тот же механизм. На узких экранах сокращаем: `Eval · M% · Line`.

## 3. Сравнение вариантов контрола

|  | **A. Segmented control в шапке panel** | **B. Кликабельные заголовки колонок (выбран)** | **C. Dropdown «Сортировка: …»** | **D. Icon-toggle (⇅) рядом с MaiaEloSelect** |
|---|---|---|---|---|
| Очевидность | высокая | высокая (привычный табличный паттерн) | средняя (надо открыть) | низкая (что значит ⇅?) |
| Места в шапке panel | +60-90 px | 0 (новый row над линиями ~22 px) | +120 px | +24 px |
| Стоимость DOM | 1 кнопка | 1 row | 1 dropdown | 1 кнопка |
| Mobile-фит | тесно (уже MultiPV + ELO + ⚙ + Start) | хорошо (row под контролами) | тесно | хорошо |
| Активный режим виден | да (highlight) | да (стрелка ↓ у колонки) | нужно открыть | нужно tooltip |
| Соответствует UX табличных компонентов | нет | **да** | нет | нет |

**Отбрасываем A** — шапка panel уже плотная (MultiPV-controls + `⚙` + MaiaEloSelect + Start). Добавлять ещё segmented control = шапка не помещается даже на mid-desktop, не говоря о mobile.

**Отбрасываем C** — лишний клик на типичную операцию (переключение «туда-обратно»). Dropdown оправдан когда вариантов 5+, у нас 2.

**Отбрасываем D** — icon-only нечитаем. `⇅` или похожий символ требует tooltip / mental-mapping. Особенно плохо на mobile (нет hover).

**Выбираем B** — естественно для таблицы (eval | prob | pv = столбцы). Активная колонка явно помечена. Шапка panel не растёт. Mobile работает без отдельной адаптации.

## 4. UX-детали

### 4.1. Внешний вид

Текстовый макет «как стало» (desktop и mobile одинаково):

```
┌─ Engine ────── [⚙] [Lines − 3 +] [Maia 1500 ▾] [Stop] ▾ ─┐
│ ▸ Stockfish (depth 24, wasm)                              │
│   Eval ↓     Maia%      Line                              │  ← новая строка-заголовок
│   +0.32      (45.0%)    e2e4 e7e5 g1f3 b8c6 …             │
│   +0.18      (22.1%)    d2d4 d7d5 c2c4 e7e6 …             │
│   -0.05      ( 8.5%)    g1f3 g8f6 c2c4 …                  │
└───────────────────────────────────────────────────────────┘
```

После клика по `Maia%`:

```
│   Eval       Maia% ↓    Line                              │
│   +0.32      (45.0%)    e2e4 e7e5 g1f3 b8c6 …             │
│   +0.18      (22.1%)    d2d4 d7d5 c2c4 e7e6 …             │
│   -0.05      ( 8.5%)    g1f3 g8f6 c2c4 …                  │
```

Стрелка `↓` указывает активную колонку. Направление сортировки — всегда desc (от большего к меньшему по primary-метрике). Третья колонка `Line` — не кликабельная (нет смысла сортировать по тексту PV).

### 4.2. Сортировка

```ts
function sortLines(lines: EvalLine[], mode: SortMode, getProb: (uci: string) => number | undefined): EvalLine[] {
  if (mode === 'stockfish') {
    // Лево как пришло от движка (он уже сортирует по eval desc).
    // Но даём явный sort для стабильности при ничейных eval.
    return [...lines].sort((a, b) => evalCompare(b, a) || a.multipv - b.multipv);
  }
  // mode === 'maia'
  return [...lines].sort((a, b) => {
    const pa = getProb(extractBestUci(a.pv) ?? '') ?? -1;
    const pb = getProb(extractBestUci(b.pv) ?? '') ?? -1;
    if (pa !== pb) return pb - pa;                          // primary: probability desc
    const ec = evalCompare(b, a);                            // tiebreak: eval desc
    if (ec !== 0) return ec;
    return a.multipv - b.multipv;                            // final: original order
  });
}
```

`probability === undefined` → присваиваем `-1` → такие ходы стабильно уходят в конец списка (после всех имеющих вероятность). Никаких NaN, никакого «прыжка» между рендерами.

### 4.3. Поведение при смене позиции

- При новом FEN Stockfish присылает новый набор линий (после своего цикла).
- Maia пересчитывает `policyByMove` (debounce 250 мс).
- Sort-режим из state не меняется.
- Если Maia ещё не пришла к моменту прихода SF-линий и mode=maia → все линии имеют `prob=undefined` → сортируются по tiebreak (eval), визуально не отличается от Stockfish-режима. Когда Maia пришла — список переупорядочивается. Пользователь видит «прыжок», но это честная индикация: «вот сейчас данные пришли».
- Опционально (см. §6 открытые вопросы) — приглушать prob-колонку через `.stockfish-maia-prob--stale` до прихода Maia, как уже делается в KS-3588.

### 4.4. Сохранение

```ts
const SORT_KEY = 'analysis.engine.sortMode';
type SortMode = 'stockfish' | 'maia';

function loadSortMode(): SortMode {
  const raw = localStorage.getItem(SORT_KEY);
  return raw === 'maia' ? 'maia' : 'stockfish';
}

function saveSortMode(mode: SortMode): void {
  localStorage.setItem(SORT_KEY, mode);
}
```

Дефолт всегда `'stockfish'`. Чтение при init `AnalysisSidebar` / hook'а.

### 4.5. Поведение при отсутствии Maia

- Mode=maia, `policyByMove` пустой / status=error: линии сортируются по tiebreak (eval) — внешне выглядит как Stockfish-режим. Стрелка `↓` остаётся у колонки `Maia%`, прозрачность процента — `(--)`.
- Кликабельность заголовка `Maia%` **не отключается** — пользователь должен иметь возможность переключиться обратно на Stockfish без поиска другого контрола.
- Опциональный tooltip на заголовке `Maia%` при `status=error`: «Maia недоступна — порядок Stockfish» (i18n).

### 4.6. Mobile

Та же строка заголовков, та же логика. Размер шрифта 12px (как `.stockfish-pv` на mobile). Сокращение если узко (`< 360px`): `Eval · M% · Line`.

Bottom-sheet ADR-073 не трогаем — добавляется один row ~22 px, snap-точки `half`/`full` это съедают без проблем.

## 5. Декомпозиция

### Этап A — frontend (0.5-1 день)

**KS-XXXX: Sort-режим Stockfish/Maia для линий engine-panel.**

1. Hook `apps/web/src/hooks/useEngineSortMode.ts` (или extend `useMaiaAnalysis` — на усмотрение фронта):
   - State `sortMode: 'stockfish' | 'maia'`.
   - Init: чтение из localStorage `analysis.engine.sortMode`, fallback `'stockfish'`.
   - Setter: запись в localStorage.
   - Возврат: `{ sortMode, setSortMode }`.
2. Утилита `sortLines(lines, mode, getProb)` (см. §4.2) — рядом с `extractBestUci` / `formatEval` (например, в `utils/chessFormat.ts` или новый `utils/engineSort.ts`).
3. В `pages/analysis/AnalysisSidebar.tsx`:
   - Импорт хука + утилиты.
   - Перед рендером `.stockfish-lines.map(...)` — применить `sortLines(displayedLines, sortMode, maia.getProbability)`.
   - Добавить новый row `.stockfish-lines-header` над `.stockfish-lines` с тремя `<button>`-заголовками: `Eval` / `Maia%` / `Line` (последний не button, просто span). Активный имеет modifier `.stockfish-lines-header__col--active` + символ `↓`.
   - Onclick на `Eval` → `setSortMode('stockfish')`. Onclick на `Maia%` → `setSortMode('maia')`.
   - Сделать одно и то же в desktop-блоке и mobile-блоке.
4. i18n:
   - `analysis.engine.sort.eval` («Eval» / «Оценка»).
   - `analysis.engine.sort.maia` («Maia%» / «Maia%»).
   - `analysis.engine.sort.line` («Line» / «Линия»).
   - `analysis.engine.sort.maiaUnavailableTip` («Maia недоступна — порядок Stockfish») — опционально.
5. Vitest:
   - `sortLines` — sort by stockfish, sort by maia, tiebreak, undefined prob → конец списка, пустой `policyByMove` → eval-sort.
   - hook `useEngineSortMode` — persistence в localStorage.
   - integration: клик по заголовку меняет порядок, режим сохраняется через reload.

**Acceptance:**
- В шапке списка линий — три заголовка, активный помечен `↓`.
- Клик меняет режим, порядок линий перестраивается.
- Режим сохраняется в localStorage и подхватывается после reload.
- Mode=maia + Maia error: линии в порядке eval, кнопка остаётся кликабельной.
- Vitest зелёный.

### Этап B — layout (0.5 дня)

**KS-XXXX: Стили строки заголовков `.stockfish-lines-header`.**

1. Добавить в `apps/web/src/styles/engine.css`:
   - `.stockfish-lines-header` — flex-row, padding согласован с `.stockfish-line`, разделитель снизу `border-bottom: 1px solid var(--c-border-subtle)`.
   - `.stockfish-lines-header__col` — заголовок-кнопка, monospace для eval/maia колонок (выравнивание с данными), inline-flex с пространством для `↓` индикатора. Hover/focus стили согласованы с `.engine-multipv-btn`.
   - `.stockfish-lines-header__col--active` — bold + видимая стрелка.
   - `.stockfish-lines-header__col--label` — некликабельная колонка `Line`, обычный текст.
2. Ширины колонок:
   - `Eval` — фиксированная (~50-60 px), как `.stockfish-eval`.
   - `Maia%` — фиксированная (~60-70 px), как `.stockfish-maia-prob`.
   - `Line` — flexible.
3. Mobile (`max-width: 767px`): размер шрифта 12px. На совсем узком (`< 360px`) — сократить лейблы по медиа-запросу (визуально, через `[data-narrow]` атрибут или `@media + display: none` для длинной версии и `display: inline` для короткой). Frontend может либо рендерить оба варианта (CSS прячет один), либо просто положить data-attr.
4. Темизация — через токены палитры, обе темы сразу (урок KS-3581/3590).
5. Не трогать `data-snap`, `analysis-mobile-section--*`, `analysis-mobile-panel` (ADR-073).

**Acceptance:**
- Шапка списка линий выровнена по колонкам с данными (eval/prob/pv).
- Активная колонка визуально выделена.
- Обе темы согласованы.
- Mobile: помещается в одну строку на ширине ≥ 320 px.
- Bottom-sheet snap-точки без регрессии.

## 6. Открытые вопросы к пользователю

1. **`stale`-приглушение Maia%-колонки во время инференса** — оставляем как сейчас (KS-3588 ставит `--stale` modifier) или хотим также приглушать чисел при mode=maia (когда сортировка ещё не валидна)? Дефолт: оставляем как есть, без дополнительной логики.
2. **Сортировка только по primary-метрике или toggle desc/asc?** Я предлагаю всегда `desc` (по убыванию, как сейчас Stockfish). asc-режим — редкий кейс, не вижу для него мотивации. Подтвердить.
3. **Tooltip «Maia недоступна» на заголовке** — нужен или избыточен (символ `(--)` в линиях уже это сообщает)? Дефолт: добавляем (стоит дёшево, помогает понять «почему ничего не изменилось»).
4. **Поведение третьей колонки `Line`** — некликабельный текст или вообще не показывать заголовок там (а только над eval/prob)? Дефолт: показывать как обычный нерактивный label — это делает row визуально завершённым.
5. **Кнопка-стрелка для смены direction** — НЕТ в MVP (см. §6.2). Future-вопрос: понадобится ли когда-нибудь? Если да — заведём отдельно.

## 7. Что НЕ входит

- Сортировка по другим метрикам (depth, nodes, и т.п.).
- Изменение состава линий (это всё ещё top-N от Stockfish, MultiPV управляет количеством).
- Сортировка для side-эффектов (выделение «лучшего» хода стрелкой на доске — это отдельный механизм `suggestedArrow`, не зависит от sort-mode).
- Cross-engine quality grading (trap-blunder подсветка, ADR-097 §9 — future).
- Stockfish-режим с MultiPV=1 не имеет смысла переключать (один элемент в списке) — кнопки остаются кликабельными, sort no-op'ит.

## 8. Резюме

Добавляем строку-заголовок над `.stockfish-lines` с тремя колонками `Eval / Maia% / Line`. Первые две кликабельны → переключают `sortMode ∈ {stockfish, maia}`. Активная колонка помечена `↓`. Сортировка применяется к уже посчитанному набору линий (без изменения состава). Persist в localStorage, default `stockfish`. При отсутствии Maia — tiebreak на eval, кнопка остаётся кликабельной. Mobile — та же логика, минимальный размер строки заголовков ~22 px (snap-точки ADR-073 не страдают). Объём работ — ~1 день frontend + 0.5 дня layout.
