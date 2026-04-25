# Seed-фикстуры раздела «Уроки»

MVP раздела «Уроки» (ADR-024). Формат контента — **TypeScript-модули**:
жёсткая типизация через `@kingside/shared` (`StepPayload` дискриминирован
по `type`), автодополнение в IDE, проверка компилятором. YAML/JSON
не используется — shape сложный (union + вложенные структуры), а
отдельный Markdown-файл на каждый урок избыточен: inline
`bodyMarkdown` удобнее автору контента.

Альтернатива в ADR-024 §2.4 (YAML + отдельные `.md`-файлы) отброшена:
YAML + class-validator через `plainToInstance` работает, но chess-expert
теряет автодополнение и проверку типов. Решение зафиксировано здесь.

## Структура

```
apps/api/src/lessons/seed/
├── README.md                  — этот файл
├── fixture-types.ts           — типы CourseFixture/LessonFixture/StepFixture
├── lint.ts                    — основная логика валидации
├── lint-lessons.ts            — точка входа линтера (без БД)
├── seed-lessons.ts            — точка входа apply-скрипта (с БД + linter)
└── courses/
    ├── index.ts               — список всех курсов для накатки
    └── <course-slug>.ts       — одна фикстура на курс
```

## Скрипты

В `apps/api/package.json`:

- `npm run seed:lessons:lint` — только проверки shape + FEN/PGN/UCI
  (без БД). Интегрирован в `npm run lint`, падает билд при нарушении.
- `npm run seed:lessons` — линт + idempotent upsert в БД (требует
  поднятый Postgres и `DATABASE_URL`).
- `npm run seed:sample-puzzles` — минимум синтетических задач
  (`source='sample'`) для resolver'а PuzzleStep, KS-1783.
- `npm run seed:user-courses` — два пользовательских курса (от имени
  DEV-юзера) для UI-скринов и e2e KS-1880/1882/1886, KS-1887.
  Идемпотентно. Требует, чтобы `DEV` юзер уже был — он создаётся
  скриптом `npm run prisma:seed --workspace=@kingside/db`. Курсы:
  - `/lessons/my/demo-public-course` — public, 2 урока (text/text,
    text/puzzle/endgame_drill);
  - `/lessons/my/demo-private-course` — private, 1 урок (для
    owner-only views).

## Что проверяет линтер

1. **Shape payload** — класс-валидатор по дискриминированному union
   (`StepPayloadDto`, см. `apps/api/src/lessons/dto/step-payload.dto.ts`).
   6 вариантов: `text`, `puzzle`, `quiz`, `position`, `game_review`,
   `video`.
2. **FEN** — `chess.js` `Chess#load(fen)` по всем полям
   `fen`: `TextStep.diagrams[].fen`, `PositionStep.fen`,
   `QuizQuestion.fen`.
3. **UCI-ходы** — для `PositionStep.expectedMoves` линтер загружает
   позицию и пытается сделать каждый ход через `chess.js`.
4. **PGN** — `chess.js` `Chess#loadPgn(pgn)` для `GameReviewStep.pgn`.
5. **PuzzleId** — для `PuzzleStep.selection.mode='ids'` проверяется
   наличие id в таблице `puzzles` (только в `seed:lessons`, т. е.
   с БД).
6. **URL** — `video.url` парсится `new URL(...)`.
7. **Уникальность** — `course.slug` глобально, `lesson.slug` в
   рамках курса, `step.id` в рамках урока.
8. **Консистентность quiz** — для `multi=false` ровно один
   `correctOptionIds`, все `correctOptionIds` — из `options[].id`.
9. **Диапазон рейтингов** — `PuzzleStep.selection.mode='filter'`
   не допускает `ratingMin > ratingMax`.

## Идемпотентность

Upsert ведётся по:
- `courses.slug` (глобально уникален).
- `lessons (course_id, slug)` (уникально в рамках курса).
- `lesson_steps` — полностью переписываются на каждый запуск
  (`deleteMany` + `createMany`). Это сознательный выбор: порядок и
  состав шагов меняются редко, но если меняются — построчный
  upsert требует устойчивого БД-id, которого мы намеренно избегаем
  (БД-id шага генерируется Prisma при каждой вставке; привязка к
  `UserLessonProgress.stepsState` делается через `order` + клиентский
  ключ `step.id` из фикстуры).

Повторный запуск `seed:lessons` без изменений — no-op по данным
(кроме перезаписи `lesson_steps`, что прозрачно для прогресса).

## Добавление курса (пример)

1. Создать `courses/<course-slug>.ts`:

   ```ts
   import type { CourseFixture } from '../fixture-types';

   export const myCourse: CourseFixture = {
     slug: 'my-course',
     level: 'beginner',
     titleKey: 'lessons.my-course.title',
     descriptionKey: 'lessons.my-course.description',
     order: 1,
     isPublished: true,
     lessons: [
       {
         slug: 'lesson-1',
         order: 0,
         blockKey: 'intro',
         kind: 'theory',
         titleKey: 'lessons.my-course.lesson-1.title',
         summaryKey: 'lessons.my-course.lesson-1.summary',
         isPublished: true,
         steps: [
           {
             id: 'welcome',
             order: 0,
             payload: {
               type: 'text',
               bodyMarkdown: '# Привет\n\nЭто первый урок.',
             },
           },
         ],
       },
     ],
   };
   ```

2. Зарегистрировать в `courses/index.ts`:

   ```ts
   import { myCourse } from './my-course';
   export const COURSES = [beginnerBasics, myCourse];
   ```

3. Запустить `npm run seed:lessons:lint --workspace=@kingside/api` —
   проверить что валидация проходит.
4. (Опционально) локально `npm run seed:lessons` на dev-БД.

## i18n-ключи

`titleKey` / `summaryKey` / `bodyI18nKey` / `promptI18nKey` и т. п. —
строки, указывающие на словари:
- `apps/web/src/i18n/<locale>/lessons.json` — для UI;
- `apps/api/src/i18n/<locale>/lessons.json` — для API-ответов (если
  нужны человеческие строки в сообщениях об ошибках и т. п.).

В MVP поддерживаем только `ru`. `en` — после L-16 (см. roadmap §5).
Для коротких inline-текстов `TextStepPayload.bodyMarkdown` допустим —
использовать для первых прототипов / монолингвальных курсов.
