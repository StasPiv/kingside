/**
 * KS-3409 / ADR-086 §9 B2. REST-endpoints guess-the-move.
 *
 * KS-4130 / ADR-128 §6.8.2: class-level `JwtAuthGuard` снят. Auth
 * вешается per-method:
 *  - Write-ручки (`POST /sessions`, `POST /sessions/:id/move`,
 *    `POST /sessions/:id/finish`, `POST /sessions/:id/to-analysis`):
 *    `OptionalJwtGuard`. Гость → 204 No Content без записи в БД
 *    (ADR-128 §11.13: PF-write no-op для гостя).
 *  - `GET /sessions/:id` (review): `OptionalJwtGuard`. Гость → 404
 *    (личная сессия, гость не должен узнать о её существовании).
 *  - Личные read-ручки (`GET /history`, `/stats/me`, `/trends/me`,
 *    `/breakdowns/me`) и `DELETE /sessions/:id`: `JwtAuthGuard`.
 */
import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { GuessService } from './guess.service';
import { StartGuessSessionDto, SubmitGuessMoveDto } from './dto/guess.dto';

/** Выбор языка для i18n: ru при начальном `ru`, иначе en. */
function pickLang(acceptLanguage?: string): string {
  if (!acceptLanguage) return 'en';
  const first = acceptLanguage.split(',')[0]?.trim().toLowerCase() ?? '';
  if (first.startsWith('ru')) return 'ru';
  return 'en';
}

/**
 * KS-4130: req.user заполняется `OptionalJwtGuard`. Для гостя =
 * `null`/`undefined`. Для авторизованного — объект Passport с `id`.
 */
type OptionalAuthRequest = AuthenticatedRequest & {
  user?: AuthenticatedRequest['user'] | null;
};

function isGuest(req: OptionalAuthRequest): boolean {
  return !req.user || !req.user.id;
}

@Controller('guess')
export class GuessController {
  constructor(private readonly guess: GuessService) {}

  /**
   * POST /guess/sessions — старт сессии.
   * Гость → 204 (ADR-128 §11.13).
   */
  @Post('sessions')
  @UseGuards(OptionalJwtGuard)
  @HttpCode(200)
  async start(
    @Request() req: OptionalAuthRequest,
    @Body() dto: StartGuessSessionDto,
  ) {
    if (isGuest(req)) {
      // KS-4130: PF-write для гостя — no-op. Возвращаем 204 как
      // унифицированный сигнал «принято, ничего не записали».
      return undefined;
    }
    return this.guess.startSession(req.user!.id, dto);
  }

  /** POST /guess/sessions/:id/move — ход пользователя (server-trust). */
  @Post('sessions/:id/move')
  @UseGuards(OptionalJwtGuard)
  async move(
    @Request() req: OptionalAuthRequest,
    @Param('id') id: string,
    @Body() dto: SubmitGuessMoveDto,
  ) {
    if (isGuest(req)) return undefined;
    return this.guess.submitMove(req.user!.id, id, dto);
  }

  /** POST /guess/sessions/:id/finish — финал (две точности + звёзды). */
  @Post('sessions/:id/finish')
  @UseGuards(OptionalJwtGuard)
  async finish(@Request() req: OptionalAuthRequest, @Param('id') id: string) {
    if (isGuest(req)) return undefined;
    return this.guess.finish(req.user!.id, id);
  }

  /**
   * KS-3460 / ADR-089 §6.1. POST /guess/sessions/:id/to-analysis —
   * создать Analysis с NAG-аннотациями. Идемпотентно: повторный клик
   * возвращает existing. Локализация комментариев через i18next: язык
   * берётся из заголовка `Accept-Language` (ru | en), дефолт en.
   */
  @Post('sessions/:id/to-analysis')
  @UseGuards(OptionalJwtGuard)
  async toAnalysis(
    @Request() req: OptionalAuthRequest,
    @Param('id') id: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    if (isGuest(req)) return undefined;
    const lang = pickLang(acceptLanguage);
    return this.guess.toAnalysis(req.user!.id, id, lang);
  }

  /**
   * GET /guess/sessions/:id — review (сессия + ходы).
   * Гость → 404 (сессия личная, не светим существование).
   */
  @Get('sessions/:id')
  @UseGuards(OptionalJwtGuard)
  review(@Request() req: OptionalAuthRequest, @Param('id') id: string) {
    if (isGuest(req)) {
      throw new NotFoundException('guess session not found');
    }
    return this.guess.getSession(req.user!.id, id);
  }

  /** GET /guess/history?limit=&offset= — список сессий пользователя. */
  @Get('history')
  @UseGuards(JwtAuthGuard)
  history(
    @Request() req: AuthenticatedRequest,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.guess.history(req.user.id, limit, offset);
  }

  /** KS-3508. GET /guess/stats/me — личная статистика. */
  @Get('stats/me')
  @UseGuards(JwtAuthGuard)
  statsMe(@Request() req: AuthenticatedRequest) {
    return this.guess.statsForUser(req.user.id);
  }

  /** KS-3508. GET /guess/trends/me?bucket=day|week|month (default week). */
  @Get('trends/me')
  @UseGuards(JwtAuthGuard)
  trendsMe(
    @Request() req: AuthenticatedRequest,
    @Query('bucket') bucket?: string,
  ) {
    return this.guess.trendsForUser(req.user.id, bucket);
  }

  /** KS-3508. GET /guess/breakdowns/me — verdict + userClass distribution. */
  @Get('breakdowns/me')
  @UseGuards(JwtAuthGuard)
  breakdownsMe(@Request() req: AuthenticatedRequest) {
    return this.guess.breakdownsForUser(req.user.id);
  }

  /**
   * KS-3530. DELETE /guess/sessions/:id — удалить guess-сессию (cascade
   * GuessMove). Analysis с привязкой `guessSessionId` НЕ трогается.
   * Owner-check встроен; 204 No Content при успехе.
   */
  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async deleteSession(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.guess.deleteSession(req.user.id, id);
  }
}
