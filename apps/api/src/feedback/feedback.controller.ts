import {
  Body, Controller, DefaultValuePipe, Delete, ForbiddenException, Get,
  Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Request, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { RedisService } from '../redis/redis.service';
import { FeedbackService } from './feedback.service';
import { CreateFeedbackDto } from './dto/create-feedback.dto';

const RATE_LIMIT_PER_MIN = 5;

@Controller('feedback')
export class FeedbackController {
  constructor(
    private readonly feedbackService: FeedbackService,
    private readonly redis: RedisService,
  ) {}

  @UseGuards(OptionalJwtGuard)
  @Post()
  async create(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateFeedbackDto,
  ) {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const key = `feedback:rate:${ip}`;
    const count = parseInt((await this.redis.get(key)) ?? '0', 10);
    if (count >= RATE_LIMIT_PER_MIN) {
      throw new ForbiddenException('Too many submissions. Try again in a minute.');
    }
    await this.redis.set(key, String(count + 1), 'EX', 60);

    return this.feedbackService.create({
      userId: req.user?.id, email: dto.email, title: dto.title,
      type: dto.type, message: dto.message, page: dto.page,
      userAgent: req.headers['user-agent'] as string, isPublic: dto.isPublic,
    });
  }

  @UseGuards(OptionalJwtGuard)
  @Get()
  list(
    @Request() req: AuthenticatedRequest,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('sort') sort?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.feedbackService.list({ type, status, sort, limit, offset, userId: req.user?.id });
  }

  @UseGuards(OptionalJwtGuard)
  @Get(':id')
  getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.feedbackService.getOne(id, req.user?.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/comments')
  addComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
    @Body() body: { message: string },
  ) {
    return this.feedbackService.addComment(id, req.user.id, body.message);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/vote')
  toggleVote(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.feedbackService.toggleVote(id, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  deleteFeedback(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.feedbackService.deleteFeedback(id, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('comments/:id')
  deleteComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.feedbackService.deleteComment(id, req.user.id);
  }
}
