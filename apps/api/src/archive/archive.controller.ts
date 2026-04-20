import { Controller, Get, Param, Query } from '@nestjs/common';
import type {
  ArchiveGameDetail,
  ArchiveGamesResponse,
  ArchiveTreeResponse,
} from '@kingside/shared';
import { ArchiveService } from './archive.service';
import { ArchiveTreeQueryDto } from './dto/archive-tree-query.dto';
import { ArchiveGamesQueryDto } from './dto/archive-games-query.dto';

@Controller('archive')
export class ArchiveController {
  constructor(private readonly archive: ArchiveService) {}

  @Get('tree')
  getTree(@Query() query: ArchiveTreeQueryDto): Promise<ArchiveTreeResponse> {
    return this.archive.getTree(query);
  }

  @Get('games/:id')
  getGame(@Param('id') id: string): Promise<ArchiveGameDetail> {
    return this.archive.getGameById(id);
  }

  @Get('games')
  getGames(@Query() query: ArchiveGamesQueryDto): Promise<ArchiveGamesResponse> {
    return this.archive.getGames(query);
  }
}
