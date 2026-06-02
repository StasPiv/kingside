/**
 * KS-3615 / ADR-102 §8 B-этап. REST-контроллер LLM-комментариев к ходам.
 *
 *   POST /api/analysis-review/comments
 *   Body: BatchCommentDto { facts: MoveFactsDto[]; userElo; language; }
 *   Auth: JWT (тот же что вся /api).
 *   Response: { comments: string[] } — длина совпадает с `facts.length`.
 *   Errors:
 *     400 — невалидный body (class-validator),
 *     401 — нет JWT,
 *     429 — превышен rate-limit (per-user или global).
 *
 * Не даём 500 при сбое LLM/webhook — сервис деградирует до пустых
 * комментариев (см. ADR-102 §4.2 «Дефолты»).
 */
import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { BatchCommentDto } from './dto/batch-comment.dto';
import { ReviewCommentService } from './review-comment.service';

@Controller('analysis-review')
@UseGuards(JwtAuthGuard)
export class ReviewCommentController {
  constructor(private readonly svc: ReviewCommentService) {}

  @Post('comments')
  async batchComment(
    @Request() req: AuthenticatedRequest,
    @Body() dto: BatchCommentDto,
  ): Promise<{ comments: string[] }> {
    // Rate-limit ДО вызова webhook'а — иначе зря тратим квоту Pro/Max
    // на запрещённый запрос. checkRateLimit бросает 429 при превышении.
    await this.svc.checkRateLimit(req.user.id);
    await this.svc.incrementRateLimit(req.user.id);

    const comments = await this.svc.batchComment(req.user.id, dto);
    return { comments };
  }
}
