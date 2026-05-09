import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CoursesService } from './courses.service';
import { UserCoursesService } from './user-courses/user-courses.service';
import { ListUserCoursesQueryDto } from './user-courses/dto/user-course.dto';

/**
 * KS-2101: язык курсов берётся из `User.locale` (настройка профиля),
 * меняется через `PATCH /users/me/settings`. Query `?lang=` и
 * `Accept-Language` намеренно не читаются — единственный source of
 * truth — настройка профиля.
 *
 * KS-2643 / ADR-054 Phase C2. GET-роуты `/lessons/courses[/:slug]`
 * расширены поддержкой пользовательских курсов:
 *
 *   - `GET /lessons/courses?mine=1|0` — при наличии query `mine` запрос
 *     уходит в `UserCoursesService.list({mine})`. Без query — старый
 *     системный listing (`CoursesService.listCourses`). Это позволяет
 *     alias-redirect'у `/lessons/user-courses?mine=…` транспарентно
 *     переходить на `/lessons/courses?mine=…` без потери семантики.
 *
 *   - `GET /lessons/courses/:slug` — сначала ищет системный курс
 *     (старое поведение). Если не нашёл — пробует пользовательский по
 *     namespace владельца / public. Аноним получает только системный
 *     путь (UserCoursesService требует userId, для null — пропускаем).
 *
 * Эти расширения нужны, чтобы фронт после Phase D ходил единым URL'ом
 * `/lessons/courses[/:slug]` и для системных, и для пользовательских.
 */
@UseGuards(JwtAuthGuard)
@Controller('lessons/courses')
export class CoursesController {
  constructor(
    private readonly coursesService: CoursesService,
    private readonly userCoursesService: UserCoursesService,
  ) {}

  /**
   * GET /api/lessons/courses — listing.
   *   - без `?mine=…` → системные курсы + рекомендация уровня (как раньше).
   *   - `?mine=1` (или alias `?mine=true`/без значения) — свои
   *     пользовательские курсы.
   *   - `?mine=0` (или `?mine=false`) — публичные пользовательские.
   */
  @Get()
  list(
    @Request() req: AuthenticatedRequest,
    @Query() query: ListUserCoursesQueryDto,
  ) {
    if (query.mine !== undefined) {
      const minePath = query.mine !== '0' && query.mine !== 'false';
      return this.userCoursesService.list(req.user.id, {
        mine: minePath,
        limit: query.limit,
        offset: query.offset,
      });
    }
    return this.coursesService.listCourses(req.user?.id ?? null);
  }

  /**
   * GET /api/lessons/courses/:slug — курс с блоками/уроками.
   * Сначала ищет системный, при отсутствии — пользовательский (для
   * залогиненных).
   */
  @Get(':slug')
  async getBySlug(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
  ) {
    const userId = req.user?.id ?? null;
    try {
      return await this.coursesService.getCourseBySlug(slug, userId);
    } catch (e) {
      if (!(e instanceof NotFoundException) || userId === null) {
        throw e;
      }
      // Fallback: пользовательский курс в namespace владельца / public.
      return this.userCoursesService.getBySlug(userId, slug);
    }
  }
}
