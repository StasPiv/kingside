# ADR-054 — Слияние пользовательских курсов в системные модели Course/Lesson/LessonStep

- Статус: Proposed
- Дата: 2026-05-09
- Связанные задачи: KS-2637
- Пересматривает: ADR-026 (User Courses, отдельные модели)
- Влияет на: ADR-049 (User courses parity), ADR-052 (My courses admin), ADR-053 (UI-унификация reader-страницы)
- Авторы: architect

---

## 1. Контекст

ADR-026 (KS-1827) ввёл для пользовательских курсов **параллельное дерево моделей** `UserCourse / UserLesson / UserLessonStep` + два прогресс-агрегата `UserCoursePlayProgress / UserLessonPlayProgress` рядом с системными `Course / Lesson / LessonStep / UserCourseProgress / UserLessonProgress`. На момент решения это было оправдано: системные курсы шли через i18n-keys и админский импорт, пользовательский редактор был изолированным MVP, а слияние ломало бы i18n-flow.

С тех пор:
- ADR-049 (Tier 1) добавил пользовательскому редактору quiz/diagram/endgame_drill — типы шагов и payload-валидаторы у системных и пользовательских уроков теперь **идентичны** (`StepPayload` shared union).
- ADR-052 закрыл админку автора (`/lessons/my`) на старой схеме.
- ADR-053 §2 показал, что параллельные деревья дают семантически зеркальные API/хуки/страницы и `UserLessonPlayProgress.stepsState` восстановлен до уровня `UserLessonProgress.stepsState` (KS-1879/KS-1880).

Жалоба пользователя (2026-05-09): «Системные курсы работают отлично — пользователь должен создавать в той же структуре и в тех же таблицах. Никакого дублирования». Запрос явно требует слить деревья.

Цель ADR — спроектировать миграцию, оценить риски, разложить по задачам и принять решение по уже намеченному Tier 1 ADR-053.

---

## 2. Аудит дублирования (с файлами)

### 2.1 БД — модели

`packages/db/prisma/schema.prisma`:

| Системные | Пользовательские | Расхождение |
|-----------|------------------|-------------|
| `Course` (`schema.prisma:848-904`) | `UserCourse` (`schema.prisma:1049-1065`) | system: `lang`, `parentCourseId`, `level`, `titleKey`, `descriptionKey`, `audience/hook/outcome` (+ i18n-ключи), `coverUrl`, `difficulty`, `estimatedMinutes`, `tags`, `blockOrder`, `order`, `isPublished`. user: `ownerId`, `slug @unique`, `title`, `description`, `isPublic`. |
| `Lesson` (`906-944`) | `UserLesson` (`1067-1081`) | system: `slug`, `blockKey`, `kind`, `titleKey/title`, `summaryKey/summary`, `lang`, `parentLessonId`, `isPublished`. user: только `userCourseId`, `order`, `title`, `estMinutes`. |
| `LessonStep` (`947-958`) | `UserLessonStep` (`1084-1095`) | По полям **идентичны**: `id, lessonId/userLessonId, order, type, payload (Json), createdAt`. Разница только в `type`-whitelist (system: 8, user: 4). |
| `UserCourseProgress` (`961-976`) — простой агрегат курса | `UserCoursePlayProgress` (`1098-1112`) — играющий прогресс с `lastActivityAt`/`completedLessonsCount` | Разные поля: system держит `currentLessonId`, user — счётчик. |
| `UserLessonProgress` (`979-998`) — `stepsState`, `score`, `completedAt`, `masteredAt` | `UserLessonPlayProgress` (`1114-1136`) — `stepsState`, `completedStepsCount/totalSteps`, `lastActivityAt` | Семантически зеркальны. SM-2-поля только у системного. |
| `LessonReview` (`1009-1027`) — SM-2 | — | SM-2 только у системных (ADR-026 §2.1). |

**Вывод:** дублирование подтверждено. `LessonStep` ↔ `UserLessonStep` — клон по shape. Прогресс-таблицы зеркальны с разными именами. Курс/урок дублируются с поправкой на i18n-tree и `ownerId`.

### 2.2 Backend — параллельные модули

| Системные | Пользовательские |
|-----------|------------------|
| `apps/api/src/lessons/courses.controller.ts` (`@Controller('lessons/courses')`) | `apps/api/src/lessons/user-courses/user-courses.controller.ts` (`@Controller('lessons/user-courses')`), `user-courses-public.controller.ts`, `user-lessons.controller.ts` (`@Controller('lessons')` префикс с `user-lessons/*`), `user-lesson-steps.controller.ts` (`@Controller('lessons/user-lesson-steps')`) |
| `apps/api/src/lessons/lessons.controller.ts` (`@Controller('lessons/lessons')`) — `GET /:id` | (входит в `user-lessons.controller.ts`) |
| `apps/api/src/lessons/progress.controller.ts` (`@Controller('lessons/progress')`) — `step`, `lesson/complete` | `apps/api/src/lessons/user-courses/user-progress.controller.ts` (`@Controller('lessons/user-progress')`) — `lessons/:userLessonId/step`, `complete`, `courses/:userCourseId`, `lessons/:userLessonId` |
| `apps/api/src/lessons/admin/lessons-admin.controller.ts` + `admin/lessons-admin-lessons.controller.ts` + `admin/lessons-admin-steps.controller.ts` (под `@Controller('lessons/admin/*')`) | (нет — пользователь сам себе админ через `UserCourseOwnerGuard`) |
| Сервисы: `courses.service.ts`, `lessons.service.ts`, `progress.service.ts`, `sm2.service.ts` | `user-courses.service.ts`, `user-lessons.service.ts`, `user-lesson-steps.service.ts`, `user-progress.service.ts`, `slug.service.ts` |
| DTOs: `apps/api/src/lessons/dto/*` (StepPayload-варианты, complete-lesson, update-step-progress) | `apps/api/src/lessons/user-courses/dto/*` — параллельные (`user-course.dto.ts`, `user-lesson.dto.ts`, `user-lesson-step.dto.ts`, `user-progress.dto.ts`, **`user-step-payload.dto.ts`** — отдельный whitelist, ссылается на тот же `step-payload.dto.ts`) |
| Guards: `JwtAuthGuard` + `AdminGuard` (для `/lessons/admin/*`) | `JwtAuthGuard` + `UserCourseOwnerGuard` (`user-course-owner.guard.ts`) — owner или 404 для приватного |
| Лимиты: нет per-user (создаёт админ) | `user-courses-limits.ts`: `coursesPerUser=20`, `lessonsPerCourse=30`, `stepsPerLesson=50`, + rate-limits per user |

### 2.3 Shared — параллельные DTO

`packages/shared/src/types/lessons.ts` vs `packages/shared/src/types/user-courses.ts`:

- `Course/Lesson/LessonStep` DTO ↔ `UserCourseDto/UserLessonDto/UserLessonStepDto`.
- `LessonStepType` (8) ↔ `UserStepType` (4: `text|puzzle|endgame_drill|quiz`).
- `StepPayload` union — **общий**, переиспользуется напрямую (`user-courses.ts:20` импортирует `LessonStepState, StepPayload` из `./lessons.js`). Это уже намёк на возможность слияния.

### 2.4 Frontend — параллельные API-клиенты, страницы, хуки

| Слой | Системные | Пользовательские |
|------|-----------|-------------------|
| API-клиент | `apps/web/src/api/lessonsApi.ts` | `apps/web/src/api/userCoursesApi.ts` |
| Страница «курс» | `apps/web/src/pages/CoursePage.tsx` (`/lessons/:courseSlug`) | `apps/web/src/pages/UserCoursePage.tsx` (`/lessons/my/:slug`) |
| Страница «урок» | `apps/web/src/pages/LessonPage.tsx` (`/lessons/:courseSlug/:lessonSlug`) | `apps/web/src/pages/UserLessonPage.tsx` (`/lessons/my/:slug/:lessonId`) |
| Админка автора | — (есть `LessonEditorPage` для админа на `/lessons/editor`) | `apps/web/src/components/lessons/editor/user/UserCourseEditor.tsx` (`/lessons/my/:slug/edit`) |
| Список своих | — (нет «my courses») | `apps/web/src/pages/MyCoursesPage.tsx` (ADR-052) |
| Reader-хук | `apps/web/src/hooks/useLessonProgress.ts` | `apps/web/src/hooks/useUserLessonProgress.ts` |
| Step-компоненты (`<TextStep>`/`<QuizStep>`/…) и `<StepRenderer>` | **Общие** (см. ADR-053 §2.3) | (используют те же общие) |

### 2.5 Что общее уже сейчас

- `StepPayload` shared union — общий.
- `<StepRenderer>` и все Step-компоненты — общие.
- DTO mapping `UserLessonStepDto → LessonStep` тривиальный (только переименование `userLessonId → lessonId`, см. `UserLessonPage.tsx:43-51`).
- Хуки прогресса повторяют один интерфейс (см. ADR-053 §2.3).

То есть **продуктовое поведение и render-слой уже унифицированы**, дублирование оставлено только в данных и контроллерах. Это идеальная ситуация для миграции данных без переделки UI-компонентов.

---

## 3. Целевая модель

### 3.1 Принципы

1. **Один набор таблиц** `courses`, `lessons`, `lesson_steps`. Никаких `user_*` параллельных таблиц.
2. **Признак владельца** — `ownerId String? @db.Uuid`. `NULL` = системный (как раньше). UUID = пользовательский, `ownerId` ссылается на `User.id`.
3. **Видимость через два явных флага + DB CHECK constraint**, не через enum:
   - `isPublished: Boolean` — действует только для системных (`ownerId IS NULL`). Ставит админ.
   - `isPublic: Boolean` — действует только для пользовательских (`ownerId IS NOT NULL`). Ставит автор.
   - DB CHECK: `(owner_id IS NULL AND is_public = FALSE) OR (owner_id IS NOT NULL AND is_published = FALSE)`. Пересечение запрещено — это эквивалентно явному «у системных нет isPublic, у пользовательских нет isPublished».
   - **Альтернатива (рассмотрена и отвергнута):** единое поле `visibility: enum('private', 'public', 'system_published', 'system_draft')`. Чище для выборок, но требует пересоздавать enum в Postgres при добавлении значения, дороже миграция, не несёт пользовательской выгоды относительно двух bool-полей с CHECK. Оставляем bool'ы — это понятно и расширяется добавлением колонки `unlisted` без ALTER TYPE.
4. **i18n остаётся опциональной**:
   - `titleKey: String?`, `descriptionKey: String?`, `summaryKey: String?` — `NULL` для пользовательских.
   - `title`, `description`, `summary` — текстовые override'ы. Уже сейчас системные импортирующиеся через admin API имеют inline-заполнение (`Course.title`, `Lesson.title` — `apps/api/src/lessons/admin/*`). Контракт фронта остаётся: `resolveInlineText(title, titleKey, t, fallback)` (есть в `apps/web/src/utils/inlineI18nText.ts`) — если `titleKey` непустой → `t(titleKey)`, иначе `title` напрямую. Расширения не требуется.
   - Поле `lang` остаётся обязательным (default `'ru'`), для пользовательских — выводится из `User.locale` на момент создания.
5. **Slug-namespace разделён по владельцу.** Уникальность `(slug, lang)` для системных (root) и `(ownerId, slug)` для пользовательских. Технически — два partial-unique индекса:
   - `UNIQUE INDEX courses_slug_lang_system_uniq ON courses (slug, lang) WHERE owner_id IS NULL;`
   - `UNIQUE INDEX courses_owner_slug_user_uniq ON courses (owner_id, slug) WHERE owner_id IS NOT NULL;`

   Это сохраняет существующий compound `Course @@unique([slug, lang])` для системных и переносит сегодняшний `UserCourse.slug @unique` в namespace владельца.
6. **Прогресс — одна таблица на каждый уровень**:
   - `LessonProgress` (renamed from `UserLessonProgress`): `userId, lessonId, stepsState, score, completedAt, masteredAt, startedAt, lastActivityAt, updatedAt`.
   - `CourseProgress` (renamed from `UserCourseProgress`): `userId, courseId, currentLessonId, completedAt, lastActivityAt`.
   - `UserCoursePlayProgress` и `UserLessonPlayProgress` **удаляются** после копирования данных в `LessonProgress`/`CourseProgress`.
   - Поля счётчиков (`completedStepsCount`, `totalSteps`, `completedLessonsCount`) — **не нужны на хранение**: они вычисляются из `stepsState` / `lessons.length` (как уже делает `progress.service.ts`/`user-progress.service.ts`). Если профилирование покажет узкое место — возвращаем как computed-колонки, но пока денормализация не оправдана.
7. **SM-2 (`LessonReview`) — остаётся как есть**, FK на единую `lessons.id`. Активация SM-2 по правилу: `lesson.ownerId IS NULL`. Для пользовательских уроков SM-2 не запускается (как сейчас, ADR-026 §2.1). Если в будущем хотим включить — снимаем условие в `Sm2Service`, ничего в схеме не меняется.
8. **Авторские лимиты** (`coursesPerUser`, `lessonsPerCourse`, `stepsPerLesson`) применяются только когда `ownerId IS NOT NULL`. Для системных лимита нет.
9. **Type-whitelist** для пользовательских (`UserStepType` 4 значения) проверяется в DTO-валидаторе **по условию `ownerId IS NOT NULL`**. Системные курсы могут использовать все 8 типов. Это контракт сервиса, а не БД.

### 3.2 Целевая Prisma-схема (фрагмент)

```prisma
model Course {
  id               String   @id @default(uuid()) @db.Uuid
  ownerId          String?  @map("owner_id") @db.Uuid           // NEW: NULL=system
  slug             String
  lang             String   @default("ru")
  parentCourseId   String?  @map("parent_course_id") @db.Uuid
  level            String?                                       // NULL для user (раньше required)
  titleKey         String?  @map("title_key")                    // NULL для user
  descriptionKey   String?  @map("description_key")              // NULL для user
  title            String?
  description      String?
  audience         String?
  hook             String?
  outcome          String?
  coverUrl         String?  @map("cover_url")
  difficulty       Int?     // NULL для user
  estimatedMinutes Int?     @map("estimated_minutes")
  audienceI18nKey  String?  @map("audience_i18n_key")
  hookI18nKey      String?  @map("hook_i18n_key")
  outcomeI18nKey   String?  @map("outcome_i18n_key")
  tags             String[] @default([])
  blockOrder       String[] @default([]) @map("block_order")
  order            Int      @default(0)
  isPublished      Boolean  @default(false) @map("is_published") // только system
  isPublic         Boolean  @default(false) @map("is_public")    // только user (NEW)
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  owner        User?     @relation("OwnedCourses", fields: [ownerId], references: [id], onDelete: Cascade)
  lessons      Lesson[]
  progress     CourseProgress[]
  parent       Course?   @relation("CourseTranslations", fields: [parentCourseId], references: [id], onDelete: SetNull)
  translations Course[]  @relation("CourseTranslations")

  // Partial-unique индексы:
  //   (slug, lang) WHERE owner_id IS NULL — системный namespace
  //   (owner_id, slug) WHERE owner_id IS NOT NULL — namespace владельца
  // Создаются прямой SQL-командой в миграции (Prisma 5.x не умеет partial unique в схеме).

  @@index([level, order])
  @@index([isPublished])
  @@index([lang, isPublished])
  @@index([ownerId, isPublic])                                   // user-public listings
  @@map("courses")
}

model Lesson {
  id             String   @id @default(uuid()) @db.Uuid
  courseId       String   @map("course_id") @db.Uuid
  ownerId        String?  @map("owner_id") @db.Uuid              // NEW: денормализация из course (для guards без join)
  slug           String?                                          // NULL для user (раньше required)
  order          Int      @default(0)
  blockKey       String?  @map("block_key")                       // NULL для user (раньше required)
  kind           String?                                          // NULL для user
  titleKey       String?  @map("title_key")
  summaryKey     String?  @map("summary_key")
  title          String?
  summary        String?
  estMinutes     Int      @default(10) @map("est_minutes")
  lang           String   @default("ru")
  parentLessonId String?  @map("parent_lesson_id") @db.Uuid
  isPublished    Boolean  @default(false) @map("is_published")
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  course       Course           @relation(fields: [courseId], references: [id], onDelete: Cascade)
  steps        LessonStep[]
  progress     LessonProgress[]
  reviews      LessonReview[]
  parent       Lesson?  @relation("LessonTranslations", fields: [parentLessonId], references: [id], onDelete: SetNull)
  translations Lesson[] @relation("LessonTranslations")

  @@index([courseId, order])
  @@index([courseId, blockKey, order])
  @@index([isPublished])
  @@index([parentLessonId])
  @@index([ownerId])                                              // owner-guard lookups
  @@map("lessons")
}

model LessonStep {
  id        String   @id @default(uuid()) @db.Uuid
  lessonId  String   @map("lesson_id") @db.Uuid
  order     Int      @default(0)
  type      String
  payload   Json
  createdAt DateTime @default(now()) @map("created_at")

  lesson Lesson @relation(fields: [lessonId], references: [id], onDelete: Cascade)

  @@index([lessonId, order])
  @@map("lesson_steps")
}

model CourseProgress {  // ex-UserCourseProgress
  id              String    @id @default(uuid()) @db.Uuid
  userId          String    @map("user_id") @db.Uuid
  courseId        String    @map("course_id") @db.Uuid
  startedAt       DateTime  @default(now()) @map("started_at")
  completedAt     DateTime? @map("completed_at")
  currentLessonId String?   @map("current_lesson_id") @db.Uuid
  lastActivityAt  DateTime  @default(now()) @map("last_activity_at")  // ex-user_course_play_progress
  updatedAt       DateTime  @default(now()) @updatedAt @map("updated_at")

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  course Course @relation(fields: [courseId], references: [id], onDelete: Cascade)

  @@unique([userId, courseId])
  @@index([userId])
  @@index([userId, lastActivityAt])
  @@map("course_progress")  // переименование с user_course_progress
}

model LessonProgress {  // ex-UserLessonProgress
  id             String    @id @default(uuid()) @db.Uuid
  userId         String    @map("user_id") @db.Uuid
  lessonId       String    @map("lesson_id") @db.Uuid
  startedAt      DateTime  @default(now()) @map("started_at")
  completedAt    DateTime? @map("completed_at")
  masteredAt     DateTime? @map("mastered_at")
  score          Int       @default(0)
  stepsState     Json      @default("{}") @map("steps_state")
  lastActivityAt DateTime  @default(now()) @map("last_activity_at")
  updatedAt      DateTime  @default(now()) @updatedAt @map("updated_at")

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  lesson Lesson @relation(fields: [lessonId], references: [id], onDelete: Cascade)

  @@unique([userId, lessonId])
  @@index([userId])
  @@index([userId, completedAt])
  @@map("lesson_progress")  // переименование с user_lesson_progress
}
```

### 3.3 CHECK constraints (raw SQL в миграции)

```sql
ALTER TABLE courses ADD CONSTRAINT courses_visibility_owner_check CHECK (
  (owner_id IS NULL  AND is_public = FALSE) OR
  (owner_id IS NOT NULL AND is_published = FALSE)
);

ALTER TABLE lessons ADD CONSTRAINT lessons_published_user_check CHECK (
  owner_id IS NULL OR is_published = FALSE
);
```

### 3.4 Авторизация (один guard вместо двух)

`LessonsAccessGuard` (новый):
- `JwtAuthGuard` — обязательный логин (как и сейчас).
- Для **read** (`GET /lessons/courses/:slug`, `GET /lessons/lessons/:id`):
  - системный (`ownerId IS NULL`) `isPublished=true` → доступен всем;
  - пользовательский `isPublic=true` → доступен всем;
  - `ownerId === currentUserId` → доступен (черновик/приватный);
  - иначе → 404 (не раскрываем существование).
- Для **write** (`POST/PATCH/DELETE`):
  - системный курс → только `AdminGuard`.
  - пользовательский → только owner.
- Лимиты `coursesPerUser/lessonsPerCourse/stepsPerLesson` применяются если `ownerId IS NOT NULL`.

Заменяет: `UserCourseOwnerGuard`, частично `AdminGuard` для не-admin путей.

### 3.5 Уровень API после миграции

Целевые URL — единые `/lessons/courses/*`, `/lessons/lessons/*`, `/lessons/progress/*`. Старые `/lessons/user-courses/*`, `/lessons/user-lessons/*`, `/lessons/user-lesson-steps/*`, `/lessons/user-progress/*` — **deprecated alias-роуты** с HTTP 308 + заголовком `Deprecation: true` на 1 релиз, потом удаляются. Это страхует FE, у которого процесс перевозки клиентов идёт параллельно.

```
GET    /lessons/courses                           — listing (filters: ownerId, isPublic, isPublished, mine, lang)
GET    /lessons/courses/:slug                     — деталь (slug + ownerId namespace для пользовательских; slug + lang для системных)
POST   /lessons/courses                           — создать пользовательский (ownerId = currentUser; админ создаёт через /lessons/admin/courses)
PATCH  /lessons/courses/:id                       — owner или admin
DELETE /lessons/courses/:id                       — owner или admin
POST   /lessons/courses/:id/lessons               — добавить урок (owner/admin)
POST   /lessons/courses/:id/lessons/reorder       — reorder
GET    /lessons/lessons/:id                       — деталь урока
PATCH  /lessons/lessons/:id                       — обновить урок
DELETE /lessons/lessons/:id                       — удалить
POST   /lessons/lessons/:id/steps                 — добавить шаг
POST   /lessons/lessons/:id/steps/reorder         — reorder
PATCH  /lessons/steps/:id                         — обновить шаг
DELETE /lessons/steps/:id                         — удалить шаг
POST   /lessons/progress/lessons/:id/step         — отметка шага
POST   /lessons/progress/lessons/:id/complete     — финал
GET    /lessons/progress/lessons/:id              — текущий прогресс
GET    /lessons/progress/courses/:id              — текущий прогресс курса
```

Админский подресурс `/lessons/admin/courses/*` остаётся отдельным (создание системных курсов, импорт YAML, модерация). Обращается к тем же таблицам.

### 3.6 Frontend после миграции

- `userCoursesApi` сливается в `lessonsApi` (или сохраняется тонкой обёрткой над фасадом). В Tier 1 миграции — оставляем тонкую обёртку под старыми именами для непрерывной работы FE.
- `UserCoursePage` → удаляется, маршрут `/lessons/my/:slug` редиректит на `/lessons/:slug`.
- `UserLessonPage` → удаляется, маршрут `/lessons/my/:slug/:lessonId` редиректит на `/lessons/:slug/:lessonSlug` (для пользовательских уроков, у которых нет `slug`, фоллбек на `id`).
- `CoursePage` / `LessonPage` получают **owner-actions** (Edit, Make public/private, Delete) через `course.ownerId === currentUser.id`. Совмещают сегодняшнюю функциональность `UserCoursePage` + системную.
- `MyCoursesPage` (`/lessons/my`, ADR-052) — остаётся, но `userCoursesApi.list({scope:'own'})` заменяется на `lessonsApi.listCourses({mine:true})`.
- `useUserLessonProgress` сливается с `useLessonProgress` (после ADR-053 их интерфейсы зеркальны; добавляем factor для `quality?: number` — оставляем optional для будущего SM-2 пользовательских).
- Редактор `UserCourseEditor` остаётся как есть, но переключается на единые ручки `/lessons/courses/:id`. Маршрут `/lessons/my/:slug/edit` остаётся (или сливается с админским `/lessons/editor` через детект `ownerId`).

### 3.7 Что критично для слугов и URL

Сегодняшний URL `/lessons/my/:slug` использует пользовательский slug (уникальный по namespace владельца). После миграции slug всё ещё уникален в namespace owner'а, поэтому путь можно сохранить как `/lessons/my/:slug` (alias) или унифицировать в `/lessons/:slug` (но тогда возможны коллизии с системными slugs). **Предлагаем:** сохранить `/lessons/my/:slug` как маршрут «свои/публичные пользовательские», а `/lessons/:courseSlug` оставить только для системных. Это user-friendly разделение и **не требует** менять slug-генератор.

Альтернатива: ввести единый namespace `/lessons/:slug` и переименовывать пересекающиеся при миграции. Дороже и без выгоды — оставляем разделение префиксом `my`.

---

## 4. План миграции

Миграция делится на **5 фаз** с явным rollback-окном до Phase E. Каждая фаза — самостоятельный PR + миграция Prisma + сценарий отката.

### Phase A — расширение системных таблиц (additive, БД)

1. Prisma-миграция `add_owner_visibility_to_lessons`:
   - `courses`: добавить `owner_id uuid NULL`, `is_public boolean DEFAULT false`. Сделать `level`, `title_key`, `description_key`, `difficulty` nullable.
   - `lessons`: добавить `owner_id uuid NULL`. Сделать `slug`, `block_key`, `kind`, `title_key`, `summary_key` nullable.
   - Создать partial-unique индексы (см. §3.1 п.5) **сразу**, чтобы избежать гонки при копировании.
2. CHECK constraints **не добавляем** в Phase A — они появятся в Phase E после удаления старых таблиц, чтобы не ломать промежуточные write'ы.
3. Сервисы и контроллеры остаются на старых моделях (read/write `UserCourse` пока через старые таблицы).
4. **Risk:** низкий (additive). **Rollback:** `prisma migrate down` снимает колонки.
5. **Срок:** 1-2 дня (миграция + тесты на пустоту чтения).

### Phase B — копирование данных (БД, ETL)

1. Один SQL-script (или TS-скрипт через Prisma):
   ```sql
   -- copy user_courses → courses
   INSERT INTO courses (id, owner_id, slug, lang, title, description, is_public, created_at, updated_at, ...)
     SELECT id, owner_id, slug, 'ru', title, description, is_public, created_at, updated_at, ...
       FROM user_courses;
   -- copy user_lessons → lessons (с denormalized owner_id из user_courses)
   INSERT INTO lessons (id, course_id, owner_id, "order", title, est_minutes, lang, created_at, updated_at)
     SELECT ul.id, ul.user_course_id, uc.owner_id, ul."order", ul.title, ul.est_minutes, 'ru', ul.created_at, ul.updated_at
       FROM user_lessons ul JOIN user_courses uc ON uc.id = ul.user_course_id;
   -- copy user_lesson_steps → lesson_steps
   INSERT INTO lesson_steps (id, lesson_id, "order", type, payload, created_at)
     SELECT id, user_lesson_id, "order", type, payload, created_at
       FROM user_lesson_steps;
   ```
2. Прогресс: `user_lesson_play_progress → lesson_progress`, `user_course_play_progress → course_progress`.
3. **Идемпотентность:** все INSERT с `ON CONFLICT (id) DO NOTHING` — при повторном запуске не дублируем.
4. UUID-стабильность: id в `lessons` остаётся тем же, что в `user_lessons` — это сохраняет внешние ссылки (`UserLessonPlayProgress.userLessonId === lessons.id` после миграции).
5. Verification queries в конце скрипта: `SELECT COUNT(*) FROM courses WHERE owner_id IS NOT NULL` = `SELECT COUNT(*) FROM user_courses` и т.д.
6. **Risk:** средний (data integrity). Сценарий отката: `DELETE FROM courses WHERE owner_id IS NOT NULL; DELETE FROM lessons WHERE owner_id IS NOT NULL; ...` — данные в `user_*` не тронуты.
7. **Срок:** 2-3 дня (скрипт + dry-run на дампе production + verification).

### Phase C — backend dual-write (опционально) или прямой switch

**Вариант C1 (рекомендован) — прямой switch:**
1. Объединённые контроллеры/сервисы. `UserCoursesController/Service` удаляются; в `CoursesService` появляется код для пользовательских (с проверкой `ownerId`) и админских.
2. `UserCourseOwnerGuard` → `LessonsAccessGuard`.
3. Старые URL `/lessons/user-courses/*` → alias-controller возвращает HTTP 308 на новые URL. Сохраняется на 1 релиз.
4. Бэк-тесты переписываются: `*.spec.ts` объединяются в один пакет; добавляются e2e на (а) системный happy-path не сломан, (б) пользовательский CRUD работает на новой схеме.
5. **Risk:** высокий (вся реальная нагрузка пишет в новую схему). Mitigation: фича-флаг `lessons.unified_models` на уровне сервиса — при `false` старые контроллеры пишут в `user_*` (как сейчас), при `true` — в `courses`. Включаем флаг постепенно.
6. **Rollback:** выключаем фича-флаг, БД-данные в обеих копиях остаются (Phase B копировал, Phase C параллельно пишет в обе ветки если флаг dual-write включён).
7. **Срок:** 5-7 дней.

**Вариант C2 (отвергнут):** долгосрочный dual-write с асинхронной репликацией. Сложно поддерживать, не оправдано на 1 разработчика.

### Phase D — frontend switch

1. `userCoursesApi` пересобирается как тонкий фасад над `lessonsApi` с новыми эндпоинтами. Внешний контракт `userCoursesApi.list/create/...` сохраняется → меньше зацепок в FE.
2. `UserCoursePage`, `UserLessonPage` удаляются. Маршруты `/lessons/my/:slug` и `/lessons/my/:slug/:lessonId` — оставляем, но компонент один: `CoursePage`/`LessonPage`. Внутри определяем `isOwner = course.ownerId === user?.id` и рендерим owner-actions/edit-кнопки.
3. `useUserLessonProgress` удаляется. `useLessonProgress` принимает новые routes (`/lessons/progress/lessons/:id/step` и т.д.).
4. Редактор `UserCourseEditor` остаётся как компонент, но переключается на единые ручки.
5. ADR-053 Tier 1 (см. §5) — поглощается этой фазой.
6. **Risk:** средний (UI-регрессия). Mitigation: e2e на системный reader не трогается, e2e на пользовательский переписывается.
7. **Rollback:** revert FE-коммитов; данные не страдают (BE поддерживает обе ветки через флаг C1).
8. **Срок:** 7-10 дней (с учётом тестов).

### Phase E — cleanup (final, irreversible)

1. **Дамп `user_*` таблиц в S3/локально** (страховка, не для restore — для аналитики).
2. Drop таблиц: `user_lesson_play_progress`, `user_course_play_progress`, `user_lesson_steps`, `user_lessons`, `user_courses`.
3. Удаление alias-controller'ов и `userCoursesApi` (если ещё не удалили).
4. Применение CHECK constraints (см. §3.3) после удаления.
5. **Risk:** низкий, но необратимый. Делаем только после 1-2 недель стабильности после Phase D.
6. **Rollback:** только из дампа. До этой фазы — все предыдущие отменяемы.
7. **Срок:** 1 день.

### 4.1 Сводка сроков и рисков

| Phase | Что | Срок | Risk | Rollback |
|-------|-----|------|------|----------|
| A | Расширение схемы | 1-2д | low | snap | 
| B | Копирование данных | 2-3д | mid | DELETE из new | 
| C | BE switch + alias | 5-7д | high | feature flag |
| D | FE switch | 7-10д | mid | revert | 
| E | Cleanup | 1д | low (irrev) | dump |

**Итого:** 16-23 дня чистой работы. С учётом ревью/багфиксов и того, что разработчик один — реалистично **5-7 недель** до Phase E.

---

## 5. Решение по Tier 1 ADR-053

KS-2629 (UserLessonPage переписан на «один шаг = один экран» под старую модель) — **уже сделано**. Этот код переживёт миграцию: страница работает, при Phase D компонент удалится, но содержательная state-машина шага будет извлечена в общий `<LessonReader>` или адаптируется в `LessonPage`.

KS-2630..KS-2636 пересматриваем:

| Тикет | Тема | Решение |
|-------|------|---------|
| KS-2630 | Step-nav: Prev/Next + клавиатура | **Отменить.** После Phase D пользовательский урок открывается через `LessonPage`, у которого это уже есть (KS-2041). Дублировать в умирающем `UserLessonPage` бесполезно. |
| KS-2631 | Extract `<LessonStepNav>` | **Отменить.** Если после Phase D одна страница — extracting не оправдан. Возвращаемся к нему отдельным тикетом, если на единой `LessonPage` появятся branch'и owner/system. |
| KS-2632 | Footer Complete (все done) для user | **Отменить.** В единой `LessonPage` всё это уже работает (KS-2091). |
| KS-2633 | Completion overlay для user | **Отменить.** Уже есть в `LessonPage` (KS-2057). |
| KS-2634 | Mobile sticky-bottom для user | **Перенести в Phase D.** Применяется к единой `LessonPage` — проверить, что overlay/footer работают и для пользовательских курсов на узких экранах. Объединить с регрессионным mobile-чеком системного. |
| KS-2635 | i18n-ключи для user-reader | **Отменить.** Reader будет общий — ключи `lessons.next/prev/complete*` уже есть. Если в ходе Phase D понадобятся новые ключи (например, `lessons.private`/`lessons.public` бейджи на странице курса) — заводим внутри Phase D. |
| KS-2636 | E2E user-reader | **Перенести в Phase D.** Переписать e2e на единый `LessonPage` с фикстурой пользовательского курса. |

**Итог:** 4 из 7 задач (KS-2630/2631/2632/2633) отменяются как избыточные после миграции. KS-2634/2635/2636 — поглощаются Phase D как часть e2e-проверки и mobile-полировки. ADR-053 получает статус «частично реализован, остаток поглощён ADR-054».

> Координатор: после согласования этого ADR закрываем ADR-053 проследить, что переоткрытие отменённых тикетов не требуется. KS-2629 — оставляем закрытой, код будет переиспользован при extract'е в Phase D.

---

## 6. Декомпозиция на тикеты

Порядок строго A → B → C → D → E. Внутри каждой фазы возможна параллелизация, но между фазами — нет.

### Phase A — schema additive

| # | Назначение | Что |
|---|------------|-----|
| A1 | backend | Prisma-миграция: добавить `owner_id`, `is_public` в `courses`, `owner_id` в `lessons`. Сделать nullable: `level`, `title_key`, `description_key`, `difficulty`, `slug` (lessons), `block_key`, `kind`, `title_key` (lessons), `summary_key`. |
| A2 | backend | SQL: создать partial-unique индексы `courses_slug_lang_system_uniq` и `courses_owner_slug_user_uniq`; снять старый `Course @@unique([slug, lang])`. Заменить `UserCourse.slug @unique` подразумевается удалением модели в Phase E. |
| A3 | qa | Регресс-тест: системные эндпоинты не сломаны (CRUD курсов, импорт, прогресс). Пользовательские эндпоинты не задеты. |

### Phase B — data copy

| # | Назначение | Что |
|---|------------|-----|
| B1 | backend | Скрипт `copy-user-courses-to-system.ts`: INSERT…SELECT из `user_*` → `courses`/`lessons`/`lesson_steps`. Идемпотентность через `ON CONFLICT DO NOTHING`. |
| B2 | backend | Скрипт `copy-user-progress-to-unified.ts`: `user_lesson_play_progress` → `lesson_progress`, `user_course_play_progress` → `course_progress`. Маппинг `userLessonId === lesson.id` (uuid-стабильность). |
| B3 | qa + devops | Dry-run на дампе production-БД. Verification SQL: row-count соответствие, FK-целостность. |

### Phase C — backend switch

| # | Назначение | Что |
|---|------------|-----|
| C1 | backend | Объединённый сервис `LessonsService` (бывший `UserCoursesService` + `CoursesService` cores). Single source of CRUD. Лимиты per-owner применяются если `ownerId IS NOT NULL`. |
| C2 | backend | `LessonsAccessGuard` (новый): объединяет логику `UserCourseOwnerGuard` + read-checks для системных. Проверка через единый запрос `findUnique({where:{slug}}) | findUnique({where:{id}})`. |
| C3 | backend | Маршрутизация: добавить `/lessons/courses/:id`, `/lessons/lessons/:id`, `/lessons/steps/:id` (если нужно отдельно), `/lessons/progress/*`. Старые `/lessons/user-courses/*`, `/lessons/user-lessons/*`, `/lessons/user-lesson-steps/*`, `/lessons/user-progress/*` — alias-controller с HTTP 308. |
| C4 | backend | DTO-валидация: type-whitelist (`UserStepType` 4 vs `LessonStepType` 8) применяется по условию `course.ownerId IS NOT NULL`. |
| C5 | backend | SM-2 (`Sm2Service`): пропускать lesson если `lesson.ownerId IS NOT NULL` (как сейчас, но через единое поле). |
| C6 | backend | Feature-flag `lessons.unified_models` (default off). При on — записи идут в новую схему, при off — в старую. Для откатов. |
| C7 | qa | Бэк-тесты: переписать `user-courses-controller.spec.ts` под единые эндпоинты. Сохранить старые spec'и для alias-контроллеров (они тестируют 308). |

### Phase D — frontend switch

| # | Назначение | Что |
|---|------------|-----|
| D1 | frontend | `lessonsApi`: добавить методы для пользовательских курсов (`createCourse({ownerType:'user', title})`, `updateCourse(id, {isPublic})` и т.д.). |
| D2 | frontend | `userCoursesApi` → тонкий фасад над `lessonsApi` (или удалить, мигрируя callers). |
| D3 | frontend | `useUserLessonProgress` → удалить, заменить на `useLessonProgress` со всеми callers. |
| D4 | frontend | `UserCoursePage` → удалить; вмержить owner-actions в `CoursePage`. |
| D5 | frontend | `UserLessonPage` → удалить; вмержить в `LessonPage`. |
| D6 | frontend | Маршруты: `/lessons/my/:slug` и `/lessons/my/:slug/:lessonId` рендерят `CoursePage`/`LessonPage` (загрузка по slug в namespace owner'а). |
| D7 | frontend | `MyCoursesPage` (ADR-052) — переключить на `lessonsApi`. |
| D8 | frontend | `UserCourseEditor` — переключить вызовы на новые ручки. Компонент остаётся, поведение редактора не меняется. |
| D9 | layout | Mobile-полировка единой `LessonPage` для пользовательских курсов (поглощает KS-2634). |
| D10 | qa | E2E на единый reader (поглощает KS-2636). Регрессионный e2e на системные курсы — повторно прогнать. |

### Phase E — cleanup

| # | Назначение | Что |
|---|------------|-----|
| E1 | devops | Дамп `user_*` таблиц в S3 (стат. снимок до удаления). |
| E2 | backend | Drop user_* таблиц через Prisma-миграцию. |
| E3 | backend | Удалить alias-controllers + старые DTOs/services. |
| E4 | backend | CHECK constraints (см. §3.3). |
| E5 | qa | Smoke-тест production: 50 ручек × 10 запросов на каждую. |

---

## 7. Acceptance ADR

- [x] ADR создан в `docs/`.
- [x] Аудит конкретный, с файлами и таблицами (§2).
- [x] Спроектирована единая модель и план миграции (§3, §4).
- [x] Решение по Tier 1 ADR-053 (что отменяется/переносится) (§5).
- [x] Декомпозиция на backend → frontend с порядком и рисками (§6, §4.1).
- [ ] Координатор согласует с пользователем и поставит задачи Phase A (отдельные тикеты под каждую строку §6).

---

## 8. Последствия

**Положительные:**
- Один источник правды для контента курсов. Новые фичи (поиск, лента, аналитика) пишутся один раз.
- Убирается дублирование в БД, API, FE — снижение поверхности багов и тестов.
- Будущее SM-2 для пользовательских курсов / i18n переводов авторских курсов / админская модерация — одно изменение в единой модели вместо двух.

**Отрицательные:**
- Большая миграция (5-7 недель). На время неё «My courses»-фичи (ADR-052) и UI-улучшения reader'а (ADR-053) фрагментарно заморожены.
- Phase E необратима без бэкапа. Требует дисциплины — не пропускать дамп.
- В Phase D возможны UI-регрессии в системных курсах (общий компонент с `isOwner`-веткой). Mitigation: e2e + ручной QA-чек системного reader'а на 5 типах шагов.

**Долг и follow-up'ы (после ADR-054 закрыт):**
- ADR-055 (потенциальный): включить SM-2 для пользовательских курсов после жалоб.
- ADR-056 (потенциальный): админская модерация публичных пользовательских курсов (флаг `moderation_state`).
- Удаление поля `lessonsPerCourse=30` лимита если пользовательских курсов будет очень много (вряд ли).
