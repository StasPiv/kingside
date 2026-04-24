import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  StepPayload,
  UpdateUserLessonStepRequest,
  UserLessonStepDto,
  UserStepType,
} from '@kingside/shared';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * UserLessonStepsService — отдельные шаги (PATCH/DELETE) пользовательских
 * уроков (ADR-026 §2.5, KS-1829).
 *
 * Валидация payload'а и whitelist'а типов (MVP: `text`/`puzzle`/
 * `endgame_drill`) — задача BE-3. Здесь мы только пишем в БД и мапим
 * в DTO.
 */
@Injectable()
export class UserLessonStepsService {
  constructor(private readonly prisma: PrismaService) {}

  async update(
    stepId: string,
    body: UpdateUserLessonStepRequest,
  ): Promise<UserLessonStepDto> {
    const updated = await this.prisma.userLessonStep.update({
      where: { id: stepId },
      data: {
        ...(body.payload !== undefined
          ? { payload: body.payload as any }
          : {}),
        ...(body.order !== undefined ? { order: body.order } : {}),
      },
    });
    return toStepDto(updated);
  }

  async delete(stepId: string): Promise<void> {
    // Ловим 404 явно: `prisma.delete` без существующей записи кидает P2025.
    try {
      await this.prisma.userLessonStep.delete({ where: { id: stepId } });
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
 */
export function toStepDto(row: {
  id: string;
  userLessonId: string;
  order: number;
  type: string;
  payload: unknown;
}): UserLessonStepDto {
  return {
    id: row.id,
    userLessonId: row.userLessonId,
    order: row.order,
    type: row.type as UserStepType,
    payload: row.payload as StepPayload,
  };
}
