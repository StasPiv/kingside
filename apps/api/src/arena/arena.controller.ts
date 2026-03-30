import { Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { ArenaService } from './arena.service';
import { RoundManagerService } from './round-manager.service';

@Controller('arena')
export class ArenaController {
  constructor(
    private readonly arena: ArenaService,
    private readonly roundManager: RoundManagerService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  create(
    @Request() req: AuthenticatedRequest,
    @Body() body: {
      name: string;
      timeInitialSec: number;
      timeIncrementSec: number;
      durationMin: number;
      startsAt: string;
    },
  ) {
    return this.arena.create(req.user.id, body);
  }

  @Get()
  findAll(@Query('status') status?: string) {
    return this.arena.findAll(status);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.arena.findOne(id);
  }

  @Get(':id/standings')
  getStandings(@Param('id', ParseUUIDPipe) id: string) {
    return this.arena.getStandings(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/join')
  join(@Request() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.arena.join(id, req.user.id);
  }

  @Get(':id/rounds')
  getRounds(@Param('id', ParseUUIDPipe) id: string) {
    return this.roundManager.getRounds(id);
  }

  @Get(':id/rounds/:n')
  getRound(@Param('id', ParseUUIDPipe) id: string, @Param('n', ParseIntPipe) n: number) {
    return this.roundManager.getRound(id, n);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/start-round')
  startRound(@Param('id', ParseUUIDPipe) id: string) {
    return this.roundManager.startNextRound(id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  delete(@Request() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.arena.delete(id, req.user.id);
  }
}
