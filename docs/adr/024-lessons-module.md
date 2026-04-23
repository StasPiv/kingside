# ADR-024: Lessons module — схема, payload-политика, прогресс

**Дата:** 2026-04-23
**Статус:** Предложено
**Задача:** KS-1756 (L-01)
**Связанные документы:**
- [lessons-module.md](../architecture/lessons-module.md) — общее видение
- [lessons-roadmap.md](../architecture/lessons-roadmap.md) — план разработки
- Ссылается на: KS-1753 (архитектурное видение), KS-1754 (методическое видение), KS-1755 (план)

---

## 1. Контекст

Запускаем раздел «Уроки». Иерархия контента (из KS-1754): курс → блок
→ урок → шаг. Курсы: «Начинающий» (~30 уроков), «Средний» (~48),
«Опытный» (60+ модульно). Урок состоит из шагов разных типов
(текст+диаграммы, интерактивная позиция, задача, тренажёр, разбор
партии, мини-тест, видео).

Что уже есть в коде (подробно — в `docs/architecture/lessons-module.md`):
- `puzzle` (база задач Lichess + сгенерированные, Glicko-рейтинг,
  фильтр по темам и рейтингу, `PuzzleAttempt`)
- `analysis` (хранение PGN с аннотациями/вариантами)
- `workshop` (PGN-импорт, `ExternalChessService` для Lichess/chess.com)
- `engine` (Stockfish WASM + внешний движок + `GameReport`)
- `archive-service` (индекс партий пользователя по позициям)

Что нужно решить **до миграции** (`L-03`):
1. Точный набор таблиц Prisma и их поля.
2. Как хранить разнородные параметры шагов (payload).
3. Как считать прогресс «пройден» / «освоено» и как это сочетается
   с будущим SM-2 (итерация 2).
4. Как доставлять контент в БД на старте (seed vs админка).
5. Где граница между LessonsModule и существующими модулями —
   чтобы не дублировать логику задач, анализа, импорта.

## 2. Решение

### 2.1 Пять сущностей Prisma (`packages/db/prisma/schema.prisma`)

Все PK — `uuid`, snake_case в БД. Поле `payload` — `Json` (PostgreSQL
JSONB).

#### Course

```prisma
model Course {
  id              String   @id @default(uuid()) @db.Uuid
  slug            String   @unique                              // "beginner-basics"
  level           String                                        // "beginner" | "intermediate" | "advanced"
  titleKey        String   @map("title_key")                    // i18n ключ
  descriptionKey  String   @map("description_key")
  order           Int      @default(0)
  isPublished     Boolean  @default(false) @map("is_published")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt      @map("updated_at")

  lessons         Lesson[]
  progress        UserCourseProgress[]

  @@index([level, order])
  @@index([isPublished])
  @@map("courses")
}
```

Обоснование:
- `slug` — стабильный человекочитаемый id для seed-фикстур и URL `/lessons/:slug`.
- `level` — строка, а не enum, чтобы не переписывать миграцию при
  добавлении уровней (например, `kids`). Валидация — на API.
- «Блок» из методического видения **не выносим в отдельную таблицу**:
  блок — это группа уроков внутри курса, моделируется полем
  `Lesson.blockKey` (ниже). Блоки — атрибут отображения, отдельная
  сущность избыточна.

#### Lesson

```prisma
model Lesson {
  id            String   @id @default(uuid()) @db.Uuid
  courseId      String   @map("course_id") @db.Uuid
  slug          String                                          // уникален в рамках курса
  order         Int      @default(0)
  blockKey      String   @map("block_key")                      // "rules", "basic-mates", ...
  kind          String                                          // "theory" | "tactics_set" | "endgame_set" | "opening_line" | "game_review" | "quiz"
  titleKey      String   @map("title_key")
  summaryKey    String   @map("summary_key")
  estMinutes    Int      @default(10) @map("est_minutes")       // оценка 5..15
  isPublished   Boolean  @default(false) @map("is_published")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt      @map("updated_at")

  course        Course        @relation(fields: [courseId], references: [id])
  steps         LessonStep[]
  progress      UserLessonProgress[]

  @@unique([courseId, slug])
  @@index([courseId, order])
  @@index([courseId, blockKey, order])
  @@index([isPublished])
  @@map("lessons")
}
```

#### LessonStep

```prisma
model LessonStep {
  id         String   @id @default(uuid()) @db.Uuid
  lessonId   String   @map("lesson_id") @db.Uuid
  order      Int      @default(0)
  type       String                                  // "text" | "position" | "puzzle" | "quiz" | "video" | "game_review"
  payload    Json                                    // JSONB, см. §2.2
  createdAt  DateTime @default(now()) @map("created_at")

  lesson     Lesson @relation(fields: [lessonId], references: [id], onDelete: Cascade)

  @@index([lessonId, order])
  @@map("lesson_steps")
}
```

#### UserCourseProgress

```prisma
model UserCourseProgress {
  id               String    @id @default(uuid()) @db.Uuid
  userId           String    @map("user_id") @db.Uuid
  courseId         String    @map("course_id") @db.Uuid
  startedAt        DateTime  @default(now()) @map("started_at")
  completedAt      DateTime? @map("completed_at")
  currentLessonId  String?   @map("current_lesson_id") @db.Uuid

  user    User   @relation(fields: [userId], references: [id])
  course  Course @relation(fields: [courseId], references: [id])

  @@unique([userId, courseId])
  @@index([userId])
  @@map("user_course_progress")
}
```

#### UserLessonProgress

```prisma
model UserLessonProgress {
  id           String    @id @default(uuid()) @db.Uuid
  userId       String    @map("user_id") @db.Uuid
  lessonId     String    @map("lesson_id") @db.Uuid
  startedAt    DateTime  @default(now()) @map("started_at")
  completedAt  DateTime? @map("completed_at")                 // ставится при score ≥ 70
  masteredAt   DateTime? @map("mastered_at")                  // ставится в итерации 2 через SM-2
  score        Int       @default(0)                          // 0..100, доля «успешных» шагов
  stepsState   Json      @map("steps_state")                  // { [stepId]: "done" | "failed" | "skipped" }

  user    User   @relation(fields: [userId], references: [id])
  lesson  Lesson @relation(fields: [lessonId], references: [id], onDelete: Cascade)

  @@unique([userId, lessonId])
  @@index([userId])
  @@index([userId, completedAt])
  @@map("user_lesson_progress")
}
```

**Попытки задач внутри урока не дублируются.** Решение пользователя
по `puzzle`-шагу пишется в существующий `PuzzleAttempt`. В
`UserLessonProgress.stepsState` храним только агрегат
(`done`/`failed`/`skipped`) — этого достаточно для расчёта `score` и
UI-маркеров.

### 2.2 Политика `payload` (JSONB)

Проблема: у каждого типа шага свой набор параметров (у `puzzle` —
`puzzleId` или список, у `text` — markdown-ключ, у `position` —
FEN + ожидаемые ходы). Классический путь — таблица на тип шага
(`TextStep`/`PuzzleStep`/…) — даёт избыточную сложность под одного
разработчика. Принимаем JSONB + дисциплину валидации.

Форма `payload` — **дискриминированный union** по `LessonStep.type`,
источник истины — `packages/shared/src/types/lessons.ts`
(задача `L-02`):

```ts
// Пример (нормативный вид — в L-02)
type StepPayload =
  | { type: 'text';   bodyKey: string;  figures?: FenFigure[] }
  | { type: 'position'; fen: string; solutionUci: string[]; hintKey?: string }
  | { type: 'puzzle'; puzzleId: string }                           // id из `puzzles`
  | { type: 'quiz';   questionKey: string; options: QuizOption[]; correctIndex: number }
  | { type: 'video';  url: string; captionKey?: string }
  | { type: 'game_review'; sourceKind: 'import' | 'analysis'; analysisId?: string; questions: string[] };
```

Защита целостности `payload` — **три уровня**, все обязательные:

1. **Shared типы** (`packages/shared/src/types/lessons.ts`, L-02)
   — единый источник истины для backend и frontend.
2. **API-валидация**: DTO с `class-validator` + `@ValidateNested`
   по `type`. Запись в БД только через эти DTO. Никаких прямых вставок
   в API.
3. **Seed-линтер** (L-05) перед импортом фикстур:
   - валидирует `payload` против shared-union;
   - прогоняет `chess.js` по всем `fen`/`solutionUci` и проверяет
     легальность;
   - проверяет, что каждый `puzzleId` существует в таблице `puzzles`;
   - проверяет, что каждый i18n-ключ присутствует в `apps/web/src/i18n/ru`
     и `apps/api/src/i18n/ru` (для итерации 1 — только `ru`);
   - падает при любом нарушении, миграция/seed не проходит.

**Индексы по `payload` не заводим** на старте. Выборки идут по
`lessonId` + `order`; если позже понадобится искать шаги по
`payload.puzzleId`, добавим частичный expression-index отдельной
миграцией.

### 2.3 Политика прогресса

- **Шаг считается «успешным»**, когда:
  - `text`: пользователь нажал «Продолжить» → `done`.
  - `position`: сделан ожидаемый ход (или серия ходов) → `done`;
    иначе после N попыток → `failed` (N — параметр шага, по умолчанию
    3).
  - `puzzle`: `PuzzleAttempt.solved = true` в рамках этого урока →
    `done`; иначе `failed`.
  - `quiz`: выбран правильный вариант с первой попытки → `done`;
    со второй — `done` с пометкой; дальше — `failed`.
  - `video`: «просмотрено» по клику «Продолжить» → `done`
    (детектирование фактического просмотра — вне MVP).
  - `game_review`: прохождены все направляющие вопросы шага (итерация 3).

- **Урок «пройден»:** `score ≥ 70`, где
  `score = round(100 * done / (done + failed))`. Не учитываем
  `skipped`. Ставится `completedAt = now()`.

- **Урок «освоен» (`masteredAt`):** вводится в **итерации 2** вместе
  с SM-2 (L-20..L-22). Правило: повторное прохождение урока через
  7–14 дней после `completedAt` со `score ≥ 80`. В MVP поле заведено
  в схеме, но всегда `null`.

- **Курс «завершён»:** все `isPublished = true` уроки курса
  имеют `UserLessonProgress.completedAt != null` для пользователя.
  Вычисляется на лету, отдельной колонки нет.

- **Переход между уровнями** (KS-1754):
  - Начинающий → Средний: курс «Начинающий» завершён **и**
    `user.ratingPuzzle ≥ 1200` **и** сумма
    `gamesPlayedBullet+Blitz+Rapid+Classical ≥ 20`.
  - Средний → Опытный: курс «Средний» завершён **и**
    `user.ratingPuzzle ≥ 1700` **и** `user.ratingRapid ≥ 1400` **и**
    суммарное число `PuzzleAttempt.solved = true` по пользователю ≥ 500.

  Реализация — API-эндпоинт `GET /lessons/level-gate`, возвращает
  `{ level: 'beginner'|'intermediate'|'advanced', unlocked: boolean,
  blockers: string[] }`. UI-плашка — задача `L-15` / `L-26`.

### 2.4 Контент: seed, без админки (MVP)

- Контент хранится в `apps/api/src/lessons/seed/*.ts` как
  типизированные TS-модули (типы — из shared, L-02).
- Накатка: `npm run seed-lessons` (L-05). Идемпотентно по `slug`
  (upsert курса/урока/шагов). Удаление существующих шагов перед
  upsert — по `lessonId` (порядок меняется).
- Тексты — через i18n в `apps/web/src/i18n/ru/lessons/*` и
  `apps/api/src/i18n/ru/lessons/*` (для сообщений в API ответах).
  Картинки — `apps/web/public/lessons/`.
- Админку (UI для редактирования уроков через БД) в MVP **не
  делаем**. В итерации 2 появится «редактор уроков» (L-27), который
  экспортирует в тот же формат seed-фикстур — не переходит на прямое
  редактирование БД.
- Причина: один разработчик, быстрый старт, контент стабилен
  (меняется редко), версионируется в git рядом с кодом.

### 2.5 Границы с существующими модулями

`LessonsModule` — тонкий слой. Всё «тяжёлое» делают существующие
модули.

| Зона                                  | Модуль                | Что делает LessonsModule |
|---------------------------------------|-----------------------|--------------------------|
| Получение задачи по id                | `PuzzleModule`        | По `payload.puzzleId` вызывает `PuzzleService.getById`. Своей копии задач не держит. |
| Фиксация попытки решения задачи       | `PuzzleModule`        | `PuzzleService.submitAttempt` — тот же путь, что и на странице `/puzzle`. В `UserLessonProgress.stepsState` пишется только агрегат. |
| Рейтинг задач (Glicko)                | `PuzzleModule`        | Не дублируем, полагаемся. |
| Фильтр задач по темам/рейтингу (для рекомендаций) | `PuzzleModule` | Переиспользуем существующий API (`L-06` — ревизия существующего фильтра). |
| Хранение PGN-разборов                 | `AnalysisModule` (`Analysis`) | Для шагов `game_review` ссылаемся на `Analysis.id`, не копируем PGN. |
| Импорт партий с Lichess/chess.com     | `WorkshopModule` (`ExternalChessService`, `parsePgnGames`) | Шаг `game_review` с `sourceKind: 'import'` открывает `ImportExternalModal` и создаёт `PgnImport` → пользователь выбирает игру → `LessonsModule` записывает `analysisId` в `stepsState`. |
| Анализ позиции / отчёт по партии      | `engine` + `GameReport` | Переиспользуем хуки `useEngine`/`useGameReport` на фронте. |
| Архив партий пользователя по позициям | `archive-service`     | Потенциально используется в треке A (дебюты) и треке D; в MVP не задействован. |

**Чего LessonsModule принципиально не делает:**
- Не держит свои таблицы задач/анализов/PGN-импортов.
- Не валидирует шахматные ходы «с нуля» — это `chess.js` в shared
  утилитах и `PuzzleService`.
- Не реализует матчмейкинг / WebSocket / чат.

## 3. Альтернативы, отвергнутые

1. **Таблица на каждый тип шага** (`TextStep`, `PuzzleStep`, …).
   Отвергнуто: 6 типов в ближней перспективе, один разработчик,
   усложняет seed, миграции и запросы. JSONB + трёхуровневая
   валидация покрывает риск.
2. **Отдельная таблица `Block`** под методические блоки. Отвергнуто:
   блок — атрибут отображения, не несёт поведения; поле `Lesson.blockKey`
   достаточно и проще в миграциях.
3. **Хранение попыток задач отдельной таблицей `LessonAttempt`**.
   Отвергнуто: дублирует `PuzzleAttempt`. Достаточно агрегата в
   `stepsState`.
4. **Сразу внедрить SM-2 в MVP.** Отвергнуто: расширяет скоуп MVP,
   тянет планировщик, отдельный ADR (025), осмысленно только после
   накопления прохождений.
5. **Админка уроков через БД в MVP.** Отвергнуто: один разработчик,
   контент редко меняется, seed + git — дешевле и безопаснее.
6. **Хранить тексты уроков прямо в `Lesson.titleText`/`bodyText`.**
   Отвергнуто: в проекте весь пользовательский контент идёт через
   i18n (ru/en), не дублируем механизм.

## 4. Последствия

### Положительные
- Минимальный набор таблиц, предсказуемая миграция.
- Нулевое дублирование логики задач/анализа/импорта.
- Контент версионируется в git, легко ревьюить.
- JSONB + shared union даёт гибкость без тяжёлой схемы.

### Отрицательные / компромиссы
- Добавление нового типа шага требует правки в трёх местах:
  shared union, API DTO, seed-линтер. Митигация: это сознательная
  цена «гибкость через дискриминант», документирована.
- Прогресс уровня (освоение) — только в итерации 2. В MVP
  пользователь видит только «пройден / не пройден».
- Контент без админки — порог входа для не-разработчика выше. Митигация:
  в итерации 2 появится редактор (L-27).

### Нейтральные / задел на будущее
- Поле `masteredAt` заведено заранее, чтобы в итерации 2 не
  делать миграцию.
- `blockKey` — строка, можно в будущем вынести в `Block` без
  ломающей миграции (data migration).

## 5. Что делать после принятия ADR

1. `L-02`: оформить shared-типы в `packages/shared/src/types/lessons.ts`
   (дискриминированный union `StepPayload`).
2. `L-03`: написать Prisma-миграцию по §2.1.
3. `L-05`: реализовать формат seed + линтер с тремя проверками
   (shared union, `chess.js` для FEN/UCI, существование `puzzleId` и
   i18n-ключей).
4. `L-04`: API `LessonsModule` с DTO-валидацией.

Изменения схемы после принятия ADR — через новый ADR или отдельным
комментарием в `lessons-module.md` с привязкой к тикету.
