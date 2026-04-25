# ADR-030: Лобби «Мои курсы» — лента публичных курсов и авторы

**Дата:** 2026-04-25
**Статус:** Предложено
**Задача:** KS-1917
**Связанные:**
- [ADR-026 User courses](./026-user-courses.md) — §2.6 «Публичный каталог чужих курсов — НЕ в MVP» **обновляется этим ADR**
- KS-1840 — `MyCoursesBlock` на `/lessons`
- KS-1882 — бейдж «Курс пройден» на карточке курса
- KS-1890 — `EnrolledCoursesBlock` («Курсы, которые я прохожу»)
- KS-1914 — endpoint `GET /api/players/:username/courses`
- KS-1915 — `AuthorCoursesBlock` на профиле игрока

---

## 1. Контекст

### 1.1 Что есть сейчас

**Страница `/lessons`** содержит блоки в таком порядке (из
`apps/web/src/pages/LessonsPage.tsx`):

1. `ReviewsDueBlock` — SM-2 «к повторению сегодня».
2. `MistakesDiaryBlock` — топ-5 тем из дневника ошибок.
3. `LevelGateBanner` — индикатор перехода beginner→intermediate.
4. `MyCoursesBlock` — собственные пользовательские курсы (KS-1840).
5. `EnrolledCoursesBlock` — чужие публичные, в которых есть прогресс (KS-1890).
6. Системные курсы по уровням (Beginner / Intermediate / Advanced).

**Доступ к чужим курсам сейчас** возможен только тремя путями:
- Прямая ссылка от автора (`/lessons/my/<slug>`).
- Через профиль автора (`/player/<username>` → `AuthorCoursesBlock`,
  KS-1915), но нужно знать username автора.
- Через `EnrolledCoursesBlock`, но он показывает только курсы, в
  которых уже есть прогресс — это не способ обнаружения.

**Страница `/players`** (`apps/web/src/pages/PlayersPage.tsx`) имеет
три таба:
- **Top** — топ игроков по рейтингу (Bullet/Blitz/Rapid/Classical/Puzzle).
- **Online** — кто сейчас в сети.
- **Search** — поиск по username с пагинацией.

Все три таба ориентированы на **геймплей** — соперник для партии,
быстрая навигация в профиль, рейтинговый топ. С курсами не связаны.

**ADR-026 §2.6** явно отвергал «публичный каталог»:

> «В MVP публичные курсы доступны только по прямой ссылке. … Это
> защищает от необходимости вводить модерацию, репорты, фильтр по
> рейтингу автора. Отдельная задача: каталог `/lessons/community` с
> модерацией — после запуска MVP.»

### 1.2 Что просит пользователь

1. **Лента последних добавленных публичных курсов** — на главной
   `/lessons` показывать N недавних публичных курсов всех авторов
   (sort by `updatedAt DESC`). Студент видит «что нового» без
   необходимости знать конкретного автора.

2. **«Видны авторы курсов, а не просто все игроки»** — расплывчато.
   Координатор перечислил две интерпретации:
   - Заменить всех игроков на `/players` авторами курсов.
   - Добавить блок «Авторы» на `/lessons`.

### 1.3 Толкование «авторов курсов» — после изучения кода

Замена всех игроков авторами на `/players` **не подходит**. Аргументы:
- `/players` обслуживает **геймплей** (Top для соревнования, Online для
  поиска соперника, Search для перехода к профилю). Это не зона
  курсов.
- На сайте сейчас 100% игроков и 0–N авторов; замена сломает
  существующий UX (где найти Online-список соперников?).
- Игрок и автор — **разные роли одного и того же пользователя**, а не
  взаимоисключающие сущности. Один человек может быть и сильным
  игроком в топе, и автором курсов одновременно.

**Принимаемое толкование** — лобби раздела «Мои курсы» (= `/lessons`)
должно показывать авторов как первичный UX, а на `/players` авторы
доступны как **дополнительный таб**, не заменяющий существующие.

---

## 2. UX-расширения

### 2.1 Лента «Последние публичные курсы» на `/lessons`

**Где:** новый блок `LatestCoursesBlock` на `/lessons`, между
`EnrolledCoursesBlock` и системными уровневыми курсами. Логика порядка
блоков на странице:
1. Что мне нужно повторить (Reviews, Mistakes).
2. Что я делаю (LevelGate, MyCourses, EnrolledCourses).
3. **Что нового от других** (LatestCourses, CourseAuthors). ← новые блоки.
4. Системные уровневые курсы.

**Структура карточки** (переиспользует `.lessons-course-card` стили):
```
┌─ Latest course card ────────────────────────────┐
│ Title                              [✦ NEW]      │
│ Short description (truncate 100ch)              │
│                                                 │
│ by [@username]   ·   N lessons  ·   Updated 2d  │
└─────────────────────────────────────────────────┘
```

- **Title + description** — `UserCourseDto.title/description`,
  description обрезается до 100 символов с многоточием.
- **Бейдж «✦ NEW»** — если `updatedAt` за последние 7 дней.
- **`by [@username]`** — ссылка на `/player/<username>` (новая
  навигация для студента).
- **`N lessons`** — `lessonCount`, plural по en-локали.
- **`Updated 2d`** — relative time от `updatedAt`.

**Сколько:** **10 карточек**, без пагинации в MVP. Хватит для
ощущения «что-то новое появилось»; полноценный каталог с пагинацией —
отложенная задача (см. §6).

**Ordering:** `updatedAt DESC`. Аргументы:
- Включает и новые курсы (createdAt ≈ updatedAt сразу после создания),
  и значимые правки (автор дополнил курс — он снова в ленте).
- `createdAt DESC` отсёк бы автора, который улучшил старый курс —
  студент не увидит обновления.
- Sort by `lessonCount DESC` или `enrolledCount DESC` — это рекомендатор,
  а не лента; вне MVP.

**Edge case — собственные курсы:** если у пользователя есть свои
публичные курсы, они уже видны в `MyCoursesBlock` выше. Дублировать
не нужно. Реализуем фильтр на FE: при наличии `useAuth().user`
отфильтровать `course.ownerId !== currentUserId`. Альтернатива
(BE-флаг `?excludeOwn=1`) сложнее, выигрыш минимальный — клиентский
фильтр на 10 карточках незаметен.

**Empty state:** если на сайте 0 публичных курсов от других —
блок **скрыт целиком** (как `EnrolledCoursesBlock`). Не плодим UI без
смысла.

### 2.2 Блок «Авторы курсов» на `/lessons`

**Где:** новый блок `CourseAuthorsBlock`, **под** `LatestCoursesBlock`.
Логика: сначала показываем «что есть» (контент), потом «кто это
делает» (люди).

**Структура карточки автора:**
```
┌─ Author card ─────────┐
│  ⊙ avatar             │
│  @username            │
│  N courses            │
│  Last: <course title> │
└───────────────────────┘
```

- **Avatar** — `User.avatarUrl` (если есть, иначе генерим инициалами,
  как в существующих компонентах).
- **`@username`** — ссылка на `/player/<username>`.
- **`N courses`** — `publicCoursesCount`, plural.
- **`Last: <course title>`** — title последнего обновлённого курса
  автора, truncate 40ch, ссылка на `/lessons/my/<slug>`. Это
  «teaser» содержания.

**Сколько:** **топ-12 авторов** в MVP, горизонтальная сетка
(2 ряда × 6 на десктопе, 1 ряд × 4 + scroll на мобильном).

**Ordering:** `publicCoursesCount DESC`, при равенстве —
`lastCourseUpdatedAt DESC`. Это даёт «продуктивные авторы первыми, при
равной продуктивности — недавно активные».

**Edge case — свой собственный аккаунт:** если у меня есть публичные
курсы, я могу появиться в списке. Скрываем на FE по `user.id` —
собственная карточка автора в этом блоке избыточна (свои курсы
видны в `MyCoursesBlock`).

**Кнопка «Все авторы»:** в правом верхнем углу заголовка блока —
ссылка на `/players?tab=authors` (см. §2.3).

**Empty state:** скрываем целиком, как и ленту.

### 2.3 Tab «Authors» на `/players`

**Что:** четвёртый таб в существующей панели `[Top] [Online] [Search]
[Authors]`. Не заменяет ничего.

**Содержание таба:** список авторов с пагинацией (как Top/Online,
infinite scroll через IntersectionObserver):

```
┌─ /players?tab=authors ──────────────────────────────────────┐
│ [Top] [Online] [Search] [Authors]   ← active                │
│                                                              │
│ Showing 24 of 47 authors                                    │
│                                                              │
│ ┌────────────────────┬──────────┬───────────────────┐       │
│ │ Author             │ Courses  │ Last updated       │       │
│ ├────────────────────┼──────────┼───────────────────┤       │
│ │ ⊙ @alice           │   12     │ 2d ago            │       │
│ │ ⊙ @bob             │    7     │ 5d ago            │       │
│ │ ⊙ @claire          │    3     │ 3w ago            │       │
│ │ …                  │  …       │ …                 │       │
│ └────────────────────┴──────────┴───────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

- Стиль таблицы — те же `.players-table` классы, что и Top/Online.
- Пагинация — infinite scroll, page size 50 (как Top/Online).
- Sort такой же, как в блоке на `/lessons`: `publicCoursesCount DESC,
  lastCourseUpdatedAt DESC`.
- Клик по `@username` → `/player/<username>` (стандартная навигация).

---

## 3. API-контракты

### 3.1 Лента публичных курсов — расширение существующего endpoint

**Существующий:** `GET /api/lessons/user-courses?mine=0` уже отдаёт все
публичные курсы с sort by `updatedAt DESC` (см.
`apps/api/src/lessons/user-courses/user-courses.service.ts:53-61`).

**Что нужно добавить:**
- Query-параметр `?limit=N` (1..50, default 50). На уровне сервиса —
  передать в `prisma.userCourse.findMany({ take: limit })`.
- Query-параметр `?offset=M` (0..1000) — для будущего «Все курсы» на
  `/lessons/community` (вне MVP, но лучше заложить контракт сейчас).
- Опционально `?excludeOwn=1` — фильтрует `ownerId !== req.user.id` на
  стороне сервера. Опционально, потому что клиентский фильтр на
  10 карточках достаточен; добавить, только если понадобится для
  пагинации (чтобы page size был стабильным).

**Решение:** добавить `?limit` и `?offset` сейчас. `?excludeOwn` — НЕ
добавлять, фильтруем на FE.

### 3.2 Список авторов — новый endpoint

**Endpoint:** `GET /api/lessons/user-courses/authors`

**Query:**
- `limit` (1..100, default 12) — для `CourseAuthorsBlock` на
  `/lessons` достаточно 12, для таба `/players` — 50 на страницу.
- `offset` (0..10000, default 0) — для пагинации таба.
- `sort` (`courses` | `recent`, default `courses`) — `courses` =
  `publicCoursesCount DESC, lastCourseUpdatedAt DESC`; `recent` =
  `lastCourseUpdatedAt DESC`. Минимально полезные сортировки;
  расширим если потребуется.

**Auth:** **без JWT** (публичная витрина, как и сами публичные курсы).

**SQL-логика** (в `UserCoursesService.listAuthors`):

```sql
SELECT
  u.id, u.username, u.avatar_url, u.country,
  COUNT(uc.id) AS public_courses_count,
  MAX(uc.updated_at) AS last_course_updated_at,
  -- последний обновлённый курс — для teaser'а
  (SELECT slug FROM user_courses
    WHERE owner_id = u.id AND is_public = true
    ORDER BY updated_at DESC LIMIT 1) AS latest_course_slug,
  (SELECT title FROM user_courses
    WHERE owner_id = u.id AND is_public = true
    ORDER BY updated_at DESC LIMIT 1) AS latest_course_title
FROM users u
JOIN user_courses uc ON uc.owner_id = u.id AND uc.is_public = true
GROUP BY u.id
ORDER BY public_courses_count DESC, last_course_updated_at DESC
LIMIT $1 OFFSET $2;
```

В Prisma — через `groupBy({by: ['ownerId'], _count: {id: true},
_max: {updatedAt: true}})` + второй запрос на user-метаданные. Точная
форма — на исполнителе.

**Индексы:** существующий `@@index([isPublic, updatedAt])` в `UserCourse`
(ADR-026 §2.1) покрывает фильтр `is_public=true` + сортировку.
Дополнительных индексов не нужно.

**Кеширование:** Redis на 5 минут (ключ `lessons:authors:<sort>:<limit>:<offset>`).
Лента обновляется не при каждом просмотре страницы. Инвалидация — при
publish/unpublish курса (publish toggle в `UserCoursesService.update`).

**Shared-типы** (`packages/shared/src/types/user-courses.ts`):

```ts
export interface CourseAuthorDto {
  user: {
    id: string;
    username: string;
    avatarUrl: string | null;
    country: string | null;
  };
  publicCoursesCount: number;
  /** ISO-8601 от updatedAt последнего публичного курса автора. */
  lastCourseUpdatedAt: string;
  /** Slug последнего обновлённого публичного курса — для прямого link. */
  latestCourseSlug: string;
  /** Title последнего обновлённого публичного курса. */
  latestCourseTitle: string;
}

export interface CourseAuthorsListResponse {
  data: CourseAuthorDto[];
  total: number;
}
```

**Total** — общее число авторов с публичными курсами (для UI «Showing
24 of 47»). Считается отдельным `count(distinct ownerId)` запросом.

### 3.3 Что НЕ делаем

- **Не добавляем поиск** в `/api/lessons/user-courses` (поиск по
  title/description). Поиск по курсам — отдельный feature (когда
  объём будет того стоить).
- **Не делаем рекомендатор** (popular/trending). Sort `updatedAt DESC`
  и `publicCoursesCount DESC` — детерминированные, без сигналов о
  качестве; рекомендации требуют отдельного дизайна.
- **Не открываем профиль автора без публичных курсов.** Если автор
  снял все курсы с публикации — он исчезает из листинга. Карточка
  «Курсы автора» на его профиле в этом случае пустая (поведение
  KS-1915).

---

## 4. Wireframe главной `/lessons` (после изменений)

```
┌─ /lessons ───────────────────────────────────────────────────┐
│ Header: Lessons title + subtitle                             │
├──────────────────────────────────────────────────────────────┤
│ Reviews due (SM-2)                                           │ ← существует
├──────────────────────────────────────────────────────────────┤
│ Mistakes diary (top 5 themes)                                │ ← существует
├──────────────────────────────────────────────────────────────┤
│ Level gate banner                                            │ ← существует
├──────────────────────────────────────────────────────────────┤
│ My courses              [+ Create my course]                 │ ← существует
│  [my-card 1] [my-card 2] [my-card 3] …                       │
├──────────────────────────────────────────────────────────────┤
│ Courses I'm taking                                           │ ← существует
│  [enrolled-card 1] [enrolled-card 2] …                       │
├══════════════════════════════════════════════════════════════┤
│ ✦ Latest courses (NEW)                  Updated <date>       │ ← НОВОЕ §2.1
│  [public-card 1] [public-card 2] …  (10 cards, 2 rows × 5)   │
├══════════════════════════════════════════════════════════════┤
│ ✦ Course authors (NEW)                  [All authors →]      │ ← НОВОЕ §2.2
│  [author 1] [author 2] [author 3] …  (12 cards, 2 rows × 6)  │
├══════════════════════════════════════════════════════════════┤
│ Beginner   ▸ system course cards                             │ ← существует
│ Intermediate ▸ …                                             │
│ Advanced ▸ …                                                 │
└──────────────────────────────────────────────────────────────┘
```

**Mobile (≤ 640px):** все блоки стекаются в одну колонку. Карточки
курсов и авторов — горизонтальный scroll внутри блока (`overflow-x:
auto`), как в `EnrolledCoursesBlock` mobile-варианте (KS-1890).

---

## 5. План реализации

Без оценок сроков — это зона координатора.

### Backend

| Код | Описание | Зависит от |
|---|---|---|
| BE-1 | Расширить `GET /api/lessons/user-courses` query: `?limit=N (1..50, default 50)`, `?offset=M (0..1000, default 0)`. Передать в `findMany({take, skip})`. Обновить `user-courses.controller.ts` + `user-courses.service.ts`. | — |
| BE-2 | Shared-тип `CourseAuthorDto` + `CourseAuthorsListResponse` в `packages/shared/src/types/user-courses.ts`. | — |
| BE-3 | Новый endpoint `GET /api/lessons/user-courses/authors` (без JWT) с query `limit/offset/sort`. Метод `UserCoursesService.listAuthors`. SQL: groupBy ownerId с агрегатами `_count.id` и `_max.updatedAt`, второй запрос на user-метаданные, latest course через коррелированный subquery (или отдельный батч-запрос). | BE-2 |
| BE-4 | Redis-кеш для `listAuthors`: ключ по `(sort, limit, offset)`, TTL 5 мин. Инвалидация при `update` курса с изменением `isPublic` или `updatedAt`. | BE-3 |
| BE-5 | Unit-тесты `UserCoursesService.list` (новые limit/offset параметры) и `listAuthors` (sort, лимиты, deduplication, пустой результат). | BE-1, BE-3 |
| BE-6 | E2E: `GET /api/lessons/user-courses?mine=0&limit=10` (10 публичных, sort updatedAt DESC), `GET /api/lessons/user-courses/authors?limit=12` (топ авторов с агрегатом). | BE-3..5 |

### Frontend

| Код | Описание | Зависит от |
|---|---|---|
| FE-1 | API-клиент: расширить `userCoursesApi.list({limit, offset})`, добавить `userCoursesApi.listAuthors({limit, offset, sort})`. | BE-1, BE-2 |
| FE-2 | `LatestCoursesBlock` (`apps/web/src/components/lessons/`). Использует `userCoursesApi.list({mine: false, limit: 10})`, фильтрация своих по `useAuth().user.id`. Карточка с author link, бейджем NEW (`updatedAt < 7 дней`), relative time. | FE-1 |
| FE-3 | `CourseAuthorsBlock` (`apps/web/src/components/lessons/`). Использует `userCoursesApi.listAuthors({limit: 12, sort: 'courses'})`. Карточка с avatar, username link, courses count, latest course link. Кнопка «Все авторы» → `/players?tab=authors`. | FE-1 |
| FE-4 | Интеграция в `LessonsPage.tsx`: монтаж `LatestCoursesBlock` и `CourseAuthorsBlock` между `EnrolledCoursesBlock` и системными курсами. | FE-2, FE-3 |
| FE-5 | `/players` четвёртый таб «Authors». Расширение `PlayersPage.tsx`: добавить tab key `'authors'`, infinite scroll, page size 50. Та же таблица-стилистика. | FE-1 |
| FE-6 | i18n-ключи в en/ru: `lessons.latestCourses.title/empty/badgeNew`, `lessons.courseAuthors.title/coursesCount/lastCourse/allAuthors`, `players.tabAuthors`, `players.authors.coursesHeader/lastUpdatedHeader`. | FE-2, FE-3, FE-5 |
| FE-7 | Тесты vitest: `LatestCoursesBlock`, `CourseAuthorsBlock`, `/players?tab=authors`. | FE-2, FE-3, FE-5 |

### Layout

| Код | Описание | Зависит от |
|---|---|---|
| L-1 | CSS `.lessons-latest-courses-block`, `.lessons-course-authors-block` — переиспользует существующие `.my-courses-block` стили, плюс мобильный horizontal-scroll. | FE-2, FE-3 |
| L-2 | Стили карточки автора `.author-card` (avatar + 3 строки текста). | FE-3 |

### Документация

| Код | Описание | Зависит от |
|---|---|---|
| D-1 | Обновить `docs/features/user-courses.md` (RU + EN) §2 «Главная страница „Уроки"» — добавить описание блоков `LatestCoursesBlock` и `CourseAuthorsBlock`, обновить раздел 7.1 «Каталога публичных курсов нет» — теперь частично есть лента. | После релиза FE-7 |

---

## 6. Что остаётся вне скоупа

Исходное ADR-026 §2.6 утверждало, что каталога нет. Этим ADR мы делаем
**частичный шаг к каталогу**, но НЕ полный:

- **Полнотекстовый поиск по курсам** (по title/description) — нет.
  Появится отдельной задачей, если объём публичных курсов сделает это
  необходимым.
- **Фильтры** (по уровню, темам, длине) — нет. То же.
- **Страница `/lessons/community`** с пагинацией всех публичных курсов —
  нет. Запас на будущее: API уже поддержит `offset`, добавить страницу
  тривиально.
- **Модерация** (репорты, бан курсов, ограничения по рейтингу автора) —
  нет. Включаем при появлении абуза или когда объём публичных курсов
  потребует.
- **Recommendations / trending** — нет. Sort'ы детерминированные.

---

## 7. Влияние на существующие документы

### 7.1 ADR-026 §2.6

Старая формулировка:
> «В MVP публичные курсы доступны только по прямой ссылке. В `/lessons`
> блок „Мои курсы" показывает только свои.»

**Обновление (фиксируется этим ADR):**
> «В MVP публичные курсы доступны через: прямую ссылку, профиль автора
> (`AuthorCoursesBlock`, KS-1915), ленту последних публичных курсов
> на `/lessons` (`LatestCoursesBlock`, KS-1917), блок авторов на
> `/lessons` (`CourseAuthorsBlock`, KS-1917) и таб „Authors" на
> `/players` (KS-1917). Полноценный каталог с поиском, фильтрами и
> модерацией — вне MVP, см. §6 ADR-030.»

### 7.2 `docs/features/user-courses.md` (пользовательская документация)

Раздел 2 «Главная страница „Уроки"» дополняется блоками
`LatestCoursesBlock` и `CourseAuthorsBlock`. Раздел 7.1 «Каталог
публичных курсов нет» переформулируется на «полноценного каталога с
поиском нет, но есть лента и список авторов».

Обновление документации — отдельная задача (D-1) после релиза.

---

## 8. Что точно НЕ меняется

- **API контракт `GET /api/players/:username/courses` (KS-1914)** —
  без изменений.
- **`AuthorCoursesBlock` на профиле игрока (KS-1915)** — без
  изменений.
- **`MyCoursesBlock`, `EnrolledCoursesBlock`** — без изменений
  (возможные правки порядка рендера в `LessonsPage` — не считаются
  изменением блоков).
- **Существующие табы `/players`** (Top/Online/Search) — без
  изменений, добавляется четвёртый.
- **Схема БД** — без изменений (используется существующий индекс
  `(isPublic, updatedAt)`).
