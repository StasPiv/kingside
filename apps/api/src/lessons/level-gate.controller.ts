import { BadRequestException, Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import type { CourseLevel } from '@kingside/shared';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LevelGateService } from './level-gate.service';

const ALLOWED_FROM: ReadonlyArray<CourseLevel> = ['beginner', 'intermediate', 'advanced'];

@UseGuards(JwtAuthGuard)
@Controller('lessons')
export class LevelGateController {
  constructor(private readonly service: LevelGateService) {}

  /**
   * GET /api/lessons/level-gate[?from=beginner|intermediate|advanced]
   *
   * Без `from` — сервер сам определяет текущий уровень пользователя.
   * С `from` — возвращает gate с указанного уровня (нужно фронту на
   * CoursePage intermediate, чтобы показать плашку intermediate → advanced
   * независимо от того, закрыл ли игрок уже этот gate).
   */
  @Get('level-gate')
  get(
    @Request() req: AuthenticatedRequest,
    @Query('from') from?: string,
  ) {
    let level: CourseLevel | undefined;
    if (from !== undefined) {
      if (!ALLOWED_FROM.includes(from as CourseLevel)) {
        throw new BadRequestException(
          `Invalid "from" value: must be one of ${ALLOWED_FROM.join(', ')}`,
        );
      }
      level = from as CourseLevel;
    }
    return this.service.getGate(req.user.id, level);
  }
}
