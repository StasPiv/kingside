/**
 * KS-3207 / ADR-074 §10 B3 — assistant-tools для пользовательских уроков.
 *
 * 4 tool'а, доступные AI-ассистенту через `McpAssistantRegistry`
 * (KS-3206). Это адаптеры поверх существующих `UserCoursesService` /
 * `UserLessonsService` со специфичной для ассистента валидацией
 * (хард-лимиты ADR-074 §10 B3) и whitelist'ом step-типов.
 *
 * Tools:
 *   - `create_user_course`         — создать курс под текущим юзером.
 *   - `create_user_lesson`         — добавить урок (owner-check).
 *   - `create_user_lesson_step`    — добавить text/quiz-шаг
 *     (только эти 2 типа; puzzle/game/endgame_drill запрещены 400).
 *   - `get_user_course_url`        — UI-ссылка на свой курс.
 *
 * Хард-лимиты (ADR-074 §10 B3, ужесточают ADR-026 / ADR-049):
 *   - text-шаг: `bodyMarkdown` ≤ `ASSISTANT_TEXT_BODY_MAX` (4000) символов.
 *   - quiz: 1–5 вопросов × 2–4 варианта.
 *   - В одном уроке через assistant — ≤ `ASSISTANT_STEPS_PER_LESSON_MAX`
 *     (10) шагов. Системный лимит ADR-026 (50) остаётся как floor —
 *     ассистенту даём более узкие границы, чтобы он не «накидывал»
 *     длинные курсы за один заход.
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../../common/authenticated-request';
import { McpTool } from '../../mcp/decorators';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { McpToolForAssistant } from '../../mcp/decorators';
import { PuzzleService } from '../../puzzle/puzzle.service';
import { UserCoursesService } from './user-courses.service';
import { UserLessonsService } from './user-lessons.service';

export const ASSISTANT_TEXT_BODY_MAX = 4000;
export const ASSISTANT_QUIZ_QUESTIONS_MIN = 1;
export const ASSISTANT_QUIZ_QUESTIONS_MAX = 5;
export const ASSISTANT_QUIZ_OPTIONS_MIN = 2;
export const ASSISTANT_QUIZ_OPTIONS_MAX = 4;
export const ASSISTANT_STEPS_PER_LESSON_MAX = 10;
export const ASSISTANT_ALLOWED_STEP_TYPES = ['text', 'quiz'] as const;
export type AssistantAllowedStepType =
  (typeof ASSISTANT_ALLOWED_STEP_TYPES)[number];

/**
 * KS-3208 / ADR-074 §10 B4. Лимит на создание курса через ассистента —
 * 5 курсов в час с одного userId. Системный `coursesPerUser=20`
 * (ADR-026) остаётся как страховка верхнего потолка.
 */
export const ASSISTANT_CREATE_COURSE_RATE_LIMIT = {
  maxRequests: 5,
  windowSec: 60 * 60,
} as const;

/**
 * KS-3221 / ADR-075 §7 B1. Хард-лимиты puzzle-инструментов ассистента:
 *  - в одном шаге `puzzle/filter` — ≤ `ASSISTANT_PUZZLE_LIMIT_MAX` пазлов;
 *  - в одном уроке ≤ `ASSISTANT_PUZZLE_STEPS_PER_LESSON_MAX` puzzle-шагов
 *    (отдельный потолок шире `create_user_lesson_step`-овых 10: тренировка
 *    с пазлами осмысленнее в наборах по 8-15 шт.);
 *  - 1-3 темы на фильтр;
 *  - preview ≤ `ASSISTANT_PUZZLE_PREVIEW_MAX` (показ без записи в БД).
 */
export const ASSISTANT_PUZZLE_THEMES_MIN = 1;
export const ASSISTANT_PUZZLE_THEMES_MAX = 3;
export const ASSISTANT_PUZZLE_LIMIT_MAX = 10;
export const ASSISTANT_PUZZLE_PREVIEW_MAX = 5;
export const ASSISTANT_PUZZLE_STEPS_PER_LESSON_MAX = 15;

/**
 * KS-3221 / ADR-075 §7 B1. Whitelist `PuzzleTheme`-значений (RUntime-
 * массив), который class-validator `@IsIn` применяет к каждому
 * элементу `themes[]`. Источник истины — `PuzzleTheme` union в
 * `packages/shared/src/types/puzzle.ts`. При расширении/удалении тем
 * в shared нужно обновлять этот массив (compile-time assertion в
 * spec проверяет покрытие основных тем).
 */
export const PUZZLE_THEME_WHITELIST: readonly string[] = [
  'advancedPawn', 'advantage', 'anapierce', 'arabianMate',
  'attackingF2F7', 'attraction', 'backRankMate', 'bishopEndgame',
  'bodenMate', 'capturingDefender', 'castling', 'clearance',
  'crushing', 'defensiveMove', 'deflection', 'discoveredAttack',
  'doubleBishopMate', 'doubleCheck', 'dovetailMate', 'enPassant',
  'endgame', 'equality', 'exposedKing', 'fork',
  'hangingPiece', 'hookMate', 'interference', 'intermezzo',
  'kingsideAttack', 'knightEndgame', 'long', 'master',
  'masterVsMaster', 'mate', 'mateIn1', 'mateIn2',
  'mateIn3', 'mateIn4', 'mateIn5', 'middlegame',
  'oneMove', 'opening', 'pawnEndgame', 'pin',
  'promotion', 'queenEndgame', 'queenRookEndgame', 'queensideAttack',
  'quietMove', 'rookEndgame', 'sacrifice', 'short',
  'skewer', 'smotheredMate', 'superGM', 'trappedPiece',
  'underPromotion', 'veryLong', 'xRayAttack', 'zugzwang',
] as const;

// ─── DTOs ────────────────────────────────────────────────────────────

export class CreateUserCourseAssistantInput {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CreateUserLessonAssistantInput {
  @IsUUID()
  courseId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  estMinutes?: number;
}

export class AssistantQuizOption {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  label!: string;
}

export class AssistantQuizQuestion {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  prompt!: string;

  @IsArray()
  @ArrayMinSize(ASSISTANT_QUIZ_OPTIONS_MIN)
  @ArrayMaxSize(ASSISTANT_QUIZ_OPTIONS_MAX)
  @ValidateNested({ each: true })
  @Type(() => AssistantQuizOption)
  options!: AssistantQuizOption[];

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  correctOptionIds!: string[];

  @IsOptional()
  @IsBoolean()
  multi?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  explanation?: string;
}

export class CreateUserLessonStepAssistantInput {
  @IsUUID()
  lessonId!: string;

  /**
   * Только `text` или `quiz` — других типов через ассистент создавать
   * нельзя (ADR-074 §10 B3). `puzzle`/`game`/`endgame_drill` валятся
   * здесь же на `@IsIn`, давая 400 с понятным сообщением.
   */
  @IsIn(ASSISTANT_ALLOWED_STEP_TYPES as unknown as string[])
  type!: AssistantAllowedStepType;

  // type='text':
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(ASSISTANT_TEXT_BODY_MAX)
  bodyMarkdown?: string;

  // type='quiz':
  @IsOptional()
  @IsArray()
  @ArrayMinSize(ASSISTANT_QUIZ_QUESTIONS_MIN)
  @ArrayMaxSize(ASSISTANT_QUIZ_QUESTIONS_MAX)
  @ValidateNested({ each: true })
  @Type(() => AssistantQuizQuestion)
  questions?: AssistantQuizQuestion[];
}

export class GetUserCourseUrlAssistantInput {
  @IsUUID()
  courseId!: string;
}

/**
 * KS-3221 / ADR-075 §7 B1. Input для `add_puzzle_step_filter` —
 * добавляет в урок шаг типа `puzzle` с режимом фильтра (themes + rating
 * range + limit). Сам список пазлов вычисляется фронтом на ходу при
 * прохождении шага через PuzzleService.findPuzzles.
 */
export class AddPuzzleStepFilterAssistantInput {
  @IsUUID()
  lessonId!: string;

  /**
   * 1-3 темы (из PuzzleTheme enum). Внутри puzzle.service строит
   * AND-условие — все темы должны присутствовать у пазла. Поэтому
   * слишком узкая комбинация может дать пустую выдачу; рекомендуем
   * модели брать 1-2 темы.
   */
  @IsArray()
  @ArrayMinSize(ASSISTANT_PUZZLE_THEMES_MIN)
  @ArrayMaxSize(ASSISTANT_PUZZLE_THEMES_MAX)
  @IsIn(PUZZLE_THEME_WHITELIST, { each: true })
  themes!: string[];

  @IsOptional()
  @IsInt()
  @Min(400)
  ratingMin?: number;

  @IsOptional()
  @IsInt()
  @Min(400)
  ratingMax?: number;

  @IsInt()
  @Min(1)
  @Max(ASSISTANT_PUZZLE_LIMIT_MAX)
  limit!: number;

  /**
   * Опциональный заголовок шага / вступительный текст. UI пока его
   * не использует (PuzzleStepPayload не содержит явного поля), но
   * храним в `payload.instruction` на будущее.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  instruction?: string;
}

/**
 * KS-3221 / ADR-075 §7 B1. Input для `find_puzzles_preview` — показывает
 * примеры пазлов без записи в БД. Лимит 1-5 (защита от token-bloat в
 * tool_result).
 */
export class FindPuzzlesPreviewAssistantInput {
  @IsArray()
  @ArrayMinSize(ASSISTANT_PUZZLE_THEMES_MIN)
  @ArrayMaxSize(ASSISTANT_PUZZLE_THEMES_MAX)
  @IsIn(PUZZLE_THEME_WHITELIST, { each: true })
  themes!: string[];

  @IsOptional()
  @IsInt()
  @Min(400)
  ratingMin?: number;

  @IsOptional()
  @IsInt()
  @Min(400)
  ratingMax?: number;

  @IsInt()
  @Min(1)
  @Max(ASSISTANT_PUZZLE_PREVIEW_MAX)
  limit!: number;
}

// ─── Tool controller ─────────────────────────────────────────────────
//
// KS-3213: класс теперь @Controller с HTTP-эндпоинтами под
// `/lessons/ai-tools/*`. Каждый метод помечен @McpTool, чтобы
// `McpDiscoveryService` (ADR-061) включил их в `/_mcp/tools` — оттуда
// внешний webhook-MCP-сервер забирает каталог tools для Anthropic.
// Параллельно сохранён @McpToolForAssistant — для in-process tool-loop
// в dev/локальном режиме (когда `AI_CHAT_WEBHOOK_URL` пуст, KS-3205).

@Controller('lessons/ai-tools')
@UseGuards(JwtAuthGuard)
export class LessonAssistantTools {
  private readonly logger = new Logger(LessonAssistantTools.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: UserCoursesService,
    private readonly lessons: UserLessonsService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly puzzles: PuzzleService,
  ) {}

  /**
   * KS-3208: ручная проверка rate-limit (декоратор `@UserRateLimit` —
   * для HTTP-роутов, а ассистент дёргает метод напрямую через
   * `McpAssistantRegistry`). Семантика идентична `UserRateLimitGuard`:
   * INCR + EXPIRE; превышение → 429 с `Retry-After`. Fail-open при
   * сбое Redis (логируем) — не валим UX из-за временного глюка кеша.
   */
  private async enforceAssistantRateLimit(
    userId: string,
    op: string,
    cfg: { maxRequests: number; windowSec: number },
  ): Promise<void> {
    const key = `ratelimit:assistant:${op}:${userId}`;
    try {
      const current = await this.redis.incr(key);
      if (current === 1) {
        await this.redis.expire(key, cfg.windowSec);
      }
      if (current > cfg.maxRequests) {
        let retryAfter = cfg.windowSec;
        try {
          const ttl = await this.redis.ttl(key);
          if (ttl > 0) retryAfter = ttl;
        } catch {
          /* fall through with windowSec */
        }
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `Assistant rate limit exceeded for '${op}' (max ${cfg.maxRequests} per ${cfg.windowSec}s)`,
            retryAfter,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (e) {
      if (e instanceof HttpException) throw e;
      this.logger.warn(
        `assistant rate-limit Redis error for op='${op}' user=${userId}: ${(e as Error).message}`,
      );
      // fail-open
    }
  }

  @Post('create_user_course')
  @McpTool({
    name: 'create_user_course',
    description:
      'Create a new chess course owned by the current user. ' +
      'Title is required (1-100 chars); description is optional (≤500). ' +
      'Use when the user explicitly asks the assistant to build a course. ' +
      'Returns the new course id and slug. ' +
      'Rate limit: 5 courses per hour per user; subsequent calls return 429.',
  })
  @McpToolForAssistant({
    name: 'create_user_course',
    description:
      'Create a new chess course owned by the current user. ' +
      'Title is required (1-100 chars); description is optional (≤500). ' +
      'Use when the user explicitly asks the assistant to build a course. ' +
      'Returns the new course id and slug. ' +
      'Rate limit: 5 courses per hour per user; subsequent calls return 429.',
  })
  async createUserCourse(
    @Body() input: CreateUserCourseAssistantInput,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ id: string; slug: string; title: string }> {
    const userId = req.user.id;

    // KS-3208: rate-limit 5/час на ассистент-создание курса. Проверяем
    // ДО записи в audit, чтобы 429 не плодил pending-строки.
    await this.enforceAssistantRateLimit(
      userId,
      'create_user_course',
      ASSISTANT_CREATE_COURSE_RATE_LIMIT,
    );

    // KS-3208: audit-журнал. Пишем `pending` с исходным input'ом до
    // вызова сервиса; после успеха обновляем status+createdCourseId,
    // при ошибке — status=failed + error (и rethrow'аем).
    const generation = await this.prisma.aiLessonGeneration.create({
      data: {
        userId,
        planJson: { ...input } as object,
        status: 'pending',
      },
      select: { id: true },
    });
    try {
      const dto = await this.courses.create(userId, {
        title: input.title,
        description: input.description,
      });
      await this.prisma.aiLessonGeneration.update({
        where: { id: generation.id },
        data: { status: 'created', createdCourseId: dto.id },
      });
      return { id: dto.id, slug: dto.slug, title: dto.title };
    } catch (e) {
      const errMsg = (e as Error).message ?? String(e);
      await this.prisma.aiLessonGeneration
        .update({
          where: { id: generation.id },
          data: { status: 'failed', error: errMsg.slice(0, 4000) },
        })
        .catch((updErr) => {
          this.logger.warn(
            `failed to mark generation ${generation.id} as failed: ${(updErr as Error).message}`,
          );
        });
      throw e;
    }
  }

  @Post('create_user_lesson')
  @McpTool({
    name: 'create_user_lesson',
    description:
      'Add a new lesson to one of the current user\'s courses (owner only). ' +
      'Requires courseId (UUID) and title (1-100 chars). ' +
      'Optional estMinutes (≥1).',
  })
  @McpToolForAssistant({
    name: 'create_user_lesson',
    description:
      'Add a new lesson to one of the current user\'s courses (owner only). ' +
      'Requires courseId (UUID) and title (1-100 chars). ' +
      'Optional estMinutes (≥1).',
  })
  async createUserLesson(
    @Body() input: CreateUserLessonAssistantInput,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ id: string; courseId: string; title: string; order: number }> {
    const dto = await this.courses.addLesson(req.user.id, input.courseId, {
      title: input.title,
      estMinutes: input.estMinutes,
    });
    return {
      id: dto.id,
      courseId: input.courseId,
      title: dto.title,
      order: dto.order,
    };
  }

  @Post('create_user_lesson_step')
  @McpTool({
    name: 'create_user_lesson_step',
    description:
      'Add a learning step to one of the current user\'s lessons (owner only). ' +
      'Allowed types: "text" (bodyMarkdown ≤4000 chars) or "quiz" ' +
      '(1-5 questions × 2-4 options each). Puzzle/game/endgame_drill steps ' +
      'are NOT allowed via the assistant — they must be created in the editor. ' +
      'Hard cap: ≤10 steps per lesson via the assistant.',
  })
  @McpToolForAssistant({
    name: 'create_user_lesson_step',
    description:
      'Add a learning step to one of the current user\'s lessons (owner only). ' +
      'Allowed types: "text" (bodyMarkdown ≤4000 chars) or "quiz" ' +
      '(1-5 questions × 2-4 options each). Puzzle/game/endgame_drill steps ' +
      'are NOT allowed via the assistant — they must be created in the editor. ' +
      'Hard cap: ≤10 steps per lesson via the assistant.',
  })
  async createUserLessonStep(
    @Body() input: CreateUserLessonStepAssistantInput,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ id: string; lessonId: string; type: string; order: number }> {
    // Дублирующий guard на тип шага — `@IsIn` уже отсекает, но даём
    // явное сообщение если входной DTO миновал валидацию (e2e/прямой
    // вызов сервиса).
    if (!ASSISTANT_ALLOWED_STEP_TYPES.includes(input.type)) {
      throw new BadRequestException(
        `Step type '${input.type}' is not allowed via assistant ` +
          `(allowed: ${ASSISTANT_ALLOWED_STEP_TYPES.join(', ')})`,
      );
    }

    // Owner-check + лимит «≤10 шагов через ассистент». UserLessonsService
    // сам валидирует лимит ADR-026 (50), но мы хотим более строгий
    // потолок для AI, поэтому считаем сами.
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: input.lessonId },
      select: {
        ownerId: true,
        _count: { select: { steps: true } },
      },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (lesson.ownerId !== req.user.id) {
      throw new ForbiddenException('You do not own this lesson');
    }
    if (lesson._count.steps >= ASSISTANT_STEPS_PER_LESSON_MAX) {
      throw new BadRequestException(
        `Lesson already has ${ASSISTANT_STEPS_PER_LESSON_MAX} steps ` +
          `(assistant limit; ask the user to remove some before adding more)`,
      );
    }

    let payload: unknown;
    if (input.type === 'text') {
      if (!input.bodyMarkdown || input.bodyMarkdown.length === 0) {
        throw new BadRequestException(
          'text step requires non-empty bodyMarkdown',
        );
      }
      payload = { type: 'text', bodyMarkdown: input.bodyMarkdown };
    } else {
      // quiz
      if (!input.questions || input.questions.length === 0) {
        throw new BadRequestException(
          'quiz step requires at least one question',
        );
      }
      // Доп. валидация консистентности: correctOptionIds должны
      // существовать в options. Это не ловит class-validator на ниже-
      // лежащем уровне (только cross-field check), но в `LessonsService`
      // публичный аналог уже есть; мы дублируем для понятной ошибки.
      for (const q of input.questions) {
        const ids = new Set(q.options.map((o) => o.id));
        for (const cid of q.correctOptionIds) {
          if (!ids.has(cid)) {
            throw new BadRequestException(
              `quiz question '${q.id}': correctOptionId '${cid}' is not in options`,
            );
          }
        }
        if (!q.multi && q.correctOptionIds.length !== 1) {
          throw new BadRequestException(
            `quiz question '${q.id}': single-answer must have exactly 1 correctOptionId`,
          );
        }
      }
      payload = { type: 'quiz', questions: input.questions };
    }

    const created = await this.lessons.addStep(
      input.lessonId,
      {
        type: input.type,
        // shape соответствует StepPayload из shared.
        payload: payload as never,
      },
      req.user.id,
    );
    return {
      id: created.id,
      lessonId: input.lessonId,
      type: created.type,
      order: created.order,
    };
  }

  @Post('get_user_course_url')
  @McpTool({
    name: 'get_user_course_url',
    description:
      'Get the public URL of one of the current user\'s courses (owner only). ' +
      'Use after creating a course to share the link back to the user.',
  })
  @McpToolForAssistant({
    name: 'get_user_course_url',
    description:
      'Get the public URL of one of the current user\'s courses (owner only). ' +
      'Use after creating a course to share the link back to the user.',
  })
  async getUserCourseUrl(
    @Body() input: GetUserCourseUrlAssistantInput,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ url: string; slug: string }> {
    const course = await this.prisma.course.findUnique({
      where: { id: input.courseId },
      select: { ownerId: true, slug: true },
    });
    if (!course) throw new NotFoundException('Course not found');
    if (course.ownerId !== req.user.id) {
      throw new ForbiddenException('You do not own this course');
    }
    const base = (
      this.config.get<string>('SITE_URL', 'https://kingside.site') ?? ''
    ).replace(/\/+$/, '');
    return {
      slug: course.slug,
      url: `${base}/lessons/courses/${course.slug}`,
    };
  }

  // ─── KS-3221 / ADR-075 §7 B1 — puzzle-инструменты ─────────────────

  @Post('add_puzzle_step_filter')
  @McpTool({
    name: 'add_puzzle_step_filter',
    description:
      'Add a puzzle-step to the current user\'s lesson (owner only) with a ' +
      'theme+rating filter. The actual puzzles are selected dynamically at ' +
      'runtime by the puzzle service, so the lesson stays fresh as the puzzle ' +
      'database grows. Input: lessonId (UUID), themes (1-3 from PuzzleTheme ' +
      'enum), optional ratingMin/ratingMax, limit (1-10). Hard cap: ' +
      '≤15 puzzle-steps per lesson via the assistant.',
  })
  @McpToolForAssistant({
    name: 'add_puzzle_step_filter',
    description:
      'Add a puzzle-step to the current user\'s lesson (owner only) with a ' +
      'theme+rating filter. Themes whitelist: PuzzleTheme enum. Limit 1-10.',
  })
  async addPuzzleStepFilter(
    @Body() input: AddPuzzleStepFilterAssistantInput,
    @Request() req: AuthenticatedRequest,
  ): Promise<{
    id: string;
    lessonId: string;
    type: string;
    order: number;
    themes: string[];
    limit: number;
  }> {
    // Owner-check + лимит «≤15 puzzle-шагов через ассистент». В отличие
    // от text/quiz (KS-3207's 10) для puzzle даём более широкий потолок —
    // тренировочный сет имеет смысл от 8 шагов.
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: input.lessonId },
      select: {
        ownerId: true,
        steps: {
          where: { type: 'puzzle' },
          select: { id: true },
        },
      },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (lesson.ownerId !== req.user.id) {
      throw new ForbiddenException('You do not own this lesson');
    }
    if (lesson.steps.length >= ASSISTANT_PUZZLE_STEPS_PER_LESSON_MAX) {
      throw new BadRequestException(
        `Lesson already has ${ASSISTANT_PUZZLE_STEPS_PER_LESSON_MAX} puzzle steps ` +
          `(assistant limit; ask the user to remove some before adding more)`,
      );
    }

    if (
      input.ratingMin !== undefined &&
      input.ratingMax !== undefined &&
      input.ratingMin > input.ratingMax
    ) {
      throw new BadRequestException(
        `ratingMin (${input.ratingMin}) > ratingMax (${input.ratingMax})`,
      );
    }

    const selection: Record<string, unknown> = {
      mode: 'filter',
      themes: input.themes,
      limit: input.limit,
    };
    if (input.ratingMin !== undefined) selection.ratingMin = input.ratingMin;
    if (input.ratingMax !== undefined) selection.ratingMax = input.ratingMax;

    const payload: Record<string, unknown> = {
      type: 'puzzle',
      selection,
    };
    // `instruction` храним для будущего UI-использования. PuzzleStepPayload
    // (shared) не описывает поле, но JSONB переживёт extra-keys.
    if (input.instruction) {
      payload.instruction = input.instruction;
    }

    const created = await this.lessons.addStep(
      input.lessonId,
      {
        type: 'puzzle',
        payload: payload as never,
      },
      req.user.id,
    );
    return {
      id: created.id,
      lessonId: input.lessonId,
      type: created.type,
      order: created.order,
      themes: input.themes,
      limit: input.limit,
    };
  }

  @Post('find_puzzles_preview')
  @McpTool({
    name: 'find_puzzles_preview',
    description:
      'Preview puzzles matching a theme+rating filter WITHOUT adding them ' +
      'to any lesson. Returns up to 5 puzzles with id, fen, first solution ' +
      'move (UCI), and matching themes. Use to verify a filter is reasonable ' +
      'before calling add_puzzle_step_filter.',
  })
  @McpToolForAssistant({
    name: 'find_puzzles_preview',
    description:
      'Preview puzzles for a theme+rating filter. No DB writes. limit 1-5.',
  })
  async findPuzzlesPreview(
    @Body() input: FindPuzzlesPreviewAssistantInput,
    @Request() _req: AuthenticatedRequest,
  ): Promise<{
    puzzles: Array<{
      puzzleId: string;
      fen: string;
      bestMove: string;
      themes: string[];
      rating: number | null;
    }>;
    appliedFilter: {
      themes: string[];
      ratingMin?: number;
      ratingMax?: number;
      limit: number;
    };
  }> {
    if (
      input.ratingMin !== undefined &&
      input.ratingMax !== undefined &&
      input.ratingMin > input.ratingMax
    ) {
      throw new BadRequestException(
        `ratingMin (${input.ratingMin}) > ratingMax (${input.ratingMax})`,
      );
    }

    const found = await this.puzzles.findPuzzles({
      themes: input.themes,
      ratingMin: input.ratingMin,
      ratingMax: input.ratingMax,
      limit: input.limit,
      orderBy: 'random',
      // assistant-preview всегда показывает обычные forced-line задачи
      // (PVE — отдельная фича, требует свой scope обсуждения с моделью).
      solutionMode: 'forced-line',
    });

    return {
      puzzles: found.map((p) => ({
        puzzleId: p.id,
        fen: p.fen,
        // `moves` приходит как уже распакованный массив UCI после
        // formatPuzzle. Первый — setup или ход решающего (зависит от
        // firstMoveIsUser); для preview достаточно показать первый ход
        // как намёк.
        bestMove: (p.moves ?? [])[0] ?? '',
        themes: p.themes ?? [],
        rating: p.rating ?? null,
      })),
      appliedFilter: {
        themes: input.themes,
        ratingMin: input.ratingMin,
        ratingMax: input.ratingMax,
        limit: input.limit,
      },
    };
  }
}
