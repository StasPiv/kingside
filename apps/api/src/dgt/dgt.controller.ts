import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { DgtService, DgtTournamentResult, DgtRoundResult } from './dgt.service';

@Controller('dgt')
export class DgtController {
  constructor(private readonly dgtService: DgtService) {}

  @Get('tournament')
  getTournamentByUrl(@Query('url') url: string): Promise<DgtTournamentResult> {
    return this.dgtService.getTournamentInfo(url);
  }

  @Get('tournament/:uuid')
  getTournament(@Param('uuid') uuid: string): Promise<DgtTournamentResult> {
    return this.dgtService.getTournamentInfo(uuid);
  }

  @Get('tournament/:uuid/round/:round')
  getRound(
    @Param('uuid') uuid: string,
    @Param('round', ParseIntPipe) round: number,
  ): Promise<DgtRoundResult> {
    return this.dgtService.getRound(uuid, round);
  }
}
