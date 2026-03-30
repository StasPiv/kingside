import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { ArenaService } from './arena.service';

@Controller('arena')
export class ArenaController {
  constructor(private readonly arena: ArenaService) {}

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

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  delete(@Request() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.arena.delete(id, req.user.id);
  }
}
