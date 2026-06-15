/**
 * KS-4160 + KS-4162 / ADR-128 §6.8.2 + §10 + §11.13. Публичный
 * sub-контроллер Opening Trainer'а. Основной `OpeningTrainerController`
 * остаётся под class-`JwtAuthGuard` (личные репертуары и SRS-очередь).
 * Этот контроллер обслуживает витринные эндпоинты для гостя:
 *
 *  - `GET /opening-trainer/demo` — список demo-репертуаров.
 *  - `GET /opening-trainer/demo/:id` — конкретный demo-репертуар
 *    (`OpeningRepertoireDetailDto`, та же форма, что у личного).
 *  - `POST /opening-trainer/sessions` — 204 no-op (ADR-128 §11.13).
 *
 * По §6.8.2 контроллер без class-guard — `JwtAuthGuard`/`OptionalJwtGuard`
 * не вешаются (это публичные данные, не зависят от user-id, ADR-128 §11.12).
 * Class-level guard оставлен только для rate-limit: 60 req/min на IP
 * (§6.8.4).
 *
 * Источник данных — `DemoRepertoireSeedService` (KS-4162): seed-PGN
 * в `seeds/demo-repertoires/*.pgn`, парсится общим
 * `RepertoireBuilderService.buildTree(pgn)`. С пустой директорией
 * `/demo` отдаёт `[]`, `/demo/:id` — 404.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  RateLimit,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
import { type OpeningRepertoireDetailDto } from '@kingside/shared';
import {
  DemoRepertoireSeedService,
  type DemoRepertoireSummary,
} from './demo-repertoire-seed.service';

@Controller('opening-trainer')
@UseGuards(RedisRateLimitGuard)
@RateLimit(60, 60)
export class OpeningTrainerPublicController {
  constructor(private readonly demoSeed: DemoRepertoireSeedService) {}

  /**
   * GET /opening-trainer/demo — список demo-репертуаров.
   * Прямой массив (ADR-128 §6.8.2), не `{ data: [...] }`.
   */
  @Get('demo')
  listDemoRepertoires(): DemoRepertoireSummary[] {
    return this.demoSeed.listSummaries();
  }

  /**
   * GET /opening-trainer/demo/:id — конкретный demo-репертуар.
   * Возвращает `OpeningRepertoireDetailDto` (та же форма, что для
   * личного `GET /opening-trainer/repertoires/:id`). Слаг не найден — 404.
   */
  @Get('demo/:id')
  getDemoRepertoire(@Param('id') id: string): OpeningRepertoireDetailDto {
    const detail = this.demoSeed.getDetail(id);
    if (!detail) {
      throw new NotFoundException(`demo repertoire ${id} not found`);
    }
    return detail;
  }

  /**
   * POST /opening-trainer/sessions — старт демо-сессии.
   * Гость → 204 no-op (ADR-128 §11.13). Авторизованный flow личных
   * репертуаров идёт через `POST /opening-trainer/repertoires/:id/sessions`
   * (основной контроллер под JwtAuthGuard); этот плоский путь — точка
   * входа для гостя, чтобы «попробовать» тренажёр без логина.
   */
  @Post('sessions')
  @HttpCode(204)
  startSession(@Body() _body: unknown): void {
    // 204 No Content — ничего не записываем, сессии для гостей
    // живут в localStorage (см. ADR-128 §11.12).
    return;
  }
}
