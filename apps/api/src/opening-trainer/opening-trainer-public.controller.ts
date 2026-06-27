/**
 * KS-4160 + KS-4162 + KS-4674 / ADR-128 §6.8.2 + §10 + §11.13 + ADR-146.
 * Публичный sub-контроллер Opening Trainer'а:
 *
 *  - `GET /opening-trainer/demo` — список demo-репертуаров.
 *  - `GET /opening-trainer/demo/:id` — конкретный demo-репертуар
 *    (`OpeningRepertoireDetailDto`, та же форма, что у личного).
 *  - `POST /opening-trainer/sessions` — 204 no-op (ADR-128 §11.13).
 *
 * KS-4674: источник данных переехал с in-memory file-registry
 * (`DemoRepertoireSeedService`) в БД — `OpeningTrainerDemoService`
 * читает `opening_repertoires WHERE is_demo=true AND is_published=true`.
 * Контракт ответа DTO не изменился — URL-`id` это `slug`, ownerId —
 * sentinel NIL UUID (см. сервис).
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
  DemoRepertoireSummary,
  OpeningTrainerDemoService,
} from './opening-trainer-demo.service';

@Controller('opening-trainer')
@UseGuards(RedisRateLimitGuard)
@RateLimit(60, 60)
export class OpeningTrainerPublicController {
  constructor(private readonly demo: OpeningTrainerDemoService) {}

  /**
   * GET /opening-trainer/demo — список demo-репертуаров.
   * Прямой массив (ADR-128 §6.8.2), не `{ data: [...] }`.
   */
  @Get('demo')
  listDemoRepertoires(): Promise<DemoRepertoireSummary[]> {
    return this.demo.listSummaries();
  }

  /**
   * GET /opening-trainer/demo/:id — конкретный demo-репертуар.
   * `:id` это slug (URL-семантика, backward-compat с KS-4162). Не найден
   * или не опубликован → 404.
   */
  @Get('demo/:id')
  async getDemoRepertoire(
    @Param('id') id: string,
  ): Promise<OpeningRepertoireDetailDto> {
    const detail = await this.demo.getDetail(id);
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
