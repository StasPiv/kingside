import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  StepPayload,
  UpdateUserLessonStepRequest,
  UserLessonStepDto,
  UserStepType,
} from '@kingside/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { GameStepHydratorService } from '../dto/game-step.hydrator';

/**
 * UserLessonStepsService — отдельные шаги (PATCH/DELETE) пользовательских
 * уроков (ADR-026 §2.5, KS-1829).
 *
 * KS-2648 / ADR-054 Phase E2. Сервис теперь работает поверх единой
 * таблицы `lesson_steps` (вместо legacy `user_lesson_steps`). Поведение
 * не меняется — DTO `UserLessonStepDto` остаётся прежним, поле
 * `userLessonId` маппится из `lessonId`. После Phase E3 (drop
 * `user_lesson_steps`) сервис либо переименуется, либо сольётся с
 * системным эквивалентом.
 *
 * Валидация payload'а и whitelist'а типов (MVP: `text`/`puzzle`/
 * `endgame_drill`/`quiz`) — задача BE-3. Здесь мы только пишем в БД и
 * мапим в DTO.
 */
@Injectable()
export class UserLessonStepsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gameStepHydrator: GameStepHydratorService,
  ) {}

  async update(
    stepId: string,
    body: UpdateUserLessonStepRequest,
    userId: string | null = null,
  ): Promise<UserLessonStepDto> {
    // KS-3180 (ADR-072 §7 B1): snapshot для `game/workshop_analysis`.
    const hydratedPayload =
      body.payload !== undefined
        ? await this.gameStepHydrator.hydrate(body.payload as any, userId)
        : undefined;

    const updated = await this.prisma.lessonStep.update({
      where: { id: stepId },
      data: {
        ...(hydratedPayload !== undefined
          ? { payload: hydratedPayload as any }
          : {}),
        ...(body.order !== undefined ? { order: body.order } : {}),
      },
    });
    return toStepDto(updated);
  }

  async delete(stepId: string): Promise<void> {
    // Ловим 404 явно: `prisma.delete` без существующей записи кидает P2025.
    try {
      await this.prisma.lessonStep.delete({ where: { id: stepId } });
    } catch (e) {
      if (
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        (e as { code?: unknown }).code === 'P2025'
      ) {
        throw new NotFoundException('Resource not found');
      }
      throw e;
    }
  }
}

// ─── DTO mapper ─────────────────────────────────────────────────────

/**
 * Мапер Prisma-row → DTO. `type` в БД хранится как `String`; приведение
 * к `UserStepType` безопасно после BE-3, который добавит валидацию на
 * входе. До этого мы доверяем БД как источнику — если туда попал
 * неподдерживаемый тип, это баг записи, и корректнее не прятать его
 * кастом (API вернёт, фронт закроет по `unknown` ветке union'а).
 *
 * KS-2648: row теперь из `lesson_steps`, поле `lessonId` (системное).
 * В DTO легасном поле `userLessonId` — мапим 1:1 (id урока тот же
 * UUID, только переменная названа иначе).
 */
export function toStepDto(row: {
  id: string;
  lessonId: string;
  order: number;
  type: string;
  payload: unknown;
}): UserLessonStepDto {
  return {
    id: row.id,
    userLessonId: row.lessonId,
    order: row.order,
    type: row.type as UserStepType,
    payload: row.payload as StepPayload,
  };
}
