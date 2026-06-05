/**
 * KS-3711. REST-контроллер LLM-комментариев одного хода в режиме
 * «Полный разбор партии». Заменяет пакетный `/analyses/review/comments`
 * (старый эндпоинт остаётся рабочим до миграции фронта в KS-3712).
 *
 *   POST /api/analyses/review/move-comment
 *   Body: MoveCommentDto { move, before, after, language }
 *   Auth: JWT.
 *   Response: PositionCommentResponse { comment, highlights, arrows }
 *     — тот же контракт, что у `/analyses/position/comment`
 *     (KS-3690 / ADR-108b §6.2).
 *   Errors:
 *     400 — невалидный body (class-validator),
 *     401 — нет JWT,
 *     429 — превышен rate-limit (per-minute / per-day / global).
 *
 * 5xx при сбое webhook'а наружу не отдаём — сервис деградирует до
 * пустого ответа `{comment: '', highlights: [], arrows: []}` (фронт
 * рендерит пустой комментарий, не падает).
 *
 * Rate-limit ДО вызова webhook'а — экономия квоты на запрещённый
 * запрос (см. `MoveCommentService.checkRateLimit`).
 */
import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import type { PositionCommentResponse } from '@kingside/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { MoveCommentDto } from './dto/move-comment.dto';
import { MoveCommentService } from './move-comment.service';

@Controller('analyses/review')
@UseGuards(JwtAuthGuard)
export class MoveCommentController {
  constructor(private readonly svc: MoveCommentService) {}

  @Post('move-comment')
  async moveComment(
    @Request() req: AuthenticatedRequest,
    @Body() dto: MoveCommentDto,
  ): Promise<PositionCommentResponse> {
    await this.svc.checkRateLimit(req.user.id);
    await this.svc.incrementRateLimit(req.user.id);

    return this.svc.comment(req.user.id, dto);
  }
}
