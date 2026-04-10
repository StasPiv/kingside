import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateGameWithBotDto, SaveAnalysisDto } from './dto/game.dto';
import { LiveGamesDto } from './dto/live-games.dto';
import { RedisRateLimitGuard, RateLimit } from '../common/redis-rate-limit.guard';
import { GameService } from './game.service';
import { GameReportService } from './game-report.service';
import { LiveGameService } from './live-game.service';
import { UserService } from '../user/user.service';

@Controller('games')
export class GameController {
  constructor(
    private readonly gameService: GameService,
    private readonly gameReportService: GameReportService,
    private readonly liveGameService: LiveGameService,
    private readonly userService: UserService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('active')
  async getActiveGame(@Request() req: AuthenticatedRequest) {
    return this.gameService.getActiveGameForUser(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('my')
  getMyGames(
    @Request() req: AuthenticatedRequest,
    @Query('take', new DefaultValuePipe(20), ParseIntPipe) take: number,
    @Query('skip', new DefaultValuePipe(0), ParseIntPipe) skip: number,
  ) {
    return this.userService.getUserGames(req.user.id, { take, skip });
  }

  @Get('live')
  @UseGuards(RedisRateLimitGuard)
  @RateLimit(60, 60)
  getLiveGames(@Query() dto: LiveGamesDto) {
    return this.liveGameService.getLiveGames(dto.type, dto.player, dto.limit, dto.offset);
  }

  @Get('live/count')
  @UseGuards(RedisRateLimitGuard)
  @RateLimit(120, 60)
  getLiveCount() {
    return this.liveGameService.getLiveCount();
  }

  @UseGuards(JwtAuthGuard)
  @Post('bot')
  createGameWithBot(@Request() req: AuthenticatedRequest, @Body() dto: CreateGameWithBotDto) {
    return this.gameService.createGameWithBot(
      req.user.id,
      dto.color,
      dto.botLevel,
      dto.timeControl,
    );
  }

  @Get(':id')
  getGame(@Param('id', ParseUUIDPipe) id: string) {
    return this.gameService.getGame(id);
  }

  @Get(':id/moves')
  getGameMoves(@Param('id', ParseUUIDPipe) id: string) {
    return this.gameService.getGameMoves(id);
  }

  @Get(':id/report')
  getReport(@Param('id', ParseUUIDPipe) id: string) {
    return this.gameReportService.getReport(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/analyze')
  analyzeGame(@Param('id', ParseUUIDPipe) id: string) {
    return this.gameReportService.analyze(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/analysis')
  getAnalysis(@Param('id', ParseUUIDPipe) id: string, @Request() req: AuthenticatedRequest) {
    return this.gameService.getAnalysis(id, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Put(':id/analysis')
  @HttpCode(HttpStatus.NO_CONTENT)
  saveAnalysis(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
    @Body() dto: SaveAnalysisDto,
  ) {
    return this.gameService.saveAnalysis(id, req.user.id, dto.analysisPgn);
  }
}
