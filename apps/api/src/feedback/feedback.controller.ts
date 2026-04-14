import { Body, Controller, ForbiddenException, Post, Request, UseGuards } from '@nestjs/common';
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
    // Rate limit by IP
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const key = `feedback:rate:${ip}`;
    const count = parseInt((await this.redis.get(key)) ?? '0', 10);
    if (count >= RATE_LIMIT_PER_MIN) {
      throw new ForbiddenException('Too many feedback submissions. Try again in a minute.');
    }
    await this.redis.set(key, String(count + 1), 'EX', 60);

    return this.feedbackService.create({
      userId: req.user?.id,
      email: dto.email,
      type: dto.type,
      message: dto.message,
      page: dto.page,
      userAgent: req.headers['user-agent'] as string,
    });
  }
}
