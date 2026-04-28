import {
  Controller,
  Get,
  Headers,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CoursesService } from './courses.service';

/**
 * KS-2095: единый помощник резолвинга `lang` для эндпоинтов курсов.
 *
 * Приоритет:
 *   1) явный query-параметр `?lang=` (frontend будет всегда передавать);
 *   2) `Accept-Language` заголовок (фолбэк для прямых запросов / curl);
 *   3) дефолт 'ru'.
 *
 * Поддерживается ограниченный whitelist: 'ru' | 'en'. Остальные значения
 * сводятся к 'ru' — иначе пользователь, прислав случайную строку, получил
 * бы пустой список курсов и решил, что фича сломана.
 */
const SUPPORTED_LANGS: ReadonlyArray<string> = ['ru', 'en'];
function resolveLang(
  query: string | undefined,
  acceptLanguage: string | undefined,
): string {
  if (query && SUPPORTED_LANGS.includes(query)) return query;
  if (acceptLanguage) {
    // Берём первый язык-приоритет: `en-US,en;q=0.9,ru;q=0.8` → 'en'.
    const primary = acceptLanguage.split(',')[0]?.split('-')[0]?.trim().toLowerCase();
    if (primary && SUPPORTED_LANGS.includes(primary)) return primary;
  }
  return 'ru';
}

@UseGuards(JwtAuthGuard)
@Controller('lessons/courses')
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  /** GET /api/lessons/courses — список курсов + рекомендация уровня. */
  @Get()
  list(
    @Request() req: AuthenticatedRequest,
    @Query('lang') queryLang?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const lang = resolveLang(queryLang, acceptLanguage);
    return this.coursesService.listCourses(req.user?.id ?? null, lang);
  }

  /** GET /api/lessons/courses/:slug — курс с блоками/уроками. */
  @Get(':slug')
  getBySlug(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Query('lang') queryLang?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const lang = resolveLang(queryLang, acceptLanguage);
    return this.coursesService.getCourseBySlug(slug, req.user?.id ?? null, lang);
  }
}
