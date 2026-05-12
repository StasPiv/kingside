# ADR-059 — Studies module: самостоятельная сущность для пользовательских учебных студий

- Статус: Accepted
- Дата: 2026-05-12
- Связанные задачи: KS-2815 (исследование и план MVP), KS-2816 (этот ADR),
  KS-2817 (миграция), KS-2818 (модуль/сервисы/guards), KS-2819 (REST CRUD),
  KS-2820 (импорт/экспорт), KS-2821 (public controller), KS-2822 (тесты),
  KS-2823 (feature-flag), KS-2824–KS-2835 (frontend и layout).
- Связанные ADR: ADR-026 (User Courses — паттерн пользовательского контента),
  ADR-051 (Chess content delivery — паттерн public access), ADR-052 (admin
  API для авторских курсов), ADR-054 (унификация system + user content в
  общих таблицах), ADR-037 (Move annotations — макросы `[%csl][%cal][%cvc]`),
  ADR-008 (Game analysis persistence).
- Авторы: architect

---

## 1. Контекст

### 1.1 Зачем Studies

Запрос пользователя: воспроизвести в Kingside функционал Lichess Studies
— контейнеры учебных глав с деревом вариантов, NAG-аннотациями,
комментариями, стрелками, импортом/экспортом PGN, публичными ссылками.

Полное исследование функционала Lichess Studies, инвентаризация
переиспользуемого кода в Kingside, и пересмотренный план MVP —
`docs/architecture/KS-2815-studies-standalone.md`. Этот ADR — финальная
точка решений; в нём фиксируются только конкретные обязательства, без
обзорной части.

### 1.2 Ограничения, наложенные пользователем (KS-2815)

- Studies — **самостоятельная фича**, без интеграции с `/lessons`,
  AnalysisPage или broadcast-service в MVP.
- Хранение дерева — переиспользуем PGN-движок (`apps/web/src/review`)
  и формат blob'а; нормализованную таблицу узлов не вводим.
- Broadcast-зеркало не делаем.
- «Save to study» из AnalysisPage не делаем в MVP.
- `practice`/`conceal`/`gamebook` — отложены до фазы 2.
- Realtime-коллаборация — отложена до фазы 2.

Решения по мелочам (лимиты, default-режим, без contributors) — принял
архитектор без вопросов пользователю, см. §3 ниже.

---

## 2. Решение (коротко)

1. Новый модуль `apps/api/src/study` с двумя сущностями: `Study`
   (контейнер) и `StudyChapter` (глава = PGN-блоб).
2. Новые таблицы `studies` и `study_chapters` в основной БД (`packages/
   db/prisma/schema.prisma`). Никакие существующие таблицы не правятся.
3. REST-префикс `/api/studies/*`; публичное чтение через отдельный
   `StudyPublicController` без `JwtAuthGuard` (паттерн
   `AnalysisPublicController`, ADR-051 §3 share-2).
4. Frontend: новые страницы `/studies`, `/studies/:slug`,
   `/studies/:slug/:chapterId`, `/studies/c/:chapterId`. Редактор
   главы — тонкая обёртка над `useReviewState` + `ReviewMoveList`
   (~100% reuse из `apps/web/src/review`).
5. Runtime feature-flag `studiesEnabled` (default `false`).
6. Доступ из навигации в MVP — пункт sidebar «🧪 Студии» под
   `studiesEnabled`. Финальный плейсмент пункта (отдельный? внутри
   `/lessons`? иначе?) — решим после MVP в отдельной задаче.

---

## 3. Решения архитектора (без вопросов пользователю)

Все взяты из §B.2 KS-2815, повторно зафиксированы здесь как обязательные.

| Решение | Значение | Обоснование |
|---------|----------|-------------|
| Лимит глав на студию | **64** | Совпадает с Lichess; защита от абьюза; легко поднять позже |
| Лимит студий на пользователя | **20** | Скопировано с `USER_COURSES_LIMITS.coursesPerUser` |
| Лимит PGN-блоба на главу | **256 КБ** | Защита от тяжёлых PATCH; для сравнения — 500 ходов с аннотациями ≈ 30–60 КБ |
| Default-режим главы | **`analysis`** | Единственный режим в MVP; остальные отложены до фазы 2 |
| Practice в MVP | **НЕТ** | UX требует отдельной проработки |
| Membership | **только owner** | Без contributor/viewer; гранулярность private/public — единственная |
| Slug-генератор | **переиспользуем `SlugService`** из `apps/api/src/lessons/user-courses/slug.service.ts` | Формат `<shortId>-<title>` уже отлажен; URL'ы стабильные |
| Хранение дерева | **PGN-блоб в `study_chapters.pgn`** | По решению пользователя; формат идентичен `Analysis.pgn` (с макросами `[%csl][%cal][%cvc]`) |
| `visibility` | **bool `isPublic`** (без `unlisted` в MVP) | Минимум гранулярности; добавить unlisted позже без миграции |
| Order для drag-n-drop | **`orderIdx` шагом 1000** | Drag-n-drop без переписи всех строк при вставке |
| API-префикс | `/api/studies/*` | Не подмешиваем в `/api/lessons/*` |
| URL-маршруты | `/studies`, `/studies/:slug`, `/studies/:slug/:chapterId`, `/studies/c/:chapterId` | Отдельное namespace |
| Feature-flag | `studiesEnabled` (whitelist) | Стандартный паттерн KS-2105 |
| i18n | новый namespace `studies` (ru + en) | По образцу `lessons` namespace'а |
| Sidebar | временный пункт «🧪 Студии» под флагом | Релизим инкрементально, финальный плейсмент позже |

---

## 4. Модель данных

### 4.1 Prisma-схема (новые модели в `packages/db/prisma/schema.prisma`)

```prisma
/// KS-2815 / ADR-059. Учебная студия — контейнер глав. Самостоятельная
/// сущность, не связана с Course/Lesson (см. ADR-026/ADR-054 для
/// курсов). Может быть приватной (только owner) или public (всем по
/// прямой ссылке).
model Study {
  id          String   @id @default(uuid()) @db.Uuid
  ownerId     String   @map("owner_id") @db.Uuid
  /// `<shortId>-<title>` через SlugService (см. apps/api/src/lessons/
  /// user-courses/slug.service.ts). Уникален per-owner.
  slug        String
  name        String
  description String?  @db.Text
  /// false = приватная (только owner); true = публичная по прямой
  /// ссылке. Без `unlisted` в MVP — добавим в фазе 2 без миграции,
  /// добавив третье значение через String-enum.
  isPublic    Boolean  @default(false) @map("is_public")
  /// Денормализованный счётчик глав (для каталога без JOIN).
  chaptersCount Int    @default(0) @map("chapters_count")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  owner    User           @relation("OwnedStudies", fields: [ownerId], references: [id], onDelete: Cascade)
  chapters StudyChapter[]

  @@unique([ownerId, slug])
  @@index([ownerId, updatedAt])
  @@index([isPublic, updatedAt])
  @@map("studies")
}

/// Глава студии: PGN-блоб + базовые поля (имя, порядок, ориентация,
/// стартовая FEN, режим). Формат `pgn` совпадает с `Analysis.pgn`
/// (макросы [%csl/%cal/%cvc] для аннотаций/стрелок/цветов — ADR-037).
model StudyChapter {
  id          String   @id @default(uuid()) @db.Uuid
  studyId     String   @map("study_id") @db.Uuid
  name        String
  /// Шаг 1000 — для drag-n-drop без переписи всех. При исчерпании gap'а
  /// фоновый ребаланс (явный admin-action в фазе 2; в MVP — N/A,
  /// 64 главы * 1000 = ~64000, потолок Postgres INTEGER не доходит).
  orderIdx    Int      @map("order_idx")
  /// PGN-блоб дерева главы. Лимит 256 КБ на уровне API (validation в
  /// DTO). Формат — стандартный PGN с расширениями ADR-037.
  pgn         String   @db.Text
  /// Стартовая позиция FEN. NULL = стандартная начальная (`rnbqkbnr/
  /// pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1`).
  startFen    String?  @map("start_fen")
  /// "white" | "black" — ориентация доски снизу.
  orientation String   @default("white")
  /// "analysis" в MVP. Поле зарезервировано под "practice"/"conceal"/
  /// "gamebook" в фазе 2 без миграции (см. §3).
  mode        String   @default("analysis")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  study Study @relation(fields: [studyId], references: [id], onDelete: Cascade)

  @@unique([studyId, orderIdx])
  @@index([studyId])
  @@map("study_chapters")
}
```

### 4.2 Relation в `User`

```prisma
model User {
  // ... existing fields ...
  ownedStudies Study[] @relation("OwnedStudies")
}
```

### 4.3 Миграция

Чистый `CREATE TABLE`. Без `ALTER` существующих таблиц. Деплой без
даунтайма. Имя миграции: `studies_init`.

---

## 5. REST API

Префикс `/api/studies/*`. Все мутации — JWT. Чтение публичной студии
без auth — через отдельный controller (см. §5.3).

### 5.1 Studies CRUD

| Метод | Путь | Описание | Auth |
|-------|------|----------|------|
| `GET` | `/api/studies` | Listing: `?mine=1` мои; `?mine=0` публичные; без — мои | JWT |
| `POST` | `/api/studies` | Создать пустую студию `{name, description?, isPublic?}` | JWT |
| `GET` | `/api/studies/:slug` | Студия + список глав (без `pgn`) | JWT optional; private — только owner; public — anonymous через §5.3 |
| `PATCH` | `/api/studies/:slug` | Изменить `name`/`description`/`isPublic` | JWT, owner |
| `DELETE` | `/api/studies/:slug` | Удалить (каскад глав) | JWT, owner |

### 5.2 Chapters CRUD

| Метод | Путь | Описание | Auth |
|-------|------|----------|------|
| `POST` | `/api/studies/:slug/chapters` | Создать главу `{name, pgn?, startFen?, orientation?, mode?}` | JWT, owner |
| `GET` | `/api/studies/:slug/chapters/:chapterId` | Глава: pgn + meta | JWT optional |
| `PATCH` | `/api/studies/:slug/chapters/:chapterId` | Обновить `name`/`pgn`/`startFen`/`orientation`/`mode` | JWT, owner |
| `PATCH` | `/api/studies/:slug/chapters/:chapterId/order` | Reorder `{after: chapterId\|null}` | JWT, owner |
| `DELETE` | `/api/studies/:slug/chapters/:chapterId` | Удалить главу | JWT, owner |
| `POST` | `/api/studies/:slug/import-pgn` | Импорт multi-PGN → N новых глав | JWT, owner |
| `GET` | `/api/studies/:slug/export.pgn` | Экспорт всей студии (text/x-chess-pgn) | optional |
| `GET` | `/api/studies/:slug/chapters/:chapterId/export.pgn` | Экспорт одной главы | optional |

### 5.3 Public controller

`apps/api/src/study/study-public.controller.ts` (`@Controller('studies/
public')`) — **без** `JwtAuthGuard`, паттерн ADR-051 §3 share-2.

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/api/studies/public` | Каталог публичных студий (для anonymous) |
| `GET` | `/api/studies/public/c/:chapterId` | Глава по UUID, если `study.isPublic = true`; иначе **404** (не 403 — не раскрываем существование) |

### 5.4 Лимиты и валидация (DTO)

- `Study.name`: 1..120 символов, не пустая после trim.
- `Study.description`: 0..2000 символов.
- `StudyChapter.name`: 1..120 символов.
- `StudyChapter.pgn`: 0..262144 байт (256 КБ).
- `mode`: enum `'analysis' | 'practice' | 'conceal' | 'gamebook'` (в
  MVP whitelist кода — только `'analysis'`; остальные отклоняются).
- `orientation`: `'white' | 'black'`.
- `startFen`: правильная FEN-строка (regex + опционально `chess.js`
  парсинг для отбраковки).
- Per-user лимит: `count(studies WHERE ownerId = userId) < 20` —
  проверка в `StudyService.create`; иначе **400 Too many studies**.
- Per-study лимит: `chaptersCount < 64` — проверка в
  `StudyChaptersService.create` и `importPgn`; иначе **400 Too many
  chapters**.

### 5.5 Guards

- `StudyAccessGuard` (`apps/api/src/study/study-access.guard.ts`) —
  чтение: разрешает если `study.ownerId === userId` ИЛИ
  `study.isPublic === true`. Иначе **404** (а не 403, чтобы не
  раскрывать существование private-студии). Образец —
  `apps/api/src/lessons/lessons-access.guard.ts`.
- `StudyOwnerGuard` — мутации: разрешает только если `study.ownerId
  === userId`. Образец — `apps/api/src/lessons/user-courses/
  user-course-owner.guard.ts`.
- `JwtAuthGuard` — на уровне `StudyController` / `StudyChaptersController`.
- На `StudyPublicController` guard'ов нет.

---

## 6. Frontend

### 6.1 Маршруты и компоненты

| Маршрут | Компонент | Назначение |
|---------|-----------|-----------|
| `/studies` | `StudiesPage` | Каталог: табы «Мои» / «Публичные», карточки `StudyCard` |
| `/studies/:slug` | `StudyPage` | Детали студии: header, список глав (`ChapterList`), actions (share/delete/import-pgn/create-chapter) |
| `/studies/:slug/:chapterId` | `StudyChapterEditorPage` | Редактор главы: доска + дерево + NAG + стрелки. Тонкая обёртка над `useReviewState` + `ReviewMoveList` |
| `/studies/c/:chapterId` | `StudyChapterPublicPage` | Read-only публичная ссылка |

Все маршруты регистрируются в `App.tsx` с lazy-импортом.

### 6.2 Переиспользование из `apps/web/src/review`

Используется как есть (без extract в shared):

- `useReviewState` — reducer дерева ходов.
- `ReviewMoveList` — рендер вариантов.
- `parseAnnotatedPgn` / `serializeToAnnotatedPgn` — PGN ⇄ дерево.
- `NagPalette` / `NagPaletteSheet` — палитра NAG-аннотаций.
- `commentMacros` — макросы стрелок/кружков `[%cal][%csl]`.

Доска и хуки: `MemoChessboard`, `useFastDrag`, `useBoardHighlights`,
`useBoardTheme`, `useBoardSettings`, `useSounds`, `useStablePosition`.

UI-вспомогалки: `PgnHeadersModal`, `SetPositionModal`,
`VariationChooser`, `InlinePgnViewer` (последний — для public read-only
страницы).

### 6.3 Новый хук `useStudyChapterPersistence`

Auto-save главы. Копия `useAnalysisPersistence` (`apps/web/src/review/
useAnalysisPersistence.ts`), переключённая на endpoint
`PATCH /api/studies/:slug/chapters/:chapterId`. Debounce 1000 ms.

### 6.4 Shared-типы

Новый файл `packages/shared/src/types/studies.ts` — DTO для
`StudyDto`, `StudyChapterDto`, всех request/response типов из §5.
Export из `packages/shared/src/index.ts`.

### 6.5 Sidebar

Добавить временный пункт «🧪 Студии» (`/studies`) в `NAV_ITEMS`
(`apps/web/src/components/Sidebar.tsx`), скрытый по `studiesEnabled`
(default `false`). Финальный плейсмент пункта (отдельным? встроить в
группу «Анализ» с подменю по ADR-058 §11? в другом месте?) — решается
после MVP в отдельной задаче, не блокирует релиз функционала.

### 6.6 i18n

Новый namespace `studies` — `apps/web/src/i18n/locales/{ru,en}/
studies.json`. Ключи: `studies.title`, `studies.tabs.mine`,
`studies.tabs.public`, `studies.create`, `studies.delete`,
`studies.share.public`, `studies.share.private`, `studies.chapter.*`,
`studies.import.*`, `studies.empty.*`, `nav.studies`,
`studies.access.privateGuest`. Полный список — KS-2833.

---

## 7. Feature-flag и катаут

`studiesEnabled` (default `false`) — runtime-флаг по KS-2105.

- `KNOWN_FEATURE_FLAGS` в api расширяется.
- Тип `FeatureFlags` в `@kingside/shared` — расширяется.
- На фронте — gate'ит пункт sidebar и страницы (или редирект на
  `/lobby` при выключенном флаге).

Включение в продакшен — `PATCH /admin/feature-flags/studiesEnabled
{value: true}` без redeploy.

---

## 8. Что НЕ делаем (фаза 2 или позже)

- Режимы `practice` / `conceal` / `gamebook` (поле `mode` зарезервировано).
- Embed iframe (`/studies/embed/...`).
- Каталог-социалка: лайки, тренды, поиск, теги.
- Contributors / membership / роли viewer.
- Realtime-коллаборация по WS.
- Интеграция с `/lessons` (таб «Студии», кнопки переходов).
- Интеграция с AnalysisPage (`Save to study`).
- Broadcast-зеркало.
- Финальный плейсмент пункта sidebar (после KS-2839 desktop-submenu
  пакета вероятен подпункт внутри `Анализ` или отдельная группа).

Каждая из этих фич — отдельная задача, не блокирует MVP.

---

## 9. Acceptance MVP

Считаем MVP завершённым, когда:

1. Миграция `studies_init` применена; таблицы и индексы созданы.
2. Все endpoints из §5 реализованы и покрыты юнит-тестами + permission
   matrix (anonymous × owner × другой user × admin).
3. Лимиты §5.4 enforced.
4. Frontend-страницы из §6.1 рендерят и интерактивно работают.
5. Multi-PGN импорт создаёт N глав; экспорт `.pgn` отдаёт корректный
   PGN, читаемый chess.com / Lichess / chess.js.
6. Public-ссылка `/studies/c/:chapterId` работает без auth (если
   `isPublic=true`); 404 для private.
7. Feature-flag `studiesEnabled` контролирует видимость sidebar пункта
   и доступа к страницам.
8. i18n (ru + en) покрывает все строки UI.

---

## 10. Риски

| Риск | Митигация |
|------|-----------|
| **PGN-блоб ≫50 КБ → медленный PATCH** | Лимит 256 КБ; auto-save с debounce 1000 ms; на пиковой нагрузке — gzip на nginx |
| **Дублирование UI-кода с Lessons editor** | В MVP не выносим в shared; решаем после релиза, если действительно потребуется второй consumer |
| **Slug-коллизии** | `SlugService` уже обрабатывает через retry (max 5) — без новой логики |
| **Импорт многоглавного PGN превышает лимит 64** | API возвращает 400 c понятной ошибкой; partial-import не применяем (всё или ничего, в одной транзакции) |
| **Конкурентный PATCH главы (два таба у owner'а)** | Last-write-wins на стороне БД (поле `updatedAt`); UI показывает `updatedAt` после сохранения, явных версионных конфликтов не решаем в MVP |
| **Регрессия в `useReviewState` при добавлении нового consumer'а** | Хук уже стабильный (KS-2040, AnalysisPage в проде); тесты `useReviewState.spec.ts` сохраняют покрытие |
| **Финальный плейсмент в навигации не согласован** | MVP открывается под feature-flag (default off) → решение по UI-месту принимается уже на работающей фиче |

---

## 11. Ссылки

- `docs/architecture/KS-2792-studies-research.md` — исходное исследование
  Lichess Studies (§§1–§2 актуальны; §§3–§7 superseded задачей KS-2815).
- `docs/architecture/KS-2815-studies-standalone.md` — пересмотренный
  план MVP, карта переиспользуемого кода Lessons / Analysis / Workshop.
- ADR-026 — User Courses (паттерн пользовательского контента: `ownerId`,
  `isPublic`, лимиты, slug, owner-guard).
- ADR-051 §3 share-1/share-2/share-3 — паттерн public-share для
  `Analysis` (использован образцом для `StudyPublicController`).
- ADR-037 — Move annotations and variant styling: макросы `[%csl][%cal]
  [%cvc]` в PGN-комментариях, наследуются для глав.
- ADR-054 — слияние system + user content в общих таблицах (не
  применяется к Studies в MVP — Studies в отдельной таблице).
- KS-2815 / KS-2816..KS-2835 — задачи реализации MVP (см. §D.6
  документа KS-2815 для маппинга T-номеров → реальных KS).

---

## Изменения после Accept

ADR может уточняться **только** в части §3 (решения архитектора) при
смене контекста; модель данных §4 и API §5 — заморожены до фазы 2.
Любое расширение модели (новый режим, contributors, realtime) — через
новый ADR со ссылкой на этот.
