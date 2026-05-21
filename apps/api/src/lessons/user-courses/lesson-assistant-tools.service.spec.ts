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
  lesson?: { ownerId: string; stepCount: number; puzzleStepCount?: number } | null;
  course?: { ownerId: string; slug: string } | null;
  redisIncrSeq?: number[];
  puzzleSearch?: Array<{
    id: string;
    fen: string;
    moves: string[];
    themes: string[];
    rating: number | null;
  }>;
} = {}): {
  tools: LessonAssistantTools;
  coursesMock: jest.Mocked<UserCoursesService>;
  lessonsMock: jest.Mocked<UserLessonsService>;
  prismaMock: PrismaService;
  redisMock: { incr: jest.Mock; expire: jest.Mock; ttl: jest.Mock };
  puzzlesMock: { findPuzzles: jest.Mock };
  analysesMock: { findAll: jest.Mock };
} {
  const lesson = overrides.lesson;
  const course = overrides.course;

  const aiCreate = jest.fn().mockResolvedValue({ id: 'gen-1' });
  const aiUpdate = jest.fn().mockResolvedValue({});
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
                // KS-3221: puzzle path requests `steps: { where: type='puzzle' }`.
                steps: Array.from(
                  { length: lesson.puzzleStepCount ?? 0 },
                  (_, i) => ({ id: `puzzle-step-${i}` }),
                ),
              },
      ),
    },
    course: {
      findUnique: jest.fn().mockImplementation(() =>
        course === undefined ? null : course,
      ),
    },
    aiLessonGeneration: {
      create: aiCreate,
      update: aiUpdate,
    },
  } as unknown as PrismaService;

  // KS-3208: rate-limit поверх Redis. По умолчанию INCR возвращает
  // последовательно 1, 2, 3... — лимит не превышен. Тест 429 подаёт
  // последовательность, где последнее значение > maxRequests.
  const seq = overrides.redisIncrSeq ?? [1, 2, 3, 4, 5];
  let incrCallIdx = 0;
  const redisMock = {
    incr: jest.fn().mockImplementation(() => {
      const val = seq[Math.min(incrCallIdx, seq.length - 1)] ?? 1;
      incrCallIdx += 1;
      return Promise.resolve(val);
    }),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(3600),
  };

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
    addStep: jest.fn().mockImplementation((_lessonId, body) =>
      Promise.resolve({
        id: STEP_ID,
        type: body?.type ?? 'text',
        order: 0,
      }),
    ),
  } as unknown as jest.Mocked<UserLessonsService>;

  const config: ConfigService = {
    get: (key: string, def?: string) =>
      key === 'SITE_URL' ? 'https://kingside.site/' : def ?? '',
  } as unknown as ConfigService;

  // KS-3221: PuzzleService mock для find_puzzles_preview / add_puzzle_step_filter.
  const puzzlesMock = {
    findPuzzles: jest.fn().mockResolvedValue(overrides.puzzleSearch ?? []),
  } as any;

  // KS-3224: AnalysisService mock для list_my_analyses.
  const analysesMock = {
    findAll: jest.fn().mockResolvedValue([]),
  } as any;

  const tools = new LessonAssistantTools(
    prisma,
    coursesMock,
    lessonsMock,
    config,
    redisMock as any,
    puzzlesMock,
    analysesMock,
  );
  return {
    tools,
    coursesMock,
    lessonsMock,
    prismaMock: prisma,
    redisMock,
    puzzlesMock,
    analysesMock,
  };
}

describe('LessonAssistantTools (KS-3207)', () => {
  describe('create_user_course', () => {
    it('делегирует в UserCoursesService.create с userId', async () => {
      const { tools, coursesMock } = makeTools();
      const out = await tools.createUserCourse(
        { title: 'Hello', description: 'Desc' } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      expect(coursesMock.create).toHaveBeenCalledWith(USER_ID, {
        title: 'Hello',
        description: 'Desc',
      });
      expect(out).toEqual({ id: COURSE_ID, slug: 'my-course', title: 'Hello' });
    });

    // KS-3208: audit-журнал + rate-limit.
    it('пишет ai_lesson_generations pending → created при успехе', async () => {
      const { tools, prismaMock } = makeTools();
      await tools.createUserCourse(
        { title: 'Hello' } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      const aiCreate = (prismaMock as any).aiLessonGeneration.create as jest.Mock;
      const aiUpdate = (prismaMock as any).aiLessonGeneration.update as jest.Mock;
      expect(aiCreate).toHaveBeenCalledWith({
        data: {
          userId: USER_ID,
          planJson: { title: 'Hello' },
          status: 'pending',
        },
        select: { id: true },
      });
      expect(aiUpdate).toHaveBeenCalledWith({
        where: { id: 'gen-1' },
        data: { status: 'created', createdCourseId: COURSE_ID },
      });
    });

    it('пишет failed + error при ошибке UserCoursesService.create', async () => {
      const { tools, coursesMock, prismaMock } = makeTools();
      (coursesMock.create as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      await expect(
        tools.createUserCourse(
          { title: 'Hello' } as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toThrow('boom');
      const aiUpdate = (prismaMock as any).aiLessonGeneration.update as jest.Mock;
      expect(aiUpdate).toHaveBeenCalledWith({
        where: { id: 'gen-1' },
        data: { status: 'failed', error: 'boom' },
      });
    });

    it('6-й вызов в окне → 429 TOO_MANY_REQUESTS, аудит не пишется', async () => {
      const { tools, prismaMock, coursesMock } = makeTools({
        redisIncrSeq: [6], // первый же incr вернёт 6 > 5
      });
      let thrown: any;
      try {
        await tools.createUserCourse(
          { title: 'Hello' } as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        );
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
      expect(thrown.getStatus()).toBe(429);
      const aiCreate = (prismaMock as any).aiLessonGeneration.create as jest.Mock;
      // 429 ДО создания audit-записи и до вызова сервиса.
      expect(aiCreate).not.toHaveBeenCalled();
      expect(coursesMock.create).not.toHaveBeenCalled();
    });

    it('5-й вызов в окне ещё проходит (граница включительно)', async () => {
      const { tools } = makeTools({ redisIncrSeq: [5] });
      await expect(
        tools.createUserCourse(
          { title: 'Hello' } as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('create_user_lesson', () => {
    it('делегирует в UserCoursesService.addLesson', async () => {
      const { tools, coursesMock } = makeTools();
      await tools.createUserLesson(
        { courseId: COURSE_ID, title: 'Lesson 1', estMinutes: 15 } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
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
        { user: { id: USER_ID, username: 'tester' } } as any,
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
          { user: { id: USER_ID, username: 'tester' } } as any,
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
        { user: { id: USER_ID, username: 'tester' } } as any,
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
          { user: { id: USER_ID, username: 'tester' } } as any,
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
          { user: { id: USER_ID, username: 'tester' } } as any,
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
            { user: { id: USER_ID, username: 'tester' } } as any,
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
          { user: { id: USER_ID, username: 'tester' } } as any,
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
          { user: { id: USER_ID, username: 'tester' } } as any,
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
          { user: { id: USER_ID, username: 'tester' } } as any,
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
        { user: { id: USER_ID, username: 'tester' } } as any,
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
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('курс не найден → 404', async () => {
      const { tools } = makeTools({ course: null });
      await expect(
        tools.getUserCourseUrl(
          { courseId: COURSE_ID } as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── KS-3221 / ADR-075 §7 B1 ─────────────────────────────────────

  describe('add_puzzle_step_filter (KS-3221)', () => {
    const baseInput = {
      lessonId: LESSON_ID,
      themes: ['fork'],
      limit: 6,
    };

    it('создаёт puzzle-шаг с mode=filter; payload включает themes/limit', async () => {
      const { tools, lessonsMock } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 0, puzzleStepCount: 2 },
      });
      const out = await tools.addPuzzleStepFilter(
        { ...baseInput, ratingMin: 1200, ratingMax: 1800 } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      const call = (lessonsMock.addStep as jest.Mock).mock.calls[0];
      expect(call[0]).toBe(LESSON_ID);
      expect(call[1].type).toBe('puzzle');
      expect(call[1].payload).toMatchObject({
        type: 'puzzle',
        selection: {
          mode: 'filter',
          themes: ['fork'],
          limit: 6,
          ratingMin: 1200,
          ratingMax: 1800,
        },
      });
      expect(call[2]).toBe(USER_ID);
      expect(out).toMatchObject({
        id: STEP_ID,
        lessonId: LESSON_ID,
        themes: ['fork'],
        limit: 6,
      });
    });

    it('instruction (опц.) попадает в payload.instruction', async () => {
      const { tools, lessonsMock } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      await tools.addPuzzleStepFilter(
        { ...baseInput, instruction: 'Найди вилку коня' } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      const payload = (lessonsMock.addStep as jest.Mock).mock.calls[0][1]
        .payload;
      expect(payload.instruction).toBe('Найди вилку коня');
    });

    it('чужой урок → 403', async () => {
      const { tools } = makeTools({
        lesson: { ownerId: STRANGER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      await expect(
        tools.addPuzzleStepFilter(
          baseInput as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('урок не найден → 404', async () => {
      const { tools } = makeTools({ lesson: null });
      await expect(
        tools.addPuzzleStepFilter(
          baseInput as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('≥15 puzzle-шагов в уроке → 400', async () => {
      const { tools } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 0, puzzleStepCount: 15 },
      });
      await expect(
        tools.addPuzzleStepFilter(
          baseInput as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ratingMin > ratingMax → 400', async () => {
      const { tools } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      await expect(
        tools.addPuzzleStepFilter(
          { ...baseInput, ratingMin: 1800, ratingMax: 1200 } as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── KS-3223 / ADR-075 §7 B3 — validate_fen + diagrams hook ─────

  describe('validate_fen (KS-3223)', () => {
    const VALID_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const VALID_WHITE_UP = '8/8/8/8/8/8/4P3/4K2k w - - 0 1';

    it('начальная позиция → valid, sideToMove=white, materialBalance=0', async () => {
      const { tools } = makeTools();
      const out = await tools.validateFen(
        { fen: VALID_START } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      expect(out.valid).toBe(true);
      expect(out.sideToMove).toBe('white');
      expect(out.materialBalance).toBe(0);
      expect(out.piecesByColor!.white.p).toBe(8);
      expect(out.piecesByColor!.black.p).toBe(8);
    });

    it('эндшпиль K+P vs K → materialBalance=1 в пользу белых', async () => {
      const { tools } = makeTools();
      const out = await tools.validateFen(
        { fen: VALID_WHITE_UP } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      expect(out.valid).toBe(true);
      expect(out.materialBalance).toBe(1);
    });

    it('невалидный FEN → valid=false + error', async () => {
      const { tools } = makeTools();
      const out = await tools.validateFen(
        { fen: 'totally not a fen' } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      expect(out.valid).toBe(false);
      expect(out.error).toBeTruthy();
    });
  });

  describe('text-step diagrams server-side hook (KS-3223)', () => {
    const VALID_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const INVALID_FEN = 'garbage';

    it('валидные diagrams → попадают в payload.diagrams', async () => {
      const { tools, lessonsMock } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      await tools.createUserLessonStep(
        {
          lessonId: LESSON_ID,
          type: 'text',
          bodyMarkdown: '# Начальная позиция',
          diagrams: [
            { fen: VALID_FEN, caption: 'старт', orientation: 'white' },
            { fen: VALID_FEN },
          ],
        } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      const payload = (lessonsMock.addStep as jest.Mock).mock.calls[0][1].payload;
      expect(payload.type).toBe('text');
      expect(payload.diagrams).toHaveLength(2);
      expect(payload.diagrams[0]).toEqual({
        fen: VALID_FEN,
        caption: 'старт',
        orientation: 'white',
      });
      expect(payload.diagrams[1]).toEqual({ fen: VALID_FEN });
    });

    it('невалидный FEN в diagrams → BadRequest, addStep НЕ вызывается', async () => {
      const { tools, lessonsMock } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      await expect(
        tools.createUserLessonStep(
          {
            lessonId: LESSON_ID,
            type: 'text',
            bodyMarkdown: '# bad',
            diagrams: [{ fen: INVALID_FEN }],
          } as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(lessonsMock.addStep).not.toHaveBeenCalled();
    });

    it('пустой diagrams (или отсутствует) → payload без поля diagrams', async () => {
      const { tools, lessonsMock } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      await tools.createUserLessonStep(
        {
          lessonId: LESSON_ID,
          type: 'text',
          bodyMarkdown: '# no diagrams',
        } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      const payload = (lessonsMock.addStep as jest.Mock).mock.calls[0][1].payload;
      expect(payload.diagrams).toBeUndefined();
    });
  });

  // ─── KS-3224 / ADR-075 §7 B4 — game-step инструменты ───────────

  describe('list_my_analyses (KS-3224)', () => {
    it('делегирует в AnalysisService.findAll с search/limit', async () => {
      const { tools, analysesMock } = makeTools();
      (analysesMock.findAll as jest.Mock).mockResolvedValueOnce([
        {
          id: 'a1', title: 'My Game', headline: 'Fischer 1-0 Spassky',
          opening: 'Sicilian', event: 'WCC', white: 'Fischer', black: 'Spassky',
          result: '1-0', createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);
      const out = await tools.listMyAnalyses(
        { search: 'Fischer', limit: 5 } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      expect(analysesMock.findAll).toHaveBeenCalledWith(USER_ID, {
        limit: 5,
        offset: 0,
        withPgn: false,
        search: 'Fischer',
      });
      expect(out.analyses).toHaveLength(1);
      expect(out.analyses[0]).toMatchObject({
        id: 'a1',
        title: 'My Game',
        white: 'Fischer',
        black: 'Spassky',
        result: '1-0',
      });
      expect(out.analyses[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('limit по умолчанию = 10', async () => {
      const { tools, analysesMock } = makeTools();
      await tools.listMyAnalyses(
        {} as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      expect(analysesMock.findAll).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ limit: 10 }),
      );
    });
  });

  describe('add_game_step_from_analysis (KS-3224)', () => {
    const ANALYSIS_ID = '00000000-0000-4000-a000-000000000050';
    const baseInput = { lessonId: LESSON_ID, analysisId: ANALYSIS_ID };

    it('создаёт game-шаг с sourceType=workshop_analysis + analysisId', async () => {
      const { tools, lessonsMock } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      const out = await tools.addGameStepFromAnalysis(
        { ...baseInput, instruction: 'Разбери эту партию' } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      const call = (lessonsMock.addStep as jest.Mock).mock.calls[0];
      expect(call[0]).toBe(LESSON_ID);
      expect(call[1].type).toBe('game');
      expect(call[1].payload).toMatchObject({
        type: 'game',
        sourceType: 'workshop_analysis',
        analysisId: ANALYSIS_ID,
        instruction: 'Разбери эту партию',
      });
      expect(call[2]).toBe(USER_ID);
      expect(out).toMatchObject({ id: STEP_ID, lessonId: LESSON_ID, type: 'game' });
    });

    it('чужой урок → 403', async () => {
      const { tools } = makeTools({
        lesson: { ownerId: STRANGER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      await expect(
        tools.addGameStepFromAnalysis(
          baseInput as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('урок не найден → 404', async () => {
      const { tools } = makeTools({ lesson: null });
      await expect(
        tools.addGameStepFromAnalysis(
          baseInput as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('add_game_step_from_pgn (KS-3224)', () => {
    const PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6';
    const baseInput = { lessonId: LESSON_ID, pgn: PGN };

    it('создаёт game-шаг с sourceType=pgn + inline PGN + meta', async () => {
      const { tools, lessonsMock } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      await tools.addGameStepFromPgn(
        {
          ...baseInput,
          meta: { white: 'Fischer', black: 'Spassky', result: '1-0' },
          instruction: 'Просто посмотри',
        } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      const payload = (lessonsMock.addStep as jest.Mock).mock.calls[0][1]
        .payload;
      expect(payload).toMatchObject({
        type: 'game',
        sourceType: 'pgn',
        pgn: PGN,
        meta: { white: 'Fischer', black: 'Spassky', result: '1-0' },
        instruction: 'Просто посмотри',
      });
    });

    it('без meta — поле отсутствует в payload', async () => {
      const { tools, lessonsMock } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      await tools.addGameStepFromPgn(
        baseInput as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      const payload = (lessonsMock.addStep as jest.Mock).mock.calls[0][1]
        .payload;
      expect(payload.meta).toBeUndefined();
      expect(payload.instruction).toBeUndefined();
    });

    it('чужой урок → 403', async () => {
      const { tools } = makeTools({
        lesson: { ownerId: STRANGER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      await expect(
        tools.addGameStepFromPgn(
          baseInput as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── KS-3225 / ADR-075 §7 B5 — add_tactical_drill_step ──────────

  describe('add_tactical_drill_step (KS-3225)', () => {
    const base = { lessonId: LESSON_ID, drillType: 'find-fork', count: 3 };

    it('создаёт drill-шаг с drillType + count (без bucket)', async () => {
      const { tools, lessonsMock } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      const out = await tools.addTacticalDrillStep(
        base as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      const call = (lessonsMock.addStep as jest.Mock).mock.calls[0];
      expect(call[0]).toBe(LESSON_ID);
      expect(call[1].type).toBe('drill');
      expect(call[1].payload).toMatchObject({
        type: 'drill',
        drillType: 'find-fork',
        count: 3,
      });
      expect(call[1].payload.difficultyBucket).toBeUndefined();
      expect(call[2]).toBe(USER_ID);
      expect(out).toMatchObject({
        id: STEP_ID,
        lessonId: LESSON_ID,
        type: 'drill',
        drillType: 'find-fork',
      });
    });

    it('bucket попадает в payload.difficultyBucket', async () => {
      const { tools, lessonsMock } = makeTools({
        lesson: { ownerId: USER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      await tools.addTacticalDrillStep(
        { ...base, bucket: 'easy', instruction: 'Найди вилку!' } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      const payload = (lessonsMock.addStep as jest.Mock).mock.calls[0][1]
        .payload;
      expect(payload.difficultyBucket).toBe('easy');
      expect(payload.instruction).toBe('Найди вилку!');
    });

    it('чужой урок → 403', async () => {
      const { tools } = makeTools({
        lesson: { ownerId: STRANGER_ID, stepCount: 0, puzzleStepCount: 0 },
      });
      await expect(
        tools.addTacticalDrillStep(
          base as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('урок не найден → 404', async () => {
      const { tools } = makeTools({ lesson: null });
      await expect(
        tools.addTacticalDrillStep(
          base as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('find_puzzles_preview (KS-3221)', () => {
    const baseInput = { themes: ['fork'], limit: 3 };

    it('возвращает примеры без записи в БД (lessons.addStep не дёргается)', async () => {
      const { tools, lessonsMock, puzzlesMock } = makeTools({
        puzzleSearch: [
          {
            id: 'p1',
            fen: '8/8/8/8/8/8/PPP5/K7 w - - 0 1',
            moves: ['a2a4', 'a7a5'],
            themes: ['fork', 'middlegame'],
            rating: 1450,
          },
          {
            id: 'p2',
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            moves: ['e2e4', 'e7e5'],
            themes: ['fork', 'opening'],
            rating: 1500,
          },
        ],
      });
      const out = await tools.findPuzzlesPreview(
        baseInput as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      expect(lessonsMock.addStep).not.toHaveBeenCalled();
      expect(puzzlesMock.findPuzzles).toHaveBeenCalledWith(
        expect.objectContaining({
          themes: ['fork'],
          limit: 3,
          orderBy: 'random',
          solutionMode: 'forced-line',
        }),
      );
      expect(out.puzzles).toHaveLength(2);
      expect(out.puzzles[0]).toEqual({
        puzzleId: 'p1',
        fen: '8/8/8/8/8/8/PPP5/K7 w - - 0 1',
        bestMove: 'a2a4',
        themes: ['fork', 'middlegame'],
        rating: 1450,
      });
      expect(out.appliedFilter).toMatchObject({
        themes: ['fork'],
        limit: 3,
      });
    });

    it('ratingMin/Max прокидываются в PuzzleService.findPuzzles', async () => {
      const { tools, puzzlesMock } = makeTools();
      await tools.findPuzzlesPreview(
        { ...baseInput, ratingMin: 1300, ratingMax: 1600 } as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      expect(puzzlesMock.findPuzzles).toHaveBeenCalledWith(
        expect.objectContaining({ ratingMin: 1300, ratingMax: 1600 }),
      );
    });

    it('ratingMin > ratingMax → 400 (без вызова PuzzleService)', async () => {
      const { tools, puzzlesMock } = makeTools();
      await expect(
        tools.findPuzzlesPreview(
          { ...baseInput, ratingMin: 1800, ratingMax: 1200 } as any,
          { user: { id: USER_ID, username: 'tester' } } as any,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(puzzlesMock.findPuzzles).not.toHaveBeenCalled();
    });

    it('пустой результат пазлов → puzzles=[]', async () => {
      const { tools } = makeTools({ puzzleSearch: [] });
      const out = await tools.findPuzzlesPreview(
        baseInput as any,
        { user: { id: USER_ID, username: 'tester' } } as any,
      );
      expect(out.puzzles).toEqual([]);
    });
  });
});
