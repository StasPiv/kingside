import { Controller, Get, Param, Query } from '@nestjs/common';
import { PlayerService } from './player.service';
import { TopPlayersDto } from './dto/top-players.dto';
import { OnlinePlayersDto } from './dto/online-players.dto';
import { SearchPlayersDto } from './dto/search-players.dto';

@Controller('players')
export class PlayerController {
  constructor(private readonly playerService: PlayerService) {}

  @Get('top')
  getTopPlayers(@Query() dto: TopPlayersDto) {
    return this.playerService.getTopPlayers(dto.type, dto.limit, dto.offset);
  }

  @Get('online')
  getOnlinePlayers(@Query() dto: OnlinePlayersDto) {
    return this.playerService.getOnlinePlayers(dto.limit, dto.offset);
  }

  @Get('search')
  searchPlayers(@Query() dto: SearchPlayersDto) {
    return this.playerService.searchPlayers(dto.q, dto.limit);
  }

  @Get(':username')
  getPlayerProfile(@Param('username') username: string) {
    return this.playerService.getPlayerProfile(username);
  }
}
