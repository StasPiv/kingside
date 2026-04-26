## KS-1962 — Admin API для system courses (без seed-фикстур)

**Дата:** 2026-04-26
**Статус:** Черновик на обсуждение с пользователем
**Связанные:**
- KS-1958 — очистка БД от тестовых курсов
- KS-1959 — программа beginner-курса
- KS-1961 — пилотный урок «Доска и нотация»
- ADR-024 Lessons module
- ADR-026 User courses (содержит CRUD-образец)

---

### 0. TL;DR

- **БД не меняем.** Поля `Course/Lesson/LessonStep` уже содержат всё
  нужное (`coverUrl`, `difficulty`, `estimatedMinutes`,
  `audienceI18nKey`, `hookI18nKey`, `outcomeI18nKey`, `tags`,
  `isPublished`).
- **15 новых эндпоинтов** под префиксом `/lessons/admin/*`,
  зеркалирующих структуру публичного `/lessons/*` + ADR-026
  `/lessons/user-courses/*`.
- **Авторизация** — рекомендую **`AdminEmailGuard` через ENV-whitelist
  `LESSON_ADMIN_EMAILS`** (зеркало того, что уже есть на фронте). Без
  новой роли в БД, без миграции `User`. Если потом понадобится
  полноценный RBAC — мигрируем единым шагом.
- **i18n-ключи** — рекомендую **inline-вариант** (`bodyMarkdown`
  вместо `bodyI18nKey` для шагов; новые поля курса заполняются строкой,
  без отдельной таблицы переводов). Эта развилка — главная, см. §6.
- **Существующий публичный API** не меняется ни одного эндпоинта.
- **UI-админка** — отдельная задача (frontend), не блокер MVP. На
  первом этапе достаточно curl/Postman.

---

### 1. Контекст и задача

#### 1.1 Что есть сейчас

**Источник правды для system courses — seed-фикстуры:**
- `apps/api/src/lessons/seed/courses/<slug>/index.ts` — TypeScript-фикстура
  типа `CourseFixture`.
- `apps/api/src/lessons/seed/seed-lessons.ts` — идемпотентный upsert
  при запуске.
- На фронте — `LessonEditorPage` (`/lessons/editor`) собирает
  фикстуру в UI и **экспортирует .ts-файл**, который человек должен
  поместить в seed-директорию и закоммитить.

**Это не подходит для production-контента, потому что:**
- Каждое изменение текста урока = pull request + ревью + деплой.
- Нет рабочего процесса для chess-expert / автора курсов, далёких
  от Git.
- Контент завязан на цикл деплоя бэка.
- Невозможно править урок «на горячую» без релиза.

**UserCourse устроен иначе** (ADR-026): полноценный CRUD
(`/lessons/user-courses/*`), редактор в UI, контент plain-text
(без i18n). Это — рабочий образец.

#### 1.2 Задача

Спроектировать механизм наполнения system courses **через API**
(не через seed). Конкретно — `Course`, `Lesson`, `LessonStep` —
CRUD с авторизацией.

#### 1.3 Что уже готово в БД (повтор для контекста)

```prisma
model Course {
  id, slug, level, titleKey, descriptionKey,
  coverUrl, difficulty, estimatedMinutes,
  audienceI18nKey, hookI18nKey, outcomeI18nKey, tags,
  order, isPublished,
  createdAt, updatedAt
}

model Lesson {
  id, courseId, slug, order, blockKey, kind,
  titleKey, summaryKey, estMinutes, isPublished,
  createdAt, updatedAt
}

model LessonStep {
  id, lessonId, order, type, payload (jsonb),
  createdAt
}
```

**В схеме менять ничего не надо.** Все поля, которые понадобятся в
API, уже есть.

---

### 2. Принципы дизайна API

1. **Зеркало UserCourse**, насколько это совместимо: те же глаголы,
   та же структура path, тот же стиль DTO. Это ускоряет работу
   разработчика и облегчает frontend-админку.
2. **Идемпотентность по `slug`**: создание курса с существующим slug —
   409 Conflict. Update slug разрешён, но генерирует warning (см.
   §5.6 про прогресс).
3. **Чистое разделение публичного и админского API**:
   - Публичные эндпоинты (`/lessons/*`) — только чтение, фильтр
     `isPublished=true`.
   - Админские (`/lessons/admin/*`) — CRUD, видят и draft (`isPublished=false`).
4. **`isPublished` как простой переключатель**, без workflow «draft
   → preview → published». Workflow — overkill для нашей команды.
5. **Reorder через отдельный POST**, как у user-courses:
   `POST /lessons/admin/courses/:id/lessons/reorder` с массивом id'ов —
   проще на фронте, атомарно на бэке.
6. **Hard delete с каскадом** (Prisma уже это делает: Course →
   Lesson → LessonStep). Soft delete не нужен — версионирование
   удалённого контента — over-engineering для MVP. Если нужно «не
   потерять» — снять `isPublished`.

---

### 3. Спецификация эндпоинтов

#### 3.1 Полная таблица

Все эндпоинты под префиксом `/lessons/admin`. Все требуют
`JwtAuthGuard + AdminEmailGuard` (см. §4).

| # | Метод | Путь | Назначение |
|---|---|---|---|
| **Курсы** | | | |
| 1 | `GET` | `/lessons/admin/courses` | Список курсов (включая draft). Фильтры: `?level=`, `?published=`. |
| 2 | `GET` | `/lessons/admin/courses/:id` | Курс + список уроков (без шагов). |
| 3 | `POST` | `/lessons/admin/courses` | Создать курс. |
| 4 | `PATCH` | `/lessons/admin/courses/:id` | Изменить метаданные курса. |
| 5 | `DELETE` | `/lessons/admin/courses/:id` | Удалить курс (каскадно с уроками и шагами). |
| 6 | `POST` | `/lessons/admin/courses/reorder` | Изменить порядок курсов в каталоге (`order`). |
| **Уроки** | | | |
| 7 | `POST` | `/lessons/admin/courses/:courseId/lessons` | Создать урок в курсе. |
| 8 | `GET` | `/lessons/admin/lessons/:id` | Урок + список шагов. |
| 9 | `PATCH` | `/lessons/admin/lessons/:id` | Изменить метаданные урока. |
| 10 | `DELETE` | `/lessons/admin/lessons/:id` | Удалить урок. |
| 11 | `POST` | `/lessons/admin/courses/:courseId/lessons/reorder` | Переупорядочить уроки внутри курса. |
| **Шаги** | | | |
| 12 | `POST` | `/lessons/admin/lessons/:lessonId/steps` | Создать шаг. |
| 13 | `PATCH` | `/lessons/admin/steps/:id` | Изменить шаг (тип, payload). |
| 14 | `DELETE` | `/lessons/admin/steps/:id` | Удалить шаг. |
| 15 | `POST` | `/lessons/admin/lessons/:lessonId/steps/reorder` | Переупорядочить шаги внутри урока. |

**Зеркальность с UserCourse:** структура повторяет
`/lessons/user-courses` (см. `apps/api/src/lessons/user-courses/`),
сохраняет конвенции — `Get('user-lessons/:id')` etc.

#### 3.2 DTO курса

```ts
// CreateCourseDto
{
  slug: string;             // unique, kebab-case, /^[a-z0-9-]+$/
  level: 'beginner' | 'intermediate' | 'advanced';
  titleKey: string;         // см. §6 — i18n или inline?
  descriptionKey: string;   // legacy (fallback)
  coverUrl?: string | null;
  difficulty?: 1 | 2 | 3;   // default 2
  estimatedMinutes?: number;
  audienceI18nKey?: string | null;
  hookI18nKey?: string | null;
  outcomeI18nKey?: string | null;
  tags?: string[];          // default []
  order?: number;           // default = max(order)+1
  isPublished?: boolean;    // default false
}

// UpdateCourseDto — все поля optional, кроме `id` (в URL)
// Slug менять можно, но осторожно: при смене старые ссылки 404
// (см. §5.6 про прогресс — UserCourseProgress привязан к id, не slug).
```

**Ответ:** полный объект `Course` (все поля БД).

#### 3.3 DTO урока

```ts
// CreateLessonDto
{
  slug: string;                          // unique в рамках курса
  order?: number;                        // default = max(order)+1
  blockKey: string;                      // напр. 'rules' | 'basic-mates'
  kind: LessonKind;                      // 'theory' | 'tactics_set' | ...
  titleKey: string;
  summaryKey: string;
  estMinutes?: number;                   // default 10
  isPublished?: boolean;                 // default false
}

// UpdateLessonDto — все поля optional
// ReorderLessonsDto — { lessonIds: string[] } (полный список в новом порядке)
```

#### 3.4 DTO шага

Самая сложная часть — `payload` это дискриминированный union по
`type` (text | position | puzzle | quiz | video | game_review).

```ts
// CreateLessonStepDto
{
  type: 'text' | 'position' | 'puzzle' | 'quiz' | 'video' | 'game_review';
  order?: number;                        // default = max(order)+1
  payload: StepPayload;                  // обязателен, форма зависит от type
}

// UpdateLessonStepDto — все поля optional, но если меняется type, payload
// обязателен (иначе 400 — несовместимый payload).
```

**Валидация payload:** реюзаем существующий
`StepPayloadDto` из `apps/api/src/lessons/dto/step-payload.dto.ts` —
он уже валидирует payload через class-validator + дискриминированный
union. Backend задача — проверить что DTO применим в admin-контексте
(сейчас он используется только для чтения seed'а).

#### 3.5 Reorder DTO (общий шаблон)

```ts
// для courses, lessons, steps
{
  ids: string[];   // полный список в новом порядке. Если не покрывает все
                   // существующие — 400. order перезаписывается 1..N.
}
```

#### 3.6 GET для админа

`GET /lessons/admin/courses/:id` отличается от публичного
`/lessons/courses/:slug` тем, что:
- Принимает **id**, не slug (для админки удобнее).
- Возвращает курс независимо от `isPublished`.
- Включает уроки **со всеми полями** (включая `isPublished=false`).

Аналогично для `GET /lessons/admin/lessons/:id` — включает шаги.

---

### 4. Авторизация — `AdminEmailGuard`

#### 4.1 Текущая ситуация

В `User` модели **нет поля `role`/`isAdmin`**. На фронте есть
`VITE_LESSON_EDITOR_EMAILS` — env-whitelist email'ов, дающий доступ
к `LessonEditorPage` (только UI, без записи в БД).

#### 4.2 Предложение: `AdminEmailGuard` через ENV

Зеркалим фронтовый подход на бэке:

```ts
// apps/api/src/auth/admin-email.guard.ts
@Injectable()
export class AdminEmailGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const email = req.user?.email;
    const whitelist = (process.env.LESSON_ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!email || whitelist.length === 0) return false;
    if (whitelist.includes('*')) return true; // dev only
    return whitelist.includes(email.toLowerCase());
  }
}
```

Использование:

```ts
@UseGuards(JwtAuthGuard, AdminEmailGuard)
@Controller('lessons/admin')
export class LessonsAdminController { ... }
```

ENV-переменная `LESSON_ADMIN_EMAILS` — список email'ов через запятую
(`pivovartsev@example.com,coach@example.com`).

**Плюсы:**
- Без миграции (не трогаем `User`).
- Зеркальность с фронтом (одна ENV → доступ и к UI, и к API).
- Меняется без деплоя кода (только перезапуск с новой ENV).
- Унаследует от фронта существующий test-coverage логики
  whitelist'а (та же функция `isEmailAllowedFor*`).

**Минусы:**
- Не место хранить роли в ENV в долгой перспективе. Когда команда
  вырастет — мигрируем в `User.role`.
- Email можно сменить (через OAuth-провайдера) — не делает доступ
  безопаснее, но и не делает хуже.
- ENV не виден из БД — если админ пытается понять «кто может
  редактировать курсы», ответ только в конфиге деплоя.

#### 4.3 Альтернатива: новая роль `User.role`

```prisma
enum UserRole {
  user
  editor
  admin
}

model User {
  role UserRole @default(user)
  // ...
}
```

`@Roles('admin', 'editor')` декоратор + `RolesGuard`.

**Плюсы:**
- Полноценный RBAC, готов к расширению.
- Видно из БД и админ-UI, кто кем является.
- Ролями управляют через тот же админ-UI (а не через перезапуск с
  новой ENV).

**Минусы:**
- Миграция БД + back-fill (всем существующим юзерам role='user').
- Нужна страница «Управление ролями» в админке (или ручной SQL).
- Расхождение с фронтовым `LessonEditorPage` (он останется на ENV
  whitelist'е до миграции).

#### 4.4 Моя рекомендация — **§4.2 (ENV-guard)**

ENV-guard покрывает MVP, не блокирует расширение, не требует
миграции. Когда таких ENV-управляемых ролей станет 3+ или нужно
будет менять роли через UI — мигрируем в `User.role` единым шагом
(это отдельная задача).

---

### 5. Совместимость с существующим API

#### 5.1 Публичный API не меняется

Публичные эндпоинты:
- `GET /lessons/courses` — список (фильтр `isPublished=true`).
- `GET /lessons/courses/:slug` — курс + уроки (только опубликованные).
- `GET /lessons/active-courses` (KS-1955).
- `GET /lessons/lessons/:id` — урок + шаги.

**Ни одного эндпоинта не меняем.** Контракт стабилен.

#### 5.2 Что видит публичный пользователь после CRUD

- `isPublished=true` курс → виден в `/lessons/courses`.
- `isPublished=false` курс → невидим публичному API, видим админу.
- Урок/шаги внутри `isPublished=true` курса с `isPublished=false`
  уроком → курс виден, но урок скрыт. (Уже так и работает.)

#### 5.3 Прогресс пользователя при правках

`UserCourseProgress` / `UserLessonProgress` ссылаются на `Course.id` /
`Lesson.id`, не на `slug`. Поэтому:
- **Смена slug курса/урока** — прогресс не теряется.
- **Удаление курса/урока** — каскад: прогресс по этому ресурсу
  стирается вместе с курсом (Prisma `onDelete: Cascade` в
  `UserLessonProgress.lesson`, `UserCourseProgress.course`). Если
  пользователь активно проходил курс — он потеряет прогресс. Это
  **сейчас так работает** в seed-flow (если убрать курс из seed —
  тот же эффект). Кажется приемлемым; рекомендация — перед удалением
  снимать `isPublished` и подождать.
- **Переупорядочивание уроков** — `UserLessonProgress` неизменён,
  но `currentLessonId` в `UserCourseProgress` может стать
  «неактуальным» (логика курса всё равно ведёт на следующий
  невыполненный). Не блокер.

#### 5.4 Удаление шага и `stepsState`

`UserLessonProgress.stepsState` — JSONB вида
`{ [stepId]: 'done' | 'failed' }`. Если админ удалит шаг — JSONB
останется с «висящим» stepId, но это не сломает рендер
(прогресс просто не покажет несуществующий шаг). Добавление нового
шага — пользователь увидит его как `pending`, нужно будет пройти.

#### 5.5 SM-2 повторения при удалении урока

`LessonReview` имеет каскадное удаление по lessonId. При удалении
урока повторения тоже исчезнут. Опять же — приемлемо для MVP.

#### 5.6 Smith of slug: бэк должен делать что-то особое?

Нет. Достаточно валидировать что новый slug уникален. Старые ссылки
(`/lessons/<old-slug>`) после смены вернут 404 — это нормально для
правки контента.

---

### 6. i18n-ключи — главная развилка

#### 6.1 Сейчас в seed

Тексты живут в `apps/web/src/i18n/locales/{en,ru}/translation.json`
и `apps/api/src/i18n/{en,ru}/lessons.json`. Фикстура хранит **только
ключ** (`titleKey: 'lessons.demo.text-demo.title'`), сам текст — в
JSON-файлах. Перевод обновляется коммитом в JSON.

**При CRUD через API это становится проблемой:** админ создаёт курс
через POST → `titleKey: 'lessons.beginner.board.title'`, но
JSON-файл с этим ключом не существует. UI покажет либо ключ как
fallback, либо пусто.

#### 6.2 Вариант A — inline-тексты в БД (рекомендую)

Для **новых** курсов — отказываемся от i18n-ключей, храним тексты
прямо в БД:

```prisma
model Course {
  // существующие поля
  titleKey         String   @map("title_key")  // legacy, остаётся для seed
  descriptionKey   String   @map("description_key")
  // новые поля для inline-текстов
  title            String?  // если задано — приоритет над titleKey
  description      String?
  audience         String?  // вместо audienceI18nKey
  hook             String?
  outcome          String?
}

model Lesson {
  titleKey         String                       // legacy
  summaryKey       String
  title            String?
  summary          String?
}

// LessonStep уже имеет flexibility через payload — TextStepPayload уже
// поддерживает либо `bodyI18nKey`, либо `bodyMarkdown`.
```

**Плюсы:**
- Просто. Админ создаёт курс с текстом, не думая о ключах.
- Совместимо с существующим UI: компонент проверяет
  `course.title ?? t(course.titleKey)`.
- Никаких новых таблиц.
- Один язык в MVP — оптимально (см. §6.4).

**Минусы:**
- Однaя локаль на запись. Если завтра надо мультиязычно —
  отдельная задача (см. §6.4).
- Расходимся с seed-подходом (но seed теперь только для
  легаси-демо).

#### 6.3 Вариант B — отдельная таблица переводов

```prisma
model I18nString {
  id     String @id
  key    String  // 'lessons.beginner.board.title'
  locale String  // 'ru' | 'en'
  value  String
  @@unique([key, locale])
}
```

CRUD-эндпоинты для переводов; `titleKey` в `Course` ссылается на
ключ.

**Плюсы:**
- Полноценная i18n-инфраструктура.
- Можно редактировать переводы независимо от курсов.

**Минусы:**
- Новая таблица + миграция.
- Усложняет каждый GET курса (joins / отдельный запрос).
- Overkill пока контента «один курс, один язык».

#### 6.4 Аргумент в пользу варианта A

Текущий beginner-курс (KS-1959) — на одном языке. Расширение на en —
**отдельная содержательная задача** (нужен chess-expert на английском).
Когда (если) понадобится мультиязычно — мигрируем поля
`title/description/etc.` в `I18nString`. Стоимость миграции
ограничена количеством курсов (вероятно 5-15 на тот момент) — приемлемо.

**Моя рекомендация — вариант A** (inline в БД). Вариант B — когда
содержательно понадобится мультиязычность.

---

### 7. Открытые вопросы

#### 7.1 Авторизация — ENV-guard или новая роль?

См. §4. Моя рекомендация — ENV-guard (вариант 4.2). Альтернатива
(4.3 — `User.role`) — если хочешь сразу полноценный RBAC.

#### 7.2 i18n — inline или отдельная таблица?

См. §6. Моя рекомендация — inline (6.2).

#### 7.3 Bulk-import из markdown

KS-1961 готовит уроки в markdown-формате (см.
`docs/courses/beginner/lesson-01-game.md`). Можно ли сделать
эндпоинт `POST /lessons/admin/courses/import-markdown`, принимающий
такой markdown и собирающий из него курс/уроки/шаги?

- За: ускоряет наполнение, chess-expert работает в markdown.
- Против: нужен парсер markdown → структура (отдельная нетривиальная
  задача). Простая альтернатива — frontend-админка с copy-paste
  блоков из markdown.
- Моя рекомендация — **не делать сейчас**. Накапливаем 2-3 урока
  через обычный CRUD (curl/Postman), потом смотрим, есть ли смысл
  в импортере.

#### 7.4 Frontend-админка — нужна сразу или позже?

- За «сразу»: chess-expert не работает с curl.
- Против «сразу»: добавляет 2-3 недели разработки. На MVP можем
  сами заводить контент через Postman + готовый markdown.
- Моя рекомендация — **MVP без UI**. Сначала архитектура + первые
  2-3 урока через Postman. Потом — UI отдельной задачей.

#### 7.5 Workflow `draft → preview → published`

Сейчас предлагаю простой переключатель `isPublished`. Если нужен
«предпросмотр чернового урока» — это отдельная история (preview
URL с подписью админа, доступ только админам). Не блокер MVP.

#### 7.6 Изменение `slug` после публикации

Сейчас разрешаю с предупреждением. Альтернатива — запретить
вообще (после `isPublished=true` slug заморожен). Моя рекомендация —
разрешить, потому что опечатки в slug встречаются часто; отслеживать
сломанные ссылки — задача SEO, не контента.

#### 7.7 Ratelimits

Нужен ли admin rate-limit? У UserCourse есть
`USER_COURSES_RATE_LIMITS`. Для admin'ов — наверное нет (доверяем
своим). Но базовый — поставить можно (например, 100 запросов/мин на
эндпоинт), для защиты от accidental DoS из-за бага в админке.

---

### 8. Разбивка на задачи

#### 8.1 Backend (агент `backend`)

| # | Задача | Описание | Зависит от | Метки |
|---|---|---|---|---|
| **B-1** | `AdminEmailGuard` | Создать guard в `apps/api/src/auth/admin-email.guard.ts`. Логика — зеркало фронтового `isEmailAllowedForEditor`. ENV: `LESSON_ADMIN_EMAILS`. Тесты: пустая ENV → deny, `*` → allow всех, конкретные email — case-insensitive. | — | `auth`, `tests` |
| **B-2** | Inline-поля в `Course`/`Lesson` | Prisma migration: добавить `title`, `description`, `audience`, `hook`, `outcome` в `Course`; `title`, `summary` в `Lesson`. Все nullable. Старые `*Key` остаются как fallback. | — | `prisma` |
| **B-3** | Обновление DTO `CourseListItem`/`Course` в shared | Добавить inline-поля. Логика fallback: `course.title ?? t(course.titleKey)`. | B-2 |  |
| **B-4** | Обновление публичного API | `CoursesService` мапит inline-поля в DTO (если есть). Если оба пустые — старое поведение. Без новых эндпоинтов, только маппинг. | B-2, B-3 |  |
| **B-5** | `LessonsAdminController` — курсы | Эндпоинты #1–6 из §3.1 (GET/POST/PATCH/DELETE/reorder). Контроллер под `/lessons/admin/courses`. Гарды: `JwtAuthGuard + AdminEmailGuard`. DTO см. §3.2. | B-1, B-2 |  |
| **B-6** | `LessonsAdminController` — уроки | Эндпоинты #7–11. | B-5 |  |
| **B-7** | `LessonsAdminController` — шаги | Эндпоинты #12–15. Реюзать `StepPayloadDto` для валидации payload. | B-6 |  |
| **B-8** | `LessonsAdminService` | Сервис с CRUD-методами для всех трёх сущностей. Идемпотентность slug (Course unique, Lesson unique в курсе). Транзакции для reorder. | B-5, B-6, B-7 |  |
| **B-9** | E2E-тесты admin API | 1) Полный CRUD курса. 2) CRUD урока. 3) CRUD шага. 4) Reorder. 5) Авторизация (без email — 401, с не-админ email — 403, с админ email — 200). 6) Каскадное удаление. 7) Регресс-тест публичного API (не сломан). | B-1..B-8 | `tests` |
| **B-10** | (опционально) Rate limit | Admin endpoints: 100 req/min на user. См. §7.7. | B-8 |  |

#### 8.2 Frontend (опционально, отдельная задача после MVP)

| # | Задача | Описание | Зависит от |
|---|---|---|---|
| **F-1** | Страница `/lessons/admin/courses` | Список + CTA «Создать курс». Фильтр draft/published. | B-5 |
| **F-2** | Форма курса (создать/редактировать) | Поля: slug, level, title, description, cover (upload), difficulty, estimatedMinutes, audience/hook/outcome, tags, order, isPublished. | B-5 |
| **F-3** | Страница `/lessons/admin/courses/:id` | Курс + список уроков с reorder + CTA «Создать урок». | B-6 |
| **F-4** | Форма урока | Метаданные + список шагов с reorder + CTA «Создать шаг». | B-6 |
| **F-5** | Редактор шага | Дискриминированный редактор по типу: TextStep (markdown editor), PositionStep (FEN editor), PuzzleStep (поиск/фильтр puzzle), QuizStep (form), VideoStep, GameReviewStep. | B-7 |
| **F-6** | Авторизация на фронте | Использовать `LESSON_ADMIN_EMAILS` (новая ENV или реюзать `VITE_LESSON_EDITOR_EMAILS`). | B-1 |

**Замечание:** F-5 — самая трудоёмкая часть фронта, потому что
типов шагов 6 и каждый со своим payload. Можно реюзать
существующий `StepEditor` из `LessonEditorPage` (он умеет редактировать
все типы для seed-фикстур), переключив target с экспорта в TS на
POST в API.

#### 8.3 DevOps

| # | Задача | Описание | Зависит от |
|---|---|---|---|
| **D-1** | ENV `LESSON_ADMIN_EMAILS` | Добавить в production-конфиг с email'ами текущих админов. Документировать в README. | B-1 |

#### 8.4 Документация

| # | Задача | Описание | Зависит от |
|---|---|---|---|
| **DOC-1** | OpenAPI / curl-примеры | После B-9 — короткий гид «как создать курс через curl» в `docs/admin/`. Для chess-expert и автора курса. | B-9 |

#### 8.5 Граф зависимостей

```
B-1 (AdminGuard) ──┐
                   ├──► B-5 (Courses CRUD) ──► B-6 (Lessons CRUD) ──► B-7 (Steps CRUD) ──► B-8 (Service) ──► B-9 (E2E)
B-2 (Migration) ──►│       │                                                                                    │
                   B-3 (DTO) ──► B-4 (Public API mapping)                                                       │
                                                                                                                ▼
                                                                                                            DOC-1
B-1 ──► D-1 (ENV)

(Frontend F-1..F-6 — после B-5..B-7, отдельной волной.)
```

**Критический путь до возможности завести курс через API:**
`B-1 → B-2 → B-5 → B-6 → B-7 → B-8`. После — можно через curl
заводить весь beginner-курс.

---

### 9. Что НЕ входит в эту задачу

- **Реализация (код)** — только проектирование.
- **Frontend-админка** — отдельная задача (§8.2).
- **Bulk-import markdown** — §7.3, отвергли для MVP.
- **Полноценный RBAC** (`User.role`) — §7.1, отдельной миграционной
  задачей, когда понадобится.
- **Мультиязычность** контента — §6.4, отдельной задачей при
  появлении второго языка.
- **Workflow draft/preview/published** — §7.5, не нужен MVP.
- **Удаление seed-фикстур** — отдельная задача после миграции
  существующих демо-курсов в БД через API (или просто оставить seed
  выключенным в production).

---

### Приложение A. Соответствие пунктам ТЗ

| Пункт ТЗ | Где в документе |
|---|---|
| 1. CRUD-эндпоинты для Course/Lesson/Step | §3 |
| 1. i18n-ключи | §6 |
| 2. Авторизация (admin/editor) | §4 |
| 3. Совместимость с публичным API | §5 |
| 4. Опциональный UI | §8.2 |
| Что в схеме БД менять не надо | §1.3 + §6 (надо добавить inline-поля) |
| Что добавить (роль editor / middleware) | §4.2 (`AdminEmailGuard`) |
| Открытые вопросы | §7 |
| Разбивка на задачи | §8 |
