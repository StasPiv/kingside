# ADR-076. `/precision` — упрощение мобильной навигации (chips-фильтры + bottom-sheet)

Статус: предложен (2026-05-22)
Связано: KS-3242 (этот ADR), ADR-057 (Precision UX split),
ADR-073 (Game step mobile focus-mode), ADR-058 (Sidebar restructure).

## 1. Проблема

На странице `/precision` (Тренировка точности) на мобильном до
сетки пазлов накапливается 700+ px управляющих элементов. Сетка
вообще не помещается в первый экран — пользователь видит только
самый верх первой пары карточек.

Источник: `/tmp/telegram/326129992_0.jpg` (Samsung S22-класс,
viewport ~610×1234), пользователь:

> Здесь слишком много визуальных элементов для навигации.

## 2. Аудит элементов сверху вниз

Высоты — на основе скриншота (±10%). Файл компонента:
`apps/web/src/pages/PrecisionPage.tsx`.

| # | Элемент | Где | Высота | Можно убрать/сжать? |
|---|---|---|---|---|
| 1 | Системный статус-бар | OS | 30 | нет |
| 2 | Глобальный `<header>` Kingside | MainLayout | 80 | нет (общий) |
| 3 | `PrecisionSubNav` «Тренировка / Прогресс / История» | line 506 | 64 | оставить — основная навигация раздела |
| 4 | `<h1>` «Тренировка точности» | line 508 | 50 | **скрыть на mobile** — дублирует активный таб SubNav |
| 5 | `<p>` описание (3 строки) | line 509–514 | 76 | **скрыть на mobile**, перенести в ⓘ-popover рядом с табом |
| 6 | Action-buttons «← Все пазлы» + «Генерация из PGN» | line 515–531 | 56 | **в three-dots «⋮» меню** на mobile |
| 7 | Segment-tabs «Все / Мои пазлы» | line 534–570 | 64 | объединить в общий filter-chips bar |
| 8 | Segment-tabs «Все / Реализуй / Ничью» (2 строки на mobile) | line 575–615 | 80 | объединить в общий filter-chips bar |
| 9 | Чекбокс «Показать решённые» | line 623–641 | 56 | объединить в общий filter-chips bar |
| 10 | Slider «Рейтинг 800 — 3000» | line 646–715 | 80 | **в bottom-sheet** «Рейтинг», откр. по pill |
| 11 | `precision-compact-stats` | line 724–798 | 64 | сжать в 1 строку (36 px) |
| 12 | Сетка карточек | line 839–1207 | — | главное |
| 13 | `MobileBottomBar` | MainLayout | 70 | оставить |

Суммарно «до сетки»: 30+80+64+50+76+56+64+80+56+80+64 = **700 px**
из viewport'а 844. На сетку остаётся 74 px — её фактически не
видно.

После предлагаемых изменений на mobile: 30+80+64+0+0+0+48+36 =
**258 px**. Сетка получает 516 px — видны 2 ряда карточек.

Действия 4–11 — изменения **только под mobile breakpoint
(`@media (max-width: 767px)`)**. На desktop ничего не меняем
(там горизонтального места хватает, текущий layout читается
нормально).

## 3. Целевая структура (mobile)

Сверху вниз:

```
┌─────────────────────────────────────────┐  30  (OS)
├─────────────────────────────────────────┤  80  (header)
│ Тренировка   Прогресс   История  ⋮ⓘ   │  64  (SubNav + actions menu + info)
├─────────────────────────────────────────┤
│ [Все] [Мои] [Реализуй] [Ничью] [⋯] [↺] │  48  (filter chips bar)
├─────────────────────────────────────────┤
│ 62% точность · 116/151 · Полная стат → │  36  (compact stats one-line)
├─────────────────────────────────────────┤
│                                         │
│   [доска]      [доска]                  │ ←─ сетка карточек,
│                                         │     видна сразу
│   [доска]      [доска]                  │
│                                         │
└─────────────────────────────────────────┘
 ▼  MobileBottomBar (Тренировка/Анализ/ТВ/Ещё)  70
```

### 3.1 Filter chips bar

Один горизонтальный ряд pill'ов (chips), скроллится по
горизонтали если не помещается:

- **Authorship**: `[Все]` ↔ `[Мои]` — взаимоисключающие, ровно
  одна активна. Без подписи «Filter» — две pill'ы рядом, активная
  с акцент-фоном.
- **Тип**: `[Реализуй]` `[Ничью]` — обе могут быть выключены =
  «все типы»; одна активна — фильтр по типу. (URL-параметр
  `objective` принимает один из двух или отсутствует.)
- **Pending solved**: `[Показать решённые]` — checkbox-toggle в
  виде pill (активна = `?showSolved=true`).
- **Rating filter pill** (показывается всегда):
  - Если фильтр не активен — `[+ Рейтинг]` (открывает
    bottom-sheet).
  - Если активен — `[Рейтинг 1200–1600 ✕]` (внутри pill — крестик
    для сброса; tap по самой pill — открывает sheet для
    редактирования).
- **Reset**: `[↺]` (icon-only) — появляется только когда есть хотя
  бы один не-дефолтный фильтр; сбрасывает все query-параметры
  фильтрации, оставляя `mine` (это не «фильтр», а основной
  контекст).

URL-state — без изменений (`mine`, `objective`, `showSolved`,
`blundererEloMin/Max`). Это критично для совместимости shareable-
links и тестов.

### 3.2 Bottom-sheet «Рейтинг»

Открывается тапом по pill «+ Рейтинг» / «Рейтинг N–M». Содержит:

- Заголовок «Рейтинг сыгравших».
- Текущие значения «800 — 3000» (или активные).
- Двухсторонний slider (тот же `precision-elo-filter__slider`
  что сейчас на странице, переместить из inline-layout в
  sheet-контент).
- Кнопки «Сбросить» и «Применить» (применение и так
  идёт по дебаунсу — кнопка скорее просто закрывает sheet).

Реализация — CSS bottom-sheet (как в ADR-073 §4 для game-шага):
`position: fixed`, `transform: translateY(...)`, swipe-down для
закрытия. Один snap-point (`half`, ~40% высоты).

### 3.3 Three-dots menu «⋮»

В правом углу `PrecisionSubNav`, рядом с табом «История».
Контекстное меню (dropdown) на mobile:

- «Генерация из PGN» — открывает `PuzzleGeneratorModal` (только
  для авторизованных).
- «Все пазлы» — ссылка на `/puzzles`.

На desktop — three-dots-меню НЕ показываем, оставляем inline-
кнопки в шапке как сейчас.

### 3.4 Info-popover «ⓘ»

Иконка ⓘ рядом с three-dots:

- Tap → tooltip-popover с текстом описания (existing
  `precision.intro`).
- Закрывается по тапу-вне.
- НЕ перекрывает контент (anchored на иконку).

Это лучше «one-time banner» (с close-X на первый заход) —
проще реализовать, нет state «уже видел / не видел», работает
кросс-устройство.

### 3.5 Compact stats — одна строка

Сейчас 3 ячейки (Move accuracy / Preserved-Lost / Full stats →) в
two-row layout. На mobile сжать в одну строку с разделителями `·`:

```
62% точность · 116/151 удержано · Полная статистика →
```

Если не помещается — горизонтальный скролл (как chips-bar).
На desktop — оставить текущий 3-cell layout.

## 4. Что НЕ делаем

- НЕ трогаем глобальный header'а — он общий, focus-mode-паттерн
  (ADR-073) для лобби-страниц не подходит (пользователь активно
  фильтрует, не «зашёл-видишь-доску»).
- НЕ меняем `PrecisionSubNav` — это правильная навигация раздела.
- НЕ объединяем `/precision` / `/precision/stats` / `/precision/
  history` обратно в одну страницу (ADR-057 §2 разделил их
  осознанно).
- НЕ меняем URL-state и DTO. Все query-параметры остаются
  совместимыми (`mine`, `objective`, `showSolved`,
  `blundererEloMin/Max`, `visibility`). Тесты `PrecisionPage.test.tsx`
  и `PrecisionRoute.test.tsx` продолжают работать без диффа.
- НЕ трогаем карточки пазлов — owner-actions, бейджи, формат
  meta остаются как сейчас.
- НЕ убираем `MobileBottomBar` — `/precision` это лобби раздела,
  навигация между разделами нужна.

## 5. Альтернативы и причины отказа

### A. Скрыть header при scroll-down (collapse-on-scroll)

— Отвергнуто: двухуровневый scroll (страница + infinite-scroll
сетки пазлов через IntersectionObserver) делает поведение
непредсказуемым. Плюс focus-mode-паттерн ADR-073 актуален для
просмотра одного экрана (доска), а не для активной фильтрации.

### B. Полный редизайн с filter sidebar (как на десктопе chess.com)

— Отвергнуто: на mobile sidebar — это либо drawer (отдельный
жест), либо bottom-sheet. Drawer для одной страницы — overkill.
Bottom-sheet используем точечно для слайдера рейтинга, не для
всех фильтров. Chips-bar остаются всегда видимы — статус
фильтров читается с одного взгляда.

### C. Унифицированный chip-bar для mobile И desktop

— Отвергнуто как риск: ломает существующие визуальные тесты
desktop-layout'а (segments-tabs протестированы в KS-3147 и др.).
Для одного разработчика разумнее изменение под breakpoint, а
если в дальнейшем chip-вариант понравится — раскатать и на
desktop отдельным тикетом.

### D. Объединить «Authorship» (Все/Мои) с «Тип» (Реализуй/Ничью)
в один dropdown «Фильтры»

— Отвергнуто: добавляет 1 клик к каждому переключению. Authorship
и тип — частые переключения, должны быть в один тап.

## 6. Риски

1. **Horizontal scroll chips на iOS-Safari** — корректно работает
   с `overflow-x: auto; -webkit-overflow-scrolling: touch;`. Без
   `touch` — лагает.
2. **Bottom-sheet и rotation device** — при повороте экрана нужно
   пересчитывать высоту snap-point. Стандартный CSS-приём
   (`vh`-единицы + `resize` listener).
3. **URL-state не должен раcсинхронизироваться с chips-pill'ами.**
   Activate-state pill'а — derived от searchParams (как сейчас).
   Никаких локальных state — pill читает напрямую из URL.
4. **Three-dots в SubNav может перекрыть таб «История»** при
   узких экранах. CSS: SubNav-табы в одной строке без переноса,
   actions-menu рядом, при overflow таб-лейблы сжимаются.
5. **Tests** `PrecisionPage.test.tsx`, `PrecisionRoute.test.tsx`,
   `PrecisionSubNav.test.tsx` — могут сломаться при изменении
   data-testid. Сохраняем существующие testids
   (`precision-tab-all/-mine`, `precision-objective-*`,
   `precision-show-solved-input`, `precision-elo-filter-*`) и
   добавляем новые (`precision-chips-bar`,
   `precision-filter-rating-pill`, `precision-rating-sheet`,
   `precision-actions-menu`). Логика остаётся.
6. **Регрессия на других precision-страницах**
   (`/precision/stats`, `/precision/history`) — НЕ затрагиваются.
   `PrecisionSubNav` меняется (добавляются три точки + ⓘ на
   mobile), но проп-контракт остаётся.
7. **i18n.** Новые pill'ы используют существующие i18n-ключи
   (`precision.tabs.all`, `precision.tabs.mine`,
   `puzzle.objective.convertAdvantage`,
   `puzzle.objective.saveEquality`, `precision.showSolved`,
   `precision.eloFilter.label`). Добавляются только новые
   короткие — `precision.actions.menu`, `precision.filters.reset`,
   `precision.rating.sheetTitle`.

## 7. Реализация — follow-up задачи

Все — frontend и layout. Backend не задействован.
Зависимости: F1 → F2 → L1. F2 можно делать параллельно с F1
если разделить файлы.

### KS-3243 (F1) — `PrecisionFilterChipsBar` + bottom-sheet «Рейтинг»

**Assignee:** frontend.
**Labels:** `puzzle`, `mobile`.
**Описание:**
- Новый компонент `apps/web/src/components/precision/PrecisionFilterChipsBar.tsx`:
  pill'ы Authorship (Все/Мои), Тип (Реализуй/Ничью),
  Show-solved, Rating-pill, Reset-icon. Activate-state читается
  из `useSearchParams`, click меняет URL.
- Bottom-sheet `apps/web/src/components/precision/PrecisionRatingSheet.tsx`:
  переиспользует существующий dual-range slider (перенесён из
  PrecisionPage.tsx line 646–715). Один snap-point (~40%
  высоты), swipe-down закрывает.
- В `PrecisionPage.tsx` под `@media (max-width: 767px)` —
  заменить inline-segments и slider на `<PrecisionFilterChipsBar />`
  (через CSS visibility или branched rendering — выбрать
  CSS-only, чтобы не плодить условный JSX).
**Acceptance:**
- На mobile pills видны в одну строку, активные подсвечены.
- URL-state синхронизирован двусторонне (изменение pill →
  URL → re-render).
- Tap по «+ Рейтинг» открывает bottom-sheet с slider'ом;
  изменения дебаунсятся как сейчас (300 ms).
- На desktop — bottom-sheet не используется, layout как сейчас.
- Тесты: `PrecisionFilterChipsBar.test.tsx`,
  `PrecisionRatingSheet.test.tsx`, в `PrecisionPage.test.tsx`
  добавить smoke на mobile breakpoint.

### KS-3244 (F2) — three-dots menu в SubNav + скрытие H1/desc + info-popover

**Assignee:** frontend.
**Labels:** `puzzle`, `mobile`.
**Зависит:** —
**Описание:**
- В `PrecisionSubNav.tsx` добавить три кнопки справа от табов:
  - «⋮» (only mobile) — dropdown «Генерация из PGN», «Все пазлы».
  - «ⓘ» — popover с текстом `precision.intro`.
- В `PrecisionPage.tsx`: обернуть `<h1>` и `<p.intro>` в
  `<div className="play-vs-engine-puzzles__hero-desktop">` —
  скрывается CSS-ом на mobile.
- Action-кнопки «← Все пазлы», «Генерация из PGN» — обернуть
  в `<div className="play-vs-engine-puzzles__nav-desktop">`,
  тоже скрыть на mobile (дублируются в three-dots).
- Onclick «Генерация из PGN» в three-dots — тот же
  `setShowGenerator(true)`, что и сейчас.
**Acceptance:**
- Mobile: H1, описание, два action-button'а скрыты. SubNav
  содержит ⓘ и ⋮.
- Tap по ⓘ — popover с текстом, tap-вне закрывает.
- Tap по ⋮ — dropdown с двумя пунктами; «Генерация из PGN»
  открывает PuzzleGeneratorModal как сейчас.
- Desktop: layout без изменений.
- Тесты: `PrecisionSubNav.test.tsx` (новые testids
  `precision-actions-menu`, `precision-info-popover`),
  `PrecisionPage.test.tsx` (hero-desktop скрыт на mobile).

### KS-3245 (L1) — CSS chips-bar, bottom-sheet, compact-stats one-line

**Assignee:** layout.
**Labels:** `puzzle`, `mobile`.
**Зависит:** KS-3243, KS-3244.
**Описание:**
- CSS для `.precision-chips-bar`:
  `display: flex; overflow-x: auto; -webkit-overflow-scrolling: touch;
  gap: 8px; padding: 8px 16px;`. Pill: 32 px высоты, скруглённая,
  активная — accent bg + контрастный text.
- CSS для `.precision-rating-sheet` (bottom-sheet):
  `position: fixed; bottom: 0; left: 0; right: 0; transform:
  translateY(...); transition: transform 200ms;`. Handle
  сверху (drag-indicator 32×4 px).
- CSS для one-line `.precision-compact-stats--compact` (mobile-
  only): `flex-direction: row; gap: 12px; font-size: 13px;`
  с `·`-разделителями (через `::after` на не-последних cell'ах).
- CSS для скрытия `__hero-desktop`/`__nav-desktop` на mobile:
  `@media (max-width: 767px) { display: none; }`.
- Safe-area-inset для bottom-sheet (iOS notch).
**Acceptance:**
- На viewport 360×844 виден весь chips-bar (с горизонтальным
  скроллом если pill'ов больше 4); compact-stats в одну
  строку; сетка пазлов видна без скролла страницы.
- На viewport 414×896 — то же.
- На iPhone 15 Pro (с notch) — bottom-sheet не перекрыт
  home-indicator'ом.
- Desktop (≥ 1024 px) — визуально без регрессий
  (Playwright-скриншот существующего layout до/после
  идентичен).

## 8. Что НЕ в этом ADR

- Изменения compact-stats содержимого (другие метрики, не
  только accuracy и preserved/lost) — отдельный feature-запрос.
- Фильтр по дополнительным темам (mate-in-N, endgame-type) —
  отдельный backend-расширение, не в этом ADR.
- Перенос «Генерация из PGN» в /puzzles или отдельный route —
  отдельный UX-вопрос.
- Применение chips-pattern'а к `/puzzles` (puzzle browser) —
  отдельная задача, если выяснится что такой же подход нужен и
  там.

## 9. Откат

- Удалить media-query скрытия hero-desktop / nav-desktop —
  H1/desc/buttons возвращаются на mobile.
- Удалить компоненты `PrecisionFilterChipsBar` /
  `PrecisionRatingSheet` — inline-segments в PrecisionPage
  оставлены под conditional render, можно вернуть.
- Удалить three-dots в `PrecisionSubNav` — он добавляется
  условно.
- URL-state не меняется — никаких миграций пользовательских
  ссылок.
