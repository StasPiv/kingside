import { Controller, Get } from '@nestjs/common';
import { TournamentService } from './tournament.service';

@Controller('tournaments')
export class TournamentController {
  constructor(private readonly tournamentService: TournamentService) {}

  @Get('top-active')
  getTopActive(): Promise<any[]> {
    return this.tournamentService.getTopActiveTournaments();
  }

  @Get('live')
  getLiveTournaments() {
    return this.tournamentService.getLiveTournaments();
  }
}
