import { Controller, Get, Param, Request, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CoursesService } from './courses.service';

@UseGuards(JwtAuthGuard)
@Controller('lessons/courses')
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  /** GET /api/lessons/courses — список курсов + рекомендация уровня. */
  @Get()
  list(@Request() req: AuthenticatedRequest) {
    return this.coursesService.listCourses(req.user?.id ?? null);
  }

  /** GET /api/lessons/courses/:slug — курс с блоками/уроками. */
  @Get(':slug')
  getBySlug(@Request() req: AuthenticatedRequest, @Param('slug') slug: string) {
    return this.coursesService.getCourseBySlug(slug, req.user?.id ?? null);
  }
}
