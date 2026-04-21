import { Controller, Get, Param, Query } from '@nestjs/common';
import type {
  ArchiveGameDetail,
  ArchiveGamesByPositionResponse,
  ArchiveGamesResponse,
  ArchiveTreeResponse,
} from '@kingside/shared';
import { ArchiveService } from './archive.service';
import { ArchiveTreeQueryDto } from './dto/archive-tree-query.dto';
import { ArchiveGamesQueryDto } from './dto/archive-games-query.dto';
import { ArchiveGamesByPositionQueryDto } from './dto/archive-games-by-position-query.dto';

@Controller()
export class ArchiveController {
  constructor(private readonly archive: ArchiveService) {}

  @Get('tree')
  getTree(@Query() query: ArchiveTreeQueryDto): Promise<ArchiveTreeResponse> {
    return this.archive.getTree(query);
  }

  /**
   * Games-by-position — keyset-paginated list of games that reached a
   * given position. See ADR-014 §2, §4.1.
   *
   * Declared BEFORE `games/:id` so Nest routes `by-position` as a
   * literal path segment, not a `:id` match.
   */
  @Get('games/by-position')
  getGamesByPosition(
    @Query() query: ArchiveGamesByPositionQueryDto,
  ): Promise<ArchiveGamesByPositionResponse> {
    return this.archive.getGamesByPosition(query);
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
