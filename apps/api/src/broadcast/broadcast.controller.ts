import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type BroadcastSummary = {
  id: string;
  lichessId: string;
  title: string;
  status: 'active' | 'finished';
  startDate: string | null;
  roundCount: number;
};

type BroadcastListResponse = {
  data: BroadcastSummary[];
  total: number;
  limit: number;
  offset: number;
};

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

  /** GET /api/broadcasts — список трансляций (summary + пагинация) */
  @Get()
  async getActiveBroadcasts(
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
  ): Promise<BroadcastListResponse> {
    const MAX_LIMIT = 100;
    const DEFAULT_LIMIT = 20;

    let limit = limitParam ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
    if (isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    let offset = offsetParam ? parseInt(offsetParam, 10) : 0;
    if (isNaN(offset) || offset < 0) offset = 0;

    const where = { isActive: true };

    const [broadcasts, total] = await Promise.all([
      this.prisma.broadcast.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          lichessId: true,
          title: true,
          isActive: true,
          startDate: true,
          _count: { select: { rounds: true } },
        },
      }),
      this.prisma.broadcast.count({ where }),
    ]);

    const data: BroadcastSummary[] = broadcasts.map((b) => ({
      id: b.id,
      lichessId: b.lichessId,
      title: b.title,
      status: b.isActive ? 'active' as const : 'finished' as const,
      startDate: b.startDate?.toISOString() ?? null,
      roundCount: b._count.rounds,
    }));

    return { data, total, limit, offset };
  }

  /** GET /api/broadcasts/:id — метаданные трансляции */
  @Get(':id')
  async getBroadcast(@Param('id') id: string) {
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
      format: broadcast.format,
      timeControl: broadcast.timeControl,
      location: broadcast.location,
      players: broadcast.players,
      website: broadcast.website,
      standingsUrl: broadcast.standingsUrl,
      imageUrl: broadcast.imageUrl,
      startDate: broadcast.startDate?.toISOString() ?? null,
      endDate: broadcast.endDate?.toISOString() ?? null,
      streams: broadcast.streams,
      createdAt: broadcast.createdAt.toISOString(),
    };
  }

  /** GET /api/broadcasts/:id/standings — crosstable standings */
  @Get(':id/standings')
  async getStandings(@Param('id') id: string) {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id },
      include: {
        rounds: {
          orderBy: { startsAt: 'asc' },
          include: { games: true },
        },
      },
    });
    if (!broadcast) throw new NotFoundException(`Broadcast ${id} not found`);

    // Collect all players and their results
    const playerSet = new Set<string>();
    const results: Array<{ round: string; white: string; black: string; result: string; gameId: string }> = [];

    for (const round of broadcast.rounds) {
      for (const game of round.games) {
        const white = game.whitePlayer ?? 'Unknown';
        const black = game.blackPlayer ?? 'Unknown';
        playerSet.add(white);
        playerSet.add(black);
        if (game.result && game.result !== '*') {
          results.push({ round: round.name, white, black, result: game.result, gameId: game.id });
        }
      }
    }

    const playerNames = [...playerSet].sort();

    // Calculate points and crosstable scores
    const points = new Map<string, number>();
    const gamesPlayed = new Map<string, number>();
    // scores: "player1:player2" → array of { score, gameId }
    const scores = new Map<string, Array<{ score: number; gameId: string }>>();

    for (const name of playerNames) {
      points.set(name, 0);
      gamesPlayed.set(name, 0);
    }

    for (const r of results) {
      gamesPlayed.set(r.white, (gamesPlayed.get(r.white) ?? 0) + 1);
      gamesPlayed.set(r.black, (gamesPlayed.get(r.black) ?? 0) + 1);

      let wp = 0;
      let bp = 0;
      if (r.result === '1-0') { wp = 1; bp = 0; }
      else if (r.result === '0-1') { wp = 0; bp = 1; }
      else if (r.result === '1/2-1/2') { wp = 0.5; bp = 0.5; }

      points.set(r.white, (points.get(r.white) ?? 0) + wp);
      points.set(r.black, (points.get(r.black) ?? 0) + bp);

      const wKey = `${r.white}:${r.black}`;
      const bKey = `${r.black}:${r.white}`;
      if (!scores.has(wKey)) scores.set(wKey, []);
      if (!scores.has(bKey)) scores.set(bKey, []);
      scores.get(wKey)!.push({ score: wp, gameId: r.gameId });
      scores.get(bKey)!.push({ score: bp, gameId: r.gameId });
    }

    // Calculate Sonneborn-Berger (SB)
    const sb = new Map<string, number>();
    for (const name of playerNames) {
      let sbScore = 0;
      for (const opp of playerNames) {
        if (opp === name) continue;
        const key = `${name}:${opp}`;
        const ptsFromOpp = scores.get(key) ?? [];
        const oppTotalPts = points.get(opp) ?? 0;
        for (const entry of ptsFromOpp) {
          sbScore += entry.score * oppTotalPts;
        }
      }
      sb.set(name, Math.round(sbScore * 100) / 100);
    }

    // Sort: points DESC, SB DESC, name ASC
    const sorted = playerNames.sort((a, b) =>
      (points.get(b) ?? 0) - (points.get(a) ?? 0)
      || (sb.get(b) ?? 0) - (sb.get(a) ?? 0)
      || a.localeCompare(b));

    const players = sorted.map((name, i) => ({
      rank: i + 1,
      name,
      points: points.get(name) ?? 0,
      gamesPlayed: gamesPlayed.get(name) ?? 0,
      sb: sb.get(name) ?? 0,
      scores: Object.fromEntries(
        sorted.filter((opp) => opp !== name).map((opp) => [opp, scores.get(`${name}:${opp}`) ?? []]),
      ),
    }));

    return { players };
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
