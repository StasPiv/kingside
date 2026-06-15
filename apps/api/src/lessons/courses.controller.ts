import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Request,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import {
  RateLimit,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
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
 * расширены поддержкой пользовательских курсов.
 *
 * KS-4130 / ADR-128 §6.8.2: class-level `JwtAuthGuard` снят. Per-method:
 *  - `GET /lessons/courses` (без `?mine=…`) → `OptionalJwtGuard` +
 *    rate-limit 60 req/min. Каталог системных курсов открыт гостю.
 *  - `GET /lessons/courses?mine=…` → требует логин (`?mine=…` =
 *    личное listing'и пользовательских курсов).
 *  - `GET /lessons/courses/enrolled` → `JwtAuthGuard` (личный прогресс).
 *  - `GET /lessons/courses/:slug` → `OptionalJwtGuard` + rate-limit.
 *    Аноним получает только системный путь; fallback в пользовательский
 *    namespace — для залогиненных.
 */
@Controller('lessons/courses')
export class CoursesController {
  constructor(
    private readonly coursesService: CoursesService,
    private readonly userCoursesService: UserCoursesService,
  ) {}

  /**
   * GET /api/lessons/courses — listing.
   *   - без `?mine=…` → системные курсы + рекомендация уровня (открыт гостю).
   *   - `?mine=1` (или alias `?mine=true`/без значения) — свои
   *     пользовательские курсы (требует логин).
   *   - `?mine=0` (или `?mine=false`) — публичные пользовательские
   *     (требует логин — listing личной библиотеки чужих публичных).
   */
  @Get()
  @UseGuards(OptionalJwtGuard, RedisRateLimitGuard)
  @RateLimit(60, 60)
  list(
    @Request() req: AuthenticatedRequest,
    @Query() query: ListUserCoursesQueryDto,
  ) {
    if (query.mine !== undefined) {
      if (!req.user?.id) {
        throw new UnauthorizedException('login required for ?mine= filter');
      }
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
   * GET /api/lessons/courses/enrolled — KS-2646 / ADR-054 Phase D fix.
   * «Курсы, которые я прохожу» — чужие пользовательские курсы, по
   * которым у меня есть прогресс. Объявлен **до** `@Get(':slug')` —
   * иначе Express матчит `enrolled` как параметр slug. Личный
   * прогресс — `JwtAuthGuard`.
   */
  @Get('enrolled')
  @UseGuards(JwtAuthGuard)
  listEnrolled(@Request() req: AuthenticatedRequest) {
    return this.userCoursesService.listEnrolled(req.user.id);
  }

  /**
   * GET /api/lessons/courses/:slug — курс с блоками/уроками.
   * Сначала ищет системный, при отсутствии — пользовательский (для
   * залогиненных).
   *
   * KS-4130: гостю отдаётся системный курс. Если не нашёлся системный —
   * 404 (fallback в user-courses только для авторизованных).
   */
  @Get(':slug')
  @UseGuards(OptionalJwtGuard, RedisRateLimitGuard)
  @RateLimit(60, 60)
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
