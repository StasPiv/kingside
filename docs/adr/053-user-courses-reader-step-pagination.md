# ADR-053 — Унификация reader пользовательских курсов с системными: «один шаг = одна страница»

- Статус: Proposed
- Дата: 2026-05-09
- Связанные задачи: KS-2628
- Связанные ADR: ADR-026 (user-courses), ADR-049 (user-courses parity), ADR-052 (my-courses admin)
- Связанные тикеты-источник паттерна: KS-2041 (один шаг = один экран в системных уроках), KS-2056/KS-2076/KS-2078/KS-2091 (полировка step-навигации), KS-2057 (completion overlay)
- Авторы: architect

---

## 1. Контекст

Жалоба пользователя (2026-05-09): системные и пользовательские курсы дают разный UX. В системных уроках (`/lessons/:courseSlug/:lessonSlug`) рендерится **один шаг на страницу** с кнопками «Назад/Далее» и финальной кнопкой «Завершить урок» (паттерн KS-2041). В пользовательских (`/lessons/my/:slug/:lessonId`) — **все шаги в одном вертикальном списке `<ol>`**. Учиться по длинному списку неудобно: страница уезжает на километры, ученик теряется, не видно, на каком шаге он сейчас.

Цель ADR — выбрать стратегию унификации reader'а пользовательских курсов и сформулировать MVP-декомпозицию.

---

## 2. Аудит дублирования (read-only)

### 2.1 БД-модели — параллельные деревья

| Сущность | Системные | Пользовательские | Семантическое отличие |
|----------|-----------|------------------|------------------------|
| Курс | `Course` | `UserCourse` | system: i18n-tree (parentCourseId/lang), `isPublished`, `Lesson.kind`, `blockKey`. user: один язык, `isPublic`, `ownerId`, без блок-структуры. |
| Урок | `Lesson` (`titleKey`/`title`, `summaryKey`/`summary`, `estMinutes`, `kind`) | `UserLesson` (`title`, `estMinutes`) | system держит `kind`, `blockKey`, i18n-fallbacks, `parentLessonId`. |
| Шаг | `LessonStep` (`type`, `payload: Json`) | `UserLessonStep` (`type`, `payload: Json`) | **Идентичны по shape**: `id`, `lessonId`/`userLessonId`, `order`, `type`, `payload`. Разница — whitelist `type` (system: 8, user: 4) и текст внутри `payload` (system из `*Key`, user в plain). |
| Прогресс курса | `UserCourseProgress` (минимальный: `currentLessonId`, `completedAt`) | `UserCoursePlayProgress` (`completedLessonsCount`, `lastActivityAt`, `completedAt`) | Близко по смыслу, разные поля. |
| Прогресс урока | `UserLessonProgress` (`stepsState: Json`, `score: Int`, `completedAt`, `masteredAt`) | `UserLessonPlayProgress` (`stepsState: Json`, `completedStepsCount`, `totalSteps`, `completedAt`, `lastActivityAt`) | **Оба** хранят `stepsState`, оба имеют `completedAt`. system дополнительно держит `masteredAt`/`score` под SM-2. user дублирует агрегаты `completedStepsCount`/`totalSteps`. |
| SM-2 | `LessonReview` | — | В user-курсах SM-2 не подключён (ADR-026 §2.1). |

Источник: `packages/db/prisma/schema.prisma:848-1137`.

**Вывод по моделям:** дерево действительно дублирующее. На уровне «как лежит payload шага» отличий нет — `LessonStep.payload` и `UserLessonStep.payload` оба `Json` под shared `StepPayload` union (см. `packages/shared/src/types/lessons.ts`). Все различия структурные и завязаны на сторонние фичи: i18n, блоки, SM-2 — то есть на функционал, который user-курсам не нужен **сейчас**, но не «никогда».

### 2.2 API-эндпоинты — два изолированных контроллера

**Системные** (`apps/api/src/lessons/`):

- `GET /lessons/courses/:slug` — курс + lessons.
- `GET /lessons/lessons/:id` — урок + steps + `progress` (в т.ч. `stepsState`).
- `POST /lessons/progress/step` — `{lessonId, stepId, state}`.
- `POST /lessons/progress/lesson/:id/complete` — финал, опц. `quality` (SM-2).
- + `GET /lessons/reviews/due`, `GET /lessons/active-courses`, `/lessons/courses/recommended`.

**Пользовательские** (`apps/api/src/lessons/user-courses/`):

- `GET /lessons/user-courses?mine=…` — список.
- `GET /lessons/user-courses/:slug` — курс + lessons.
- `GET /lessons/user-lessons/:id` — урок + steps + `progress.stepsState`.
- `POST /lessons/user-progress/lessons/:id/step` — `{stepId, state}`.
- `POST /lessons/user-progress/lessons/:id/complete` — `{score}`.
- + `POST /lessons/user-courses` / `PATCH` / `DELETE` / `lessons/reorder` и т.д. (BE-3).

Семантика прогресс-эндпоинтов **почти идентична** (KS-1879/KS-1880 явно поднял user-progress до того же shape'а: `stepsState` отдаётся в DTO для seed'а UI). Различия:

- system принимает `quality` (SM-2), user — нет.
- путь `/lessons/progress/*` vs `/lessons/user-progress/*`.
- system эндпоинт `step` ожидает `{lessonId, stepId, state}`, у user `lessonId` идёт URL-параметром.

### 2.3 Frontend — общие компоненты, разные страницы

**Что уже общее:**

- `<StepRenderer>` (`apps/web/src/components/lessons/StepRenderer.tsx`) — диспетчер `step.type → <TextStep>/<QuizStep>/<PuzzleStep>/<EndgameDrillStep>/<PositionStep>/<VideoStep>/<GameReviewStep>/<OpeningDrillStep>`. Принимает `LessonStep` shared-shape. **Используется и в LessonPage, и в UserLessonPage** — `UserLessonPage` уже маппит `UserLessonStepDto → LessonStep` функцией `stepDtoToLessonStep`.
- Сами Step-компоненты (`<TextStep>`, `<QuizStep>` и т.д.) — общие, без if'ов system/user.
- Shared-типы `LessonStep`, `LessonStepState`, `StepPayload` — общие (`packages/shared/src/types/lessons.ts`, переиспользованы в `user-courses.ts`).

**Что разъехалось:**

| Страница | system | user | Разница |
|----------|--------|------|---------|
| Reader-страница | `LessonPage.tsx` (`/lessons/:courseSlug/:lessonSlug`) | `UserLessonPage.tsx` (`/lessons/my/:slug/:lessonId`) | system **уже** «один шаг — один экран» (KS-2041): `?step=N`, кнопки Prev/Next, ArrowLeft/Right клавиатура, scroll-to-top, footer-completion + конфетти-overlay (KS-2057), блокировка повторного complete (KS-2078), требование «все шаги done» (KS-2091), review-mode + SM-2 (KS-1799). user — `<ol>` со всеми шагами вертикально. |
| Reader curriculum | `CoursePage.tsx` | `UserCoursePage.tsx` | список уроков курса; внутри owner-actions (см. ADR-052). |
| Прогресс-хук | `useLessonProgress.ts` | `useUserLessonProgress.ts` | API почти зеркальный: `stepsState`, `markStep`, `completeLesson`, `score`, `threshold`, `resetProgress`. system дополнительно принимает `quality` (SM-2). user не имеет `quality`. |

**Вывод по фронту:** дублируется только «оболочка» (страница-контейнер + хук), а UI-кирпичи общие. То есть унификация reader'а на UI-уровне — это **в основном перепись `UserLessonPage` под паттерн `LessonPage`**, без переписи компонентов шагов.

### 2.4 Роутинг — параллельные пространства

| Роль | Системный | Пользовательский |
|------|-----------|------------------|
| Список курсов / лобби | `/lessons` | + `/lessons/discover`, `/lessons/my` (ADR-052 — proposed) |
| Курс | `/lessons/:courseSlug` | `/lessons/my/:slug` |
| Урок | `/lessons/:courseSlug/:lessonSlug` | `/lessons/my/:slug/:lessonId` |
| Активный шаг | `?step=N` (KS-2041) | — (нет) |
| Редактор | `/lessons/editor` (admin) | `/lessons/my/:slug/edit` (owner) |

Идентификатор урока в URL разный: system использует `lessonSlug`, user — `lessonId` (UUID). Это исторически обусловлено (UserLesson не имеет slug-поля, см. ADR-026 §2.5). Унифицировать формат URL без миграции БД нельзя — оставляем как есть.

### 2.5 Что говорят сами файлы

В `useUserLessonProgress.ts:18-23` явно зафиксировано: «Аналог `useLessonProgress` для системных курсов, но бьёт в BE-4 endpoint'ы…», и `KS-1879/KS-1880` уже подняли user-прогресс до того же поведения. То есть совпадение архитектуры — преднамеренное, а не случайное.

---

## 3. Решение

### 3.1 Выбор стратегии

Сравним два пути из задачи:

#### Опция (a) — переписать только UI пользовательского reader'а

Что меняем:
- `UserLessonPage.tsx`: рендер ровно одного `<li>` по индексу из `?step=N`, навигация Prev/Next, клавиатура, scroll-to-top, completion overlay — копируя паттерн KS-2041 / KS-2057.
- Хук `useUserLessonProgress` — уже даёт всё нужное (`stepsState`, `markStep`, `completeLesson`).
- Опционально: общий вспомогательный компонент `<LessonStepNav>` и/или `<LessonCompletionOverlay>`, чтобы не копипастить разметку из `LessonPage`.

Что НЕ меняем:
- BE-эндпоинты, схему БД, shared-типы.
- Системную страницу `LessonPage`.
- Редактор `UserCourseEditor` (он остаётся со списком всех шагов).

**Цена:** один FE-тикет на компонент + лёгкая верстка + e2e. Одна рабочая неделя при базовом темпе одного разработчика.

**Риск:** минимальный. Поверхность изменений локальная, e2e системного reader'а не трогается, e2e user-reader'а заранее покрывает паттерн.

#### Опция (b) — слить модели в одну унифицированную сущность

Что меняем:
- Schema: либо мигрировать `User*` в `*` с дискриминатором `ownership: 'system' | 'user'`, либо ввести «общий» супер-тип `Lesson` с двумя backref-relations. Любой из этих двух вариантов — большая миграция:
  - перенос данных из 3-х таблиц в 3 (или объединение в 3 с дискриминатором), реломочный schema-update,
  - переезд `UserCoursePlayProgress` → `UserCourseProgress`, `UserLessonPlayProgress` → `UserLessonProgress`. Эти таблицы расходятся по составу полей (см. §2.1) — без потери данных или добавления nullable-полей не обойтись.
  - адаптация i18n-tree (`parentCourseId/lang`) и SM-2 (`LessonReview`) под user-сущности — либо разрешить, либо явно запретить.
- Бэк: один контроллер вместо двух, один сервис, общие guards. Нужно решить, как будет работать `isPublic`/`isPublished` (две разные модели публикации).
- Фронт: одна страница reader'а, одна страница course-page, один прогресс-хук, общий API-клиент.

**Цена:** многомесячный рефактор. Затрагивается всё, что в §2.1-§2.4.

**Риск (высокий):**
1. **Регрессии в системных курсах.** Системные уроки — основа продукта (i18n, SM-2, lessons-reviews due, recommended). Любая миграция модели рискует зацепить мастер-фичу.
2. **Несоответствие моделей публикации.** `Course.isPublished` (модерация) и `UserCourse.isPublic` (расшаривание) — это разные процессы (см. ADR-052 §3.1). Сливать в одно поле нельзя без переусложнения.
3. **SM-2 на user-уроках.** ADR-026 §2.1 сознательно отключил SM-2 для user-курсов («автор-контент не имеет канонического правильного прохождения»). При слиянии SM-2 либо случайно начнёт работать, либо приходится тащить флаг enable.
4. **Авторские лимиты.** `coursesPerUser`, rate-limits, `UserCourseOwnerGuard` — всё user-специфичное. На системных уроках этого нет, унификация добавляет их повсюду либо разводит обратно через флаги.
5. **Не закрывает жалобу пользователя быстрее.** Жалоба про UX reader'а, а не про код-дублирование. Пользователю всё равно, две таблицы у нас или одна.

#### Решение

**Выбираем (a).** Жалоба про UX, и она закрывается чисто фронтовой переработкой страницы за счёт уже сделанной KS-1879/KS-1880 параллели хуков. Опция (b) даёт долгосрочный выигрыш в коде, но на текущем этапе — это переписать продукт под архитектурную чистоту, а не решить задачу пользователя. Если в будущем дублирование станет реально мешать (новая фича одновременно нужна обеим веткам), вернёмся к (b) отдельным ADR.

> **Примечание о среднем пути.** Можно было бы вынести reader-логику (state-машина, ?step=N, навигация, overlay) в общий компонент `<LessonReader steps={...} progress={...}>` и переиспользовать в обеих страницах. Это разумное промежуточное решение, **рекомендуется** в рамках Tier 1 (см. §4 #3): вынести `<LessonStepNav>` и `<LessonCompletionOverlay>` в `apps/web/src/components/lessons/`, чтобы система и user использовали один кирпич. Полный extract `<LessonReader>` — follow-up.

### 3.2 Дизайн целевого `UserLessonPage`

**URL:** `/lessons/my/:slug/:lessonId?step=N` — добавляем query-параметр `step` (1-based). При входе без параметра:
- если `progress.stepsState` пуст или у всех шагов state ≠ 'done' — `step=1`;
- иначе — первый шаг с state ≠ 'done' (паттерн `LessonPage:172-207`);
- иначе (всё done) — `step=1` (повторный просмотр).

**Шаг как один экран:**
- Из `state.steps` берём `sortedSteps[currentStepIndex]` (по аналогии с `LessonPage:212-218`).
- Рендерим один `<li class="lesson-step lesson-step--<type>">` с тем же `<StepRenderer>`.
- header-блок шага: «#order · type-label», прогресс sticky сверху со счётчиком `Step N/M — done X/M (P%)` (как в системных).

**Навигация между шагами (`<LessonStepNav>`):**
- `[◀ Previous]` — disabled если `currentStepIndex === 0`. Иначе `goToStep(currentStepIndex - 1)`.
- Counter `N/M` в центре.
- `[Next ▶]` — показывается только когда **активный шаг done** и не последний. Это паттерн KS-2056/KS-2076: вперёд только через «Готово» внутри шага (которое сразу делает `markStep(done)` + `goToStep(+1)`), а на повторном проходе по уже пройденному шагу кнопка Next возвращается.
- Клавиатура: `←` назад всегда, `→` вперёд только на done-шаге (паттерн `LessonPage:246-275`).
- Scroll-to-top при смене шага (`window.scrollTo({top:0})`).

**Footer «Complete lesson»:**
- Условие активации: **все шаги done** (`allStepsDone`, паттерн KS-2091). Сейчас user-reader использует score ≥ threshold (0.7); меняем на «все done», чтобы UX совпадал с системным.
  - Альтернатива: оставить 70%-порог. Аргумент против: это reader, а не review-mode; если пользователь хочет «по верхам» — он листает, а complete как факт прохождения должен означать факт. SM-2-моды у user-курсов нет (см. §2.1), нечего тонко настраивать.
  - **Решение: «все done».** Меняем `useUserLessonProgress.canComplete` логику в `UserLessonPage`. Сам хук-API остаётся, страница считает `allStepsDone` локально, как в `LessonPage:358-363`.
- Disabled-стейты: «Все шаги пройти» / «Уже пройден» (если `progress.completedAt != null` — паттерн KS-2078). Источник правды — серверный `completedAt`, чтобы блокировка переживала перезагрузку.

**Completion overlay:**
- После успешного `completeLesson` показываем тот же overlay с галочкой и конфетти, что и в `LessonPage:752-850` (KS-2057). Кнопки: «Next lesson» (если есть) и «Back to course» (`/lessons/my/:slug`).
- Маршрут next lesson вычисляется как сейчас: `state.courseLessons[idx+1].id`.

**Что НЕ делаем:**
- Review-mode (`?mode=review` + SM-2). У user-курсов SM-2 не подключён (ADR-026 §2.1). Если в будущем подключим — добавим параметр в этом же файле.
- Bulk «Mark all as done».

### 3.3 Прогресс ученика

Прогресс уже корректно работает по KS-1879/KS-1880:
- `POST /lessons/user-progress/lessons/:id/step` записывает state в `UserLessonPlayProgress.stepsState`.
- `POST /lessons/user-progress/lessons/:id/complete` ставит `completedAt`.
- При повторном открытии `GET /lessons/user-lessons/:id` возвращает `progress.stepsState` — UserLessonPage уже использует его как `initialStepsState` (`UserLessonPage.tsx:106-113`).

Ничего нового на BE не требуется. Гарантии:
- При смене активного шага (`?step=N`) прогресс не теряется — `stepsState` хранится поштучно.
- Метка «done» на шаге — оптимистичная локально, дебаунс-POST на BE (см. `useUserLessonProgress`).

### 3.4 Mobile-адаптация

- **<560px:** одна колонка, без двух-в-строку.
- **Step nav:** строка `[◀ Prev] [N/M] [Next ▶]`. Если экран узкий — Prev/Next остаются текстовыми кнопками (стрелка + слово), но при ширине ≤480px можно оставить только стрелки.
- **Sticky-progress сверху** — уже есть в текущем `UserLessonPage` (`lesson-progress-sticky`). Сохраняем.
- **Sticky bottom CTA «Complete lesson»** — на mobile нижний `<footer>` фиксируется (`position: sticky; bottom: 0`) с safe-area-inset, чтобы кнопка была доступна без скролла в самый конец. На desktop — обычный footer-блок (как сейчас в системных).
- **Свайпы:** **не делаем в MVP.** Step-контент часто содержит chess-board (`<TextStep>` с диаграммами, `<EndgameDrillStep>`, `<PuzzleStep>`) и горизонтальные жесты конфликтуют с drag по доске. Кнопок Prev/Next и стрелок клавиатуры достаточно. Если ляжет жалоба — добавим как follow-up с touch-zones по краям экрана.

### 3.5 Что с редактором

`UserCourseEditor` (`/lessons/my/:slug/edit`) **оставляем без изменений**. Это редактор — автору удобно видеть весь список шагов сразу, dragdrop reorder, delete, edit inline. Унификация UI касается только reader'а.

Если в редакторе нужен «preview как ученик» — это отдельный follow-up (`?preview=1` рендерит ту же страницу в read-only режиме). Не делаем сейчас.

### 3.6 Что НЕ делаем (out of scope)

- Слияние моделей (опция b) — не делаем.
- SM-2 / review-mode для user-курсов.
- Унифицированный `<LessonReader>` как полноценный extracted-компонент. В Tier 1 выносим только `<LessonStepNav>` и `<LessonCompletionOverlay>` — этого достаточно, чтобы при следующих правках (KS-2096, KS-2300+) не плодить копипасту.
- Свайпы на mobile.
- Маршрут `?step=N` редирект-нормализация для системных уроков (там это уже работает).

---

## 4. Декомпозиция на тикеты

Backend изменений нет. Опция (a) — чисто FE/layout/qa.

### Tier 1 — MVP (закрывает жалобу)

| # | Назначение | Что | Зависимости |
|---|------------|-----|-------------|
| 1 | frontend | Переписать `UserLessonPage`: state-машина активного шага по `?step=N`, рендер одного `<li>`, scroll-to-top при смене, восстановление initial step из `stepsState` (первый не-done). Убрать `<ol>` со всеми шагами. | — |
| 2 | frontend | Step-навигация: кнопки Prev/Next, counter N/M, ArrowLeft/Right keyboard handler. Логика: Next доступен только на done-шаге и не на последнем (KS-2056/KS-2076 паттерн). | #1 |
| 3 | frontend | Вынести общий компонент `<LessonStepNav>` (`apps/web/src/components/lessons/LessonStepNav.tsx`) — переиспользовать в `LessonPage` и `UserLessonPage`. По образцу — то, что сейчас inline в `LessonPage:615-663`. | #2 |
| 4 | frontend | Footer «Complete lesson»: disabled пока `!allStepsDone`, лейблы «Complete all steps first»/«Lesson already completed» (если `progress.completedAt`). Изменить семантику с 70%-порога на «все done», как в системных (KS-2091). | #1 |
| 5 | frontend | Completion overlay: после успешного `completeLesson` показать оверлей с галочкой + конфетти + кнопками «Next lesson»/«Back to course». Вынести `<LessonCompletionOverlay>` (общий с `LessonPage`, KS-2057 паттерн). | #1, #4 |
| 6 | layout | Mobile-стили: sticky-bottom footer для «Complete», узкий layout step-nav на <480px, проверка диаграмм/доски в шаге внутри узкой колонки. CSS только. | #1, #2, #4 |
| 7 | frontend | i18n-ключи (`lessons.my.stepNav.*`, `lessons.my.completion.*` или переиспользование уже существующих `lessons.next/prev/complete*`) ru/en. | #2, #4, #5 |
| 8 | qa | E2E happy-path для user-reader: открыть урок → видеть один шаг → пройти все шаги → complete → next lesson. Mobile viewport. Регрессионный e2e системного reader'а — не трогаем (паттерн KS-2041 уже покрыт). | #1–#6 |

**Граф:**

```
#1 (state-машина и render одного шага)
 ├─► #2 (step-nav: Prev/Next/keyboard)
 │    └─► #3 (extract <LessonStepNav>)
 ├─► #4 (footer Complete)
 │    └─► #5 (completion overlay + extract)
 └─► #6 (mobile-стили) ─► #7 (i18n) ─► #8 (e2e)
```

Можно делать #1 → (#2, #4) параллельно → (#3, #5, #6) параллельно → #7, #8.

### Tier 2 — улучшения (после MVP)

| # | Назначение | Что | Триггер |
|---|------------|-----|---------|
| 9 | frontend | Полный extract `<LessonReader>` — общий компонент state + рендер шага + nav + footer. Переиспользовать в `LessonPage` и `UserLessonPage`. | После Tier 1, когда станет ясно, какие точки кастомизации нужны (review-mode, SM-2, completion overlay-варианты) |
| 10 | frontend + backend | Preview-режим в редакторе: автор открывает редактор и переключает «Preview as student» → видит ту же страницу-reader read-only. | Запрос автора |
| 11 | frontend | Свайпы влево/вправо для step-навигации на mobile с обходом drag-зон chess-board. | Жалоба «листать неудобно» |
| 12 | backend | Опционально — review-mode для user-курсов. Маршрут `?mode=review` + SM-2-планировщик. Требует ADR-расширения ADR-026/ADR-025. | Если автор хочет «дать ученику расписание повторений» |
| 13 | backend + frontend | **Опция (b) — слияние моделей** в отдельный долгосрочный ADR, если новые фичи (общая аналитика, общий поиск, общий каталог) реально упрутся в дублирование. На сегодня — не нужно. | Появление фичи, которой больно с двумя моделями |

### Acceptance ADR

- [x] Аудит дублирования зафиксирован (§2: модели, API, фронт, роутинг).
- [x] Решение по reader пользовательских курсов с обоснованием выбора между (a) и (b) — выбран (a) (§3.1).
- [x] Декомпозиция на backend/frontend (§4). Backend задач нет.
- [ ] Координатор согласует с пользователем и поставит задачи Tier 1.

---

## 5. Последствия

**Положительные:**
- Reader пользовательских и системных курсов даёт одинаковый UX, жалоба пользователя закрыта.
- Появляются переиспользуемые компоненты (`<LessonStepNav>`, `<LessonCompletionOverlay>`) — следующая правка системного или user-reader'а не плодит копипасту.
- Backend и схема БД не трогаются — ноль рисков регрессии в системных курсах.

**Отрицательные / технический долг:**
- Дублирование `LessonPage` ↔ `UserLessonPage` остаётся на уровне страниц-контейнеров. Извлечение полного `<LessonReader>` отложено в Tier 2 — это компромисс ради скорости MVP.
- Параллельные модели в БД остаются. Это явно осознаваемое решение ADR (§3.1, опция b отвергнута). При появлении новой кросс-фичи (например, общий «лента активности», общий «mistakes diary» по уроку) дублирование станет дороже — тогда возвращаемся к (b).
- Меняем условие «Complete lesson» с 70%-порога на «все done» — это поведенческое изменение для существующих пользователей user-курсов. Если кто-то завершал уроки на 70% — теперь будет требоваться 100%. Считаем это не ломающим (UX становится строже и понятнее), но в release-notes отметить стоит.
