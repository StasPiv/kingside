# KS-2815: Studies как самостоятельная фича — пересмотр плана MVP

**Дата:** 2026-05-12
**Автор:** architect
**Статус:** Accepted (готов к декомпозиции)
**Связано:** KS-2792 (исходное исследование, §§3–§7 superseded в части
интеграции), KS-2793 (вариант D отменён пользователем), KS-2794 (sidebar
ревизия — независимо). См. `docs/architecture/KS-2792-studies-research.md`.

---

## 0. Контекст пересмотра

В KS-2793 была предложена интеграция Studies в существующие разделы:
редактор главы внутри AnalysisPage, каталог — табом в `/lessons`,
ребрендинг `Уроки → Обучение`. Пользователь скорректировал требования:

> «фокус — на функционале студии, а не на интеграции неготового
> раздела с существующими разделами. Если архитектор хочет сделать
> раздел студий отдельно — давай пока сделаем его отдельным, а потом
> уже будем думать, как интегрировать».

Решения пользователя:

1. **Studies — самостоятельный раздел** на отдельном маршруте, без
   интеграции в `/lessons` и AnalysisPage в MVP.
2. **broadcast-зеркало** — не делаем (это функционал broadcast, не
   Studies).
3. **«Save to study» из AnalysisPage** — отложено.
4. **Хранение дерева** — pgn-блоб + переиспользование
   `apps/web/src/review`. Никакой нормализованной таблицы узлов.
5. `practice`-режим и лимит глав — на усмотрение архитектора.

Из этих ограничений рождается план §B ниже. Главное продвижение —
сначала глубокий аудит уже сделанного в Lessons (§A), чтобы понять,
что можно переиспользовать.

---

## A. Карта переиспользуемого кода в существующих модулях

### A.1 Backend: `apps/api/src/lessons`

Перед нами не один Lessons-модуль, а **система из двух параллельных
сценариев**, объединённых ADR-054 в общие таблицы `courses`/`lessons`/
`lesson_steps` с `ownerId IS NULL` для системных и `IS NOT NULL` для
пользовательских курсов. Главные участники:

| Часть | Файлы / артефакты | Назначение | Подходит для Studies? |
|------|--------------------|------------|------------------------|
| **Auth guards** | `lessons-access.guard.ts` (204 строки, с тестами) | Универсальный guard для системного + пользовательского контента; обрабатывает `ownerId`, `isPublic`, public/private, anon | **переиспользуется в Studies as-is** (через общий guard / копию-аналог с другим Prisma-моделью) |
| **SlugService** | `user-courses/slug.service.ts` (генерация nanoid+title slug'а, retry, валидация) | Создание slug'а для пользовательских курсов: `<shortId>-<title>` | **переиспользуется 1:1** для Study (slug удобен в URL `/studies/<slug>`) |
| **Лимиты** | `user-courses-limits.ts` | Константы (courses/user, lessons/course, steps/lesson) | Шаблон для `studies-limits.ts` (studies/user, chapters/study) |
| **UserCoursesService** | `user-courses/user-courses.service.ts` (CRUD + listings + stats) | CRUD пользовательских курсов, list mine/public, enrolled | **служит образцом** для `StudiesService`, но не переиспользуется напрямую (отличия в модели) |
| **UserLessonsService** | `user-courses/user-lessons.service.ts` | CRUD уроков пользовательского курса | **служит образцом** для `StudyChaptersService` |
| **Owner-guard** | `user-courses/user-course-owner.guard.ts` | Проверка `ownerId === userId` для мутаций | **переиспользуется** as-is или клонируется под Study |
| **Rate-limit** | `user-courses/rate-limits.ts`, `admin/admin-rate-limit.ts` | Декораторы `@UserRateLimit` для пользовательских мутаций | **переиспользуется** as-is (декоратор универсальный) |
| **Adr054UnifiedController** | `adr054-unified.controller.ts` (277 строк) | Унифицированные `/lessons/*` роуты для system+user | **не для Studies** (специфика lessons) |
| **CoursesController** | `courses.controller.ts` (listings + getBySlug, fallback system→user) | Listing + getBySlug | **служит образцом**, шаблон копируется |
| **SM-2** | `sm2.service.ts`, `sm2.scheduler.ts`, `reviews.controller.ts` | Интервальное повторение уроков | **НЕ для Studies** в MVP (Studies — без идеи «повторения») |
| **AdaptiveDifficultyService** | `adaptive-difficulty.service.ts` | Адаптивная сложность шагов | **НЕ для Studies** |
| **PuzzleResolverService** | `puzzle-resolver.service.ts` | Резолв puzzle-шага в задачу из lichess-puzzles | **НЕ для Studies** в MVP |
| **LessonsAdmin** | `admin/lessons-admin*.ts`, `admin/lessons-admin-import.service.ts` | Админский CRUD системных курсов + YAML-импорт | **НЕ для Studies** (Studies — user-content, не system content) |
| **Tests** | `*.spec.ts` (примерно 6500 строк суммарно) | Прецеденты для копирования при написании StudyService.spec | Косвенно полезны как примеры |

Итог по backend: **прямого переиспользования** — guards, slug-сервис,
rate-limit; **служат образцом** — UserCoursesService/UserLessonsService,
CoursesController; **не для Studies** — SM-2, adaptive, puzzle-resolver,
admin-import.

### A.2 Backend: `apps/api/src/analysis`

| Часть | Файлы | Подходит для Studies? |
|------|------|------------------------|
| **AnalysisService.findPublic** | `analysis.service.ts:256` | Образец публичного read-only доступа (`isPublic=true` → отдаём; иначе 404). **Переиспользуется как паттерн** в `StudyService.findPublic` |
| **AnalysisService.share** | `analysis.service.ts:343` | Toggle `isPublic` автором (PATCH /share). Паттерн ADR-051 §3 share-3 — **переиспользуется** |
| **AnalysisPublicController** | `analysis-public.controller.ts` | Образец controller'а без `JwtAuthGuard` для публичного чтения. **Переиспользуется** структура в `StudyPublicController` |
| **Backfill metadata** | `analysis.service.ts:onModuleInit` → backfill | Извлечение PGN-headers в отдельные поля (event/site/white/black/...). **Переиспользуется** в Study (parser-функции `extractHeader`, `extractMetadata`) — выносится в shared util |
| **CreateAnalysisDto** | `dto/create-analysis.dto.ts` | Шаблон `IsString, IsOptional, IsIn`. Переиспользуется как образец |

### A.3 Backend: `apps/api/src/workshop`

| Часть | Файлы | Подходит для Studies? |
|------|------|------------------------|
| **PGN parser** | `pgn.parser.ts` — `splitPgn` (multi-game PGN → array of single-game) | **Прямое переиспользование** для импорта multi-PGN → главы. Уже отлажен на реальных PGN из workshop |
| **External-chess service** | `external-chess.service.ts` | НЕ для Studies (это импорт из chess.com/lichess аккаунтов) |

### A.4 Frontend: `apps/web/src/review` (♥ ядро для Studies)

| Часть | Файлы / артефакты | LOC | Подходит для Studies? |
|------|--------------------|-----|------------------------|
| **`types.ts`** | `ChessMove`, `NodeAnnotations`, `VariationColor`, `ArrowAnnotation`, `SquareHighlight` | 81 | **Базовый тип**, используется как есть |
| **`useReviewState`** | reducer с операциями: LOAD_FROM_PGN, GOTO_*, ADD_MOVE, ADD_VARIATION, PROMOTE_VARIATION, DELETE_VARIATION, DELETE_REMAINING, SET_NAG, SET_COMMENT, SET_ANNOTATIONS, SET_VARIATION_COLOR | 547 | **Сердце редактора главы** — переиспользуется 1:1 |
| **`utils/PgnDeserializer.ts`** | парсит PGN с NAG/comments/variations/annotations | 335 | **as-is** для импорта главы |
| **`utils/PgnSerializer.ts`** | сериализует дерево обратно в PGN | 99 | **as-is** для экспорта/сохранения главы |
| **`utils/AddMoveToHistory.ts`** | добавление хода в дерево | 123 | as-is |
| **`utils/AddVariationToHistory.ts`** | добавление варианта | 55 | as-is |
| **`utils/PromoteVariationLink.ts`** | promote (поднять вариант в main) | 327 | as-is |
| **`utils/DeleteVariation.ts` / `DeleteRemaining.ts`** | удаление вариантов / остатка | 254 | as-is |
| **`utils/ChessHistoryUtils.ts`** | поиск/линковка узлов | 343 | as-is |
| **`utils/commentMacros.ts`** | макросы `[%csl][%cal][%cvc]` для стрелок/цветов | 209 | as-is |
| **`utils/nagUtils.ts`** | NAG-логика | 37 | as-is |
| **`components/ReviewMoveList.tsx`** | визуальный рендер дерева вариантов | ~600 (с тестами) | **переиспользуется** в `ChapterEditor` (тот же UI) |
| **`components/NagPalette.tsx` + `NagPaletteSheet.tsx`** | палитра NAG-аннотаций | ~500 | **as-is** (правая панель главы) |
| **`useAnalysisPersistence.ts`** | сохранение / загрузка анализа из API | 73 | **служит образцом** (свой `useStudyChapterPersistence` для разной модели) |

**Итог по `review`:** 4000+ строк кода, уже работающего в проде на
AnalysisPage. Дерево вариантов / NAG / стрелки / макросы / PGN — всё
закрыто. Для Studies глава реализуется как тонкая обёртка над
`useReviewState` + `ReviewMoveList`.

### A.5 Frontend: компоненты lessons / общие

| Часть | Файлы | LOC | Подходит для Studies? |
|------|------|-----|------------------------|
| **`MemoChessboard`** | `components/MemoChessboard.tsx` | — | **Базовый компонент доски** — as-is |
| **`useFastDrag`, `useBoardHighlights`, `useBoardTheme`, `useBoardSettings`, `useSounds`, `useStablePosition`** | `hooks/*.ts` | — | as-is для доски в редакторе |
| **`PgnHeadersModal`** | `components/PgnHeadersModal.tsx` | — | **as-is** для редактирования PGN-tags главы |
| **`SetPositionModal`** | `components/SetPositionModal.tsx` | — | **as-is** для задания стартового FEN главы |
| **`VariationChooser`** | `components/VariationChooser.tsx` | — | as-is (UI выбора между вариантами) |
| **`InlinePgnViewer`** | `components/lessons/steps/InlinePgnViewer.tsx` | — | **as-is для read-only режима** главы (публичный просмотр) |
| **`DiagramEditor`** | `components/lessons/editor/shared/DiagramEditor.tsx` | — | not-directly — это редактор статичной FEN-диаграммы для lesson-step, не дерева ходов. Может пригодиться, если в Study появится «диаграмма-комментарий», но не в MVP |
| **`useUserCourseState`** | `hooks/useUserCourseState.ts` | — | **Не нужен**: у Studies другая структура (главы как pgn-блобы, не шаги) |
| **`UserCourseEditor`** | `components/lessons/editor/user/UserCourseEditor.tsx` (689 строк) | — | **служит образцом UX**: список + детальный редактор, auto-save, delete-dialog, share-toggle |
| **`AddLessonEmptyState`, `LessonOverview`, `CourseOutline`** | `editor/user/*.tsx` | — | UX-шаблоны (empty-state, outline, header) — копируются под Studies |
| **`SaveStatusPill`** | `editor/user/SaveStatusPill.tsx` | — | as-is (индикатор «сохранено / сохраняется / ошибка») |
| **`PublishToggle`** | `editor/user/PublishToggle.tsx` | — | as-is (toggle `isPublic`) |
| **`useAutoSave`** | `hooks/useAutoSave.ts` | — | as-is (debounce-автосохранение pgn'а главы) |

### A.6 Shared: `packages/shared`

| Артефакт | Файлы | Подходит для Studies? |
|---------|------|------------------------|
| **`StepPayload` union** | `types/lessons.ts` | НЕ для Studies (это шаги уроков, не главы) |
| **`UserCourseDto`, `UserLessonDto`** | `types/user-courses.ts` | Образец для `StudyDto`, `StudyChapterDto` — копируется и адаптируется |
| **`AnnotationColor`, `ArrowAnnotation`, `SquareHighlight`** | (в `apps/web/src/review/types.ts`, локально) | **Нужно вынести в shared** при работе над Studies (T-shared). Сейчас они в `apps/web`, что мешает использовать на backend для валидации |
| **`DiagramArrow`, `DiagramHighlight`** | `types/lessons.ts` | Реальный shared-уровень для аннотаций (sub-set). Можно расширить ради Studies |

### A.7 Shared: `packages/db` (Prisma schema)

| Модель | Подходит для Studies? |
|--------|------------------------|
| `Course` (с `ownerId`, `isPublic`, `slug`) | Образец для **нового `Study`** — копируем нужные поля |
| `Lesson` (с `ownerId`, `slug`, `order`) | Образец для **нового `StudyChapter`** — но без `kind`/`titleKey`/SM-2/прогресс |
| `Analysis` (с `pgn`, `fen`, `isPublic`, метаданные header'ов) | Похожий профиль, но **отдельная сущность не подойдёт**: у Studies несколько глав, у Analysis — один документ |
| `UserCourseProgress` / `UserLessonProgress` | НЕ для Studies в MVP (Studies — без прогресса) |
| `LessonReview` (SM-2) | НЕ для Studies |

**Вывод: новые таблицы `studies` и `study_chapters` обязательны** (модель
Lesson не растягивается без поломки SM-2 и прогресса — см. KS-2793 §7.2
вариант B). Но **поля и индексы копируются** с `courses` / `lessons`,
что экономит время.

### A.8 Сводка переиспользования

| Категория | LOC, доступных к переиспользованию | Реально берётся |
|----------|------------------------------------|------------------|
| review (PGN-движок, дерево, NAG) | ~4000 | **~4000** (~100% reuse) |
| Доска и хуки (Memo/Drag/Theme/Sounds/...) | ~500 (хуки) | **~500** as-is |
| UI: PgnHeadersModal, SetPositionModal, VariationChooser, InlinePgnViewer | ~600 | **~600** as-is |
| editor/user (UserCourseEditor + outline + dnd + auto-save + pill + publish-toggle) | ~5000 | **~1500** (auto-save, publish-toggle, save-pill, delete-dialog, owner-guard logic) + **~3500 как референс UX** |
| backend: guards, slug, rate-limit | ~600 | **~400** as-is |
| backend: UserCoursesService, UserLessonsService, CoursesController | ~1500 | **0** прямо, **~1500 как образец** при написании Studies-сервисов |
| backend: AnalysisService (findPublic, share, backfill) | ~400 | **~150 как паттерн** в Study |
| backend: workshop/pgn.parser splitPgn | 69 | **69** as-is |

**Итог:** ядро editor + backend плумбинг переиспользуется почти
полностью; **что писать с нуля — это контроллеры/сервисы Studies
(тонкие)**, **миграция БД**, **страница каталога + страница студии +
панель глав**. Объём фактической новой разработки заметно меньше, чем
кажется по списку MVP-фич.

---

## B. Самостоятельный MVP Studies

### B.1 Скоуп MVP

Включаем:

- Сущности `Study` (контейнер) и `StudyChapter` (глава = pgn-блоб).
- Owner-only приватные студии + public via `isPublic` (по паттерну
  ADR-051: публичная ссылка без auth).
- Multi-PGN импорт (один PGN → одна глава).
- Экспорт `.pgn` (одна глава / вся студия).
- UI:
  - `/studies` — каталог: мои + публичные.
  - `/studies/:slug` — страница студии (список глав).
  - `/studies/:slug/:chapterId` — редактор главы (доска + дерево +
    NAG + стрелки + комментарии — поверх `useReviewState`).
  - `/studies/c/:chapterId` — публичная read-only ссылка на главу.
- Sidebar: **временный пункт** «🧪 Студии» (`/studies`). Финальный
  плейсмент решим позже (KS-2791 sidebar ревизия пакет ещё не
  выполнен, можем уточнить пункт там).

НЕ включаем (отложено):

- ❌ Интеграция с `/lessons` (отдельный пункт, отдельная фича).
- ❌ Интеграция с AnalysisPage (нет «Save to study»; ничто не лезет
  в Workshop).
- ❌ Broadcast-зеркало.
- ❌ Коллаборация / realtime (WebSocket).
- ❌ Режимы `practice` / `conceal` / `gamebook`.
- ❌ Embed iframe.
- ❌ Лайки / каталог-социалка.
- ❌ Поиск по студии.
- ❌ Comments-thread / contributors (только owner на старте, без
  member-таблицы).

### B.2 Решения, принятые архитектором (без вопросов пользователю)

| Решение | Что выбрано | Обоснование |
|---------|------------|--------------|
| Лимит глав на студию | **64** | Совпадает с Lichess; разумный потолок против абьюза; легко поднять позже |
| Default mode главы | **analysis** | Единственный режим в MVP; `practice`/`conceal`/`gamebook` отложены |
| Practice в MVP | **НЕТ** | Без него MVP проще; UX practice требует отдельной UX-проработки. Добавим в фазе 2 |
| Лимит студий на пользователя | **20** | Скопировано с `USER_COURSES_LIMITS.coursesPerUser` |
| Slug-генератор | **переиспользуем `SlugService`** | Формат `<shortId>-<title>` уже отлажен; URL'ы стабильные |
| Хранение дерева | **pgn-блоб в `study_chapters.pgn`** | По решению пользователя; нормализованная таблица — не нужна для MVP. `useReviewState` парсит pgn и работает с деревом в памяти |
| Membership | **только owner** | Нет contributor/viewer; private vs public — единственная гранулярность |
| URL-маршруты | `/studies`, `/studies/:slug`, `/studies/:slug/:chapterId`, `/studies/c/:chapterId` | Префикс `/studies` — отдельное namespace, не пересекается с `/lessons` или `/analysis` |
| API-префикс | `/api/studies/*` | Симметрия с UI; не подмешиваем в `/api/lessons/*` |
| Sidebar | **временный пункт «🧪 Студии» под флагом `studiesEnabled` (default off)** | Чтобы релизить инкрементально; пользователь сам включит когда захочет |
| Feature-flag | `studiesEnabled` (как `lessonsEnabled`) | Стандартный паттерн KS-2105 |
| Backend язык | NestJS + Prisma | Как весь api |
| Frontend язык | React + react-router | Как весь web |
| i18n | `ru` + `en` (новый namespace `studies`) | Как остальные модули |

### B.3 Модель БД (новые таблицы)

```prisma
/// Учебная студия. Самостоятельная сущность, не связана с Course/Lesson.
/// KS-2815 (ADR-058? — нет; добавим ADR при создании миграции).
model Study {
  id          String   @id @default(uuid()) @db.Uuid
  ownerId     String   @map("owner_id") @db.Uuid
  /// `<shortId>-<title>` через SlugService. Уникален per-owner.
  slug        String
  name        String
  description String?  @db.Text
  /// false = приватная (только owner); true = публичная по прямой
  /// ссылке. Без unlisted в MVP — упрощаем.
  isPublic    Boolean  @default(false) @map("is_public")
  /// Денормализованный счётчик глав (для каталога).
  chaptersCount Int    @default(0) @map("chapters_count")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  owner    User @relation("OwnedStudies", fields: [ownerId], references: [id], onDelete: Cascade)
  chapters StudyChapter[]

  @@unique([ownerId, slug])
  @@index([ownerId, updatedAt])
  @@index([isPublic, updatedAt])
  @@map("studies")
}

/// Глава студии. PGN-блоб + базовые поля.
model StudyChapter {
  id          String   @id @default(uuid()) @db.Uuid
  studyId     String   @map("study_id") @db.Uuid
  name        String
  /// Порядок в студии (шаг 1000 для drag-n-drop без переписи всех).
  orderIdx    Int      @map("order_idx")
  /// PGN дерева главы. Формат совпадает с `Analysis.pgn` — включает
  /// макросы [%csl/%cal/%cvc] для аннотаций/стрелок/цветов.
  pgn         String   @db.Text
  /// Стартовая позиция FEN. NULL = стандартная.
  startFen    String?  @map("start_fen")
  /// Ориентация доски снизу: "white" | "black".
  orientation String   @default("white")
  /// MVP — всегда "analysis". В будущем — "practice"/"conceal"/"gamebook".
  mode        String   @default("analysis")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  study Study @relation(fields: [studyId], references: [id], onDelete: Cascade)

  @@unique([studyId, orderIdx])
  @@index([studyId])
  @@map("study_chapters")
}
```

Что в `User` модели:

```prisma
model User {
  // ... existing fields ...
  ownedStudies Study[] @relation("OwnedStudies")
}
```

Никаких изменений в `Course`/`Lesson`/`LessonStep` — Studies живёт
параллельно.

### B.4 REST API

Префикс `/api/studies/*`. Все мутации — JWT. Чтение публичной студии
— anonymous, через отдельный controller (по образцу
`AnalysisPublicController`).

| Метод | Путь | Описание | Auth |
|-------|------|----------|------|
| `GET` | `/api/studies` | Listing: `?mine=1` мои; `?mine=0` публичные; без — мои | JWT |
| `POST` | `/api/studies` | Создать пустую студию `{name, isPublic?}` → новый Study + slug | JWT |
| `GET` | `/api/studies/:slug` | Студия + список глав (без `pgn`) | optional (private — только owner; public — всем) |
| `PATCH` | `/api/studies/:slug` | Изменить `name`/`description`/`isPublic` | JWT, owner |
| `DELETE` | `/api/studies/:slug` | Удалить студию (каскад глав) | JWT, owner |
| | | | |
| `POST` | `/api/studies/:slug/chapters` | Создать главу `{name, pgn?, startFen?, orientation?, mode?}` | JWT, owner |
| `GET` | `/api/studies/:slug/chapters/:chapterId` | Глава: pgn + meta | optional (private — owner; public — всем) |
| `PATCH` | `/api/studies/:slug/chapters/:chapterId` | Обновить `name`/`pgn`/`startFen`/`orientation`/`mode` | JWT, owner |
| `PATCH` | `/api/studies/:slug/chapters/:chapterId/order` | Переупорядочить `{after: chapterId|null}` | JWT, owner |
| `DELETE` | `/api/studies/:slug/chapters/:chapterId` | Удалить главу | JWT, owner |
| `POST` | `/api/studies/:slug/import-pgn` | Импорт multi-PGN → N глав | JWT, owner |
| `GET` | `/api/studies/:slug/export.pgn` | Экспорт всей студии (text/x-chess-pgn) | optional |
| `GET` | `/api/studies/:slug/chapters/:chapterId/export.pgn` | Экспорт одной главы | optional |
| | | | |
| `GET` | `/api/studies/public/c/:chapterId` | Публичный доступ к главе по UUID (если `study.isPublic=true`) | none |

Логика guard'а: используем **новый `StudyAccessGuard`** по образцу
`LessonsAccessGuard`. На мутациях — owner; на чтении — owner либо
public.

### B.5 UI-маршруты и компоненты

| Маршрут | Компонент | Что |
|---------|-----------|-----|
| `/studies` | `StudiesPage` | Каталог: вкладки «Мои» / «Публичные», карточки `StudyCard` |
| `/studies/:slug` | `StudyPage` | Заголовок + описание + список глав (`ChapterList`) + действия (Создать главу / Импорт PGN / Share / Delete) |
| `/studies/:slug/:chapterId` | `StudyChapterEditorPage` | Композиция: `MemoChessboard` + `ReviewMoveList` (из `apps/web/src/review`) + `NagPalette` + кнопки `PgnHeadersModal`/`SetPositionModal` |
| `/studies/c/:chapterId` | `StudyChapterPublicPage` | Read-only `InlinePgnViewer` стиль |

Новые компоненты только:

- `StudiesPage.tsx` (каталог, ~200 LOC)
- `StudyPage.tsx` (детальная страница студии, ~250 LOC)
- `StudyChapterEditorPage.tsx` (тонкая обёртка над `useReviewState` +
  `ReviewMoveList`; ~300 LOC)
- `StudyChapterPublicPage.tsx` (read-only, ~150 LOC)
- `StudyCard.tsx` (~80 LOC)
- `ChapterList.tsx` (drag-n-drop, ~200 LOC)
- `ImportPgnDialog.tsx` (~120 LOC)
- `useStudyChapterPersistence.ts` хук (auto-save с debounce; копия
  `useAnalysisPersistence`, переключённая на `/api/studies/...`; ~80 LOC)
- `studiesApi.ts` (~150 LOC)

Итого **~1530 LOC чистого нового frontend-кода** на MVP. Всё, что
переиспользуется — переиспользуется через импорт; никаких extract'ов в
shared в MVP (это можно сделать в фазе 2, если потребуется backend-
валидация аннотаций).

### B.6 Что НЕ делаем

- Не создаём пункт sidebar **на постоянной основе** — только под
  флагом `studiesEnabled` (default off). Это страховка.
- Не плодим WebSocket-каналов, серверной in-memory модели — нет
  realtime в MVP.
- Не вводим систему лайков / каталога-социалки.
- Не делаем embed-страницу с iframe (отдельный тикет фазы 2).
- Не выносим `AnnotationColor`/`ArrowAnnotation` в shared (пусть
  пока живут в `apps/web/src/review/types.ts`, как сейчас). Backend
  не валидирует структуру pgn — только string-блоб + length-limit.
- Не переписываем уже работающую логику review/PgnSerializer — берём
  через import.

### B.7 Риски и митигации

| Риск | Митигация |
|------|-----------|
| **PGN-блоб ≫50 КБ → медленный PATCH** | Лимит на размер pgn (например 256 КБ) + auto-save с debounce 1000ms |
| **Дублирование с Lessons editor** | Сначала строим, **потом** решаем — есть ли что выносить в общий компонент. В MVP не выносим |
| **slug-коллизии** | `SlugService` уже обрабатывает через retry; max 5 попыток |
| **64 главы ≫ deps в одной транзакции** | Импорт multi-PGN пакетит chunk'ами по 8 глав, чтобы не упереться в Prisma timeout |
| **Migration в проде без даунтайма** | Чистое `CREATE TABLE` — без `ALTER` существующих таблиц; даунтайма нет |
| **«Где это в меню?»** | Под flag-flag'ом, пользователь сам включит когда захочет; ссылка из профиля (опц.) |

---

## C. Пересмотренная оценка трудозатрат

### C.1 Сравнение с KS-2792 §4.1 (исходный MVP в Proposed)

| Этап | Старый план | Новый план (KS-2815) | Δ |
|------|-------------|------------------------|---|
| Backend (миграция, модуль, REST, импорт/экспорт) | 5–6 дн | **4–5 дн** | −1 дн |
| Frontend (страницы, редактор глав, каталог) | 5–6 дн | **4–5 дн** | −1 дн (отказ от Lichess-полной палитры в MVP) |
| Тесты | 1–2 дн | **1–2 дн** | равно |
| **Итого MVP** | **10–12 дн** | **9–11 дн** | **−1 дн** |

Чистая экономия — за счёт явного отказа от сложных частей (practice,
gamebook, embed, contributors), фокус только на «работающие главы +
shared-каталог».

### C.2 Что переиспользуется (LOC reuse / total)

| Слой | Reused LOC | New LOC | % reuse |
|------|-----------|---------|---------|
| Frontend dependencies (`review`, доска, hooks, modal'ы) | ~5500 | 0 | 100% |
| Frontend новые компоненты | 0 | ~1530 | 0% |
| Backend guards/slug/rate-limit | ~400 | 0 | 100% |
| Backend Studies-сервисы (контроллеры, сервис, dto, тесты) | 0 | ~1800 | 0% |
| Backend PGN-utils (workshop splitPgn, analysis metadata-extract) | ~250 | 0 | 100% |
| Миграция БД | 0 | ~80 | 0% |

Из «новых» ~3400 строк значительная часть — boilerplate (DTOs, controller
endpoints, тесты), что в продуктивном коде пишется быстро.

---

## D. Декомпозиция тикетов (создаются в трекере одним пакетом)

Все тикеты — TODO, без перевода в работу. Ассайны: **backend**,
**frontend**, **layout**, **architect** (для ADR-документа).

### D.1 Architecture / Migration

- **T1 architect**: Создать ADR (`docs/adr/059-studies-module.md`) —
  ссылка на этот KS-2815, фиксирует модель `Study`/`StudyChapter`, API,
  guards. ≈ 0.5 дня.
- **T2 backend**: Prisma-миграция: новые таблицы `studies`,
  `study_chapters` + индексы; добавление `ownedStudies` relation в `User`.
  ≈ 0.5 дня.

### D.2 Backend

- **T3 backend**: `StudyModule` + `StudyService` + `StudyChaptersService`
  + DTO + `StudyAccessGuard` + `StudyOwnerGuard`. ≈ 1.5 дня.
- **T4 backend**: REST endpoints (CRUD study + CRUD chapter +
  reorder). ≈ 1 день.
- **T5 backend**: Multi-PGN import + .pgn export endpoints
  (переиспользуем `workshop/pgn.parser`). ≈ 0.5 дня.
- **T6 backend**: `StudyPublicController` для anonymous access по
  публичной ссылке. ≈ 0.25 дня.
- **T7 backend**: Тесты сервисов и контроллеров (happy-path + permissions
  matrix). ≈ 1 день.
- **T8 backend**: Feature-flag `studiesEnabled` (whitelist в
  `KNOWN_FEATURE_FLAGS` + сидинг default `false`). ≈ 0.25 дня.

### D.3 Frontend

- **T9 frontend**: `studiesApi.ts` + типы DTO в `packages/shared`
  (новый файл `types/studies.ts`). ≈ 0.5 дня.
- **T10 frontend**: `StudiesPage` (`/studies` каталог: мои / публичные,
  карточки). ≈ 1 день.
- **T11 frontend**: `StudyPage` (`/studies/:slug` детальная — список
  глав, заголовок, действия). ≈ 1 день.
- **T12 frontend**: `StudyChapterEditorPage` (`/studies/:slug/:chapterId`
  — обёртка над `useReviewState` + `ReviewMoveList` + кнопки управления
  + auto-save). ≈ 1.5 дня.
- **T13 frontend**: `StudyChapterPublicPage` (`/studies/c/:chapterId` —
  read-only). ≈ 0.5 дня.
- **T14 frontend**: `ImportPgnDialog` + интеграция в `StudyPage`. ≈ 0.5
  дня.
- **T15 frontend**: `ChapterList` с drag-n-drop. ≈ 0.5 дня.
- **T16 frontend**: Sidebar — добавить пункт «🧪 Студии» под
  `studiesEnabled` (default off). ≈ 0.25 дня.
- **T17 frontend**: i18n-ключи `studies.*` (ru/en). ≈ 0.5 дня.
- **T18 frontend**: vitest для каталога и редактора. ≈ 0.75 дня.

### D.4 Layout / CSS

- **T19 layout**: `studies.css` — стили каталога, страницы студии,
  редактора, public-page. ≈ 0.5 дня.

### D.5 Сводка

| Категория | Тикетов | Дней |
|-----------|---------|-----|
| Architecture | 1 | 0.5 |
| Backend | 7 | 5 |
| Frontend | 10 | 7 |
| Layout | 1 | 0.5 |
| **Всего** | **19** | **≈ 13 дней одного человека последовательно** |

При параллельной работе backend + frontend (без зависимостей):
**≈ 7–8 календарных дней**.

### D.6 Реальные ключи в трекере (созданы пакетом KS-2815)

| T | Ключ | Assignee | Резюме |
|---|------|----------|--------|
| T1 | KS-2816 | architect | ADR-059 Studies module |
| T2 | KS-2817 | backend | Prisma миграция (studies + study_chapters) |
| T3 | KS-2818 | backend | StudyModule — сервисы, DTO, guards |
| T4 | KS-2819 | backend | REST Studies CRUD + Chapters CRUD + reorder |
| T5 | KS-2820 | backend | Multi-PGN импорт + экспорт |
| T6 | KS-2821 | backend | StudyPublicController |
| T7 | KS-2822 | backend | Тесты backend permissions matrix |
| T8 | KS-2823 | backend | Feature-flag studiesEnabled |
| T9 | KS-2824 | frontend | Shared types + studiesApi.ts |
| T10 | KS-2825 | frontend | StudiesPage (каталог) |
| T11 | KS-2826 | frontend | StudyPage (детали + действия) |
| T12 | KS-2827 | frontend | StudyChapterEditorPage |
| T13 | KS-2829 | frontend | StudyChapterPublicPage |
| T14 | KS-2830 | frontend | ImportPgnDialog |
| T15 | KS-2831 | frontend | ChapterList drag-n-drop |
| T16 | KS-2832 | frontend | Sidebar пункт «🧪 Студии» под флагом |
| T17 | KS-2833 | frontend | i18n studies (ru/en) |
| T18 | KS-2834 | frontend | vitest frontend |
| T19 | KS-2835 | layout | studies.css |

Все тикеты в статусе **TODO**. Запуск пакетом по согласованию.

---

## E. Что произойдёт после MVP (Phase 2 — отдельно)

Эти задачи **не входят** в пакет MVP, перечислены только чтобы пакет
не блокировал перспективы:

- Режим `practice` (проверка хода по дереву).
- Режим `conceal` (скрытие ветки после ply).
- Режим `gamebook` (учебник с инструкциями).
- Embed iframe `/studies/embed/:chapterId`.
- Поиск и фильтры в каталоге.
- Лайки и счётчик популярности.
- Contributors / membership.
- Интеграция UI с `/lessons` (если пользователь решит, что нужно).
- Кнопка «Сохранить как студию» в AnalysisPage.
- Broadcast-зеркало (если решим).
- Realtime-коллаборация (если решим).

---

## F. Ссылки

- Документ: `docs/architecture/KS-2792-studies-research.md` (исходное
  исследование); §§3–§7 superseded в части интеграции, см. §8 там же.
- ADR-051 chess-content-delivery-cache (share-1/2 паттерн для публичного
  доступа).
- ADR-026 user-courses-* (паттерн пользовательского контента — образец).
- ADR-054 user-courses-merge (единые таблицы system+user, образец для
  совместного guard'а).
- KS-2793 (вариант D отменён).
- KS-2794 (sidebar restructure — независимо).
- Файлы:
  - `apps/web/src/review/*` — переиспользуется как ядро.
  - `apps/api/src/lessons/user-courses/*` — образец сервисного слоя.
  - `apps/api/src/analysis/*` — образец публичного доступа.
  - `apps/api/src/workshop/pgn.parser.ts` — splitPgn для импорта.
