import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LessonPuzzleResolverService } from './puzzle-resolver.service';
import { PuzzleStepPayloadDto } from './dto/step-payload.dto';

/**
 * KS-1777: REST-эндпоинт для батч-резолва `PuzzleStep` из урока.
 *
 * Фронт для `selection.mode='filter'` ранее делал несколько одиночных
 * `GET /api/puzzles/next` с дедупом, что было неэффективно. Теперь можно
 * одним запросом получить полный список задач в рамках шага.
 *
 * Эндпоинт — `POST`, потому что тело — `PuzzleStepPayload` (сложный
 * discriminated union, не кладётся в query-параметры).
 */
@UseGuards(JwtAuthGuard)
@Controller('lessons/puzzle-step')
export class PuzzleResolverController {
  constructor(private readonly resolver: LessonPuzzleResolverService) {}

  /**
   * POST /api/lessons/puzzle-step/resolve — вернуть список задач по payload'у.
   *
   * Валидацию shape'а делает global `ValidationPipe` + class-validator в
   * `PuzzleStepPayloadDto` (IsIn(['puzzle']), @ValidateNested на selection
   * и т. п.). Левый type или некорректный селектор → 400 автоматически.
   */
  @Post('resolve')
  resolve(@Body() payload: PuzzleStepPayloadDto) {
    return this.resolver.resolve(payload);
  }
}
