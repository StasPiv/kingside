# ADR-073. Шаг урока «Партия» на мобильном — focus-mode и bottom-sheet движка

Статус: предложен (2026-05-21)
Связано: KS-3187 (этот ADR), ADR-072 (тип шага «Партия»),
KS-3183 (адаптив шага), KS-3186 (фикс прыжков вёрстки).

## 1. Проблема

После реализации шага «Партия» (ADR-072) и фикса прыжков вёрстки
(KS-3186) на мобильном экране видна только верхняя часть
просмотрщика: глобальный header, breadcrumbs, заголовок урока,
sticky-прогресс, бейдж шага, заголовок партии, доска и контролы.
Табы «Ходы / Движок / Дерево» обрезаются нижним краем, Stockfish-
панель и CTA «Я разобрал партию» — за экраном. Студенту приходится
скроллить, и каждый раз, когда он смотрит вариант или включает
движок, доска уходит вверх и исчезает.

Источник: `/tmp/telegram/326129889_0.jpg` (Samsung S22-класс, viewport
~610×1234, доска занимает почти всю ширину 580 px).

## 2. Аудит элементов сверху вниз

Высоты — на основе скриншота (масштаб viewport'а, не точные пиксели —
+/- 10%). Считаем при viewport ~844 px (типичный 6.1" Android).

| # | Элемент | Где живёт | Высота | Можно убрать в режиме game? |
|---|---|---|---|---|
| 1 | Системный статус-бар | OS | ~30 | нет |
| 2 | Глобальный header (Kingside Beta + bell/messages/theme/lang/user) | `MainLayout` `<header>` | ~80 | да — collapse до 40 px или скрыть |
| 3 | Breadcrumbs «Уроки / Все курсы» | `LessonPage` | ~40 | да — убрать (есть «Назад») |
| 4 | Заголовок урока «Новый урок» | `LessonPage` | ~50 | да — спрятать в один компактный ряд с прогрессом |
| 5 | Sticky-прогресс «Шаг 1/2 — 2 пройдено (100%)» | `LessonPage` | ~50 | да — урезать до строки 28 px с pill'ом «1/2 · 100%» |
| 6 | Карточка шага: бейдж «#0 ПАРТИЯ» | `StepRenderer` / `GameStep` | ~32 | да — убрать на мобильном (тип очевиден по контенту) |
| 7 | Заголовок партии «Firouzja vs Sindarov 1/2-1/2» | `AnalysisHeader` (embedded) | ~32 | компакт — 1 строка 28 px без аватаров/счёта в отдельной строке |
| 8 | **Доска 8×8** | `AnalysisBoard` | ~580 | НЕТ — главный элемент |
| 9 | Контролы навигации (◀◀ ◀ ▶ ▶▶ ↕) | `AnalysisBoard` controls | ~48 | нет (нужны для навигации) |
| 10 | Табы «Ходы / Движок / Дерево» | `AnalysisSidebar` | ~48 | нет, но переделать в стиле bottom-sheet header |
| 11 | Stockfish-панель / список ходов / дерево | `AnalysisSidebar` | 200+ | да — bottom-sheet (overlay), не часть потока |
| 12 | CTA «Я разобрал партию» | `GameStep` `__actions` | ~56 | sticky-bottom внутри шага |
| 13 | `MobileBottomBar` приложения (Тренировка/Анализ/ТВ/Ещё) | `MainLayout` | ~70 | да — скрыть в focus-mode (паттерн `/game/*`) |

Суммарно «над доской» сейчас: 30+80+40+50+50+32+32 = **314 px**.
«Под доской» (минимум, чтобы CTA был виден): 48+48+200+56+70 = **422 px**.
На доску остаётся: 844 − 314 − 422 = **108 px** — это вообще не видно.

Целевой бюджет (focus-mode):
- Сверху: 30 (статусбар) + 40 (collapsed header c кнопкой «Назад») + 28
  (мини-прогресс) + 28 (заголовок партии) = **126 px**.
- Снизу: 48 (контролы) + 44 (sticky табы / bottom-sheet handle) + 56
  (CTA «Я разобрал») = **148 px**. `MobileBottomBar` приложения скрыт.
- На доску: 844 − 126 − 148 = **570 px** — комфортно для 8×8 на ширине ~610.

## 3. Целевой layout (focus-mode для game на мобильном)

### 3.1 Принцип

Шаг типа `game` на мобильном (viewport < 768 px) автоматически
переключает страницу урока в **focus-mode**. На desktop — без изменений
(там и так двухколоночный layout, всё помещается).

Focus-mode — не отдельный route, а флаг состояния `LessonPage`,
который через React-context уведомляет `MainLayout` свернуть шапку и
скрыть `MobileBottomBar`. Тот же паттерн уже применён для `/game/*`
(см. `MainLayout.tsx:121`: `hideBottomBar = location.pathname.startsWith('/game/')`)
— расширяем его на состояние, а не на pathname.

### 3.2 Слои сверху вниз в focus-mode

1. **Compact header (40 px)** — `MainLayout` сворачивает шапку до
   единственной строки: «← Назад к уроку» (закрывает focus-mode либо
   уводит на `/lessons/:slug`, если шаг открыт самостоятельно).
   Логотип, тема, язык, профиль — скрыты (доступны через выход).
2. **Мини-прогресс (28 px)** — sticky-полоса под header'ом:
   `Шаг 1/2 · ████░░ 50%`. Без слов «пройдено». Высота 28 px,
   font-size 13.
3. **Заголовок партии (28 px)** — компактная строка: цвет (●) +
   фамилия игрока + рейтинг, через тире результат, через тире вторая
   сторона. Без аватаров и второй строки. Источник —
   `AnalysisHeader` в режиме `mode='embedded-compact'`.
4. **Доска (≈ width)** — без изменений, квадратная, центрирована.
5. **Контролы (48 px)** — без изменений (5 кнопок навигации + flip).
6. **Sidebar = bottom-sheet** — табы «Ходы / Движок / Дерево»
   превращаются в *handle* bottom-sheet'а:
   - Свернутое состояние (`peek`): только табы (44 px), содержимое
     скрыто.
   - Полусвернутое (`half`): доска уменьшается до 60% высоты,
     bottom-sheet перекрывает 40% (показывает выбранный таб).
   - Развернутое (`full`): doska 240 px, sheet занимает оставшееся.
   Переключение свайпом по handle или тапом по табу.
7. **CTA «Я разобрал партию» (56 px)** — sticky внутри шага, под
   bottom-sheet'ом в свёрнутом состоянии, либо над ним в half/full
   (всегда видна). После клика — `state='done'`, кнопка disabled
   «Пройдено ✓».

### 3.3 Что НЕ виден в focus-mode

- Breadcrumbs «Уроки / Все курсы» — скрыто. Возврат через «← Назад».
- Заголовок урока («Новый урок») — скрыто. Виден только при выходе из
  focus-mode (на CoursePage и LessonsPage).
- Бейдж «#0 ПАРТИЯ» — скрыто (тип очевиден из содержимого, нумерация
  есть в мини-прогрессе «Шаг 1/2»).
- `MobileBottomBar` приложения — скрыто (как в активной партии).
- В compact header: лого, тема, язык, профиль, bell, messages —
  скрыто.

### 3.4 Что добавляется

- Кнопка «×» в верхнем правом углу compact header — мгновенный
  выход в `/lessons/:courseSlug` (на список уроков курса). На случай,
  если «← Назад» не очевиден (он закрывает focus-mode, но если шаг —
  единственный экран в стеке, ведёт на список).
- Опционально (M2) — кнопка «↗» рядом, открывает партию в полноценной
  мастерской (`/analysis/public/:id` если `source.sourceType ===
  'workshop_analysis'`, иначе не показываем).

## 4. Bottom-sheet — детали

Используем стандартный паттерн bottom-sheet:

- 3 snap-точки: `peek` (44 px), `half` (~40% высоты), `full` (~60%).
- Свайп вверх/вниз по handle.
- Тап по неактивному табу при `peek` — раскрытие до `half`.
- Тап по активному табу при `half`/`full` — сворачивание до `peek`.
- При раскрытии `half`/`full` доска уменьшается синхронно (CSS-grid с
  `auto`-рядами + `transition` 200 ms на высоту контейнера доски).
- Внутри sheet — содержимое выбранного таба:
  - **Ходы** — линейный список ходов с подсветкой текущего ply.
  - **Движок** — `Stockfish 18 (WASM)` + контролы depth, eval, лучшие
    линии. На мобильном `peek` — только заголовок «Движок · Выключен»;
    `half` — старт-кнопка, eval, 1 линия; `full` — 3 линии.
  - **Дерево** — opening explorer и дерево вариантов.

Реализуется CSS-only (нет нужды в библиотеке) на `position: fixed` +
`transform: translateY(...)` + `touch-action: pan-y`.

## 5. Альтернативы

### A. Collapse-on-scroll глобального header'а (без focus-mode)

Header сворачивается при скролле вниз, разворачивается при скролле
вверх. Применяется на всех страницах, не только в game-шаге.

— Отвергнуто: scroll внутри страницы LessonPage и внутри embedded
AnalysisSidebar — двухуровневый, intersection observer'у тяжело
понять, какой именно scroll отслеживать. Плюс не решает другие
утечки (breadcrumbs, заголовок урока, бейдж, mobile-bar) — высоты
по-прежнему не хватает.

### B. Открыть game-шаг в отдельном полноэкранном route

Например `/lessons/:slug/:lesson/step/:stepId/game-viewer` с минимальным
шеллом (как `/precision/attempts/:id`).

— Отвергнуто: ломает паттерн «шаг — экран урока», прогресс-навигация
между шагами должна оставаться доступна. Плюс требует новых route'ов,
back-button-поведения, broken-state для refresh. Focus-mode даёт ту же
полезную поверхность без отдельного route.

### C. Использовать накладной модал (overlay sheet) при тапе на доску

Доска маленькая, по тапу — открывается fullscreen-модал «Просмотр
партии».

— Отвергнуто: лишний взаимодействие, неочевидно для пользователя,
теряем sidebar в основном состоянии. Сложнее тесты.

## 6. Риски

1. **Не сломать desktop.** Все изменения — за `@media (max-width:
   767px)`. Focus-mode-context на desktop игнорируется (его значение
   читает только мобильный CSS). Юнит-тест: на desktop layout
   LessonPage и MainLayout не меняется при `focusMode=true`.
2. **Не сломать другие типы шагов (text/puzzle/quiz/diagram).**
   Focus-mode активируется ТОЛЬКО для шагов типа `game` на мобильном.
   Для остальных типов `LessonPage` ведёт себя как сейчас. Условие —
   `currentStep.type === 'game' && isMobile`.
3. **Bottom-sheet vs Stockfish-worker.** При свёртывании sheet
   движок не должен останавливаться (он работает в WebWorker,
   независимо от visibility DOM). Юнит-тест: bottom-sheet collapse →
   Stockfish worker `alive` (через ref).
4. **Sticky CTA и iOS safe-area.** Sticky-кнопка «Я разобрал партию»
   должна учитывать `env(safe-area-inset-bottom)` (iPhone X+).
   Стандартный CSS-приём.
5. **Navigation в focus-mode.** Кнопка «← Назад» при exit'е focus-mode
   возвращает на `/lessons/:slug` (список уроков курса). НЕ на
   browser history, чтобы не уйти случайно в `/lessons` лобби.
6. **MainLayout-context.** Расширение `MainLayout` на чтение
   focus-flag из context'а — изменение зоны frontend'а, не layout'а.
   Координация: задача F (см. §7) меняет и `MainLayout.tsx`, и
   `LessonPage.tsx`, и `GameStep.tsx`.
7. **Тесты на breakpoint.** Текущие тесты `LessonPage.test.tsx`
   работают в jsdom без реального viewport'а. Добавляем
   `matchMedia`-mock для проверки focus-mode trigger'а.
8. **Регрессия на embedded `AnalysisPage`.** В embedded-режиме сейчас
   рендерится полный `AnalysisHeader`. Для focus-mode добавляем
   режим `compact` (новый prop). Изменение `AnalysisHeader.tsx`
   локализованное, не влияет на `/analysis/:id` и
   `/analysis/public/:id`.

## 7. Реализация — follow-up задачи

Приоритет P1 (этот аудит = блокер для UX мобильной аудитории).
Backend здесь не задействован — никаких новых endpoint'ов, типов или
миграций. Зависимости: F1 → F2 → L1.

### KS-3188 (F1) — focus-mode context + интеграция в MainLayout / LessonPage

**Assignee:** frontend.
**Labels:** `lessons`, `mobile`.
**Описание:**
- Завести `FocusModeContext` (`apps/web/src/context/FocusModeContext.ts`):
  `{ focusMode: boolean; setFocusMode: (v: boolean) => void }`.
- `MainLayout` оборачивает дерево в `<FocusModeProvider>`. Читает
  `focusMode` — при `true` И mobile breakpoint скрывает
  `MobileBottomBar` и переключает `<header>` в compact-режим
  (CSS-класс `header--compact`, см. L1).
- `LessonPage` при `currentStep.type === 'game' && isMobile` (через
  `useMediaQuery('(max-width: 767px)')`) ставит `focusMode = true`;
  при размонтировании / переключении на другой шаг — `false`.
- Кнопка «Назад» в compact header при focus-mode уводит на
  `/lessons/:courseSlug`.
**Acceptance:**
- На странице `/lessons/<slug>/<lesson>` с шагом game на мобильном:
  `<MobileBottomBar />` не рендерится; в `<header>` остаётся только
  «← Назад к уроку».
- На том же шаге на desktop (≥ 1024 px): layout без изменений.
- Переключение на любой другой тип шага (text/puzzle/quiz/…)
  возвращает обычный layout.
- Тесты: `MainLayout.test.tsx` (focusMode=true → нет
  MobileBottomBar), `LessonPage.test.tsx` (focusMode активируется на
  game-шаге при mock matchMedia).

### KS-3189 (F2) — embedded-compact для AnalysisHeader + скрытие лишнего в GameStep / LessonPage

**Assignee:** frontend.
**Labels:** `lessons`, `mobile`.
**Зависит:** KS-3188.
**Описание:**
- Расширить props `AnalysisPage` (или внутренний state `embedded`)
  новым флагом `embeddedCompact?: boolean`. При `true`
  `AnalysisHeader` рендерится одной строкой (28 px): цвет + игрок +
  рейтинг — тире — результат — тире — соперник. Без аватаров, без
  раздельных строк.
- В `GameStep.tsx`: при `isMobile` пробрасывать
  `embeddedCompact={true}`. Бейдж `#N ПАРТИЯ` не рендерить (или скрыть
  CSS в focus-mode).
- В `LessonPage.tsx`: при `focusMode` скрывать breadcrumbs, заголовок
  урока, sticky-прогресс в текущем виде; рендерить мини-прогресс (28
  px) `Шаг N/M · ████░░ X%`.
**Acceptance:**
- На мобильном game-шаге не видно: breadcrumbs, заголовок урока,
  бейдж `#N`, старый sticky-прогресс.
- Видно: compact header (40), мини-прогресс (28), компактный заголовок
  партии (28), доска, контролы, табы.
- На desktop никакого `compact` (доска, header — старый формат).
- Тесты: `AnalysisHeader.test.tsx` (compact-вариант), `GameStep.test.tsx`
  (compact prop пробрасывается на mobile).

### KS-3190 (F3) — bottom-sheet для табов «Ходы / Движок / Дерево» в embedded-режиме

**Assignee:** frontend.
**Labels:** `lessons`, `mobile`.
**Зависит:** KS-3188, KS-3189.
**Описание:**
- В `AnalysisSidebar` добавить мобильный режим — bottom-sheet с 3
  snap-точками (`peek` / `half` / `full`). Активируется только в
  focus-mode (через FocusModeContext) и mobile breakpoint.
- На desktop и в обычном `/analysis/:id` — sidebar как сейчас (правая
  колонка).
- Свайп по handle переключает snap. Тап по табу — раскрывает до
  `half`. Stockfish-worker не останавливается при `peek`.
- Доска синхронно уменьшается при `half` / `full` (CSS-grid auto-rows
  + transition 200 ms).
**Acceptance:**
- На мобильном game-шаге sidebar — bottom-sheet, по умолчанию
  свёрнут до `peek` (видны только табы).
- Свайп/тап раскрывает sheet до `half`; повторный — до `full`;
  обратный свайп — обратно.
- Доска видима во всех состояниях (минимум 240 px при `full`).
- CTA «Я разобрал партию» — sticky внутри `GameStep`, видна и при
  свёрнутом, и при раскрытом sheet.
- На desktop sidebar остаётся справа без изменений.
- Тесты: `AnalysisSidebar.test.tsx` (bottom-sheet рендер при flag'е);
  Playwright-скрин (опционально через `record_gif`).

### KS-3191 (L1) — стили compact header / mini-progress / sticky CTA / safe-area

**Assignee:** layout.
**Labels:** `lessons`, `mobile`.
**Зависит:** KS-3188.
**Описание:**
- CSS для `header--compact` (40 px высоты, только «← Назад», без
  лого/иконок).
- CSS для мини-прогресса (28 px, pill «Шаг N/M», прогресс-полоса).
- CSS для compact `AnalysisHeader` (28 px, single row, ellipsis на
  длинных именах).
- CSS для bottom-sheet (snap-точки, handle, плавность transform).
- `safe-area-inset-bottom` для sticky CTA «Я разобрал партию» (iOS).
- Никаких изменений цветов/тем — только сетка и геометрия.
**Acceptance:**
- Viewport 360×844: на game-шаге без скролла видны доска + контролы +
  табы (минимум `peek` bottom-sheet'а) + CTA «Я разобрал партию».
- Viewport 414×896 (iPhone 11/12 Pro Max): то же.
- iPhone 15 Pro (с notch + home-indicator): sticky CTA не перекрыт
  системной полосой.
- Desktop (≥ 1024): layout без визуальных регрессий — Playwright-
  скриншот старого `/analysis/:id` и `/lessons/:slug/:lesson` (с
  text-шагом) идентичны до/после.

## 8. Откат

- Снять activation focus-mode в `LessonPage` (одна строка) — мобильный
  layout сразу вернётся к текущему.
- `FocusModeContext` остаётся в коде (no-op без активации) или
  удаляется одним коммитом.
- CSS-классы `header--compact`, `sidebar--bottom-sheet` ничего не
  ломают при отсутствии активации (`focusMode=false`).

## 9. Что НЕ в этом ADR

- Нумерация шага с нуля (`#0 ПАРТИЯ`) — отдельный микро-фикс, не
  входит в focus-mode.
- Микро-копирайтинг прогресса («2 пройдено (100%)») — отдельная
  i18n-задача.
- Open Graph / share-меню партии — отдельный feature-запрос.
- Collapse-on-scroll глобального header'а вне game-шага — не
  рассматриваем (см. §5 A).
