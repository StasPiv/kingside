# ADR-049 — User courses: подтянуть редактор до спецификации системных уроков

- Статус: Proposed
- Дата: 2026-05-07
- Связанные задачи: KS-2568
- Связанные ADR: ADR-026 (user-courses), ADR-029 (custom puzzles в user-course steps)
- Связанные документы: `docs/architecture/KS-2015-lesson-file-format.md` (8 типов шагов системного урока)
- Авторы: architect

---

## 1. Контекст

Редактор кастомных курсов (`/lessons/my/:slug/edit`, `apps/web/src/components/lessons/editor/user/UserCourseEditor.tsx`) предлагает пользователю три типа шагов: **Лекция** (`text`), **Задача** (`puzzle`), **Эндшпиль** (`endgame_drill`). Системные уроки поддерживают восемь (KS-2015 §1.1, `LessonStepType`):

| Тип | В системных | В user-courses (сейчас) | Назначение |
|-----|-------------|-------------------------|------------|
| `text` | ✓ | ✓ | Текст с диаграммами (FEN, **arrows[]**, **highlightedSquares[]**), `{{diagram:N}}` плейсхолдеры или inline ` ```fen ``` ` блоки |
| `puzzle` | ✓ | ✓ | `selection.mode` ∈ `ids` / `filter` / `custom` (ADR-029) |
| `endgame_drill` | ✓ | ✓ | FEN + playerSide + winCondition + skillLevel |
| `quiz` | ✓ | ✗ | Вопросы с вариантами ответа, опц. `fen` и `explanation` |
| `position` | ✓ | ✗ | FEN + опц. `expectedMoves[]` (UCI) — read-only / интерактивный шаблон |
| `video` | ✓ | ✗ | YouTube/Vimeo URL + опц. title |
| `game_review` | ✓ | ✗ | Партия с комментариями (по `gameId` или PGN) |
| `opening_drill` | ✓ | ✗ | PGN-дерево + playerSide + onDeviation |

**Жалоба пользователя**:
1. **Квиз** — отсутствует в редакторе, хотя viewer (`apps/web/src/components/lessons/steps/QuizStep.tsx`) и shared-тип `QuizStepPayload` готовы.
2. **Иллюстративная диаграмма со стрелками** — формально часть `text`-шага через `TextStepPayload.diagrams[].arrows[]`. Viewer (`TextStep.tsx`) уже рендерит arrows и highlightedSquares (строки 304-336). Но в редакторе user-courses нет визуального инструмента — автор не может «нарисовать стрелку», только руками вписать JSON, что для не-разработчика недоступно.

Цель ADR — спроектировать расширение редактора до полного набора 8 типов с приоритизацией по запросу пользователя и переиспользованием уже готовых viewer-компонентов и API-валидаторов.

### 1.1 Что уже подготовлено архитектурно

Это очень важная находка — расширение **тривиальное на уровне схемы**, основная работа сосредоточена в UI-редакторе.

1. **Backend DTO явно готов к расширению** — `apps/api/src/lessons/user-courses/dto/user-step-payload.dto.ts:40-46`:
   > Контроль за расширением: добавляя 4-й тип, нужно:
   > 1. Внести его в `ALLOWED_USER_STEP_TYPES`.
   > 2. Добавить его DTO в `USER_STEP_PAYLOAD_SUBTYPES`.
   > 3. Обновить `UserStepType` в `@kingside/shared`.
   > 4. Обновить UI-select в `StepEditor`.
   > **Ничего в БД/миграциях менять не надо.**

   Системные DTO (`TextStepPayloadDto`, `QuizStepPayloadDto`, `PositionStepPayloadDto`, `VideoStepPayloadDto`, `GameReviewStepPayloadDto`, `OpeningDrillStepPayloadDto`) лежат в `apps/api/src/lessons/dto/step-payload.dto.ts` и переиспользуются как есть. Для `puzzle` уже сделан отдельный `UserPuzzleStepPayloadDto` с пониженным лимитом `1..20` (anti-abuse, ADR-026 §2.2) — паттерн понятен, можно скопировать для других типов если потребуется ограничение.

2. **Shared-тип `StepPayload` общий** — `packages/shared/src/types/user-courses.ts:84-86`: «`UserLessonStep.payload` дискриминирован тем же общим shared-union». Никаких отдельных типов для user-courses нет, всё переиспользуется.

3. **Viewer-компоненты готовы**: `QuizStep`, `PositionStep`, `VideoStep`, `GameReviewStep`, `OpeningDrillStep`, `EndgameDrillStep`, `TextStep` (с поддержкой arrows/highlightedSquares — `apps/web/src/components/lessons/steps/TextStep.tsx:304-336`). `UserCoursePage.tsx` уже умеет рендерить любой `StepPayload` через те же компоненты — это унаследовано из ADR-026.

4. **`emptyStepPayload(type)` в редакторе** (`apps/web/src/types/editor.ts:93-143`) **уже** имеет дефолты для **всех 8 типов** — функция написана под универсальный `LessonStepType`, не под `UserStepType`. То есть стартер-payload готов, нужно только разрешить выбор типа в UI.

5. **Drawing-инструмент стрелок и подсветок клеток** — `react-chessboard` нативно поддерживает arrows через `arrows` prop (использовано в TextStep:336) и `squareStyles` для highlights (TextStep:311-321). User-driven рисование стрелок реализовано в `apps/web/src/pages/AnalysisPage.tsx` через right-click через `useSquareHighlights` + `annotationColorByModifiers` (импортируется в AnalysisPage.tsx:24, 870, 900, 925-991). Логика правый-клик-на-клетке → highlight, правый-клик-drag → arrow, modifiers (Shift/Alt) → color. Есть готовый и протестированный код.

То есть схема, валидация, рендер и инструмент рисования — **всё есть**. Не хватает: API-whitelist расширения + UI-редакторов под каждый тип шага в user-courses Editor + переиспользуемого `<DiagramEditor>` для редактирования `TextStepPayload.diagrams[]` визуально.

---

## 2. Решение

### 2.1 Что добавляем

Расширяем whitelist `UserStepType` с 3 до **всех 8** типов системного урока. Группируем по тирам приоритета:

| Tier | Типы | Обоснование |
|------|------|-------------|
| **Tier 1** (явный запрос пользователя) | `quiz` + визуальный редактор диаграмм со стрелками в `text` | Прямая жалоба KS-2568 |
| **Tier 2** (понятная польза, простые редакторы) | `position`, `video` | Лёгкие в реализации, расширяют арсенал автора |
| **Tier 3** (специальные, тяжёлые редакторы) | `game_review`, `opening_drill` | Нужны редкие сценарии; PGN-tree редактор / game picker — отдельная история |

ADR покрывает все три тира. Декомпозиция в §3 разнесена так, чтобы Tier 1 можно было выкатить отдельно, не дожидаясь Tier 2/3.

### 2.2 Архитектурные решения

#### 2.2.1 Schema БД и API

**Без изменений** на уровне БД (`UserLessonStep.payload` JSONB как есть). Расширение исключительно в whitelist API:

- `apps/api/src/lessons/user-courses/user-courses-limits.ts` — массив `ALLOWED_USER_STEP_TYPES`.
- `apps/api/src/lessons/user-courses/dto/user-step-payload.dto.ts` — `USER_STEP_PAYLOAD_SUBTYPES` (импортируем системные DTO).
- `packages/shared/src/types/user-courses.ts:30` — `UserStepType` union.

Как реюзаем системные DTO:
- `quiz` — переиспользуем `QuizStepPayloadDto` системный (как уже делается с `TextStepPayloadDto`).
- `position` — переиспользуем `PositionStepPayloadDto`.
- `video` — переиспользуем `VideoStepPayloadDto`.
- `game_review` — переиспользуем `GameReviewStepPayloadDto`.
- `opening_drill` — переиспользуем `OpeningDrillStepPayloadDto`.

Если в будущем понадобится **снизить лимиты** для каких-то типов под user-courses (как сделано для `puzzle.selection.filter.limit` 1..20 vs 1..100) — паттерн через отдельный класс уже есть, легко добавить. На MVP анти-абьюз лимиты пишем только если нужно (см. §2.5).

#### 2.2.2 UI-редакторы — дизайн компонентов

Каждый тип шага в редакторе — компонент `Step{Type}Editor.tsx`. Контракт:

```ts
interface StepEditorProps<TPayload extends StepPayload> {
  payload: TPayload;
  onChange: (next: TPayload) => void;
}
```

Уже есть в проекте паттерн (`StepEditor.tsx` или эквивалент в user-courses папке). Расширяем его switch-case на новые типы.

**`<TextStepEditor>` (Tier 1, ключевой)**:

- `<textarea>` для `bodyMarkdown` (есть).
- Список `diagrams[]` с UI кнопкой «Добавить диаграмму» — каждая открывает `<DiagramEditor>` (новый компонент, см. §2.2.3).
- Drag-reorder диаграмм (опционально, как в шагах).
- Превью markdown справа с подстановкой `{{diagram:N}}` (если уже есть — переиспользуем).

**`<QuizStepEditor>` (Tier 1)**:

- Список `questions[]`. Каждый вопрос:
  - `<input>` для `prompt`.
  - Опционально FEN-picker для `fen` (через `<DiagramEditor>` без arrows-режима).
  - Список `options[]` (текст + checkbox «правильный»).
  - `<textarea>` для `explanation`.
- Кнопка «Добавить вопрос». Drag-reorder. Удаление.

**`<PositionStepEditor>` (Tier 2)**:

- FEN-picker (через `<DiagramEditor>` или mini chessboard с pgn-input/paste-FEN).
- `<select>` для `orientation` ('white' | 'black').
- Список `expectedMoves[]` (UCI), вводимый через interactive mode на доске (проиграть ходы, кнопка «зафиксировать как ожидаемые»).

**`<VideoStepEditor>` (Tier 2)**:

- `<input>` для `url` (валидация на whitelist YouTube/Vimeo на FE-стороне зеркалируем backend-правило KS-1796).
- `<input>` для `titleI18nKey` (опц.).
- Превью embed — переиспользуем `VideoStep` viewer.

**`<GameReviewStepEditor>` (Tier 3)**:

- Радиокнопки: «По `gameId`» / «PGN».
- Если gameId — game-picker (поиск по своим архив-играм через GET /archive/games?owner=me — отдельный API-вопрос).
- Если PGN — `<textarea>` с paste, валидация через `chess.js#loadPgn` на blur.

**`<OpeningDrillStepEditor>` (Tier 3, тяжёлый)**:

- PGN-дерево редактор переиспользуем из Workshop / `useReviewState` (уже есть в проекте). Это серьёзная интеграция — отдельный тикет.
- `<select>` `playerSide`, `onDeviation`, опц. `engineSkillLevel`.

#### 2.2.3 `<DiagramEditor>` — переиспользуемый визуальный редактор диаграммы

Главный новый shared-компонент. Используется в TextStepEditor (для `diagrams[]` записи), QuizStepEditor (для опц. `fen`), PositionStepEditor (для основной позиции), GameReviewStepEditor (для startFen).

Контракт:

```ts
interface DiagramEditorProps {
  fen: string;
  caption?: string;
  orientation?: 'white' | 'black';
  arrows?: DiagramArrow[];
  highlightedSquares?: DiagramHighlight[];
  onChange: (next: {
    fen: string;
    caption?: string;
    orientation?: 'white' | 'black';
    arrows: DiagramArrow[];
    highlightedSquares: DiagramHighlight[];
  }) => void;
  /** Скрыть инструменты рисования (для чистого FEN-picker'а в quiz). */
  drawingDisabled?: boolean;
}
```

Реализация:

- `react-chessboard` с `arrows` и `squareStyles` props (как в TextStep:336). Дополнительно для редактора:
  - Drag фигур → меняем FEN. Через `chess.js` валидируем легальность позиции (или разрешаем нелегальные для иллюстраций — обсудим в layout-тикете).
  - Right-click drag (или alt+click) → добавить arrow `{from, to, color}`.
  - Right-click клетка → toggle highlight `{square, color}`.
  - Цвет — через modifier-keys (Shift = красный, Alt = синий, default = жёлтый), как в AnalysisPage. Перенесём `useSquareHighlights` / `annotationColorByModifiers` хук из `apps/web/src/hooks/` в shared доступ — он уже там, просто переиспользуем (импорт в AnalysisPage:24).
- Кнопки: «Очистить стрелки», «Очистить выделения», «Сбросить FEN» (на стартовую).
- `<input>` для `caption` под доской.
- `<select>` для `orientation`.
- Mode-toggle: «Drag pieces / Draw arrows» — на mobile (где right-click и modifier-keys работают плохо).

Файл: `apps/web/src/components/lessons/editor/shared/DiagramEditor.tsx`. Тесты — на отрисовку, на onChange при добавлении стрелки, на mobile-mode toggle.

#### 2.2.4 PGN-tree editor для `opening_drill`

Самый тяжёлый кусок Tier 3. В проекте уже есть PGN-дерево reducer (`apps/web/src/review/useReviewState.ts`), используемый Workshop'ом. Можно переиспользовать.

Альтернатива MVP: textarea с PGN-вставкой + рендер дерева read-only под textarea. Автор пишет PGN руками (в стандартном формате с вариантами `(...)`), мы парсим и показываем. Это упрощённый редактор, но достаточный для часто-кейса (автор уже подготовил PGN в lichess/SCID и вставляет).

**Решение**: на MVP делаем **textarea + read-only preview tree**. Полноценный визуальный редактор — открытый вопрос, отдельный ADR/тикет.

### 2.3 Что НЕ меняем

- **БД-схема** `UserLessonStep` — как есть.
- **Семантика прогресса / SM-2 / completion** — без изменений.
- **Anti-abuse лимиты** для `puzzle` (1..20 вместо 1..100) — оставляем; для других типов добавим только если выявится злоупотребление (на MVP — без лимитов на размер `quiz.questions`, `text.diagrams`, `position.expectedMoves` сверх backend-defaults; backend-DTO-валидация уже есть).
- **i18n** — пользовательские курсы по дизайну ADR-026 inline, без i18n-ключей. Это касается только `quiz.questions[].prompt`, `quiz.options[]` и т.п. — все строки автор пишет на своём языке.
- **Системный admin-редактор уроков** — у системных контента-загрузка идёт через YAML-импортер по KS-2015. Эта задача его не трогает.

### 2.4 Открытые вопросы

1. **Game-picker для `game_review`**. Сейчас архив пользовательских игр доступен через `GET /archive/games?owner=me`. Нужен компонент-выбор «своих партий» с превью. Для MVP можно ограничить только PGN-вариантом (без gameId), затем добавить gameId-вариант отдельным тикетом.
2. **PGN-tree редактор для `opening_drill`**. На MVP — textarea + read-only preview. Полный визуальный — отдельный ADR.
3. **Anti-abuse лимиты для quiz** — на текущий момент бэкенд-DTO `QuizStepPayloadDto` не имеет верхней границы на `questions.length`. Если станет проблемой — добавим `@ArrayMaxSize(20)` в user-version DTO (pattern есть, см. UserPuzzleSelectionFilterDto).
4. **Drawing UX на mobile**. Right-click + modifier-keys — desktop-парадигма. На mobile нужен mode-toggle «Draw / Drag» и предустановка цвета через swatch. Решит layout в тикете на CSS/UX.

---

## 3. Декомпозиция на тикеты

Все тикеты в **To Do**. Префикс `[User courses parity]`. Группировка по тирам — Tier 1 можно выкатывать самостоятельно.

### Tier 1 (явный запрос пользователя)

| # | Тема | Исп. | Размер | Зависит от |
|---|------|-----|--------|------------|
| 1 | Backend: расширить `ALLOWED_USER_STEP_TYPES` (`user-courses-limits.ts`) и `USER_STEP_PAYLOAD_SUBTYPES` (`user-step-payload.dto.ts`) — добавить `quiz` (reuse системного `QuizStepPayloadDto`). Юнит-тест: `POST /user-lessons/:id/steps {type:'quiz', payload}` → 201 | backend | S | — |
| 2 | Shared: расширить `UserStepType` union в `packages/shared/src/types/user-courses.ts:30` — добавить `'quiz'`. Обновить export | backend | XS | #1 |
| 3 | Frontend: shared-компонент `<DiagramEditor>` (`apps/web/src/components/lessons/editor/shared/DiagramEditor.tsx`) — fen + arrows + highlightedSquares + caption + orientation. Reuse `useSquareHighlights` / `annotationColorByModifiers` из AnalysisPage. Юнит-тесты на onChange при правом клике / drag, на mode-toggle | frontend | M | — |
| 4 | Frontend: расширить `<TextStepEditor>` (или соответствующий — найти текущий `text` редактор в `UserCourseEditor` дереве) — список `diagrams[]` с `<DiagramEditor>` для каждой. Добавить кнопку «Добавить диаграмму», drag-reorder | frontend | M | #3 |
| 5 | Frontend: новый `<QuizStepEditor>` — список `questions[]` (prompt, опц. fen через `<DiagramEditor drawingDisabled>`, options[], correctOptionIds[], explanation). Drag-reorder вопросов | frontend | M | #2, #3 |
| 6 | Frontend: добавить `'quiz'` в UI-`<select>` редактора шага (типа step-add menu в `UserCourseEditor`); обновить `emptyStepPayload` whitelist для UserStepType (если нужно — сейчас функция уже умеет 'quiz') | frontend | XS | #2, #5 |
| 7 | i18n: новые ключи RU/EN — `lessons.my.editor.stepType.quiz`, `lessons.my.editor.diagram.addArrow`, `addHighlight`, `clearArrows`, `clearHighlights` и т.д. | frontend | XS | #4, #5 |
| 8 | Layout/CSS: стили для `<DiagramEditor>` — mode-toggle, swatches для цветов, mobile-режим (mode-toggle обязателен на узких) | layout | S | #3 |
| 9 | QA: e2e — создать text-шаг с диаграммой, нарисовать стрелку, сохранить, перезагрузить, увидеть стрелку в viewer'е (`UserCoursePage`); создать quiz-шаг с двумя вопросами, ответить, увидеть оценку | qa | S | #4-#8 |

### Tier 2 (расширение спеки, простые редакторы)

| # | Тема | Исп. | Размер | Зависит от |
|---|------|-----|--------|------------|
| 10 | Backend: добавить `position` и `video` в whitelist (PositionStepPayloadDto, VideoStepPayloadDto). Юнит-тесты | backend | S | — |
| 11 | Shared: расширить `UserStepType` — `'position' \| 'video'` | backend | XS | #10 |
| 12 | Frontend: `<PositionStepEditor>` — `<DiagramEditor>` для FEN + interactive mode для записи `expectedMoves[]` (играть ходы, кнопка «зафиксировать ход N как ожидаемый»). `<select>` orientation | frontend | M | #3, #11 |
| 13 | Frontend: `<VideoStepEditor>` — `<input>` URL с whitelist YouTube/Vimeo (regex-зеркало backend), опц. titleI18nKey. Превью через `<VideoStep>` viewer | frontend | XS | #11 |
| 14 | Frontend: добавить `'position'` и `'video'` в `<select>` step-type | frontend | XS | #12, #13 |
| 15 | i18n + layout штрихи | frontend | XS | #12-#14 |
| 16 | QA: e2e на каждый из новых типов | qa | S | #14, #15 |

### Tier 3 (тяжёлые редакторы)

| # | Тема | Исп. | Размер | Зависит от |
|---|------|-----|--------|------------|
| 17 | Backend: добавить `game_review` и `opening_drill` в whitelist | backend | S | — |
| 18 | Shared: финальное расширение `UserStepType` до полного 8-набора | backend | XS | #17 |
| 19 | Frontend: `<GameReviewStepEditor>` MVP — только PGN-вариант (textarea с валидацией chess.js на blur). gameId-вариант — отдельный тикет с game-picker'ом из архива | frontend | M | #18 |
| 20 | Frontend: `<OpeningDrillStepEditor>` MVP — textarea PGN с read-only preview tree (re-use review tree component). Полный визуальный editor — открытый вопрос §2.4 | frontend | L | #18 |
| 21 | Frontend: добавить `'game_review'` и `'opening_drill'` в step-type select | frontend | XS | #19, #20 |
| 22 | i18n + layout штрихи | frontend | XS | #19-#21 |
| 23 | QA: e2e на game_review (PGN-вариант) и opening_drill (paste PGN, проверка что viewer работает) | qa | S | #21, #22 |

### Граф зависимостей (Tier 1)

```
#1 (BE whitelist quiz) ──► #2 (shared union)
                              │
#3 (DiagramEditor shared) ────┼──► #4 (TextStepEditor + diagrams)
                              │     │
                              ├──► #5 (QuizStepEditor) ──► #6 (step-type select)
                              │
                              └──► #8 (CSS)
                                    │
                                    ▼
                              #7 (i18n)
                                    │
                                    ▼
                              #9 (qa e2e)
```

Параллелизм: #1 + #3 стартуют сразу. #2 после #1. #4, #5, #8 после #3 (и #2 для #5). #6 после #2. #7 + #9 финал.

Tier 2 и Tier 3 — аналогичный паттерн. Когда выкатим Tier 1, координатор примет решение запускать ли Tier 2 (рекомендую — простые типы, расширяют ценность редактора).

---

## 4. Последствия

**Плюсы**:
- Авторы кастомных курсов получают полный набор инструментов на уровне системных уроков — не нужно ходить в админку или просить разработчика залить YAML.
- Визуальный редактор диаграмм со стрелками — главный UX-выигрыш, на текущем UI это блокировано.
- Архитектура уже готова: схема БД, API-валидаторы, viewer-компоненты переиспользуются. Не пишем новые backend-DTO, добавляем в whitelist.
- Тиры позволяют выкатывать частями: Tier 1 закрывает явную жалобу, Tier 2/3 — расширение по мере востребованности.

**Минусы / риски**:
- `<DiagramEditor>` — новый компонент с UX-нагрузкой (drawing, mode-toggle, mobile). Может потребовать итераций, особенно на mobile. Митигация: layout-тикет (#8) включает mobile-mode проверку.
- Anti-abuse лимиты на `quiz.questions.length` и т.п. сейчас отсутствуют в user-version DTO. Если автор положит 500 вопросов — запрос пройдёт. Митигация: следить за DB-метриками после релиза, добавить лимиты отдельным тикетом если выявим проблему.
- PGN-tree редактор (`opening_drill`) на MVP textarea-only. Часть пользователей будет ожидать визуальный — мы документируем в UI «вставьте готовый PGN». Полный визуальный — отдельная задача.
- `text`-шаг с большими `diagrams[]` (5+ диаграмм) — JSONB в `payload` может разрастись. На текущем масштабе не проблема, но в долгосрочной перспективе — точка наблюдения.

**Что не делает этот ADR**:
- Не пишет код. Все тикеты идут отдельным потоком разработки.
- Не меняет системный YAML-импортер (KS-2015). Системный контент по-прежнему через YAML.
- Не пересекается с user-courses puzzles (ADR-029) — `puzzle` уже есть в whitelist.
- Не меняет публичный API контрактов user-courses — только расширяет whitelist на бекенде.
