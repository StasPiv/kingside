import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { TournamentService } from './tournament.service';
import { RedisRateLimitGuard, RateLimit } from '../common/redis-rate-limit.guard';

@UseGuards(RedisRateLimitGuard)
@RateLimit(60, 60)
@Controller('tournaments')
export class TournamentController {
  constructor(private readonly tournamentService: TournamentService) {}

  @Get('top-active')
  getTopActive(): Promise<any[]> {
    return this.tournamentService.getTopActiveTournaments();
  }

  @Get('live')
  getLiveTournaments(@Query('status') status?: string) {
    return this.tournamentService.getLiveTournaments(status);
  }
}
