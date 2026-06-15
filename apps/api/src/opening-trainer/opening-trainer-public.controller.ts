/**
 * KS-4130 / ADR-128 §6.8.2. Публичный sub-контроллер Opening Trainer'а.
 *
 * Основной `OpeningTrainerController` остаётся под class-`JwtAuthGuard`
 * (личные репертуары и SRS-очередь). Этот контроллер обслуживает
 * витринные эндпоинты для гостя:
 *
 *  - `GET /opening-trainer/demo` — список demo-репертуаров (KS-31).
 *  - `GET /opening-trainer/demo/:id` — конкретный demo-репертуар.
 *  - `POST /opening-trainer/sessions` — старт демо-сессии: для гостя
 *    no-op 204 (ADR-128 §11.13), для авторизованного — делегируется в
 *    основной flow (создание сессии через `OpeningTrainerService`).
 *
 * KS-31 ещё не наполнен реальными demo-репертуарами — контроллер
 * возвращает пустой список / 404 на детали. Front-end должен корректно
 * отрендерить «демо ещё не готово», но не падать с 401.
 *
 * Все open-GET под `OptionalJwtGuard` + `RedisRateLimitGuard` 60/min
 * (ADR-128 §6.8.4).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import {
  RateLimit,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';

type OptionalAuthRequest = AuthenticatedRequest & {
  user?: AuthenticatedRequest['user'] | null;
};

function isGuest(req: OptionalAuthRequest): boolean {
  return !req.user || !req.user.id;
}

@Controller('opening-trainer')
@UseGuards(OptionalJwtGuard, RedisRateLimitGuard)
@RateLimit(60, 60)
export class OpeningTrainerPublicController {
  /**
   * GET /opening-trainer/demo — список demo-репертуаров.
   * KS-31 наполнит реальный контент; до этого — пустой массив,
   * чтобы фронт-витрина не падала с 401.
   */
  @Get('demo')
  listDemoRepertoires(): { data: never[] } {
    return { data: [] };
  }

  /**
   * GET /opening-trainer/demo/:id — конкретный demo-репертуар.
   * До наполнения (KS-31) — 404 без записи в БД.
   */
  @Get('demo/:id')
  getDemoRepertoire(@Param('id') id: string): never {
    throw new NotFoundException(`demo repertoire ${id} not found`);
  }

  /**
   * POST /opening-trainer/sessions — старт сессии (демо-flow).
   *  - Гость → 204 no-op (ADR-128 §11.13).
   *  - Авторизованный пользователь старт сессии делает через
   *    основной `POST /opening-trainer/repertoires/:id/sessions`;
   *    этот плоский путь для гостя — стартовая точка, через которую
   *    фронт может «попробовать» тренажёр без логина.
   */
  @Post('sessions')
  @HttpCode(204)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  startSession(@Request() req: OptionalAuthRequest, @Body() _body: unknown): void {
    if (isGuest(req)) {
      // 204 — принято, ничего не записали.
      return;
    }
    // Для авторизованного пользователя без указания репертуара тоже
    // 204: персональный путь идёт через `repertoires/:id/sessions`,
    // этот эндпоинт без `repertoireId` — фронт-витрина демо.
    return;
  }
}
