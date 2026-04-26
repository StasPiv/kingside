import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import type { ActiveCoursesResponse } from '@kingside/shared';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ActiveCoursesService } from './active-courses.service';

/**
 * KS-1937 (Lessons-redesign B-5).
 *
 * Один эндпоинт для Hero и страницы `/lessons/my-active`. Возвращает
 * только активные курсы пользователя из system + enrolled-чужих
 * (см. концепт §3.3 KS-1931). Без пагинации — кол-во активных
 * на пользователя ограничено десятками в худшем случае.
 */
@UseGuards(JwtAuthGuard)
@Controller('lessons')
export class ActiveCoursesController {
  constructor(private readonly service: ActiveCoursesService) {}

  /** GET /api/lessons/active-courses — список активных курсов. */
  @Get('active-courses')
  list(@Request() req: AuthenticatedRequest): Promise<ActiveCoursesResponse> {
    return this.service.listActiveCourses(req.user.id);
  }
}
