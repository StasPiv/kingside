# ADR-087. Контекстное меню действий партии в /analysis — UX-паттерн (mobile + desktop)

Статус: предложен (2026-05-29) — аналитический документ
Связано: KS-3419 (этот ADR), KS-3418 (неудачный CSS-фикс),
ADR-076 (chips-bar + rating bottom-sheet),
ADR-080 (themes bottom-sheet с группировкой),
ADR-073 (game step focus-mode + bottom-sheet).

## 1. Контекст и диагноз

Скриншот `/tmp/telegram/326130974_0.jpg` (mobile): overflow-меню
«⋯» в /analysis разваливается — пункты накладываются вертикально
в несколько столбцов, текст налезает на доску. Реактивные
CSS-фиксы (KS-3418, ce4e04c1: nowrap / переносы) дали регрессии.

Корень проблемы: **dropdown с длинными русскими названиями
семантически не помещается на узкий mobile-экран**. CSS-уровневые
обходы (truncate, ellipsis, transform) — симптоматика, а не
паттерн.

Пункты меню (~10, длинные русские названия):
1. Game Info
2. Установить позицию (FEN)
3. Найти партии с этой позиции
4. Скачать PGN
5. Скопировать PGN в буфер обмена
6. Сгенерировать пазл
7. Использовать как новый репертуар
8. Добавить в существующий репертуар
9. Угадай ходы
10. Поделиться

## 2. Решение — единый `AnalysisActionsMenu` с двумя режимами

### 2.1 Один источник, два рендера

Один компонент с двумя визуальными режимами:

- `mode='dropdown'` — desktop (≥ 768 px). Стандартный popover-меню
  с секциями-разделителями.
- `mode='sheet'` — mobile (< 768 px). **Bottom-sheet** с
  collapsible-секциями (паттерн ADR-076/080).

**Единый items-source** — массив описаний (группа / иконка / label
/ action / `enabledFor: 'guest' | 'auth' | 'always'`). Оба рендера
читают тот же массив → drift между mobile и desktop невозможен.
Лечение регрессий — в одном месте.

Это лечит **архитектурную причину**, а не симптом CSS. Дальнейшие
«CSS-фиксы вёрстки dropdown'а на mobile» становятся не нужны —
mobile вообще не использует dropdown.

### 2.2 Группировка пунктов (структура — кросс-устройственная)

10 пунктов → 4 семантические группы:

| Группа | Пункты |
|---|---|
| **Партия / позиция** | Game Info; Установить позицию (FEN); Найти партии с этой позиции |
| **PGN** | Скачать PGN; Скопировать PGN |
| **Тренировки из партии** | Сгенерировать пазл; Угадай ходы; Использовать как новый репертуар; Добавить в существующий репертуар |
| **Шаринг** | Поделиться |

Группировка одинаковая на mobile и desktop — отличается только
визуализация (заголовки секций в sheet / разделители в dropdown).

### 2.3 Что НЕ делаем

- **НЕ сокращаем названия.** Сокращения теряют ясность для
  редких пунктов (новый пользователь не понимает «Реп.»). Sheet
  даёт полную ширину — длинные названия помещаются естественно.
- **НЕ делаем «частые vs остальные» сегрегацию.** «Частоту» не
  знаем, а ввод гипотез добавит непредсказуемости. Группировка по
  смыслу — проще и стабильнее.
- **НЕ изобретаем новый bottom-sheet.** Используем CSS-паттерн
  ADR-076 (rating-sheet) / ADR-080 (themes-sheet): fixed-bottom,
  snap-points, swipe-down закрытие, safe-area-inset.
- **НЕ трогаем desktop dropdown агрессивно** — изменения только
  добавляют section-разделители; layout остаётся.
- **НЕ добавляем иконки в MVP** — итеративно в M2 (ускоряют
  сканирование, но не блокер).

## 3. Mobile — bottom-sheet (детали)

### 3.1 Спецификация

- **Фиксированное позиционирование:** `position: fixed; bottom: 0;
  left: 0; right: 0;` — полная ширина экрана.
- **Высота:** до ~70% viewport'а, `max-height: 70vh` +
  `overflow-y: auto`. Контент скроллится, если не помещается.
- **Snap-points:** один — `expanded` (показан полностью). Закрытие
  через swipe-down или тап-вне или ✕. Без `peek`/`half` — это
  action-list, не filter (не нужно «подсмотреть»).
- **Header sheet'а:** «Действия с партией» (или просто иконка ⋯ +
  закрывающий ✕ в правом углу).
- **Группы:** каждая — заголовок секции (мелким caps-шрифтом) +
  список пунктов. Без collapsible — групп всего 4, схлопывать
  излишне (в отличие от 6 секций × 50 тем в ADR-080).
- **Пункт:** строка ~48 px высоты, full-width tap-target, **полное
  название без сокращений**, опционально иконка слева (M2).
- **Тап по пункту** → действие → sheet закрывается.
- **Backdrop:** полупрозрачный затемнённый, тап вне sheet'а
  закрывает.
- **Safe-area-inset:** `padding-bottom: env(safe-area-inset-bottom)`
  для iPhone home-indicator.

### 3.2 Гость / auth

Часть действий требует auth (репертуары, угадай ходы с persist).
Опции:
- **(А) Скрыть** для гостя — чище visual, но непонятно «куда делось».
- **(Б) Показать disabled** с подписью «Войдите» — обучает.

Рекомендую **(Б)**: пункт виден, но disabled + замок-иконка +
tap → toast «Войдите, чтобы пользоваться этим действием».

### 3.3 Закрытие после действия

После тапа по пункту sheet закрывается СРАЗУ (без ожидания
завершения долгого действия — например, генерация пазла). Долгие
действия показывают свои loading-state'ы поверх контента
страницы, не блокируя sheet.

## 4. Desktop — dropdown (без агрессивных правок)

Изменения **минимальные** (никаких регрессий):
- Те же 4 группы — с **разделителями** между секциями
  (тонкая линия + опц. caps-заголовок группы).
- Длинные названия помещаются — desktop-ширина достаточна.
- Те же items-source и auth-gating.

Если desktop сейчас уже работает (CSS-проблема mobile-only) —
desktop-рендер трогается только в части секций (косметика).

## 5. Существующие mobile-паттерны (для единообразия)

| Существующее | Паттерн | Используется |
|---|---|---|
| `MobileBottomBar` (Тренировка/Анализ/ТВ/Ещё) | fixed-bottom navigation | глобальный, оставляем как есть |
| `PrecisionRatingSheet` (ADR-076) | bottom-sheet, slider, snap | для фильтра рейтинга |
| `PrecisionThemesSheet` (ADR-080) | bottom-sheet, 6 collapsible-секций, checkboxes | для фильтра тем |
| Game step focus-mode (ADR-073) | bottom-sheet sidebar | в просмотрщике шага |
| `/precision` three-dots → dropdown (ADR-076) | desktop dropdown | для actions desktop |

**Bottom-sheet — это уже наш единый паттерн** для overlay-меню на
mobile. Применяем тот же CSS-движок (snap, swipe-down, safe-area).
Никакого «нового мобильного UI».

`AnalysisActionsMenu` отличается от `PrecisionThemesSheet` тем, что
это action-list (без checkboxes), без collapsible (4 группы — не
нужно), один snap-point (полностью открыт).

## 6. Mobile-меню = desktop-dropdown: единый компонент vs два

Опции:
- **A. Два разных компонента** (`AnalysisActionsDropdown` +
  `AnalysisActionsSheet`) — гибко, но дублирование items-list,
  риск drift.
- **B. Единый компонент с двумя render-режимами** — один
  items-source, разные визуализации. Лечит регрессии в одном
  месте.

Выбран **B**. Это прямо устраняет источник KS-3418/KS-3419: drift
между mobile и desktop возникал именно потому, что mobile-вариант
был CSS-ом «адаптированного dropdown'а». Когда mobile = другой
рендер из того же items-array, нет «адаптации» — нет регрессий.

## 7. Где это в коде (предположительно)

В `apps/web/src/pages/AnalysisPage.tsx` или
`apps/web/src/pages/analysis/AnalysisHeader.tsx` сейчас
сосредоточены actions-кнопки. Frontend при реализации:
- Вычленит actions в единый items-array (предположительно есть
  fragmentation — actions раскиданы по компонентам header'а).
- Заменит overflow-меню на `AnalysisActionsMenu` с двумя режимами.

Если actions фрагментированы — это **отдельная задача** F2
(консолидация в items-source).

## 8. Реализация — follow-up задачи

Зависимости: F1 → F2 (если нужна консолидация) → L1.

### KS (F1) — `AnalysisActionsMenu` с двумя режимами

**Assignee:** frontend. **Labels:** `analysis`, `mobile`.
- Новый компонент `apps/web/src/pages/analysis/AnalysisActionsMenu.tsx`
  с props `items: ActionItem[]` (поля: group/label/onClick/
  enabledFor/icon?) и `mode: 'dropdown' | 'sheet'` (или авто-выбор
  по `useIsMobile`).
- Группировка по `item.group` (порядок групп фиксирован).
- `sheet`-режим: bottom-sheet (fixed-bottom, max-height 70vh,
  backdrop, swipe-down, safe-area-inset).
- `dropdown`-режим: popover с section-разделителями.
- Auth-gating: пункты `enabledFor='auth'` для гостя — disabled +
  ⓘ-подсказка.
- Заменить текущий overflow-меню в AnalysisPage.
- Acceptance: на mobile видна bottom-sheet с 4 группами, все 10
  пунктов помещаются без overflow; на desktop dropdown с
  разделителями; гость видит disabled-пункты с подсказкой.

### KS (F2, опц.) — консолидация actions в items-source

**Assignee:** frontend. **Labels:** `analysis`.
**Зависит:** F1 при необходимости.
- Если actions сейчас раскиданы по разным компонентам
  AnalysisHeader — вычленить в единый `useAnalysisActions(): ActionItem[]`
  хук. Обработчики (downloadPgn / copyPgn / shareLink /
  generatePuzzle / createRepertoire / addToRepertoire /
  guessTheMove / openGameInfo / setFen / findGamesByPosition)
  собрать в одном месте.
- Acceptance: один источник actions; нет дубликатов обработчиков
  между mobile/desktop.

### KS (L1) — CSS bottom-sheet + dropdown sections

**Assignee:** layout. **Labels:** `analysis`, `mobile`.
**Зависит:** F1.
- CSS bottom-sheet (повторяет паттерн ADR-076/080):
  fixed-bottom, max-height 70vh, snap (один expanded), backdrop,
  swipe-down indicator, safe-area-inset, header ✕.
- Заголовки секций (caps small-text), item-rows ≥ 48 px tap-target,
  disabled-state.
- Desktop dropdown: section-разделители (тонкая линия) + опц.
  caps-заголовок группы.
- Mobile + desktop в обеих темах (контраст ≥ 4.5:1).
- Acceptance: viewport 360×844 — 10 пунктов в 4 группах помещаются
  без overflow и без CSS-наложений; iPhone home-indicator не
  перекрывает последний пункт; desktop dropdown визуально
  читается с разделителями; никаких регрессий на desktop
  существующих actions.

Backend задач НЕТ — это чисто UI-паттерн. Shared не меняем.

## 9. Риски

1. **Конфликт с MobileBottomBar.** Sheet может перекрываться с
   fixed-bottom bar. Митигация: backdrop поверх bar'а, sheet
   `z-index` выше; ИЛИ скрываем MobileBottomBar пока sheet открыт
   (паттерн ADR-073). Решение в L1.
2. **Размер sheet'а при коротких экранах (iPhone SE 568 px).**
   `max-height: 70vh` = ~400 px → 10 пунктов × ~48 px = 480 px →
   нужен скролл. `overflow-y: auto` решает.
3. **Tap-вне-sheet закрывает.** Стандарт, привычно. Backdrop
   обязателен.
4. **Action long-running (генерация пазла).** Sheet закрывается
   сразу после тапа, loading-state поверх страницы (toast/
   spinner). Не блокируем sheet.
5. **Регрессии на desktop.** Минимизированы — desktop-рендер
   меняется только в части секций (разделители). Если страшно —
   за feature-flag `analysisActionsMenuV2`.
6. **Гость + auth-only пункты.** Disabled+подсказка — UX-выбор.
   Альтернатива — скрыть; решение в F1.

## 10. Откат

- Feature-flag `analysisActionsMenuV2` — выключение возвращает
  старое overflow-меню.
- Bottom-sheet и dropdown — внутри одного компонента; revert F1
  откатывает обе ветки.
- CSS-стили в отдельном файле — не пересекаются с другими
  компонентами.
