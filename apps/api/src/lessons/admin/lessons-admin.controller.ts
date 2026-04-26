import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
  CreateAdminCourseDto,
  ListAdminCoursesQueryDto,
  ReorderAdminCoursesDto,
  UpdateAdminCourseDto,
} from './dto/admin-course.dto';
import { ADMIN_RATE_LIMIT } from './admin-rate-limit';

/**
 * KS-1962/B-5 — admin CRUD для system courses.
 *
 * Доступ: `JwtAuthGuard` (валидный JWT) + `AdminEmailGuard` (email
 * пользователя из БД должен быть в `LESSON_ADMIN_EMAILS`). Гарды
 * расположены в этом порядке, чтобы JwtAuthGuard сначала положил
 * `req.user`, а уже на нём AdminEmailGuard проверял whitelist.
 *
 * Базовый путь — `/api/lessons/admin/courses`. Уроки и шаги
 * добавятся отдельными контроллерами в B-6/B-7 (зеркальная структура
 * с user-courses).
 */
@UseGuards(JwtAuthGuard, AdminEmailGuard, UserRateLimitGuard)
@UserRateLimit(ADMIN_RATE_LIMIT.maxRequests, ADMIN_RATE_LIMIT.windowSec)
@Controller('lessons/admin/courses')
export class LessonsAdminController {
  constructor(private readonly service: LessonsAdminService) {}

  /** GET /api/lessons/admin/courses — список (включая drafts). */
  @Get()
  list(@Query() query: ListAdminCoursesQueryDto) {
    return this.service.listCourses(query);
  }

  /**
   * POST /api/lessons/admin/courses/reorder — переупорядочить курсы.
   *
   * Должен быть объявлен ВЫШЕ `:id`-роута, иначе Nest посчитает
   * `reorder` за `id` и `ParseUUIDPipe` упадёт.
   */
  @Post('reorder')
  @HttpCode(204)
  async reorder(@Body() dto: ReorderAdminCoursesDto): Promise<void> {
    await this.service.reorderCourses(dto);
  }

  /** GET /api/lessons/admin/courses/:id — курс + список уроков. */
  @Get(':id')
  getById(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.service.getCourseById(id);
  }

  /** POST /api/lessons/admin/courses — создать курс. */
  @Post()
  create(@Body() dto: CreateAdminCourseDto) {
    return this.service.createCourse(dto);
  }

  /** PATCH /api/lessons/admin/courses/:id — изменить метаданные. */
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateAdminCourseDto,
  ) {
    return this.service.updateCourse(id, dto);
  }

  /** DELETE /api/lessons/admin/courses/:id — каскадно удалить курс. */
  @Delete(':id')
  @HttpCode(204)
  async delete(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    await this.service.deleteCourse(id);
  }
}
