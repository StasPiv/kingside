/**
 * Unit-тесты `LessonAssistantTools` (KS-3207 / ADR-074 §10 B3).
 *
 * Покрытие:
 *   1. create_user_course → courses.create(userId, { title, description }).
 *   2. create_user_lesson → courses.addLesson(userId, courseId, body).
 *   3. create_user_lesson_step (text/quiz happy paths) → lessons.addStep.
 *   4. Запрещённые типы (puzzle/game/endgame_drill) → 400 BadRequest.
 *   5. text > 4000 символов — отсечётся DTO-валидатором (тест через
 *      `assistant-registry` подключит validation; здесь — прямой вызов
 *      сервиса с уже валидированным DTO, проверка лимита через
 *      class-validator живёт в registry.spec).
 *   6. Лимит «≤10 шагов через assistant» — owner-check + step count.
 *   7. Чужой урок / курс → 403.
 *   8. get_user_course_url — owner-check, URL формируется из SITE_URL.
 */

import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LessonAssistantTools,
  ASSISTANT_STEPS_PER_LESSON_MAX,
} from './lesson-assistant-tools.service';
import type { UserCoursesService } from './user-courses.service';
import type { UserLessonsService } from './user-lessons.service';
import type { PrismaService } from '../../prisma/prisma.service';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const STRANGER_ID = '00000000-0000-4000-a000-000000000002';
const COURSE_ID = '00000000-0000-4000-a000-000000000010';
const LESSON_ID = '00000000-0000-4000-a000-000000000020';
const STEP_ID = '00000000-0000-4000-a000-000000000030';

function makeTools(overrides: {
  lesson?: { ownerId: string; stepCount: number } | null;
  course?: { ownerId: string; slug: string } | null;
} = {}): {
  tools: LessonAssistantTools;
  coursesMock: jest.Mocked<UserCoursesService>;
  lessonsMock: jest.Mocked<UserLessonsService>;
} {
  const lesson = overrides.lesson;
  const course = overrides.course;

  const prisma = {
    lesson: {
      findUnique: jest.fn().mockImplementation(() =>
        lesson === undefined
          ? null
          : lesson === null
            ? null
            : {
                ownerId: lesson.ownerId,
                _count: { steps: lesson.stepCount },
              },
      ),
    },
    course: {
      findUnique: jest.fn().mockImplementation(() =>
        course === undefined ? null : course,
      ),
    },
  } as unknown as PrismaService;

  const coursesMock = {
    create: jest
      .fn()
      .mockResolvedValue({ id: COURSE_ID, slug: 'my-course', title: 'Hello' }),
    addLesson: jest.fn().mockResolvedValue({
      id: LESSON_ID,
      title: 'Lesson 1',
      order: 0,
    }),
  } as unknown as jest.Mocked<UserCoursesService>;

  const lessonsMock = {
    addStep: jest
      .fn()
      .mockResolvedValue({ id: STEP_ID, type: 'text', order: 0 }),
  } as unknown as jest.Mocked<UserLessonsService>;

  const config: ConfigService = {
    get: (key: string, def?: string) =>
      key === 'SITE_URL' ? 'https://kingside.site/' : def ?? '',
  } as unknown as ConfigService;

  const tools = new LessonAssistantTools(
    prisma,
    coursesMock,
    lessonsMock,
    config,
  );
  return { tools, coursesMock, lessonsMock };
}

describe('LessonAssistantTools (KS-3207)', () => {
  describe('create_user_course', () => {
    it('делегирует в UserCoursesService.create с userId', async () => {
      const { tools, coursesMock } = makeTools();
      const out = await tools.createUserCourse(
        { title: 'Hello', description: 'Desc' } as any,
        { user: { id: USER_ID } },
      );
      expect(coursesMock.create).toHaveBeenCalledWith(USER_ID, {
        title: 'Hello',
        description: 'Desc',
      });
      expect(out).toEqual({ id: COURSE_ID, slug: 'my-course', title: 'Hello' });
    });
  });

  describe('create_user_lesson', () => {
    it('делегирует в UserCoursesService.addLesson', async () => {
      const { tools, coursesMock } = makeTools();
      await tools.createUserLesson(
        { courseId: COURSE_ID, title: 'Lesson 1', estMinutes: 15 } as any,
        { user: { id: USER_ID } },
      );
      expect(coursesMock.addLesson).toHaveBeenCalledWith(USER_ID, COURSE_ID, {
        title: 'Lesson 1',
        estMinutes: 15,
      });
    });
  });

  describe('create_user_lesson_step (text)', () => {
    it('happy path: создаёт text-шаг', async () => {
      const { tools, lessonsMock } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 3 },
      });
      const out = await tools.createUserLessonStep(
        {
          lessonId: LESSON_ID,
          type: 'text',
          bodyMarkdown: '# Header\nHello',
        } as any,
        { user: { id: USER_ID } },
      );
      expect(lessonsMock.addStep).toHaveBeenCalledWith(
        LESSON_ID,
        {
          type: 'text',
          payload: { type: 'text', bodyMarkdown: '# Header\nHello' },
        },
        USER_ID,
      );
      expect(out).toMatchObject({ id: STEP_ID, type: 'text' });
    });

    it('пустой bodyMarkdown → 400', async () => {
      const { tools } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 0 },
      });
      await expect(
        tools.createUserLessonStep(
          { lessonId: LESSON_ID, type: 'text', bodyMarkdown: '' } as any,
          { user: { id: USER_ID } },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('create_user_lesson_step (quiz)', () => {
    it('happy path: 1 вопрос × 2 опции', async () => {
      const { tools, lessonsMock } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 1 },
      });
      await tools.createUserLessonStep(
        {
          lessonId: LESSON_ID,
          type: 'quiz',
          questions: [
            {
              id: 'q1',
              prompt: 'Best move?',
              options: [
                { id: 'a', label: 'e4' },
                { id: 'b', label: 'd4' },
              ],
              correctOptionIds: ['a'],
            },
          ],
        } as any,
        { user: { id: USER_ID } },
      );
      const call = (lessonsMock.addStep as jest.Mock).mock.calls[0];
      expect(call[0]).toBe(LESSON_ID);
      expect(call[1].type).toBe('quiz');
      expect(call[1].payload.questions).toHaveLength(1);
    });

    it('correctOptionId не существует в options → 400', async () => {
      const { tools } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 1 },
      });
      await expect(
        tools.createUserLessonStep(
          {
            lessonId: LESSON_ID,
            type: 'quiz',
            questions: [
              {
                id: 'q1',
                prompt: '?',
                options: [
                  { id: 'a', label: 'A' },
                  { id: 'b', label: 'B' },
                ],
                correctOptionIds: ['z'],
              },
            ],
          } as any,
          { user: { id: USER_ID } },
        ),
      ).rejects.toThrow(/correctOptionId/);
    });

    it('single-answer quiz без multi → ровно один correctOptionId', async () => {
      const { tools } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 1 },
      });
      await expect(
        tools.createUserLessonStep(
          {
            lessonId: LESSON_ID,
            type: 'quiz',
            questions: [
              {
                id: 'q1',
                prompt: '?',
                options: [
                  { id: 'a', label: 'A' },
                  { id: 'b', label: 'B' },
                ],
                correctOptionIds: ['a', 'b'],
              },
            ],
          } as any,
          { user: { id: USER_ID } },
        ),
      ).rejects.toThrow(/single-answer/);
    });
  });

  describe('запрещённые типы шагов', () => {
    it.each(['puzzle', 'game', 'endgame_drill', 'video', 'drill'])(
      "type='%s' → 400 BadRequest",
      async (type) => {
        const { tools } = makeTools({
          lesson: { ownerId: USER_ID, stepCount: 0 },
        });
        await expect(
          tools.createUserLessonStep(
            { lessonId: LESSON_ID, type } as any,
            { user: { id: USER_ID } },
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );
  });

  describe('owner-check / лимит шагов', () => {
    it('чужой урок → 403', async () => {
      const { tools } = makeTools({
        lesson: { ownerId: STRANGER_ID, stepCount: 0 },
      });
      await expect(
        tools.createUserLessonStep(
          {
            lessonId: LESSON_ID,
            type: 'text',
            bodyMarkdown: 'hi',
          } as any,
          { user: { id: USER_ID } },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lessonId не найден → 404', async () => {
      const { tools } = makeTools({ lesson: null });
      await expect(
        tools.createUserLessonStep(
          {
            lessonId: LESSON_ID,
            type: 'text',
            bodyMarkdown: 'hi',
          } as any,
          { user: { id: USER_ID } },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it(`≥${ASSISTANT_STEPS_PER_LESSON_MAX} шагов в уроке → 400`, async () => {
      const { tools } = makeTools({
        lesson: {
          ownerId: USER_ID,
          stepCount: ASSISTANT_STEPS_PER_LESSON_MAX,
        },
      });
      await expect(
        tools.createUserLessonStep(
          {
            lessonId: LESSON_ID,
            type: 'text',
            bodyMarkdown: 'hi',
          } as any,
          { user: { id: USER_ID } },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('get_user_course_url', () => {
    it('owner получает URL', async () => {
      const { tools } = makeTools({
        course: { ownerId: USER_ID, slug: 'my-course' },
      });
      const out = await tools.getUserCourseUrl(
        { courseId: COURSE_ID } as any,
        { user: { id: USER_ID } },
      );
      expect(out).toEqual({
        slug: 'my-course',
        url: 'https://kingside.site/lessons/courses/my-course',
      });
    });

    it('чужой курс → 403', async () => {
      const { tools } = makeTools({
        course: { ownerId: STRANGER_ID, slug: 'their' },
      });
      await expect(
        tools.getUserCourseUrl(
          { courseId: COURSE_ID } as any,
          { user: { id: USER_ID } },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('курс не найден → 404', async () => {
      const { tools } = makeTools({ course: null });
      await expect(
        tools.getUserCourseUrl(
          { courseId: COURSE_ID } as any,
          { user: { id: USER_ID } },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
