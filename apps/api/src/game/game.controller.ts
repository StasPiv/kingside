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
import { GameService } from './game.service';
import { UserService } from '../user/user.service';

@Controller('games')
export class GameController {
  constructor(
    private readonly gameService: GameService,
    private readonly userService: UserService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('my')
  getMyGames(
    @Request() req: any,
    @Query('take', new DefaultValuePipe(20), ParseIntPipe) take: number,
    @Query('skip', new DefaultValuePipe(0), ParseIntPipe) skip: number,
  ) {
    return this.userService.getUserGames(req.user.id, { take, skip });
  }

  @UseGuards(JwtAuthGuard)
  @Post('bot')
  createGameWithBot(@Request() req: any, @Body() dto: CreateGameWithBotDto) {
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

  @UseGuards(JwtAuthGuard)
  @Get(':id/analysis')
  getAnalysis(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    return this.gameService.getAnalysis(id, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Put(':id/analysis')
  @HttpCode(HttpStatus.NO_CONTENT)
  saveAnalysis(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
    @Body() dto: SaveAnalysisDto,
  ) {
    return this.gameService.saveAnalysis(id, req.user.id, dto.analysisPgn);
  }
}
