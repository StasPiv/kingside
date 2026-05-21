import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateUserLessonStepRequest,
  LessonStepState,
  ReorderUserStepsRequest,
  UpdateUserLessonRequest,
  UserLessonDto,
  UserLessonPlayProgressDto,
  UserLessonStepDto,
  UserLessonWithStepsResponse,
} from '@kingside/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { toLessonDto } from './user-courses.service';
import { toStepDto } from './user-lesson-steps.service';
import {
  ALLOWED_USER_STEP_TYPES,
  USER_COURSES_LIMITS,
} from './user-courses-limits';
import { GameStepHydratorService } from '../dto/game-step.hydrator';

/**
 * UserLessonsService — CRUD уроков пользовательского курса + добавление
 * шагов + прогресс (ADR-026 §2.5, KS-1829).
 *
 * KS-2648 / ADR-054 Phase E2. Сервис переключён на единые таблицы:
 *   * `lessons` (вместо `user_lessons`) — урок принадлежит
 *     пользовательскому курсу, если `lesson.ownerId IS NOT NULL`
 *     (денормализация из Phase A).
 *   * `lesson_steps` (вместо `user_lesson_steps`).
 *   * `user_lesson_progress` (вместо `user_lesson_play_progress`) —
 *     системный progress-агрегат, в Phase E3 будет переименован в
 *     `lesson_progress`.
 *
 * Внешний контракт DTO `UserLessonDto` / `UserLessonStepDto` /
 * `UserLessonPlayProgressDto` сохранён 1:1 — фронту не нужно ничего
 * менять. Под капотом: `userCourseId` маппится из `courseId`,
 * `userLessonId` — из `lessonId`, `lastActivityAt` — из `updatedAt`,
 * `completedStepsCount/totalSteps` — вычисляются on-demand из
 * `stepsState` и кол-ва шагов урока (системная таблица не хранит
 * эти счётчики).
 */
@Injectable()
export class UserLessonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gameStepHydrator: GameStepHydratorService,
  ) {}

  // ─── Read ─────────────────────────────────────────────────────────

  async getWithSteps(
    userId: string,
    lessonId: string,
  ): Promise<UserLessonWithStepsResponse> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        _count: { select: { steps: true } },
        steps: { orderBy: { order: 'asc' } },
      },
    });
    if (!lesson) throw new NotFoundException('Resource not found');

    const progress = await this.prisma.userLessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId } },
    });

    return {
      lesson: toLessonDto(lesson),
      steps: lesson.steps.map((s) => toStepDto(s)),
      progress: progress
        ? toLessonPlayProgressDto(progress, lesson._count.steps)
        : null,
    };
  }

  // ─── Mutations ───────────────────────────────────────────────────

  async update(
    lessonId: string,
    body: UpdateUserLessonRequest,
  ): Promise<UserLessonDto> {
    const updated = await this.prisma.lesson.update({
      where: { id: lessonId },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        // KS-2648: системная `Lesson.estMinutes` — Int NOT NULL,
        // default 10. Если в DTO пришёл null — нормализуем в 10.
        ...(body.estMinutes !== undefined
          ? { estMinutes: body.estMinutes ?? 10 }
          : {}),
        ...(body.order !== undefined ? { order: body.order } : {}),
      },
      include: { _count: { select: { steps: true } } },
    });
    return toLessonDto(updated);
  }

  async delete(lessonId: string): Promise<void> {
    await this.prisma.lesson.delete({ where: { id: lessonId } });
  }

  /**
   * Добавить шаг в урок. Валидация `type` (whitelist MVP) и формы
   * `payload` — задача BE-3; здесь принимаем payload как `StepPayload`
   * из shared и не валидируем содержимое.
   *
   * KS-2648: пишем в `lesson_steps` с денормализованным `ownerId`
   * (наследуется от lesson.ownerId). Без него Phase E3 CHECK не пройдёт.
   */
  async addStep(
    lessonId: string,
    body: CreateUserLessonStepRequest,
    userId: string | null = null,
  ): Promise<UserLessonStepDto> {
    if (!body || typeof body.type !== 'string') {
      throw new BadRequestException('type is required');
    }

    // Whitelist (ADR-026 §2.4). Дублируем с DTO-валидатором, потому что
    // сервис может быть вызван напрямую (e2e-тесты, сиды), минуя ValidationPipe.
    if (!(ALLOWED_USER_STEP_TYPES as readonly string[]).includes(body.type)) {
      throw new BadRequestException(
        `Step type '${body.type}' not allowed in user courses. Allowed: ${ALLOWED_USER_STEP_TYPES.join(', ')}`,
      );
    }

    // KS-3180 (ADR-072 §7 B1): для `game` со sourceType=workshop_analysis
    // снимаем snapshot из Analysis (owner-check, 403 на чужой). Hydrate
    // делаем ДО открытия транзакции — он сам делает SELECT по другой
    // таблице, не нужно держать lock'и.
    const hydratedPayload = await this.gameStepHydrator.hydrate(
      body.payload as any,
      userId,
    );

    return this.prisma.$transaction(async (tx) => {
      // Лимит 50 шагов/урок (ADR-026 §2.2). Проверка в транзакции —
      // как и для уроков выше.
      const stepCount = await tx.lessonStep.count({
        where: { lessonId },
      });
      if (stepCount >= USER_COURSES_LIMITS.stepsPerLesson) {
        throw new BadRequestException(
          `Steps per lesson limit reached (${USER_COURSES_LIMITS.stepsPerLesson})`,
        );
      }

      // KS-2648: достаём `lesson.ownerId` для денормализации.
      const lesson = await tx.lesson.findUnique({
        where: { id: lessonId },
        select: { ownerId: true },
      });
      if (!lesson) throw new NotFoundException('Resource not found');

      const last = await tx.lessonStep.findFirst({
        where: { lessonId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      const next = (last?.order ?? -1) + 1;
      const created = await tx.lessonStep.create({
        data: {
          lessonId,
          ownerId: lesson.ownerId,
          order: next,
          type: body.type,
          payload: hydratedPayload as any,
        },
      });
      return toStepDto(created);
    });
  }

  /**
   * Массовая перестановка `order` шагов в одной транзакции (ADR §2.5).
   * На входе — массив id в нужном порядке; всем выставляется `order = index`.
   * Валидируем, что все id принадлежат запрошенному уроку — чтобы
   * клиент не мог подмешать чужие шаги.
   */
  async reorderSteps(
    lessonId: string,
    body: ReorderUserStepsRequest,
  ): Promise<{ ids: string[] }> {
    if (!body || !Array.isArray(body.ids) || body.ids.length === 0) {
      throw new BadRequestException('ids is required');
    }

    return this.prisma.$transaction(async (tx) => {
      const steps = await tx.lessonStep.findMany({
        where: { lessonId },
        select: { id: true },
      });
      const allowed = new Set(steps.map((s) => s.id));
      for (const id of body.ids) {
        if (!allowed.has(id)) {
          throw new BadRequestException(`step ${id} does not belong to lesson`);
        }
      }
      if (body.ids.length !== steps.length) {
        throw new BadRequestException(
          'ids must list every step of the lesson (reorder requires full list)',
        );
      }

      // Две фазы: сначала сдвигаем в «безопасный» offset (+1_000_000), потом
      // в целевые значения. Это обход unique-constraint'ов, которых на
      // (lessonId, order) нет, но практика защищает на случай будущего
      // ужесточения схемы.
      await Promise.all(
        body.ids.map((id, idx) =>
          tx.lessonStep.update({
            where: { id },
            data: { order: 1_000_000 + idx },
          }),
        ),
      );
      await Promise.all(
        body.ids.map((id, idx) =>
          tx.lessonStep.update({
            where: { id },
            data: { order: idx },
          }),
        ),
      );
      return { ids: body.ids };
    });
  }

  // Прогресс вынесен в UserProgressService (KS-1831) —
  // `POST /lessons/user-progress/lessons/:userLessonId/step` и
  // `POST /lessons/user-progress/lessons/:userLessonId/complete`.
  // `UserLessonsController` их больше не обрабатывает.
}

// ─── DTO mapper ──────────────────────────────────────────────────────

/**
 * KS-2648: row теперь из `user_lesson_progress` (системная таблица).
 * Маппинг под legacy `UserLessonPlayProgressDto`:
 *   * `userLessonId` ← `lessonId`;
 *   * `lastActivityAt` ← `updatedAt`;
 *   * `completedStepsCount` ← count('done') в `stepsState`;
 *   * `totalSteps` принимаем параметром — вызывающий уже знает кол-во
 *     шагов (через `_count.steps` в include или отдельным `count`).
 */
export function toLessonPlayProgressDto(
  row: {
    lessonId: string;
    stepsState?: unknown;
    startedAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
  },
  totalSteps: number,
): UserLessonPlayProgressDto {
  const stepsState = normalizeStepsState(row.stepsState);
  const doneCount = Object.values(stepsState).filter((s) => s === 'done').length;
  return {
    userLessonId: row.lessonId,
    completedStepsCount: Math.min(doneCount, totalSteps),
    totalSteps,
    stepsState,
    startedAt: row.startedAt.toISOString(),
    lastActivityAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

/**
 * Приводит JSON из БД к `Record<string, LessonStepState>`. Любой мусор
 * (null, не-объект, неизвестное значение состояния) → пустой объект /
 * отбрасывается. Поле `stepsState` появилось в KS-1879; для записей,
 * созданных до миграции, default `'{}'::jsonb` вернёт пустой объект.
 */
const VALID_STATES: ReadonlySet<LessonStepState> = new Set([
  'pending',
  'in_progress',
  'done',
  'failed',
  'skipped',
]);

export function normalizeStepsState(
  raw: unknown,
): Record<string, LessonStepState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, LessonStepState> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && VALID_STATES.has(v as LessonStepState)) {
      out[k] = v as LessonStepState;
    }
  }
  return out;
}
