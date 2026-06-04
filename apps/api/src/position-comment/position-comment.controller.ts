import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import type { PositionCommentResponse } from '@kingside/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { PositionCommentDto } from './dto/position-comment.dto';
import { PositionCommentService } from './position-comment.service';

@Controller('analyses/position')
@UseGuards(JwtAuthGuard)
export class PositionCommentController {
  constructor(private readonly svc: PositionCommentService) {}

  @Post('comment')
  async comment(
    @Request() req: AuthenticatedRequest,
    @Body() dto: PositionCommentDto,
  ): Promise<PositionCommentResponse> {
    await this.svc.checkRateLimit(req.user.id);
    await this.svc.incrementRateLimit(req.user.id);

    return this.svc.comment(req.user.id, dto);
  }
}
