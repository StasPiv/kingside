# KS-1132: Убрать Features из хедера, добавить в сайдбар; сайдбар на всех страницах

## 1. Текущее состояние

### Features в хедере
- `MainLayout.tsx`, строка 159: `<Link to="/features" className="header-features-link">`
- CSS: `layout.css`, строки 490-500 (`.header-features-link`)

### Sidebar
- Компонент: `apps/web/src/components/Sidebar.tsx`
- 56px ширина, иконки с tooltip на hover
- 9 элементов: Play, Tournaments, Puzzles, PuzzleRush, Workshop, TV, (divider), Friends, Settings
- На мобиле (≤768px) скрыт, вместо него `MobileBottomBar`

### Почему сайдбар не виден на некоторых страницах

**Причина — строка 139 в `MainLayout.tsx`:**
```tsx
const hideNav = location.pathname.startsWith('/game/') || location.pathname.startsWith('/analysis');
```

**Строка 278:**
```tsx
{user && !hideNav && <Sidebar />}
```

Это скрывает сайдбар на:
- `/game/:id` — страница игры
- `/analysis` — страница анализа (включая `/analysis/:id`, `/game/:gameId/review`)

### Почему скрывали
Страницы game и analysis используют полноэкранный layout (`height: 100vh/100dvh`, `overflow: hidden`). Сайдбар занимал бы 56px от ширины доски. CSS для этих страниц (`layout.css` строки 312-355) убирает max-width и padding у `.main`.

## 2. Решение

### 2.1 Удалить Features из хедера
- Удалить `<Link to="/features">` из `MainLayout.tsx` (строка 159)
- Удалить CSS `.header-features-link` из `layout.css` (строки 490-500)

### 2.2 Добавить Features в сайдбар
Добавить в `NAV_ITEMS` в `Sidebar.tsx` новый элемент перед divider:

```typescript
{ path: '/features', icon: '✨', i18nKey: 'nav.features', match: ['/features'] },
```

Позиция: после TV (📺), перед divider. Features — информационная страница, логично разместить рядом с TV/broadcasts.

### 2.3 Показать сайдбар на ВСЕХ страницах

**Убрать `hideNav` из условия рендеринга Sidebar:**
```tsx
// БЫЛО:
{user && !hideNav && <Sidebar />}
// СТАЛО:
{user && <Sidebar />}
```

**CSS доработки для game-page и analysis-page:**

Сайдбар 56px должен корректно сосуществовать с полноэкранными страницами. Структура `.app-body` уже flex-контейнер с сайдбаром и `.main` — нужно убедиться, что CSS-правила для game/analysis не ломают этот flex.

Текущие CSS-правила `.app:has(.game-page)` и `.app:has(.analysis-page)` задают `height: 100vh` на `.app`. Это корректно — `.app-body` внутри будет flex-ом с sidebar + main.

Нужно проверить, что `.main:has(.game-page)` и `.main:has(.analysis-page)` корректно работают с `flex: 1` при наличии sidebar. Сайдбар `flex-shrink: 0` — он не сжимается, `.main` займёт оставшееся пространство.

**MobileBottomBar** — отдельный вопрос. На мобиле `hideNav` также скрывает `MobileBottomBar`. Для game/analysis на мобиле bottom bar, скорее всего, тоже нужен. Но это может потребовать отдельной проверки — на мобиле доска уже занимает весь экран.

Рекомендация: оставить `hideNav` только для `MobileBottomBar` на game-страницах (во время активной игры bottom bar мешает), но показывать на analysis:

```tsx
const hideBottomBar = location.pathname.startsWith('/game/');

{user && <Sidebar />}
{user && !hideBottomBar && <MobileBottomBar />}
```

## 3. Потенциальные проблемы

1. **Analysis page layout** — доска рассчитывает доступное пространство. После добавления sidebar (56px) доска станет на 56px уже. Нужно проверить, что расчёт размера доски адаптивен (использует `flex` или `calc`).

2. **Game page layout** — аналогично. GamePage имеет собственный `game-sidebar` справа. Добавление навигационного сайдбара слева создаст layout: [nav-sidebar 56px] [board] [game-sidebar]. Нужно проверить, что доска правильно сжимается.

3. **Мобильная версия** — sidebar скрыт на ≤768px (`display: none`). На мобиле навигация через `MobileBottomBar`. Features нужно добавить и туда.

## 4. Разбивка на задачи

### Задача 1: Frontend — убрать Features из хедера, добавить в сайдбар
**Исполнитель**: frontend
**Объём**: малый

- Удалить `<Link to="/features">` из `MainLayout.tsx`
- Добавить `{ path: '/features', icon: '✨', i18nKey: 'nav.features', match: ['/features'] }` в `NAV_ITEMS` в `Sidebar.tsx`
- Добавить Features в `MobileBottomBar` (если ещё нет)

### Задача 2: Frontend + Layout — показать сайдбар на всех страницах
**Исполнитель**: frontend (логика) + layout (CSS)
**Объём**: средний

- Убрать `hideNav` из условия рендеринга `<Sidebar />`
- Скорректировать CSS для `.app:has(.game-page)` и `.app:has(.analysis-page)`, чтобы sidebar корректно вписывался
- Проверить, что размер доски адаптируется к наличию sidebar (56px уже)
- Решить поведение `MobileBottomBar` на game/analysis (рекомендация: скрывать только на `/game/` во время активной игры)
- Тестирование layout на desktop и mobile

### Порядок
Задачи можно выполнять параллельно, но задача 2 включает проверку layout после изменений задачи 1.

## 5. Затронутые файлы

| Файл | Изменение |
|------|-----------|
| `apps/web/src/layouts/MainLayout.tsx` | Удалить Features link, убрать hideNav для Sidebar |
| `apps/web/src/components/Sidebar.tsx` | Добавить Features в NAV_ITEMS |
| `apps/web/src/styles/layout.css` | Удалить `.header-features-link`, возможно скорректировать CSS game/analysis |
| `apps/web/src/components/MobileBottomBar.tsx` | Добавить Features (если нет) |
