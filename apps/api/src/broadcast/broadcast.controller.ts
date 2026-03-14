import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type BroadcastItem = {
  id: string;
  lichessId: string;
  title: string;
  description: string | null;
  url: string | null;
  isActive: boolean;
  createdAt: string;
};

type BroadcastListResponse = { data: BroadcastItem[] };

type BroadcastRoundItem = {
  id: string;
  lichessRoundId: string;
  name: string;
  startsAt: string | null;
  status: string;
};

type BroadcastRoundsResponse = { data: BroadcastRoundItem[] };

type BroadcastGameItem = {
  id: string;
  lichessGameId: string | null;
  whitePlayer: string | null;
  blackPlayer: string | null;
  result: string | null;
  pgn: string | null;
  currentFen: string | null;
  updatedAt: string;
};

type BroadcastGamesResponse = { data: BroadcastGameItem[] };

@Controller('broadcasts')
export class BroadcastController {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /api/broadcasts — список активных трансляций */
  @Get()
  async getActiveBroadcasts(
    @Query('take') take = '20',
    @Query('skip') skip = '0',
  ): Promise<BroadcastListResponse> {
    const broadcasts = await this.prisma.broadcast.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
      take: parseInt(take, 10),
      skip: parseInt(skip, 10),
    });

    const data: BroadcastItem[] = broadcasts.map((b) => ({
      id: b.id,
      lichessId: b.lichessId,
      title: b.title,
      description: b.description,
      url: b.url,
      isActive: b.isActive,
      createdAt: b.createdAt.toISOString(),
    }));

    return { data };
  }

  /** GET /api/broadcasts/:id — метаданные трансляции */
  @Get(':id')
  async getBroadcast(@Param('id') id: string): Promise<BroadcastItem> {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id },
    });
    if (!broadcast) {
      throw new NotFoundException(`Broadcast ${id} not found`);
    }
    return {
      id: broadcast.id,
      lichessId: broadcast.lichessId,
      title: broadcast.title,
      description: broadcast.description,
      url: broadcast.url,
      isActive: broadcast.isActive,
      createdAt: broadcast.createdAt.toISOString(),
    };
  }

  /** GET /api/broadcasts/:id/rounds — туры трансляции */
  @Get(':id/rounds')
  async getBroadcastRounds(@Param('id') id: string): Promise<BroadcastRoundsResponse> {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id },
    });
    if (!broadcast) {
      throw new NotFoundException(`Broadcast ${id} not found`);
    }

    const rounds = await this.prisma.broadcastRound.findMany({
      where: { broadcastId: id },
      orderBy: { startsAt: 'asc' },
    });

    const data: BroadcastRoundItem[] = rounds.map((r) => ({
      id: r.id,
      lichessRoundId: r.lichessRoundId,
      name: r.name,
      startsAt: r.startsAt ? r.startsAt.toISOString() : null,
      status: r.status,
    }));

    return { data };
  }

  /** GET /api/broadcasts/:id/rounds/:roundId/games — партии в туре */
  @Get(':id/rounds/:roundId/games')
  async getBroadcastRoundGames(
    @Param('id') id: string,
    @Param('roundId') roundId: string,
  ): Promise<BroadcastGamesResponse> {
    const round = await this.prisma.broadcastRound.findFirst({
      where: { id: roundId, broadcastId: id },
    });
    if (!round) {
      throw new NotFoundException(`Round ${roundId} not found in broadcast ${id}`);
    }

    const games = await this.prisma.broadcastGame.findMany({
      where: { roundId: round.id },
      orderBy: { updatedAt: 'asc' },
    });

    const data: BroadcastGameItem[] = games.map((g) => ({
      id: g.id,
      lichessGameId: g.lichessGameId,
      whitePlayer: g.whitePlayer,
      blackPlayer: g.blackPlayer,
      result: g.result,
      pgn: g.pgn,
      currentFen: g.currentFen,
      updatedAt: g.updatedAt.toISOString(),
    }));

    return { data };
  }
}
