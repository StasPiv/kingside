import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Контрактные тесты на Prisma-схему user-courses (KS-1828, ADR-026 §2.1).
 *
 * Почему контрактный тест читает сам `schema.prisma`, а не гоняет реальный
 * `PrismaClient` против БД:
 *
 * 1. В `apps/api/jest.config.ts` есть `moduleNameMapper`, который
 *    перехватывает ЛЮБОЙ импорт, заканчивающийся на `/generated/prisma/client`,
 *    и подменяет его на `__mocks__/prisma-client.mock.ts`. Это нужно, чтобы
 *    юнит-тесты остальной кодбазы не требовали поднятой БД и не зависели
 *    от `prisma generate`. Любая попытка в обычном spec-файле поднять
 *    настоящий `PrismaClient` всё равно получит мок.
 *
 * 2. Настоящая runtime-проверка каскада (создать курс → урок → шаг →
 *    удалить курс → проверить, что урок и шаг удалились из БД) выполнена
 *    отдельным скриптом `test/user-courses-cascade.integration.mjs`,
 *    прогоняется вручную против локальной PostgreSQL. Его вывод
 *    прикреплён к KS-1828 как подтверждение DoD.
 *
 * Здесь же мы фиксируем контракт схемы (`onDelete: Cascade` именно там,
 * где нужно, уникальные индексы, структура таблиц) — он гарантирует, что
 * при рефакторинге схемы никто не снимет каскад втихую.
 */

const SCHEMA_PATH = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'prisma', 'schema.prisma');

describe('UserCourses Prisma schema contract (KS-1828)', () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');

  describe('модели', () => {
    it.each([
      'model UserCourse {',
      'model UserLesson {',
      'model UserLessonStep {',
      'model UserCoursePlayProgress {',
      'model UserLessonPlayProgress {',
    ])('в схеме объявлена «%s»', (decl) => {
      expect(schema).toContain(decl);
    });
  });

  describe('User: back-relation поля', () => {
    // Извлекаем блок модели User, чтобы не матчить случайные вхождения
    // в комментариях/других моделях.
    const userBlock = extractModelBlock(schema, 'User');

    it.each([
      'userCourses            UserCourse[]',
      'userCoursePlayProgress UserCoursePlayProgress[]',
      'userLessonPlayProgress UserLessonPlayProgress[]',
    ])('в User объявлен relation «%s»', (line) => {
      expect(userBlock).toContain(line);
    });
  });

  describe('каскадный delete', () => {
    // Формат assertion'а: ищем точную строку relation'а с `onDelete: Cascade`,
    // так падение теста сразу покажет, что конкретно сломалось.

    it('UserCourse.owner → User: onDelete Cascade', () => {
      const block = extractModelBlock(schema, 'UserCourse');
      expect(block).toMatch(/owner\s+User\s+@relation\(fields: \[ownerId\], references: \[id\], onDelete: Cascade\)/);
    });

    it('UserLesson.course → UserCourse: onDelete Cascade', () => {
      const block = extractModelBlock(schema, 'UserLesson');
      expect(block).toMatch(/course\s+UserCourse\s+@relation\(fields: \[userCourseId\], references: \[id\], onDelete: Cascade\)/);
    });

    it('UserLessonStep.lesson → UserLesson: onDelete Cascade', () => {
      const block = extractModelBlock(schema, 'UserLessonStep');
      expect(block).toMatch(/lesson\s+UserLesson\s+@relation\(fields: \[userLessonId\], references: \[id\], onDelete: Cascade\)/);
    });

    it('UserCoursePlayProgress: каскад и от User, и от UserCourse', () => {
      const block = extractModelBlock(schema, 'UserCoursePlayProgress');
      expect(block).toMatch(/user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/);
      expect(block).toMatch(/course\s+UserCourse\s+@relation\(fields: \[userCourseId\], references: \[id\], onDelete: Cascade\)/);
    });

    it('UserLessonPlayProgress: каскад и от User, и от UserLesson', () => {
      const block = extractModelBlock(schema, 'UserLessonPlayProgress');
      expect(block).toMatch(/user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/);
      expect(block).toMatch(/lesson\s+UserLesson\s+@relation\(fields: \[userLessonId\], references: \[id\], onDelete: Cascade\)/);
    });
  });

  describe('индексы и уникальные constraints', () => {
    it('UserCourse.slug уникален', () => {
      const block = extractModelBlock(schema, 'UserCourse');
      expect(block).toMatch(/slug\s+String\s+@unique/);
    });

    it('UserCourse имеет индекс (ownerId, isPublic)', () => {
      const block = extractModelBlock(schema, 'UserCourse');
      expect(block).toContain('@@index([ownerId, isPublic])');
    });

    it('UserLesson имеет индекс (userCourseId, order)', () => {
      const block = extractModelBlock(schema, 'UserLesson');
      expect(block).toContain('@@index([userCourseId, order])');
    });

    it('UserLessonStep имеет индекс (userLessonId, order)', () => {
      const block = extractModelBlock(schema, 'UserLessonStep');
      expect(block).toContain('@@index([userLessonId, order])');
    });

    it('UserCoursePlayProgress: unique (userId, userCourseId)', () => {
      const block = extractModelBlock(schema, 'UserCoursePlayProgress');
      expect(block).toContain('@@unique([userId, userCourseId])');
    });

    it('UserLessonPlayProgress: unique (userId, userLessonId)', () => {
      const block = extractModelBlock(schema, 'UserLessonPlayProgress');
      expect(block).toContain('@@unique([userId, userLessonId])');
    });
  });

  describe('поля прогресса', () => {
    it('UserCoursePlayProgress содержит completedLessonsCount / lastActivityAt', () => {
      const block = extractModelBlock(schema, 'UserCoursePlayProgress');
      expect(block).toMatch(/completedLessonsCount\s+Int/);
      expect(block).toMatch(/lastActivityAt\s+DateTime/);
    });

    it('UserLessonPlayProgress содержит completedStepsCount / totalSteps / lastActivityAt', () => {
      const block = extractModelBlock(schema, 'UserLessonPlayProgress');
      expect(block).toMatch(/completedStepsCount\s+Int/);
      expect(block).toMatch(/totalSteps\s+Int/);
      expect(block).toMatch(/lastActivityAt\s+DateTime/);
    });
  });

  describe('миграция SQL', () => {
    const migrationSql = readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'prisma', 'migrations', '20260424150454_add_user_courses', 'migration.sql'),
      'utf-8',
    );

    it('FK user_lessons → user_courses создан с ON DELETE CASCADE', () => {
      expect(migrationSql).toMatch(/user_lessons_user_course_id_fkey.*ON DELETE CASCADE/s);
    });

    it('FK user_lesson_steps → user_lessons создан с ON DELETE CASCADE', () => {
      expect(migrationSql).toMatch(/user_lesson_steps_user_lesson_id_fkey.*ON DELETE CASCADE/s);
    });

    it('FK user_courses → users создан с ON DELETE CASCADE', () => {
      expect(migrationSql).toMatch(/user_courses_owner_id_fkey.*ON DELETE CASCADE/s);
    });
  });
});

/**
 * Достаёт тело конкретной модели из schema.prisma, начиная с строки
 * `model <name> {` и до первой закрывающей скобки на уровне модели.
 * Примитивный, но достаточный парсер — Prisma не вкладывает модели.
 */
function extractModelBlock(schema: string, modelName: string): string {
  const start = schema.indexOf(`model ${modelName} {`);
  if (start < 0) throw new Error(`model ${modelName} not found in schema`);
  const end = schema.indexOf('\n}', start);
  if (end < 0) throw new Error(`closing brace for model ${modelName} not found`);
  return schema.slice(start, end + 2);
}
