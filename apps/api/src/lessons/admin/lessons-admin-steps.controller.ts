import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AdminEmailGuard } from '../../auth/admin-email.guard';
import {
  UserRateLimit,
  UserRateLimitGuard,
} from '../../common/user-rate-limit.guard';
import { LessonsAdminService } from './lessons-admin.service';
import {
  CreateAdminStepDto,
  ReorderAdminStepsDto,
  UpdateAdminStepDto,
} from './dto/admin-step.dto';
import { ADMIN_RATE_LIMIT } from './admin-rate-limit';

/**
 * KS-1962/B-7 — admin CRUD для шагов уроков.
 *
 * Пути:
 *  - POST   /lessons/admin/lessons/:lessonId/steps
 *  - PATCH  /lessons/admin/steps/:id
 *  - DELETE /lessons/admin/steps/:id
 *  - POST   /lessons/admin/lessons/:lessonId/steps/reorder
 *
 * Гарды совпадают с другими admin-контроллерами KS-1962
 * (JwtAuthGuard → AdminEmailGuard).
 *
 * `payload` валидируется дискриминированным union'ом по полю `type`
 * (см. `STEP_PAYLOAD_SUBTYPES` из `dto/step-payload.dto.ts`),
 * который реюзается с публичным API. Все 8 типов поддержаны: `text`,
 * `puzzle`, `quiz`, `position`, `game_review`, `video`,
 * `endgame_drill`, `opening_drill`.
 */
@UseGuards(JwtAuthGuard, AdminEmailGuard, UserRateLimitGuard)
@UserRateLimit(ADMIN_RATE_LIMIT.maxRequests, ADMIN_RATE_LIMIT.windowSec)
@Controller('lessons/admin')
export class LessonsAdminStepsController {
  constructor(private readonly service: LessonsAdminService) {}

  /**
   * POST /api/lessons/admin/lessons/:lessonId/steps/reorder
   * Объявлен ВЫШЕ /steps/:id, чтобы Nest не интерпретировал
   * `reorder` как UUID.
   */
  @Post('lessons/:lessonId/steps/reorder')
  @HttpCode(204)
  async reorder(
    @Param('lessonId', new ParseUUIDPipe({ version: '4' })) lessonId: string,
    @Body() dto: ReorderAdminStepsDto,
  ): Promise<void> {
    await this.service.reorderSteps(lessonId, dto);
  }

  /** POST /api/lessons/admin/lessons/:lessonId/steps — создать шаг. */
  @Post('lessons/:lessonId/steps')
  create(
    @Param('lessonId', new ParseUUIDPipe({ version: '4' })) lessonId: string,
    @Body() dto: CreateAdminStepDto,
  ) {
    return this.service.createStep(lessonId, dto);
  }

  /**
   * PATCH /api/lessons/admin/steps/:id — изменить шаг.
   * При смене `type` обязателен `payload` (400 иначе).
   */
  @Patch('steps/:id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateAdminStepDto,
  ) {
    return this.service.updateStep(id, dto);
  }

  /** DELETE /api/lessons/admin/steps/:id — удалить шаг. */
  @Delete('steps/:id')
  @HttpCode(204)
  async delete(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    await this.service.deleteStep(id);
  }
}
