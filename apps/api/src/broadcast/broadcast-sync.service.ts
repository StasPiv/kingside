import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { BroadcastGateway } from './broadcast.gateway';

const LICHESS_API = 'https://lichess.org/api';
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REDIS_FEN_TTL = 60 * 60 * 12; // 12 hours
const MAX_CONCURRENT_STREAMS = 50;
const FETCH_TIMEOUT_MS = 30_000; // 30 seconds
const FETCH_COOLDOWN_TTL = 60 * 60; // 1 hour
const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

interface LichessBroadcast {
  tour: {
    id: string;
    name: string;
    description?: string;
    url?: string;
  };
  rounds: LichessRound[];
}

interface LichessRound {
  id: string;
  name: string;
  startsAt?: number;
  ongoing?: boolean;
  finished?: boolean;
}

interface ParsedGame {
  index: number;
  white: string;
  black: string;
  result: string;
  fen: string;
  uci: string;
  pgn: string;
  lichessGameId: string | null;
}

@Injectable()
export class BroadcastSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BroadcastSyncService.name);
  private syncTimer: NodeJS.Timeout | null = null;
  private readonly activeStreams = new Map<string, AbortController>();
  private gateway: BroadcastGateway | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  setGateway(gateway: BroadcastGateway): void {
    this.gateway = gateway;
  }

  async onModuleInit(): Promise<void> {
    await this.syncBroadcasts();
    this.syncTimer = setInterval(() => {
      this.syncBroadcasts().catch((e) =>
        this.logger.error(`Sync error: ${e.message}`),
      );
    }, SYNC_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    for (const [roundId, ctrl] of this.activeStreams) {
      ctrl.abort();
      this.logger.log(`Stream aborted for round ${roundId}`);
    }
    this.activeStreams.clear();
  }

  async syncBroadcasts(): Promise<void> {
    this.logger.log('Syncing broadcasts from Lichess...');

    try {
      const broadcasts = await this.fetchActiveBroadcasts();

      for (const bc of broadcasts) {
        await this.upsertBroadcast(bc);
        for (const round of bc.rounds) {
          const isActive = round.ongoing === true;
          await this.upsertRound(bc.tour.id, round, isActive);
          if (isActive && !this.activeStreams.has(round.id)) {
            if (this.activeStreams.size < MAX_CONCURRENT_STREAMS) {
              this.startStream(round.id);
            } else {
              this.logger.warn(
                `Max concurrent streams reached, skipping round ${round.id}`,
              );
            }
          } else if (!isActive && round.finished) {
            void this.fetchFinishedRoundGamesIfEmpty(round.id);
          }
        }
      }

      // Stop streams for rounds that are no longer active
      const activeRoundIds = new Set(
        broadcasts.flatMap((b) =>
          b.rounds.filter((r) => r.ongoing).map((r) => r.id),
        ),
      );
      for (const [roundId, ctrl] of this.activeStreams) {
        if (!activeRoundIds.has(roundId)) {
          ctrl.abort();
          this.activeStreams.delete(roundId);
          this.logger.log(`Stopped stream for inactive round ${roundId}`);
        }
      }
    } catch (e: any) {
      this.logger.error(`Failed to sync broadcasts: ${e.message}`);
    }
  }

  private async fetchActiveBroadcasts(): Promise<LichessBroadcast[]> {
    const url = `${LICHESS_API}/broadcast?nb=20`;
    const res = await fetch(url, {
      headers: { Accept: 'application/x-ndjson' },
    });
    if (!res.ok) {
      throw new Error(`Lichess API error: ${res.status}`);
    }
    const text = await res.text();
    const broadcasts: LichessBroadcast[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        broadcasts.push(JSON.parse(trimmed));
      } catch {
        // skip malformed lines
      }
    }
    return broadcasts;
  }

  private async upsertBroadcast(bc: LichessBroadcast): Promise<void> {
    await this.prisma.broadcast.upsert({
      where: { lichessId: bc.tour.id },
      update: {
        title: bc.tour.name,
        description: bc.tour.description ?? null,
        url: bc.tour.url ?? null,
        isActive: true,
      },
      create: {
        lichessId: bc.tour.id,
        title: bc.tour.name,
        description: bc.tour.description ?? null,
        url: bc.tour.url ?? null,
        isActive: true,
      },
    });
  }

  private async upsertRound(
    broadcastLichessId: string,
    round: LichessRound,
    isActive: boolean,
  ): Promise<void> {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { lichessId: broadcastLichessId },
    });
    if (!broadcast) return;

    const status = round.finished ? 'finished' : isActive ? 'ongoing' : 'pending';

    await this.prisma.broadcastRound.upsert({
      where: { lichessRoundId: round.id },
      update: {
        name: round.name,
        startsAt: round.startsAt ? new Date(round.startsAt) : null,
        status,
      },
      create: {
        broadcastId: broadcast.id,
        lichessRoundId: round.id,
        name: round.name,
        startsAt: round.startsAt ? new Date(round.startsAt) : null,
        status,
      },
    });
  }

  private async fetchFinishedRoundGamesIfEmpty(
    lichessRoundId: string,
  ): Promise<void> {
    const round = await this.prisma.broadcastRound.findUnique({
      where: { lichessRoundId },
    });
    if (!round) return;

    const existingCount = await this.prisma.broadcastGame.count({
      where: { roundId: round.id },
    });
    if (existingCount > 0) return;

    // Avoid repeated failures: skip if cooldown is active
    const cooldownKey = `broadcast:pgn-fetch-cooldown:${lichessRoundId}`;
    const cooldown = await this.redis.get(cooldownKey);
    if (cooldown) return;

    try {
      const url = `${LICHESS_API}/broadcast/round/${lichessRoundId}.pgn`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(
          `Failed to fetch PGN for finished round ${lichessRoundId}: ${res.status}`,
        );
        await this.redis.set(cooldownKey, '1', 'EX', FETCH_COOLDOWN_TTL);
        return;
      }
      const pgn = await res.text();
      if (pgn.trim()) {
        await this.processPgnUpdate(lichessRoundId, pgn);
        this.logger.log(
          `Fetched games for finished round ${lichessRoundId}`,
        );
      } else {
        // No games yet — retry after cooldown
        await this.redis.set(cooldownKey, '1', 'EX', FETCH_COOLDOWN_TTL);
      }
    } catch (e: any) {
      this.logger.error(
        `Error fetching PGN for finished round ${lichessRoundId}: ${e.message}`,
      );
      await this.redis.set(cooldownKey, '1', 'EX', FETCH_COOLDOWN_TTL);
    }
  }

  private startStream(roundId: string): void {
    const ctrl = new AbortController();
    this.activeStreams.set(roundId, ctrl);
    this.logger.log(`Starting stream for round ${roundId}`);

    this.runStream(roundId, ctrl.signal).catch((e) => {
      if (!ctrl.signal.aborted) {
        this.logger.error(`Stream error for round ${roundId}: ${e.message}`);
      }
      this.activeStreams.delete(roundId);
    });
  }

  private async runStream(roundId: string, signal: AbortSignal): Promise<void> {
    const url = `${LICHESS_API}/stream/broadcast/round/${roundId}.pgn`;
    let retryDelay = 2000;
    const maxDelay = 60000;

    while (!signal.aborted) {
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/x-ndjson' },
          signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        retryDelay = 2000;
        const decoder = new TextDecoder();
        let buffer = '';

        for await (const chunk of res.body as any) {
          if (signal.aborted) break;
          buffer += decoder.decode(chunk, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            const pgn = part.trim();
            if (!pgn) continue;
            await this.processPgnUpdate(roundId, pgn);
          }
        }
      } catch (e: any) {
        if (signal.aborted) break;
        this.logger.warn(
          `Stream for round ${roundId} disconnected: ${e.message}. Retrying in ${retryDelay}ms`,
        );
        await this.sleep(retryDelay, signal);
        retryDelay = Math.min(retryDelay * 2, maxDelay);
      }
    }

    this.logger.log(`Stream ended for round ${roundId}`);
  }

  private async processPgnUpdate(roundId: string, pgn: string): Promise<void> {
    const games = this.parsePgnGames(pgn);
    const round = await this.prisma.broadcastRound.findUnique({
      where: { lichessRoundId: roundId },
    });
    if (!round) return;

    for (const game of games) {
      const fenKey = `broadcast:fen:${roundId}:${game.index}`;
      await this.redis.set(fenKey, game.fen, 'EX', REDIS_FEN_TTL);

      if (game.lichessGameId) {
        const existing = await this.prisma.broadcastGame.findFirst({
          where: { roundId: round.id, lichessGameId: game.lichessGameId },
        });
        if (existing) {
          await this.prisma.broadcastGame.update({
            where: { id: existing.id },
            data: {
              whitePlayer: game.white,
              blackPlayer: game.black,
              result: game.result || null,
              pgn: game.pgn,
              currentFen: game.fen,
            },
          });
        } else {
          await this.prisma.broadcastGame.create({
            data: {
              roundId: round.id,
              lichessGameId: game.lichessGameId,
              whitePlayer: game.white,
              blackPlayer: game.black,
              result: game.result || null,
              pgn: game.pgn,
              currentFen: game.fen,
            },
          });
        }
      }

      if (this.gateway && game.uci) {
        this.gateway.emitMove(round.id, {
          roundId: round.id,
          gameIndex: game.index,
          uci: game.uci,
          fen: game.fen,
          whitePlayer: game.white,
          blackPlayer: game.black,
        });
      }
    }
  }

  private parsePgnGames(rawPgn: string): ParsedGame[] {
    const gameSections = rawPgn.split(/\n\n(?=\[)/);
    const games: ParsedGame[] = [];
    let index = 0;

    for (const section of gameSections) {
      if (!section.trim()) continue;
      const headerMap: Record<string, string> = {};
      const headerLines = section.match(/\[(\w+)\s+"([^"]*)"\]/g) ?? [];
      if (headerLines.length === 0) continue;
      for (const line of headerLines) {
        const m = line.match(/\[(\w+)\s+"([^"]*)"\]/);
        if (m) headerMap[m[1]] = m[2];
      }

      const fenValue = headerMap['FEN'] ?? '';
      const white = headerMap['White'] ?? 'Unknown';
      const black = headerMap['Black'] ?? 'Unknown';
      const result = headerMap['Result'] ?? '';

      // Extract last UCI move from [LastMove] header (Lichess broadcast extension)
      const lastMove = headerMap['LastMove'] ?? '';

      // Extract lichess game ID from Site header
      // e.g. [Site "https://lichess.org/abcdefgh"]
      const site = headerMap['Site'] ?? '';
      const lichessGameId = site.split('/').pop() ?? null;

      games.push({
        index,
        white,
        black,
        result,
        fen: fenValue || STARTING_FEN,
        uci: lastMove,
        pgn: section.trim(),
        lichessGameId: lichessGameId || null,
      });
      index++;
    }

    return games;
  }

  async getGameFens(roundId: string): Promise<Array<{ index: number; fen: string }>> {
    const pattern = `broadcast:fen:${roundId}:*`;
    const keys = await this.redis.keys(pattern);
    const result: Array<{ index: number; fen: string }> = [];

    for (const key of keys) {
      const fen = await this.redis.get(key);
      const indexStr = key.split(':').pop();
      if (fen && indexStr !== undefined) {
        result.push({ index: parseInt(indexStr, 10), fen });
      }
    }
    return result.sort((a, b) => a.index - b.index);
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
