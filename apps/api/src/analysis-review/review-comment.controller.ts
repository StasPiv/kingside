/**
 * KS-3615 / ADR-102 §8 B-этап. REST-контроллер LLM-комментариев к ходам.
 *
 *   POST /api/analyses/review/comments
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
 *
 * KS-3615 follow-up (404 fix): путь изменён с `analysis-review` на
 * `analyses/review` — стартовая попытка с верхнеуровневым именем
 * `/api/analysis-review/comments` отдавала 404 на проде (прокси/ALB
 * пропускает в api только пути из whitelist'а под уже существующими
 * корнями типа `analyses`, `users`, `auth` и т.п.). Размещение под
 * `analyses/review` использует существующий разрешённый префикс.
 */
import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { BatchCommentDto } from './dto/batch-comment.dto';
import { ReviewCommentService } from './review-comment.service';

@Controller('analyses/review')
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
