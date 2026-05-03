# NAG Palette — design-doc (KS-2268)

**Дата:** 2026-05-03
**Статус:** Финальный
**Источник:** [ADR-037](../adr/037-move-annotations-and-variant-styling.md), §3 (UX), §4 (variants), §6 (architecture)
**Tooltip-строки:** согласованы с chess-expert (см. §4)
**Блокирует:** KS-2269 (frontend component), KS-2270 (CSS), KS-2271 (i18n)

---

## 1. Назначение документа

Полное визуальное и поведенческое описание палитры NAG-аннотаций для окна анализа `AnalysisPage`. Является single-source-of-truth для трёх параллельных тикетов реализации:

- **KS-2269 (frontend)** — компоненты `<NagPalette>` (desktop) и `<NagPaletteSheet>` (mobile), интеграция с `useReviewState.setNag()` и `setNagInCategory()`.
- **KS-2270 (layout)** — CSS, состояния, dark/light, breakpoints.
- **KS-2271 (frontend)** — i18n-ключи и переводы из §4.

Архитектурные решения (`setNagInCategory`, dedup-логика, NAG категоризация) — в ADR-037, здесь не дублируются.

---

## 2. Состав палитры

14 кнопок в двух группах. Порядок внутри групп — **визуальная шкала** (в quality слева хорошие, справа плохие; в position-eval слева сильнее белые, справа сильнее чёрные).

### Группа 1: Quality (оценка хода)

| Pos | NAG | Symbol | Color slot |
|-----|-----|--------|------------|
| Q1  | 1   | `!`    | good       |
| Q2  | 3   | `!!`   | good       |
| Q3  | 5   | `!?`   | interesting |
| Q4  | 6   | `?!`   | interesting |
| Q5  | 2   | `?`    | bad        |
| Q6  | 4   | `??`   | bad        |

### Группа 2: Position evaluation (оценка позиции)

| Pos | NAG | Symbol | Color slot |
|-----|-----|--------|------------|
| P1  | 18  | `+−`   | white-strong |
| P2  | 16  | `±`    | white-mid   |
| P3  | 14  | `⩲`    | white-weak  |
| P4  | 10  | `=`    | neutral     |
| P5  | 13  | `∞`    | neutral     |
| P6  | 15  | `⩱`    | black-weak  |
| P7  | 17  | `∓`    | black-mid   |
| P8  | 19  | `−+`   | black-strong |

### 2.1 Color-slot → CSS-токен (для KS-2270)

| Slot | Active fill | Active border | Active text |
|---|---|---|---|
| good | `--ov-success-20-emerald` | `--c-16a34a` | `--c-16a34a` |
| interesting | `--ov-warning-20-amber` | `--c-f59e0b` | `--c-f59e0b` |
| bad | `--ov-danger-20-r600` | `--c-dc2626` | `--c-dc2626` |
| white-strong / white-mid / white-weak | `--ov-info-20` | `--c-f0d9b5` (light board square) | `--c-e0e0e0` |
| neutral | `--ov-info-20` | `--c-666` | `--c-e0e0e0` |
| black-weak / black-mid / black-strong | `--ov-info-20` | `--c-b58863` (dark board square) | `--c-e0e0e0` |

Idle (не active): прозрачный фон, `1px solid var(--c-444)`, текст `var(--c-e0e0e0)`. Hover — фон `var(--c-2a2a3e)`, border `var(--c-666)`. См. текущий код `ReviewMoveList.css:278-330` — переиспользуется.

### 2.2 Размеры

| Платформа | Кнопка | Шрифт | Зазор | Padding группы |
|---|---|---|---|---|
| Desktop | 32×32 px | 14 px / 600 weight | 4 px | 4 px 10 px 6 px |
| Mobile  | 48×48 px (touch-target ≥ 44 px) | 16 px / 600 weight | 6 px | 8 px 12 px |

Buttons — `display: flex; align-items: center; justify-content: center`. Unicode-символы рендерятся системным шрифтом, **без** замены на иконки.

---

## 3. Wireframes

### 3.1 Desktop popup

Открывается на right-click по ходу или hotkey `A`. Позиционируется `position: fixed; transform: translateY(-100%)` от точки клика (как сейчас в `ReviewMoveList.tsx:407`). Если до верхнего края viewport < 280px — позиционируется **под** ходом (transform: none).

```
                                               ▲ click anchor
┌──────────────────────────────────────────────────┐
│  ANNOTATE                                  [×]   │  ← header (см. §3.4)
│                                                  │
│  Quality                                         │  ← group label, 11 px upper, c-888
│  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐    ⟲ Clear     │
│  │ !│ │!!│ │!?│ │?!│ │ ?│ │??│                  │  ← row 1: 6 кнопок 32×32
│  └──┘ └──┘ └──┘ └──┘ └──┘ └──┘                  │
│                                                  │
│  Position                                        │
│  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐  ⟲     │
│  │+−│ │ ±│ │ ⩲│ │ =│ │ ∞│ │ ⩱│ │ ∓│ │−+│       │  ← row 2: 8 кнопок
│  └──┘ └──┘ └──┘ └──┘ └──┘ └──┘ └──┘ └──┘        │
│                                                  │
│  ────────────────────────────────────────────    │  ← divider
│                                                  │
│  + Add comment                                   │  ← существующие пункты,
│  ↑ Promote   ] Truncate   ✕ Delete variation    │     не меняем
└──────────────────────────────────────────────────┘
   Width: ~340 px (desktop). Min 320 px на breakpoint ≤ 1024 px.
```

**Размеры контейнера:**
- min-width: 320 px, max-width: 380 px,
- padding: 8 px,
- background: `var(--c-1e1e2e)`, border `1px solid var(--c-444)`, border-radius 6 px,
- box-shadow: `0 4px 16px var(--ov-black-50)` (как сейчас).

**Позиция кнопки `⟲ Clear` в строке группы:**
- кнопка-иконка 28×28 (без обводки), tooltip «Clear quality» / «Clear position»,
- сбрасывает только NAG'и из своей группы,
- видна только если в группе **есть** активный NAG (иначе пустое место).

**Кнопка `[×]` в header:**
- закрывает popup (как клик вне),
- 24×24, `position: absolute; top: 6px; right: 6px`.

### 3.2 Mobile bottom-sheet

Открывается на long-press (500 мс) по ходу. Затемнение фона + sheet снизу.

```
═══════════════════════════════════════════
               viewport top
═══════════════════════════════════════════
                                           
    [Доска и ходы остаются видны выше]    
                                           
                                           
                                           
   ┌─────────────────────────────────────┐
   │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  ← scrim, opacity 0.4
   │                                     │
   │ ┌─────────────────────────────────┐ │
   │ │           ▬▬▬▬▬▬                │ │  ← drag handle, 36×4 px,
   │ │                                 │ │     c-666, центр, 8 px от верха
   │ │  Annotate move                  │ │  ← header, 16 px / 600
   │ │                                 │ │
   │ │  Quality                        │ │
   │ │  ┌────┐ ┌────┐ ┌────┐ ┌────┐   │ │
   │ │  │  ! │ │ !! │ │ !? │ │ ?! │   │ │  ← row 1a: 4 кнопки 48×48
   │ │  └────┘ └────┘ └────┘ └────┘   │ │
   │ │  ┌────┐ ┌────┐                  │ │
   │ │  │  ? │ │ ?? │   [⟲ Clear]      │ │  ← row 1b: 2 кнопки + clear
   │ │  └────┘ └────┘                  │ │
   │ │                                 │ │
   │ │  Position                       │ │
   │ │  ┌────┐┌────┐┌────┐┌────┐       │ │
   │ │  │ +− ││  ± ││  ⩲ ││  = │       │ │  ← row 2a: 4 кнопки
   │ │  └────┘└────┘└────┘└────┘       │ │
   │ │  ┌────┐┌────┐┌────┐┌────┐       │ │
   │ │  │  ∞ ││  ⩱ ││  ∓ ││ −+ │       │ │  ← row 2b: 4 кнопки
   │ │  └────┘└────┘└────┘└────┘       │ │
   │ │                          [⟲]    │ │  ← clear position
   │ │                                 │ │
   │ │  ─────────────────────────────  │ │
   │ │                                 │ │
   │ │  + Add comment                  │ │
   │ │  ↑ Promote   ] Truncate         │ │
   │ │  ✕ Delete variation             │ │
   │ │                                 │ │
   │ │            [    Done    ]       │ │  ← primary button, full-width
   │ │                                 │ │     закрывает sheet
   │ └─────────────────────────────────┘ │
   └─────────────────────────────────────┘
═══════════════════════════════════════════
              viewport bottom
═══════════════════════════════════════════
```

**Размеры sheet:**
- ширина: `100vw`,
- min-height: 280 px (если viewport < 700 px) или 360 px (иначе),
- max-height: 60 vh (защита от перекрытия доски),
- padding: 12 px 16 px 24 px (нижний > верхнего на safe-area-inset-bottom),
- background: `var(--c-1a1a2e)`,
- border-top-left-radius / -right-radius: 16 px,
- box-shadow `0 -4px 16px var(--ov-black-50)`.

**Свайп-вниз для закрытия:**
- pointer-events: drag-handle область + любое место sheet, начало pan-down,
- если `deltaY > 60 px` или скорость `> 0.5 px/ms` — закрытие.

**Tap вне sheet:**
- тап по scrim (`position: fixed; inset: 0; background: var(--ov-black-40)`) — закрытие.

**Кнопка `Done`:**
- footer, full-width 48 px, primary стиль (`background: var(--c-1565c0); color: var(--c-fff)`),
- закрывает sheet, **сохраняет** изменения NAG (изменения уже применены через `setNag` при каждом тапе).

### 3.3 Positioning details (desktop)

Текущий код `ReviewMoveList.tsx:405-407` использует:
```
style={{ top: contextMenu.y, left: contextMenu.x, transform: 'translateY(-100%)' }}
```

Этого недостаточно для новой палитры (она шире). Расширить:

```
const computePosition = ({ clientX, clientY }: { clientX: number; clientY: number }) => {
  const PALETTE_WIDTH = 340;
  const PALETTE_HEIGHT = 280; // приблизительно
  const margin = 8;
  // X: clamp в viewport
  const left = Math.min(Math.max(clientX, margin), window.innerWidth - PALETTE_WIDTH - margin);
  // Y: предпочтительно сверху-точка-клика, fallback вниз
  const fitsAbove = clientY >= PALETTE_HEIGHT + margin;
  const top = fitsAbove ? clientY - PALETTE_HEIGHT - 4 : clientY + 4;
  return { top, left };
};
```

Никакой `transform: translateY(-100%)` — реальная позиция считается на JS.

### 3.4 Header

**Desktop:** label `Annotate` (lower-case, 11 px, `var(--c-888)`), кнопка `[×]` справа.
**Mobile:** label `Annotate move` (16 px, 600 weight), drag-handle сверху.

I18n-ключ: `review.palette.title` / `review.palette.titleMobile`.

---

## 4. Tooltip-строки RU/EN

Финальные значения. Согласованы с chess-expert (правки приняты: NAG 3 RU «Блестящий ход», NAG 16/17 — «перевес» / «is clearly better»).

### 4.1 i18n-ключи (для KS-2271)

Структура в `apps/web/src/locales/{en,ru}/translation.json`:

```json
{
  "review": {
    "palette": {
      "title": "Annotate" / "Аннотация",
      "titleMobile": "Annotate move" / "Аннотация хода",
      "groupQuality": "Quality" / "Оценка хода",
      "groupPosition": "Position" / "Оценка позиции",
      "clearQuality": "Clear quality" / "Сбросить оценку хода",
      "clearPosition": "Clear position" / "Сбросить оценку позиции",
      "doneMobile": "Done" / "Готово",
      "nag": {
        "1":  { "en": "Good move",                "ru": "Хороший ход" },
        "3":  { "en": "Brilliant move",           "ru": "Блестящий ход" },
        "5":  { "en": "Interesting move",         "ru": "Интересный ход" },
        "6":  { "en": "Dubious move",             "ru": "Сомнительный ход" },
        "2":  { "en": "Mistake",                  "ru": "Ошибка" },
        "4":  { "en": "Blunder",                  "ru": "Зевок" },
        "10": { "en": "Equal position",           "ru": "Равная позиция" },
        "13": { "en": "Unclear position",         "ru": "Неясная позиция" },
        "14": { "en": "White is slightly better", "ru": "У белых чуть лучше" },
        "15": { "en": "Black is slightly better", "ru": "У чёрных чуть лучше" },
        "16": { "en": "White is clearly better",  "ru": "У белых перевес" },
        "17": { "en": "Black is clearly better",  "ru": "У чёрных перевес" },
        "18": { "en": "White is winning",         "ru": "У белых выиграно" },
        "19": { "en": "Black is winning",         "ru": "У чёрных выиграно" }
      }
    }
  }
}
```

(В реальности i18next-структура будет flat: `review.palette.nag.1.en` → ключ `review.palette.nag.1` со значением «Good move» в `en/translation.json` и «Хороший ход» в `ru/translation.json`. Структуру выше дал для наглядности.)

### 4.2 Сводная таблица tooltip'ов

**Quality:**

| NAG | Symbol | EN | RU |
|---|---|---|---|
| 1 | `!`  | Good move        | Хороший ход     |
| 3 | `!!` | Brilliant move   | Блестящий ход   |
| 5 | `!?` | Interesting move | Интересный ход  |
| 6 | `?!` | Dubious move     | Сомнительный ход |
| 2 | `?`  | Mistake          | Ошибка          |
| 4 | `??` | Blunder          | Зевок           |

**Position evaluation:**

| NAG | Symbol | EN | RU |
|---|---|---|---|
| 18 | `+−` | White is winning         | У белых выиграно   |
| 16 | `±`  | White is clearly better  | У белых перевес    |
| 14 | `⩲`  | White is slightly better | У белых чуть лучше |
| 10 | `=`  | Equal position           | Равная позиция     |
| 13 | `∞`  | Unclear position         | Неясная позиция    |
| 15 | `⩱`  | Black is slightly better | У чёрных чуть лучше |
| 17 | `∓`  | Black is clearly better  | У чёрных перевес   |
| 19 | `−+` | Black is winning         | У чёрных выиграно  |

**Длины проверены:** все ≤ 24 символа (RU и EN). Стиль:
- quality — «<adjective> ход» / «<adjective> move» + единичные термины «Ошибка»/«Зевок» / «Mistake»/«Blunder»,
- position-eval EN — единая форма «is [adv] better/winning» + «Equal/Unclear position»,
- position-eval RU — единая форма «У [цвет] [степень]» + «Равная/Неясная позиция».

### 4.3 Реализация tooltip в HTML

```tsx
<button
  className="nag-btn"
  data-nag={nag}
  title={t(`review.palette.nag.${nag}`)}
  aria-label={t(`review.palette.nag.${nag}`)}
  onClick={() => onSelect(nag)}
>
  {nagToSymbol(nag)}
</button>
```

Mobile tooltip — нативного hover нет; вместо `title` показывать tooltip на long-press кнопки (3-секундный hold), но это отложено в v2. В v1 на mobile полагаемся на самоочевидность символов.

---

## 5. UX-flow

### 5.1 Desktop

```
Initial: notation panel open, никакого popup.

(1) User: right-click on move "e4"
    → ReviewMoveList.handleMoveContextMenu()
    → showContextMenu({clientX, clientY}, move)
    → state.contextMenu.visible = true

(2) Render: <NagPalette> mounted, позиционируется по §3.3.
    Активные NAG'и (если есть в move.nags) — отрисованы как pressed.

(3) User: clicks "!!"
    → onSelect(3)
    → setNagInCategory(currentNags, 3)
    → onSetNag(globalIndex, newNags)
    → reducer SET_NAG → re-render
    Кнопка "!" (если была) — теперь idle, "!!" — pressed.
    Popup НЕ закрывается. Пользователь может ставить ещё.

(4) User: clicks "=" (position-eval)
    → setNagInCategory([3], 10) → [3, 10]
    Quality "!!" остаётся, Position "=" pressed.

(5) User: clicks "Clear quality" (⟲ в строке Quality)
    → onSetNag(globalIndex, [10])  // оставляем только position
    Кнопка "!!" — idle, "=" — остаётся pressed.

(6) User: clicks вне popup ИЛИ ESC ИЛИ right-click другого хода
    → closeContextMenu()
    → state.contextMenu.visible = false
    Изменения уже применены (на каждом клике по NAG).
```

### 5.2 Mobile

```
Initial: notation panel open, никакого sheet.

(1) User: long-press 500 ms on move "e4"
    → handleTouchStart() запускает timer
    → 500 ms спустя — showContextMenu() с longPressFiredRef = true

(2) Render: <NagPaletteSheet> mounted snizu, scrim 40% поверх остального.
    Sheet анимация: translate-y from 100% to 0%, easeOut 200 ms.

(3) User: tap "!!"
    → onSelect(3) → setNagInCategory → setNag
    Sheet НЕ закрывается. Tap-feedback: фон кнопки на 80 ms,
    затем рендерится pressed-state.

(4) User: swipe sheet down (deltaY > 60 px)  ИЛИ
          tap on scrim                        ИЛИ
          tap "Done"                           ИЛИ
          back-button (Android)
    → closeContextMenu()
    Sheet анимация: translate-y from 0% to 100%, 200 ms.
```

### 5.3 Read-only режим

Если `<NagPalette readOnly>` или ни один из callback'ов `onSetNag` / `onSetComment` / `onPromoteVariation` не передан — компонент не render'ится вовсе. Long-press / right-click на ходе игнорируется. Это уже в текущем коде (`ReviewMoveList.tsx:78-84` — `editable` flag), сохраняем поведение.

### 5.4 Состояния ошибки

| Ситуация | Поведение |
|---|---|
| `move` undefined в момент клика | `handleNagToggle` early return — popup закрывается |
| `onSetNag` не передан | NAG-секция вообще не рендерится (как сейчас) |
| `setNagInCategory` вернул то же что было (no-op) | reducer всё равно создаст новый ref — лишний rerender, но визуально нет разницы |

---

## 6. Hotkeys (опциональная раскладка для KS-NAG-HOTKEYS / E6)

**Эта секция — задел на E6, не обязательна для E2.** Frontend в KS-2269 может реализовать как stub (no-op) или пропустить.

### 6.1 Открытие

| Key | Action |
|-----|--------|
| `A` | открыть палитру для текущего хода (`currentGlobalIndex`) |
| `Esc` | закрыть открытую палитру |

Условие активации: focus на notation panel (`tabIndex={0}` на `.review-moves-container`).

### 6.2 Внутри палитры (если открыта)

Hotkey-context переключается на палитру. Цифровые клавиши:

| Key | NAG | Symbol |
|-----|-----|--------|
| `1` | 1   | `!`    |
| `Shift+1` (`!`) | 3 | `!!` |
| `2` | 5   | `!?`   |
| `Shift+2` (`@`) | 6 | `?!` |
| `3` | 2   | `?`    |
| `Shift+3` (`#`) | 4 | `??` |
| `4` | 18  | `+−`   |
| `5` | 16  | `±`    |
| `6` | 14  | `⩲`    |
| `7` | 10  | `=`    |
| `8` | 13  | `∞`    |
| `9` | 15  | `⩱`    |
| `Shift+9` (`(`) | 17 | `∓` |
| `Shift+0` (`)`) | 19 | `−+` |
| `0` или `Backspace` | clear all NAGs | |

Эта раскладка **не финальная** — frontend на E6 может предложить альтернативу. Главное условие: цифровые клавиши не должны конфликтовать с move-navigation (если она использует digits).

---

## 7. Интеграция с компонентом

Сигнатура для KS-2269:

```tsx
interface NagPaletteProps {
  /** Текущий ход, для которого редактируем NAG */
  move: ChessMove;
  /** Активные NAG'и (move.nags ?? []) */
  currentNags: number[];
  /** Колбэк на установку NAG'ов (после применения setNagInCategory) */
  onSetNag: (nags: number[]) => void;
  /** Закрытие палитры (для desktop popup, и для sheet тоже) */
  onClose: () => void;
  /** Read-only — не рендерить interactive controls */
  readOnly?: boolean;
}

// Desktop popup
<NagPalette
  move={contextMenu.move}
  currentNags={contextMenu.move.nags ?? []}
  onSetNag={(nags) => onSetNagFromParent(contextMenu.move.globalIndex, nags)}
  onClose={closeContextMenu}
/>

// Mobile sheet (отдельный компонент или prop variant — на усмотрение frontend)
<NagPaletteSheet
  move={contextMenu.move}
  currentNags={contextMenu.move.nags ?? []}
  onSetNag={(nags) => onSetNagFromParent(contextMenu.move.globalIndex, nags)}
  onClose={closeContextMenu}
/>
```

**Внутри компонента** — вызов `setNagInCategory(currentNags, nag)` из `utils/nagCategories.ts` (создаётся в KS-2267 / KS-NAG-DEDUP, см. ADR-037 §6.1). Frontend должен ждать готовности этого утилита.

`<NagPalette>` **сам** рендерит существующие пункты `+ Add comment`, `↑ Promote`, `] Truncate`, `✕ Delete` — либо принимает их как `children` от родителя. Решение — на frontend (склоняюсь к `children`, чтобы `<NagPalette>` отвечал только за NAG-часть).

---

## 8. Чек-лист для Layout (KS-2270)

CSS-задача получает:

- [ ] Разметка из §3.1 (desktop) и §3.2 (mobile)
- [ ] Color-slots из §2.1
- [ ] Размеры из §2.2 (desktop 32×32, mobile 48×48)
- [ ] Header 11/16 px из §3.4
- [ ] Position computation из §3.3 (это TS, но layout обеспечивает CSS не блокирующий)
- [ ] Mobile sheet анимации (`translate-y`, 200 ms easeOut)
- [ ] Scrim `var(--ov-black-40)`, `position: fixed; inset: 0`
- [ ] Light/dark theme тестирование (`html[data-theme="light"]` override)
- [ ] Breakpoints: desktop ≥ 1024 px (полная палитра), mobile ≤ 768 px (sheet), tablet 768–1024 (popup, но компактный — 320 px width)
- [ ] `prefers-reduced-motion: reduce` — без анимаций sheet, instant transition

---

## 9. Чек-лист для Frontend (KS-2269)

- [ ] Создать `apps/web/src/review/components/NagPalette.tsx` (desktop popup)
- [ ] Создать `apps/web/src/review/components/NagPaletteSheet.tsx` (mobile sheet) ИЛИ вариант через prop в одном компоненте
- [ ] Использовать `setNagInCategory` из `apps/web/src/review/utils/nagCategories.ts` (зависимость от KS-2267)
- [ ] Position computation §3.3
- [ ] Long-press logic — оставить как есть в `ReviewMoveList.tsx:165-194`, заменить только render context-menu на `<NagPalette>` / `<NagPaletteSheet>`
- [ ] Pass `readOnly` prop корректно
- [ ] Не render'ить если `editable === false`
- [ ] Sheet — закрытие на swipe-down (можно через `react-spring/use-gesture` или нативно через pointer events; frontend выбирает)
- [ ] ESC закрывает desktop popup; Android-back (history.back) закрывает sheet
- [ ] Не ломать существующие пункты меню (`Add comment`, `Promote`, `Truncate`, `Delete`)

---

## 10. Чек-лист для i18n (KS-2271)

- [ ] Добавить ключи из §4.1 в `apps/web/src/locales/en/translation.json`
- [ ] Добавить ключи из §4.1 в `apps/web/src/locales/ru/translation.json`
- [ ] Структура — следовать существующему namespacing (`review.*`)
- [ ] Проверить, что `t('review.palette.nag.1')` работает в jsx (`<button title={t(...)}>`)
- [ ] Юнит-тест (если в проекте есть) — все 14 NAG-ключей возвращают непустые строки в обоих языках

---

## 11. Открытые вопросы для frontend / layout (не блокируют дизайн)

1. **Анимация появления desktop popup** — fade-in 100 ms или instant. Решение — на layout (KS-2270), документация не предписывает.
2. **`<NagPalette>` vs `<NagPaletteSheet>` — один компонент с prop'ом или два** — на усмотрение frontend (KS-2269). Логически — один shared model + два render-варианта (быстрее тесты, меньше дубля).
3. **Tooltip на mobile (long-press на кнопку)** — отложено в v2.
4. **Анимация feedback при tap на NAG-кнопке** (короткий blink фона) — добавить в KS-2270 если несложно.

---

## 12. Ссылки и зависимости

- ADR-037, разделы §3 (UX), §4 (variants), §6 (architecture).
- `apps/web/src/review/components/ReviewMoveList.tsx` — текущий context-menu, основа для миграции.
- `apps/web/src/review/components/ReviewMoveList.css:270-355` — стили текущей NAG-секции, переиспользуются.
- `apps/web/src/review/utils/nagUtils.ts` — `nagToSymbol()`, source of truth для unicode.
- `apps/web/src/review/utils/nagCategories.ts` — будет создан в KS-2267 (KS-NAG-DEDUP). Frontend зависит от готовности.

---

**Готовность:** документ готов к раздаче в KS-2269 / KS-2270 / KS-2271 как спецификация.
