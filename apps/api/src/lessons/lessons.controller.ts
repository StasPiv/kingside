import { Controller, Get, Param, ParseUUIDPipe, Request, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LessonsService } from './lessons.service';

@UseGuards(JwtAuthGuard)
@Controller('lessons/lessons')
export class LessonsController {
  constructor(private readonly lessonsService: LessonsService) {}

  /** GET /api/lessons/lessons/:id — урок с шагами + прогресс пользователя. */
  @Get(':id')
  getOne(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.lessonsService.getLessonWithSteps(id, req.user?.id ?? null);
  }
}
