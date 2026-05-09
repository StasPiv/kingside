# ADR-052 — Авторская админка пользовательских курсов: страница «Мои курсы»

- Статус: Proposed
- Дата: 2026-05-09
- Связанные задачи: KS-2619
- Связанные ADR: ADR-026 (user-courses), ADR-030 (lessons lobby), ADR-031 (lessons lobby redesign), ADR-049 (user-courses parity)
- Авторы: architect

---

## 1. Контекст

Жалоба пользователя (2026-05-09): автор не видит список именно своих курсов и не может управлять ими. Сегодня курс автора живёт в общем намespaceе `/lessons/my/:slug`, авторские действия (Edit / Make public/private / Delete) свёрнуты в footer карточки курса (`UserCoursePage`), а карточек со списком всех своих курсов нет нигде в навигации. Чтобы что-то «починить» в каталоге своих курсов, автор должен помнить slug и заходить руками. Скопировать ссылку для расшаривания тоже негде.

Цель — выделить одну страницу-список «Мои курсы» с полным набором действий per-item и зафиксировать модель видимости.

### 1.1 Что уже сделано (ADR-026, ADR-030, ADR-049)

- Редактор кастомных курсов (`/lessons/my/:slug/edit`).
- Reader-страница (`/lessons/my/:slug`).
- 4 типа шагов (text/quiz/endgame_drill/puzzle), mobile, i18n, e2e.
- Бинарная `isPublic` уже работает (модель + API + UI-toggle на странице курса).

---

## 2. Аудит текущего состояния (read-only)

### 2.1 Backend — `apps/api/src/lessons/user-courses/`

**Уже готово, новых эндпоинтов под админку MVP не требуется.**

| Метод/путь | Поведение | Источник |
|------------|-----------|----------|
| `GET /lessons/user-courses?mine=1&limit=50&offset=0` | Список курсов автора (любой видимости). Сортировка `updatedAt DESC`. Включает `_count.lessons` и `stats` (enrolled/completed/inProgress) — только для owner-овских строк. | `user-courses.controller.ts:60-75`, `user-courses.service.ts:61-95` |
| `GET /lessons/user-courses/:slug` | Курс + уроки + прогресс. Owner ИЛИ `isPublic=true`; иначе 404. | `:96-104` |
| `POST /lessons/user-courses` | Создать курс. Лимит `coursesPerUser`, rate-limit 5/10мин. Поле `isPublic` опц., default `false`. | `:110-121` |
| `PATCH /lessons/user-courses/:id` | Owner-only. Принимает `title`/`description`/`isPublic` — это и есть toggle публикации (одной ручкой). | `:124-132`, `dto/user-course.dto.ts:48-70` |
| `DELETE /lessons/user-courses/:id` | Owner-only, `204`. **Hard delete** — каскадно удаляются `UserLesson` → `UserLessonStep` (Prisma `onDelete: Cascade`) и `UserCoursePlayProgress` (тоже cascade, см. `schema.prisma:1098-1112`). | `:135-145` |

**Модель Prisma** (`packages/db/prisma/schema.prisma:1049-1065`):

```prisma
model UserCourse {
  id          String   @id @default(uuid()) @db.Uuid
  ownerId     String   @map("owner_id") @db.Uuid
  slug        String   @unique
  title       String
  description String?
  isPublic    Boolean  @default(false) @map("is_public")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  owner    User                     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  lessons  UserLesson[]
  progress UserCoursePlayProgress[]

  @@index([ownerId, isPublic])
}
```

— только бинарный `isPublic`, никаких `visibility`/`unlisted`/`deletedAt`.

**Guard-ы**:

- `JwtAuthGuard` — обязательный логин на всём контроллере.
- `UserCourseOwnerGuard` — разрешает `GET` для публичного, всё остальное — только owner. Для приватного чужого — 404 (не раскрываем существование).

**Особенности удаления** (`user-courses.service.ts:605-611`): Prisma cascade автоматически чистит `UserLesson`, `UserLessonStep`, `UserCoursePlayProgress`, `UserLessonPlayProgress`. Студенты, проходившие курс, теряют запись прогресса безвозвратно.

### 2.2 Frontend — pages, routing, components

**Маршруты** (`apps/web/src/App.tsx:330-361`):

| Path | Компонент | Назначение |
|------|-----------|------------|
| `/lessons` | `LessonsPage` | Главная learning-лобби. Hero + Reviews + Curriculum + Community strip + **`<CreateCourseCta />`** + Recommended. **Списка моих курсов нет.** |
| `/lessons/my-active` | `MyActiveCoursesPage` | «Курсы, которые я прохожу или начал» — студенческая вкладка, не админка автора. |
| `/lessons/discover` | `DiscoverCoursesPage` | Каталог публичных курсов и авторов. |
| `/lessons/editor` | `LessonEditorPage` | Системные уроки (admin). |
| `/lessons/my/:slug` | `UserCoursePage` | Reader пользовательского курса (+ скрытые owner-actions внизу). |
| `/lessons/my/:slug/edit` | `UserCourseEditor` | Редактор. |
| `/lessons/my/:slug/:lessonId` | `UserLessonPage` | Урок. |

**Owner-actions сейчас живут в `UserCoursePage`** (`UserCoursePage.tsx:210-378`): `Edit` / `Make public ↔ Make private` / `Delete` (с `window.confirm`). Действий «Copy link» и «Open as reader» нет — последнее, потому что это и есть текущая страница.

**Готовый, но не подключённый к маршрутам компонент `MyCoursesBlock`** (`apps/web/src/components/lessons/MyCoursesBlock.tsx`): загружает `userCoursesApi.list({scope:'own'})`, рендерит карточки. Использовался на `/lessons` до KS-1940 (F-3), сейчас убран — вместо него стоит компактная `<CreateCourseCta>`. Готов к переиспользованию или эволюции в основу `MyCoursesPage`.

**Sidebar** (`apps/web/src/components/Sidebar.tsx:76-84`) — у пункта `/lessons` нет sub-меню. Точки входа на «Мои курсы» нет.

**HTTP-клиент** (`apps/web/src/api/userCoursesApi.ts`) уже умеет всё нужное — `list({scope:'own'})`, `update(id, {isPublic})`, `delete(id)`.

### 2.3 Что отсутствует / что нужно добавить

1. **Отдельной страницы «Мои курсы»** (с метаданными, бейджем публикации, действиями per-item) **нет**. CTA «+ Создать курс» на `/lessons` не закрывает сценарий «у меня уже есть N курсов, хочу управлять ими».
2. **Действия «Copy link» и «Open as reader»** не реализованы вообще нигде.
3. **Точка входа в навигацию** — отсутствует.
4. **Лейаут owner-actions** на `UserCoursePage` стилистически не унифицирован: три плоские кнопки в строке без меню overflow, плохо масштабируется на mobile.

---

## 3. Решение

### 3.1 Модель видимости — оставляем бинарной `isPublic`

Добавлять `unlisted` (доступен по ссылке, но не в публичном каталоге) **не будем**. Причины:

- Текущий `isPublic=false` уже даёт фактически unlisted-режим автору: курс доступен по прямой ссылке `/lessons/my/<slug>` **только владельцу** (guard 404'ит чужих). Разделение «полностью приватный» vs «по ссылке» бессмысленно — у всех курсов есть единственный канал доступа = прямая ссылка, общественного каталога без `isPublic=true` нет.
- Если автор хочет «по ссылке для друга, но без публичного каталога» — он держит курс приватным и шлёт ссылку. Друг 404'ится: backend не пускает не-владельца к приватному. Это разрыв сценария — **признаём ограничение MVP**, исправлять в отдельном ADR через `unlisted` или share-token, не в этой задаче.
- Усложнение схемы БД и API под фичу, которой нет в явном запросе пользователя, — уход от MVP.

Итог: `isPublic` остаётся, два состояния на UI: **«Public»** / **«Private»**, тумблером.

> **Альтернатива (не выбрана):** трёхзначный `visibility: 'private' | 'unlisted' | 'public'` с `share-token`. Это +миграция, +API, +UI копи-паста ссылки с токеном. Не оправдано в рамках жалобы.

### 3.2 Удаление — оставляем hard, фиксируем последствия

**Реализовано как есть:** `DELETE /lessons/user-courses/:id` физически удаляет `UserCourse`, каскадом — `UserLesson`, `UserLessonStep`, `UserCoursePlayProgress`, `UserLessonPlayProgress`. Восстановления нет.

Последствия для студентов, проходивших чужой курс:

- Потеря записи в `UserCoursePlayProgress` (исчезновение из `/lessons/my-active` и `enrolled`).
- Потеря progress в SM-2-планировщик (для пользовательских курсов SM-2 не подключён, см. ADR-026 §2.1 — задача не возникает).
- Если у студента в момент удаления была открыта вкладка с курсом — следующий запрос вернёт 404, фронт покажет «Course not found».

**Для MVP:** оставляем как есть, добавляем подтверждение `window.confirm` (уже есть на `UserCoursePage`) с явным предупреждением «Студенты, проходящие курс (N), потеряют прогресс». N — `course.stats.enrolledCount` — backend уже отдаёт его в `UserCourseDto.stats` для owner.

**Follow-up (вне scope):** soft delete — добавить `deletedAt: DateTime?`, фильтровать в read-эндпоинтах, отдельная ручка восстановления / 30-дневный grace period. Создаётся отдельной задачей, если жалобы повторятся. **В этом ADR не делаем.**

### 3.3 Страница «Мои курсы»

#### 3.3.1 Маршрут и точка входа

- **Route:** `/lessons/my` (новый, под `<ProtectedRoute>`). Семантически parallel-к `/lessons/my-active`: префикс `/lessons/my` уже занят под user-courses namespace, на верхнем уровне без `:slug` логично разместить «свои курсы».
- **Имя страницы / компонент:** `MyCoursesPage` (`apps/web/src/pages/MyCoursesPage.tsx`).
- **Точки входа:**
  1. Sub-link в `Sidebar` под пунктом «🎓 Lessons» (раскрывающийся список или вторая строка) — основная точка.
  2. CTA на `/lessons` рядом с `<CreateCourseCta />`: «My courses (N)» — линк на `/lessons/my`, виден залогиненному.
  3. Header профиля (avatar dropdown) — пункт «My courses». Расширение Sidebar-меню более ценно — оставим dropdown на follow-up.

> **Не выбираем:** `/my-courses` верхнего уровня. Все namespace'ы lessons-пространства уже под `/lessons/*` — выносить наверх ломает breadcrumbs и SEO без выгоды.

#### 3.3.2 Содержимое страницы

```
┌─ Breadcrumb: Lessons / My courses ──────────────┐
│                                                  │
│  My courses                          [+ Create]  │
│  Manage your custom courses.                     │
│                                                  │
│  [Filter ▾ All / Public / Private]  [Sort ▾]     │
│                                                  │
│  ┌─ Course 1 ─────────────────────────────────┐  │
│  │ ●Public  My opening repertoire             │  │
│  │ 12 lessons · 47 steps · updated 2d ago     │  │
│  │ Stats: 23 enrolled, 8 completed (35%)      │  │
│  │                                            │  │
│  │  [Open] [Edit] [Copy link] [⋮ More ▾]     │  │
│  └────────────────────────────────────────────┘  │
│  ┌─ Course 2 ─────────────────────────────────┐  │
│  │ ○Private  Endgames draft                   │  │
│  │ 3 lessons · 8 steps · updated 1w ago       │  │
│  │ ─                                          │  │
│  │  [Open] [Edit] [Copy link] [⋮ More ▾]     │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Empty state: «You don't have courses yet…»      │
└──────────────────────────────────────────────────┘
```

**Поля карточки:**

- Бейдж публикации: ● Public (зелёный) / ○ Private (серый).
- Title (link на `/lessons/my/:slug` — Open as reader).
- Meta: `lessonCount` lessons · сумма stepCount (доустают frontend через FE-пересчёт по уже загруженному списку — не ходим в backend) · `formatRelativeActivity(updatedAt)`.
- Stats (только для public, или всегда): `enrolledCount` enrolled, `completedCount` completed (`%`). Backend отдаёт всегда для owner.
- Описание (truncate 2 lines) — опционально.

**Действия per-item:**

| Действие | UI | Backend | Доступность |
|----------|----|---------|-------------|
| Open as reader | Кнопка `[Open]` | navigate `/lessons/my/:slug` | всегда |
| Edit | Кнопка `[Edit]` | navigate `/lessons/my/:slug/edit` | всегда |
| Copy link | Кнопка `[Copy link]` | `navigator.clipboard.writeText(${origin}/lessons/my/${slug})`, тост | всегда; для Private + tooltip «Only owners can open this link until you publish» |
| Make public / private | Пункт `[⋮ More ▾]` | `PATCH /lessons/user-courses/:id { isPublic: !cur }` | всегда |
| Delete | Пункт `[⋮ More ▾]` (red text) | `DELETE /lessons/user-courses/:id` + `confirm()` | всегда |

`[⋮ More ▾]` — overflow-меню. Содержит: «Make public/private», «Delete». Можно расширять follow-up'ами (Duplicate, Export PGN, Share to community feed) без редизайна основной строки.

**Фильтр и сортировка** (опционально, но дёшево):

- Filter: `All` / `Public` / `Private` — только клиентская фильтрация по `isPublic` уже загруженного списка.
- Sort: `Recently updated` (default, как у backend) / `Title A→Z` — клиентская сортировка.

Не делаем серверной пагинации в MVP — backend и так лимитирует `coursesPerUser` (см. `USER_COURSES_LIMITS`), типичный автор имеет <20 курсов, default `limit=50` достаточно. Если автор уперся в лимит — отдельный диалог в follow-up.

#### 3.3.3 «Скопировать ссылку» — детали

- **Формат ссылки:** `${window.location.origin}/lessons/my/${course.slug}` — единая для public и private.
- **Behavior:**
  - Public: ссылка открывается у любого, в т.ч. неавторизованного (роут `/lessons/my/:slug` — без `<ProtectedRoute>`).
  - Private: открывается только у владельца. У неавторизованного и у других залогиненных — 404 (UserCoursePage показывает `<NotFound>`).
- **UI-сигнал** на private: при клике «Copy link» в тосте дописать «Public this course to share with others» — не блокируем копирование, но предупреждаем. На public — обычный «Link copied».
- **Реализация:** `navigator.clipboard.writeText` + fallback `<input>` + `document.execCommand('copy')` для старых iOS Safari (паттерн уже есть в проекте, см. AnalysisPage share-button — переиспользовать утилиту, если есть; если нет — отдельный `useCopyToClipboard` hook).

#### 3.3.4 Mobile-адаптация

- **<560px:** карточка вертикальная, действия — `[Open]` + `[Edit]` основной парой, `[⋮ More ▾]` собирает Copy link / visibility / delete (на mobile экономим горизонталь).
- **560–960px:** все действия в строку, как на desktop.
- **Filter/Sort** — две `<select>` рядом, не tabs. Стандартный нативный picker.
- **Bottom-action area:** `+ Create` — full-width sticky кнопка внизу экрана на мобильном (паттерн как у CreateCourseCta).
- **Confirm на delete** — нативный `window.confirm` (как сейчас в `UserCoursePage`). В follow-up — заменить на нормальную dialog-modal с предупреждением о потере прогресса учеников.

### 3.4 Контракт API

**Изменений в API не требуется для MVP.** Существующих ручек хватает:

- `GET /lessons/user-courses?mine=1&limit=50&offset=0` — список + stats для owner.
- `PATCH /lessons/user-courses/:id { isPublic: boolean }` — toggle.
- `DELETE /lessons/user-courses/:id` — hard.
- `POST /lessons/user-courses { title }` — создать (через `<CreateCourseCta>` уже работает).

Однако **рекомендуем уточнить FE-обвязку**:

1. `userCoursesApi.list({scope:'own'})` сейчас не пробрасывает `limit/offset` — для лимита 50 это ОК, на момент MVP не нужно. В follow-up добавить параметры, если упрёмся.
2. Frontend пересчитывает суммарный `stepCount` по всем урокам курса локально — для этого нужно подгрузить уроки. **Альтернатива:** добавить в `UserCourseDto` денормализованное поле `stepCount: number` (как `lessonCount`). Это backend-изменение, **выносим в follow-up**, в MVP показываем только `lessonCount`.
3. Для рендера progress других учеников по public-курсу нам ничего нового не нужно — `stats` уже отдаётся.

### 3.5 Что не делаем (out of scope)

- Soft delete + восстановление.
- `unlisted`-видимость / share-token.
- Серверная фильтрация и сортировка.
- Bulk-actions (выделить несколько → удалить / опубликовать).
- Duplicate course / Export PGN / Import.
- SEO для public курсов на отдельной странице автора (это уже частично есть, см. `AuthorCoursesBlock`).

---

## 4. Декомпозиция на тикеты

Backend-изменений нет. Всё — frontend и UX.

### Tier 1 — MVP (закрывает жалобу)

| # | Назначение | Что | Зависимости |
|---|------------|-----|-------------|
| 1 | frontend | Создать страницу `MyCoursesPage` (`/lessons/my`) с защитой `<ProtectedRoute>`. Загрузка через `userCoursesApi.list({scope:'own'})`. Список карточек со всеми описанными выше полями. Empty state. Skeleton loader. | — |
| 2 | frontend | Реализовать действия per-item: Open, Edit, Copy link, Make public/private, Delete. Overflow-menu `⋮ More` для visibility/delete. Тост «Link copied». Re-fetch / оптимистичное обновление isPublic. | #1 |
| 3 | frontend | Добавить точку входа в Sidebar: sub-link «My courses» под `/lessons` (или сделать раскрывающуюся категорию). CTA-блок «My courses (N) →» на `/lessons` рядом с `<CreateCourseCta>`. | #1 |
| 4 | frontend | Mobile-адаптация (<560px): карточка вертикальная, `+ Create` sticky bottom, основные действия в строку + overflow. | #2 |
| 5 | layout | Стили под `MyCoursesPage`: бейдж public/private, карточка, overflow-menu. По образцу `MyActiveCoursesPage`. | #1 |
| 6 | frontend | i18n-ключи (`lessons.myCourses.*`) ru/en. | #1 |
| 7 | qa | E2E happy-path: создать курс → попасть в «My courses» → toggle public → copy link → delete. Mobile viewport. | #1–4 |

**Граф:** `#1 → #2,#3,#5,#6 → #4,#7`. Backend нечего делать в этом Tier'е.

### Tier 2 — улучшения (после MVP, при наличии запроса)

| # | Назначение | Что | Триггер |
|---|------------|-----|---------|
| 8 | backend | Добавить `stepCount: number` в `UserCourseDto` (денормализация в выборку list — `_count` нельзя на двух уровнях, делаем подзапрос или materialized count). | Если автор хочет сравнивать «глубину» курсов |
| 9 | frontend | Заменить `window.confirm` на dialog-modal с предупреждением «N учеников потеряют прогресс» при delete. | UX-полировка |
| 10 | frontend | Filter (All/Public/Private) + Sort (updated/title) — клиентская реализация. | Если у автора >10 курсов |
| 11 | backend + frontend | Soft delete: `deletedAt` в схему, exclude в read-эндпоинтах, кнопка «Restore» в отдельной вкладке «Архив». | Если будут жалобы на случайное удаление |
| 12 | backend + frontend | `unlisted`-режим: `visibility` enum + share-token, генерация ссылки с `?token=…`. | Если будут запросы «дать ссылку другу без публикации» |
| 13 | frontend | Duplicate course (создать копию с `(2)` в названии и теми же уроками) — backend-side endpoint `POST /:id/duplicate`. | Запросы на reuse контента |

### Acceptance ADR

- [x] Аудит API/UI зафиксирован (§2).
- [x] Спроектирована страница «Мои курсы» + действия + модель видимости + контракт API (§3).
- [x] Декомпозиция на backend/frontend (§4).
- [ ] Координатор согласует с пользователем и поставит задачи Tier 1.

---

## 5. Последствия

**Положительные:**

- Автор получает один экран для работы со своими курсами вместо «помни slug → открой URL».
- Видимость становится явно управляемой одним кликом из списка, без захода внутрь курса.
- Точка входа `/lessons/my` готова для дальнейших расширений (Drafts/Published-табы, Архив, Аналитика).

**Отрицательные / технический долг:**

- `UserCoursePage` будет дублировать owner-actions ещё какое-то время — можно зафиксировать follow-up «вынести actions только в `MyCoursesPage` и оставить на `UserCoursePage` минимум (Edit-кнопку для удобства)».
- Hard delete с потерей прогресса учеников остаётся. Если хоть один автор удалит публичный курс с десятками enrolled — это видимая дыра в UX. Митигируем понятным предупреждением.
- Без `stepCount` в DTO список карточек показывает только число уроков (не шагов) — можно временно потерпеть, в Tier 2 закроем.
