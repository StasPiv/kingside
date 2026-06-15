/**
 * KS-4160 / ADR-128 §6.8.2 + §11.13. Публичный sub-контроллер
 * Opening Trainer'а. Основной `OpeningTrainerController` остаётся под
 * class-`JwtAuthGuard` (личные репертуары и SRS-очередь). Этот
 * контроллер обслуживает витринные эндпоинты для гостя:
 *
 *  - `GET /opening-trainer/demo` — список demo-репертуаров (KS-31).
 *  - `GET /opening-trainer/demo/:id` — конкретный demo-репертуар.
 *  - `POST /opening-trainer/sessions` — 204 no-op (ADR-128 §11.13).
 *
 * По §6.8.2 контроллер без class-guard — `JwtAuthGuard`/`OptionalJwtGuard`
 * не вешаются (это публичные данные, не зависят от user-id, ADR-128 §11.12).
 * Class-level guard оставлен только для rate-limit: 60 req/min на IP
 * (§6.8.4).
 *
 * KS-31 (контент демо-репертуаров) ещё не выполнен — `/demo` возвращает
 * пустой массив, `/demo/:id` — 404. Фронт (KS-4161) должен отрендерить
 * «демо ещё не готово», не падая с 401.
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

/**
 * Карточка демо-репертуара для list-эндпоинта.
 * Поля соответствуют требованиям KS-4160 (id, title, description,
 * языки, длина дерева) и совместимы с публичной выдачей.
 */
export interface DemoRepertoireSummary {
  id: string;
  title: string;
  description: string;
  languages: string[];
  /** Количество узлов в дереве. */
  treeSize: number;
}

@Controller('opening-trainer')
@UseGuards(RedisRateLimitGuard)
@RateLimit(60, 60)
export class OpeningTrainerPublicController {
  /**
   * GET /opening-trainer/demo — список demo-репертуаров.
   * До KS-31 (seed-контент) — пустой массив (200 OK).
   * Контракт: массив, не `{ data: [...] }` (ADR-128 §6.8.2).
   */
  @Get('demo')
  listDemoRepertoires(): DemoRepertoireSummary[] {
    return [];
  }

  /**
   * GET /opening-trainer/demo/:id — конкретный demo-репертуар.
   * До KS-31 — 404 на любой id (записи в БД нет, seed-файлов нет).
   */
  @Get('demo/:id')
  getDemoRepertoire(@Param('id') id: string): never {
    throw new NotFoundException(`demo repertoire ${id} not found`);
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
