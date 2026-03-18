import { Controller, Get, Param, Logger } from '@nestjs/common';
import { ChessResultsService, ChessResultsTournament } from './chess-results.service';

@Controller('chess-results')
export class ChessResultsController {
  private readonly logger = new Logger(ChessResultsController.name);

  constructor(private readonly chessResults: ChessResultsService) {}

  /** GET /api/chess-results/scan — scan for livechesscloud links in current tournaments */
  @Get('scan')
  async scan(): Promise<{ data: ChessResultsTournament[] }> {
    const data = await this.chessResults.scanCurrentTournaments();
    return { data };
  }

  /** GET /api/chess-results/tournament/:id — parse a specific tournament */
  @Get('tournament/:id')
  async parseTournament(
    @Param('id') id: string,
  ): Promise<ChessResultsTournament | { livechessUuids: string[] }> {
    const result = await this.chessResults.parseTournament(id);
    return result ?? { livechessUuids: [] };
  }
}
