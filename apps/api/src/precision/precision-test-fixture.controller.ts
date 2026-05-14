/**
 * KS-3029. Dev-only endpoint для e2e KS-3007: создание
 * precision-attempt с произвольными WDL/cp БЕЗ chess.js валидации.
 *
 * Защита:
 *  - `DevOnlyGuard`: на проде вернёт 404 (endpoint выглядит как
 *    несуществующий, не светим скрытую функциональность).
 *  - `JwtAuthGuard`: требуется аутентификация (берём userId из JWT).
 *    Это нужно, чтобы fixture-attempt принадлежал реальному dev-юзеру
 *    и подгружался обычными `/precision/attempts/me` listing'ами.
 *
 * Путь `_test_fixture` с префиксом `_` — конвенция «технический,
 * не публичный» (mirroring `_mcp/tools`, `_health`).
 */
import {
  Body,
  Controller,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { PrecisionService } from './precision.service';
import { DevOnlyGuard } from './dev-only.guard';
import { CreateTestFixtureAttemptDto } from './dto/test-fixture.dto';

@Controller('precision/attempts')
export class PrecisionTestFixtureController {
  constructor(private readonly precision: PrecisionService) {}

  @UseGuards(DevOnlyGuard, JwtAuthGuard)
  @Post('_test_fixture')
  async createFixture(
    @Request() req: AuthenticatedRequest,
    @Body() body: CreateTestFixtureAttemptDto,
  ): Promise<{
    attemptId: string;
    score: number | null;
    scorePct: number | null;
  }> {
    return this.precision.createTestFixtureAttempt({
      userId: req.user.id,
      body,
    });
  }
}
