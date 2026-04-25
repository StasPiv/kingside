import { Controller, Get, Query } from '@nestjs/common';
import { ListCourseAuthorsQueryDto } from './dto/user-course.dto';
import { UserCoursesService } from './user-courses.service';

/**
 * Публичные read-only эндпоинты пользовательских курсов
 * (KS-1918 / ADR-030 §3.2). Отдельный контроллер от
 * `UserCoursesController` чтобы не вешать `JwtAuthGuard` на
 * публичные роуты — лобби-витрина доступна без auth.
 *
 * Зарегистрирован в `UserCoursesModule.controllers` ДО
 * `UserCoursesController`, чтобы маршрут `/authors` не упирался в
 * параметрический `:slug` приватного контроллера.
 */
@Controller('lessons/user-courses')
export class UserCoursesPublicController {
  constructor(private readonly service: UserCoursesService) {}

  /**
   * GET /lessons/user-courses/authors — авторы публичных user-курсов
   * с агрегатом для лобби `/lessons` и таба Authors на `/players`.
   * Без auth.
   *
   * Query: `?limit=N&offset=M&sort=courses|recent`. Дефолты в
   * `UserCoursesService.listAuthors`. Кеш 5 мин, инвалидируется при
   * мутации курсов в `UserCoursesService`.
   */
  @Get('authors')
  listAuthors(@Query() dto: ListCourseAuthorsQueryDto) {
    return this.service.listAuthors({
      sort: dto.sort,
      limit: dto.limit,
      offset: dto.offset,
    });
  }
}
