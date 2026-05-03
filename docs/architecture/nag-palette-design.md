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
- ADR-038, разделы §2 (UX), §3 (палитра), §6 (архитектура) — для секции «Variation color» (§13 ниже).
- `apps/web/src/review/components/ReviewMoveList.tsx` — текущий context-menu, основа для миграции.
- `apps/web/src/review/components/ReviewMoveList.css:270-355` — стили текущей NAG-секции, переиспользуются.
- `apps/web/src/review/utils/nagUtils.ts` — `nagToSymbol()`, source of truth для unicode.
- `apps/web/src/review/utils/nagCategories.ts` — будет создан в KS-2267 (KS-NAG-DEDUP). Frontend зависит от готовности.
- `apps/web/src/review/utils/commentMacros.ts` — будет расширен `[%cvc X]` парсером в KS-VC-PGN.

---

## 13. Секция «Variation color» (KS-2290 / KS-VC-PALETTE-DESIGN)

Дополнение к палитре, спроектированное в ADR-038. Не перепутайте с автоматической раскраской по уровню (KS-2273/74/75) — это **ручной override** поверх неё.

### 13.1 Условие отображения

Секция «Variation color» рендерится в палитре **только если** ход является вариантом:

```ts
const isVariation = processedMove.isVariation === true;
// в render:
{isVariation && <VariationColorSection ... />}
```

Для main-line ходов (`isVariation === false`) — секция не рендерится. Это даёт чистый UI без бессмысленных контролов.

В read-only режиме (`<NagPalette readOnly>` или `editable === false`) секция не рендерится в любом случае — как и весь интерактив палитры (см. §5.3).

### 13.2 Wireframe desktop popup (обновлённый — добавляется секция VC)

```
                                               ▲ click anchor
┌──────────────────────────────────────────────────┐
│  ANNOTATE                                  [×]   │
│                                                  │
│  Quality                                         │
│  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐    ⟲ Clear     │
│  │ !│ │!!│ │!?│ │?!│ │ ?│ │??│                  │
│  └──┘ └──┘ └──┘ └──┘ └──┘ └──┘                  │
│                                                  │
│  Position                                        │
│  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐  ⟲     │
│  │+−│ │ ±│ │ ⩲│ │ =│ │ ∞│ │ ⩱│ │ ∓│ │−+│       │
│  └──┘ └──┘ └──┘ └──┘ └──┘ └──┘ └──┘ └──┘        │
│                                                  │
│  ── появляется только если ход внутри варианта ──│
│  Variation color                                 │
│  ●G  ●B  ●Y  ●R          ⟲ Clear                │  ← swatches 28×28
│                                                  │
│  ────────────────────────────────────────────    │
│                                                  │
│  + Add comment                                   │
│  ↑ Promote   ] Truncate   ✕ Delete variation    │
└──────────────────────────────────────────────────┘
   Width: те же ~340 px (без увеличения).
```

Высота popup'а растёт на ~52 px (label 16 px + row 28 px + spacing 8 px) когда секция видна. Это укладывается в max-height vh, не требует scroll.

### 13.3 Wireframe mobile bottom-sheet (обновлённый)

```
   ┌─────────────────────────────────────┐
   │ ┌─────────────────────────────────┐ │
   │ │           ▬▬▬▬▬▬                │ │
   │ │  Annotate move                  │ │
   │ │                                 │ │
   │ │  Quality                        │ │
   │ │  [! ] [!!] [!?] [?!]            │ │
   │ │  [? ] [??]      [⟲ Clear]       │ │
   │ │                                 │ │
   │ │  Position                       │ │
   │ │  [+−][ ±][ ⩲][ =]               │ │
   │ │  [ ∞][ ⩱][ ∓][−+]    [⟲]        │ │
   │ │                                 │ │
   │ │  ── только в варианте ──────    │ │
   │ │  Variation color                │ │
   │ │  ┌────┐┌────┐┌────┐┌────┐       │ │
   │ │  │ ● G││ ● B││ ● Y││ ● R│       │ │  ← swatches 48×48
   │ │  └────┘└────┘└────┘└────┘       │ │
   │ │                  [⟲ Clear]      │ │
   │ │                                 │ │
   │ │  ─────────────────────────────  │ │
   │ │                                 │ │
   │ │  + Add comment                  │ │
   │ │  ↑ Promote   ] Truncate         │ │
   │ │  ✕ Delete variation             │ │
   │ │                                 │ │
   │ │            [    Done    ]       │ │
   │ └─────────────────────────────────┘ │
   └─────────────────────────────────────┘
```

Высота sheet растёт на ~80 px (label 20 px + row 56 px + spacing). Если viewport < 700 px и sheet касается max-height 60vh — включается scroll внутри sheet (overflow-y: auto на корневом контейнере, ниже drag-handle).

### 13.4 Swatch-кнопки

| Аспект | Desktop | Mobile |
|---|---|---|
| Размер | 28×28 px | 48×48 px (touch ≥ 44 px) |
| Форма | `border-radius: 50%` (круг) | то же |
| Inner color | заливка цветом из §13.5 | то же |
| Idle border | `1px solid var(--c-444)` | `1.5px solid var(--c-444)` |
| Hover border | `1px solid var(--c-666)` | nope (нет hover на touch) |
| Active border | `2px solid var(--c-vc-{color})` (тот же цвет, что заливка, но 2px толщины) | `2.5px solid` |
| Active inner | заливка не меняется, но снаружи — тонкий glow `0 0 0 2px var(--c-vc-{color})` через box-shadow с opacity 0.3 | то же |
| Tap-feedback | blink-фон 80 ms (см. §11 пункт 2 — общий для всей палитры) | то же |

Внутри swatch — **никакого текста**. Узнаваемость через цвет + tooltip. Подпись `G`/`B`/`Y`/`R` в wireframe выше — **только для документации**, в UI её нет.

### 13.5 Цветовые токены (для KS-VC-CSS)

```css
:root {
  --c-vc-green:  #16a34a;
  --c-vc-blue:   #2563eb;
  --c-vc-yellow: #eab308;
  --c-vc-red:    #dc2626;
}

html[data-theme="light"] {
  --c-vc-green:  #15803d;
  --c-vc-blue:   #1d4ed8;
  --c-vc-yellow: #ca8a04;
  --c-vc-red:    #b91c1c;
}
```

Source of truth — ADR-038 §3.2. Layout не должен трогать эти hex'ы без согласования (они выровнены с контрастностью WCAG AA, см. ADR-038 §3.4).

### 13.6 Layout кнопок в строке

**Desktop** (5 элементов в строке):
```
[swatch G] [swatch B] [swatch Y] [swatch R]   [⟲ Clear]
   28×28      28×28      28×28      28×28        28×28 (no fill)
```
- Зазор между swatches: 8 px (больше, чем у NAG, потому что круги визуально слипаются если 4 px).
- `⟲ Clear` отделяется flex-spacing'ом (`margin-left: auto` или `gap` с явным spacer'ом).
- padding группы: `4 px 10 px 6 px` (как остальные секции).

**Mobile** (4 swatches в строке + Clear под/справа):
```
┌────┐┌────┐┌────┐┌────┐
│ G  ││ B  ││ Y  ││ R  │      [⟲ Clear]
└────┘└────┘└────┘└────┘
```
- Зазор между swatches: 12 px.
- `⟲ Clear` — отдельной строкой справа (как у Position, см. §3.2). На mobile clear-кнопка имеет touch-target ≥ 44 px (можно круглая 48×48 без fill, либо «pill» 80×44).

### 13.7 Tooltip-строки RU/EN (финальные)

Source: ADR-038 §3.1. Все ≤ 24 символа, единый стиль (существительное «вариант» в RU; ноун-фраза в EN).

| Letter | Color CSS-токен | EN tooltip | RU tooltip |
|---|---|---|---|
| G | `--c-vc-green`  | Good line             | Хороший вариант    |
| B | `--c-vc-blue`   | Main alternative      | Главная альтернатива |
| Y | `--c-vc-yellow` | Critical line         | Критический вариант |
| R | `--c-vc-red`    | Bad line              | Плохой вариант     |
| — | (clear)         | Clear color           | Сбросить цвет      |

Дополнительные строки:
- Section title: `Variation color` / `Цвет варианта` (≤14 символов)

### 13.8 i18n-ключи (для KS-VC-I18N)

Структура в `apps/web/src/locales/{en,ru}/translation.json`, расширяет `review.palette.*`:

```json
{
  "review": {
    "palette": {
      "...existing NAG keys...": "...",
      "variationColor": {
        "title": "Variation color" / "Цвет варианта",
        "clear": "Clear color" / "Сбросить цвет",
        "color": {
          "green":  { "en": "Good line",        "ru": "Хороший вариант" },
          "blue":   { "en": "Main alternative", "ru": "Главная альтернатива" },
          "yellow": { "en": "Critical line",    "ru": "Критический вариант" },
          "red":    { "en": "Bad line",         "ru": "Плохой вариант" }
        }
      }
    }
  }
}
```

В реальной flat-структуре i18next: `review.palette.variationColor.color.green` → «Good line» в `en/translation.json`, «Хороший вариант» в `ru/translation.json`. Ключ `review.palette.variationColor.clear` — для кнопки Clear.

### 13.9 Состояния (active / idle / disabled)

| Состояние | Когда | Стиль |
|---|---|---|
| Idle | вариант не имеет color, либо у него другой color | заливка = цвет; border `1px var(--c-444)`; opacity 1 |
| Hover (desktop) | курсор над swatch'ем | border → `var(--c-666)`; курсор `pointer` |
| Active (нажат) | `move.variationColor === <thisColor>` (lookup идёт через variation-root, см. §13.13) | border 2px цвета swatch'а + box-shadow glow; **никакого изменения заливки** — она и так этого цвета |
| Pressing (между mousedown и mouseup) | tap-feedback | brightness(1.2) на 80 ms |
| Disabled | n/a — секция вообще не отображается, если ход не вариант | — |

Кнопка `⟲ Clear`:
- видна **только** если у текущего варианта есть `variationColor` (иначе пустое место, как у NAG-clear);
- никакой active-состояния — это action-button.

### 13.10 Поведение клика

**Принцип:** «replace, не append» — как и у NAG quality/position.

- variation без цвета → клик `G` → ставит `green`.
- variation с `green` → клик `B` → **заменяет** на `blue` (внутренний reducer вызов: `setVariationColor(variationRoot, 'blue')`).
- variation с `green` → повторный клик `G` → **удаляет** (toggle off, эквивалент Clear).
- клик `⟲ Clear` → удаляет цвет, fallback к auto-coloring по уровню.

Между сессиями (после reload страницы) состояние восстанавливается из PGN comment macro `[%cvc <letter>]` (см. ADR-038 §4.1, §6.2).

### 13.11 Hotkey раскладка (для KS-VC-HOTKEYS / E4)

**Эта секция — задел на E4, не обязательна для KS-VC-COMPONENT.** Frontend в KS-VC-COMPONENT может реализовать как stub или пропустить.

#### Открытие палитры (если фокус на notation panel)

| Key | Action |
|-----|--------|
| `V` | открыть палитру для текущего хода и автоматически сфокусировать секцию Variation color (если ход — variation) |
| `Esc` | закрыть открытую палитру |

Если текущий ход — main-line (не variation), `V` всё равно открывает палитру, но секция Variation color не отображается → focus уходит на первую видимую кнопку (Quality).

#### Внутри палитры (если открыта на ход варианта)

| Key | VariationColor |
|-----|----------------|
| `1` | green  |
| `2` | blue   |
| `3` | yellow |
| `4` | red    |
| `0` или `Backspace` | clear |

Раскладка **изолированная** — конфликтует с NAG-hotkey'ями (`1..9`) только если они активны одновременно. Решение:
- Если палитра в режиме «фокус на Variation color» (после `V`) — `1..4` маппятся на цвета.
- Если палитра в режиме «фокус на Quality/Position» (после `A`, см. §6) — `1..9` маппятся на NAG.
- Переключение фокуса: `Tab` циклически по секциям (Quality → Position → Variation color → Comment → Promote → Truncate → Delete → loop).

Это **не финальная** раскладка — frontend на E4 может предложить альтернативу. Главное условие: hotkey не конфликтует с move-navigation (`←`/`→`, `Home`/`End`).

### 13.12 Сигнатура компонента (для KS-VC-COMPONENT)

Дополнение к `NagPaletteProps` из §7:

```tsx
interface NagPaletteProps {
  // ...existing fields from §7...

  /** KS-2284: текущий цвет варианта (если ход — variation и цвет задан). Lookup через variation-root, см. §13.13. */
  currentVariationColor?: VariationColor;

  /**
   * KS-2284: колбэк на установку цвета варианта.
   * `color: null` — clear (toggle off, fallback к auto-coloring).
   * Если ход — main-line, родитель не должен передавать этот колбэк
   * (или внутри palette условный рендер всё равно скроет секцию).
   */
  onSetVariationColor?: (color: VariationColor | null) => void;

  /** KS-2284: ход — внутри варианта (для условного рендера секции). */
  isVariation?: boolean;
}
```

Родитель (контейнер `ReviewMoveList`) до открытия палитры:
1. Вычисляет `variationRoot` для `move` (helper `findVariationRoot(move)`, см. §13.13).
2. Если `variationRoot !== null` — `isVariation = true`, `currentVariationColor = variationRoot.variationColor`.
3. `onSetVariationColor = (color) => dispatch SET_VARIATION_COLOR(variationRoot.globalIndex, color)`.

### 13.13 Variation root lookup (helper)

Frontend (KS-VC-COMPONENT) должен реализовать helper:

```ts
/**
 * Найти первый ход variation, к которой принадлежит данный ход.
 * Возвращает null, если ход — main-line.
 *
 * Алгоритм: подняться по `previous` до момента, когда parent.variation
 * включает текущий ход как FIRST element. Это и есть variation root.
 */
function findVariationRoot(move: ChessMove): ChessMove | null {
  // ...
}
```

Точная реализация — на стороне frontend (зависит от того, как именно `processMoveHierarchy` строит variation-tree). Юнит-тестами покрыть 3 уровня вложенности.

`useReviewState` action `SET_VARIATION_COLOR` принимает `globalIndex` именно variation-root'а — frontend ответственен передать правильный.

### 13.14 Чек-лист для Layout (KS-VC-CSS / расширяет §8)

- [ ] CSS-токены `--c-vc-{green,blue,yellow,red}` в `index.css` (dark + light) — см. §13.5
- [ ] Стили swatch-кнопок (28×28 desktop, 48×48 mobile) — см. §13.4
- [ ] Active-state с border 2px и box-shadow glow
- [ ] Layout строки swatches (8 px gap desktop, 12 px gap mobile)
- [ ] Кнопка `⟲ Clear` — переиспользует существующий стиль из NAG-секций (`.review-palette__clear-btn` или аналог)
- [ ] Section title `.review-palette__group-label` — переиспользуется (см. §3.4)
- [ ] Адаптивность: на mobile при viewport <700 px — sheet включает scroll внутри
- [ ] Контрастность WCAG AA для всех 4 цветов в обеих темах

### 13.15 Чек-лист для Frontend (KS-VC-COMPONENT / расширяет §9)

- [ ] Helper `findVariationRoot(move)` (§13.13) — `apps/web/src/review/utils/variationRoot.ts` (или подобное)
- [ ] Расширение `<NagPalette>` props согласно §13.12
- [ ] Условный рендер секции (§13.1)
- [ ] Active-state lookup: `currentVariationColor === thisSwatchColor`
- [ ] Toggle / replace / clear логика (§13.10) — в обработчике onClick swatch'а
- [ ] Юнит-тесты на `findVariationRoot` (3 уровня nesting)
- [ ] Юнит-тест: палитра не показывает секцию для main-line move

### 13.16 Чек-лист для i18n (KS-VC-I18N / расширяет §10)

- [ ] Добавить ключи из §13.8 в `apps/web/src/locales/en/translation.json`
- [ ] Добавить ключи из §13.8 в `apps/web/src/locales/ru/translation.json`
- [ ] Section title и Clear-tooltip переведены
- [ ] Все 4 цвета имеют tooltip в обоих языках

### 13.17 Открытые вопросы (для frontend / layout, не блокируют)

1. **Анимация active-state** — должно ли появление glow быть плавным (200 ms transition) или мгновенным. Решение на layout (KS-VC-CSS).
2. **Color-blind mode** — symbol-prefix вместо цвета. Отложено в v2 (см. ADR-038 §3.4).
3. **Lookup variation-root оптимизация** — для глубоких variation trees может стать slow. Кэш на уровне `processMoveHierarchy`. Решение на frontend (KS-VC-COMPONENT) если профайлер покажет hotpath.

---

**Готовность:** документ готов к раздаче в KS-2269 / KS-2270 / KS-2271 (NAG-палитра) и KS-VC-COMPONENT / KS-VC-CSS-PALETTE / KS-VC-I18N (Variation color) как единая спецификация.
