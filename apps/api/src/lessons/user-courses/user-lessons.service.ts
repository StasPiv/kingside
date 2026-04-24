import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateUserLessonStepRequest,
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

/**
 * UserLessonsService — CRUD уроков пользовательского курса + добавление
 * шагов + прогресс (ADR-026 §2.5, KS-1829).
 *
 * Прогресс-эндпоинты (`POST /lessons/user-progress/step`,
 * `POST /lessons/user-progress/lesson/complete`) в MVP обслуживаем
 * здесь упрощённо: достаточно happy-path, чтобы BE-4 (UserProgressService)
 * развернул полноценную логику завершения урока/курса. Детальный
 * `stepsState` в этой таблице не храним — только счётчики
 * `completedStepsCount`/`totalSteps` из схемы (ADR-026 уточнил §2.1).
 */
@Injectable()
export class UserLessonsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Read ─────────────────────────────────────────────────────────

  async getWithSteps(
    userId: string,
    lessonId: string,
  ): Promise<UserLessonWithStepsResponse> {
    const lesson = await this.prisma.userLesson.findUnique({
      where: { id: lessonId },
      include: {
        _count: { select: { steps: true } },
        steps: { orderBy: { order: 'asc' } },
      },
    });
    if (!lesson) throw new NotFoundException('Resource not found');

    const progress = await this.prisma.userLessonPlayProgress.findUnique({
      where: { userId_userLessonId: { userId, userLessonId: lessonId } },
    });

    return {
      lesson: toLessonDto(lesson),
      steps: lesson.steps.map((s) => toStepDto(s)),
      progress: progress ? toLessonPlayProgressDto(progress) : null,
    };
  }

  // ─── Mutations ───────────────────────────────────────────────────

  async update(
    lessonId: string,
    body: UpdateUserLessonRequest,
  ): Promise<UserLessonDto> {
    const updated = await this.prisma.userLesson.update({
      where: { id: lessonId },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.estMinutes !== undefined
          ? { estMinutes: body.estMinutes }
          : {}),
        ...(body.order !== undefined ? { order: body.order } : {}),
      },
      include: { _count: { select: { steps: true } } },
    });
    return toLessonDto(updated);
  }

  async delete(lessonId: string): Promise<void> {
    await this.prisma.userLesson.delete({ where: { id: lessonId } });
  }

  /**
   * Добавить шаг в урок. Валидация `type` (whitelist MVP) и формы
   * `payload` — задача BE-3; здесь принимаем payload как `StepPayload`
   * из shared и не валидируем содержимое.
   */
  async addStep(
    lessonId: string,
    body: CreateUserLessonStepRequest,
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

    return this.prisma.$transaction(async (tx) => {
      // Лимит 50 шагов/урок (ADR-026 §2.2). Проверка в транзакции —
      // как и для уроков выше.
      const stepCount = await tx.userLessonStep.count({
        where: { userLessonId: lessonId },
      });
      if (stepCount >= USER_COURSES_LIMITS.stepsPerLesson) {
        throw new BadRequestException(
          `Steps per lesson limit reached (${USER_COURSES_LIMITS.stepsPerLesson})`,
        );
      }

      const last = await tx.userLessonStep.findFirst({
        where: { userLessonId: lessonId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      const next = (last?.order ?? -1) + 1;
      const created = await tx.userLessonStep.create({
        data: {
          userLessonId: lessonId,
          order: next,
          type: body.type,
          payload: body.payload as any,
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
      const steps = await tx.userLessonStep.findMany({
        where: { userLessonId: lessonId },
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
      // (userLessonId, order) нет, но практика защищает на случай будущего
      // ужесточения схемы.
      await Promise.all(
        body.ids.map((id, idx) =>
          tx.userLessonStep.update({
            where: { id },
            data: { order: 1_000_000 + idx },
          }),
        ),
      );
      await Promise.all(
        body.ids.map((id, idx) =>
          tx.userLessonStep.update({
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

export function toLessonPlayProgressDto(row: {
  userLessonId: string;
  completedStepsCount: number;
  totalSteps: number;
  startedAt: Date;
  lastActivityAt: Date;
  completedAt: Date | null;
}): UserLessonPlayProgressDto {
  return {
    userLessonId: row.userLessonId,
    completedStepsCount: row.completedStepsCount,
    totalSteps: row.totalSteps,
    startedAt: row.startedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

