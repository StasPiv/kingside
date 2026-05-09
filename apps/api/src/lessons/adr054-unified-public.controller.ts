/**
 * KS-2646 / ADR-054 Phase D fix — публичный unified-роут.
 *
 * `GET /lessons/courses/authors` — авторы публичных пользовательских
 * курсов с агрегатом для лобби `/lessons` и таба Authors на
 * `/players`. Доступ без auth — тот же контракт, что у legacy
 * `GET /lessons/user-courses/authors` (см. `UserCoursesPublicController`).
 *
 * Контроллер вынесен в отдельный файл, чтобы не нарушать invariant
 * `Adr054UnifiedCoursesController` (он под `JwtAuthGuard`). Регистрация
 * в `LessonsModule.controllers` ДО `Adr054UnifiedCoursesController` —
 * чтобы маршрут `/authors` не ловил параметрический `:id` приватного
 * контроллера (хотя сейчас параметрических GET-роутов с `:id` у
 * приватного нет — `:slug` живёт в `CoursesController`, тоже под auth).
 *
 * Делегирует на тот же `UserCoursesService.listAuthors`, что и legacy:
 * результат идентичный, кеш Redis 5 мин общий (ключи
 * `lessons:authors:<sort>:<limit>:<offset>`).
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ListCourseAuthorsQueryDto } from './user-courses/dto/user-course.dto';
import { UserCoursesService } from './user-courses/user-courses.service';

@Controller('lessons/courses')
export class Adr054UnifiedCoursesPublicController {
  constructor(private readonly service: UserCoursesService) {}

  @Get('authors')
  listAuthors(@Query() dto: ListCourseAuthorsQueryDto) {
    return this.service.listAuthors({
      sort: dto.sort,
      limit: dto.limit,
      offset: dto.offset,
    });
  }
}
