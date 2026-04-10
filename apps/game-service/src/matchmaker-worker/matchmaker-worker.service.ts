import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const POLL_INTERVAL_MS = 500;
const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MAX_CONCURRENT_GAMES = parseInt(process.env.MAX_CONCURRENT_GAMES || '40', 10);

export const MATCHMAKER_PAIRED_CHANNEL = 'matchmaker:paired';
export const MATCHMAKER_FOUND_CHANNEL = 'matchmaker:found';

const arenaSeekKey = (tid: string) => `arena:${tid}:seeking`;
const lastOpponentKey = (tid: string, a: string) => `arena:${tid}:last:${a}`;
const activePlayers = (tid: string) => `arena:${tid}:active_players`;

const REGULAR_QUEUE_CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical'] as const;
const regularQueueKey = (cat: string) => `matchmaking:${cat}`;

interface QueueEntry {
  userId: string;
  rating: number;
  timeInitialSec: number;
  timeIncrementSec: number;
  ratingRange?: { min: number; max: number };
}

@Injectable()
export class MatchmakerWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchmakerWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  /** Dedicated pub client (RedisService is used for commands, pubRedis for pub/sub) */
  private pubRedis: RedisService | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit() {
    // Use same redis for pub (NestJS DI handles lifecycle)
    this.pubRedis = this.redis;
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.logger.log(`Matchmaker started (poll every ${POLL_INTERVAL_MS}ms, maxGames=${MAX_CONCURRENT_GAMES})`);
  }

  onModuleDestroy() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.logger.log('Matchmaker stopped');
  }

  private async poll(): Promise<void> {
    try {
      const busy = await this.redis.get('server:busy');
      if (busy) return;
      await this.processArenaTournaments();
      await this.processRegularQueues();
    } catch (e: any) {
      this.logger.error(`Poll error: ${e.message}`);
    }
  }

  // ========== Arena Tournament Pairing ==========

  private async processArenaTournaments(): Promise<void> {
    const tournaments = await this.prisma.arenaTournament.findMany({
      where: { status: 'active' },
      select: { id: true, timeControlType: true, timeInitialSec: true, timeIncrementSec: true },
    });
    for (const t of tournaments) {
      await this.processArenaQueue(t);
    }
  }

  private async processArenaQueue(t: {
    id: string; timeControlType: string; timeInitialSec: number; timeIncrementSec: number;
  }): Promise<void> {
    const key = arenaSeekKey(t.id);
    const apKey = activePlayers(t.id);

    const activeCount = await this.redis.scard(apKey);
    const currentGames = Math.floor(activeCount / 2);
    if (currentGames >= MAX_CONCURRENT_GAMES) return;
    const slotsAvailable = MAX_CONCURRENT_GAMES - currentGames;

    const members = await this.redis.zrange(key, 0, -1);
    if (members.length < 2) return;

    const available: string[] = [];
    for (const userId of members) {
      const isActive = await this.redis.sismember(apKey, userId);
      if (isActive) {
        await this.redis.zrem(key, userId);
      } else {
        available.push(userId);
      }
    }
    if (available.length < 2) return;

    const paired = new Set<string>();
    const pairs: [string, string][] = [];

    for (let i = 0; i < available.length; i++) {
      if (paired.has(available[i])) continue;
      const userId = available[i];
      const lastOpp = await this.redis.get(lastOpponentKey(t.id, userId)).catch(() => null);
      let bestMatch: string | null = null;
      let fallbackMatch: string | null = null;
      for (let j = i + 1; j < available.length; j++) {
        if (paired.has(available[j])) continue;
        if (available[j] === lastOpp) {
          fallbackMatch = fallbackMatch ?? available[j];
        } else {
          bestMatch = available[j];
          break;
        }
      }
      const match = bestMatch ?? fallbackMatch;
      if (!match) continue;
      paired.add(userId);
      paired.add(match);
      pairs.push([userId, match]);
    }

    const CLAIM_PAIR_SCRIPT = `
      if redis.call("SISMEMBER", KEYS[1], ARGV[1]) == 1 then return 0 end
      if redis.call("SISMEMBER", KEYS[1], ARGV[2]) == 1 then return 0 end
      redis.call("SADD", KEYS[1], ARGV[1], ARGV[2])
      redis.call("ZREM", KEYS[2], ARGV[1], ARGV[2])
      return 1`;

    const pairsToCreate = pairs.slice(0, slotsAvailable);
    let created = 0;

    for (const [a, b] of pairsToCreate) {
      try {
        const claimed = await this.redis.eval(CLAIM_PAIR_SCRIPT, 2, apKey, key, a, b) as number;
        if (!claimed) continue;
        await this.createArenaGame(t, a, b);
        created++;
      } catch (e: any) {
        this.logger.error(`Arena game creation failed: ${e.message}`);
        await this.redis.srem(apKey, a, b);
      }
    }

    if (created > 0) {
      this.logger.log(`Arena ${t.id.slice(0, 8)}: paired ${created}/${pairs.length} (active=${currentGames}/${MAX_CONCURRENT_GAMES}, seekers=${available.length})`);
    }
  }

  private async createArenaGame(
    t: { id: string; timeControlType: string; timeInitialSec: number; timeIncrementSec: number },
    userId: string, candidateId: string,
  ): Promise<void> {
    await this.redis.set(lastOpponentKey(t.id, userId), candidateId, 'EX', 300);
    await this.redis.set(lastOpponentKey(t.id, candidateId), userId, 'EX', 300);

    const whiteId = Math.random() < 0.5 ? userId : candidateId;
    const blackId = whiteId === userId ? candidateId : userId;

    const game = await this.prisma.game.create({
      data: {
        whiteId, blackId, status: 'waiting',
        timeControlType: t.timeControlType as any,
        timeInitialSec: t.timeInitialSec,
        timeIncrementSec: t.timeIncrementSec,
        tournamentId: t.id,
      },
    });

    const timeMs = t.timeInitialSec * 1000;
    await this.redis.hset(`game:${game.id}:state`, {
      fen: INITIAL_FEN, moves: '[]', status: 'active', active_color: 'white',
      white_id: whiteId, black_id: blackId,
      time_increment_sec: String(t.timeIncrementSec),
    });
    await this.redis.hset(`game:${game.id}:clocks`, {
      white_ms: String(timeMs), black_ms: String(timeMs),
      last_tick: '0', running: '0',
    });
    await this.redis.zadd('game:join_deadlines', Date.now() + 30_000, game.id);

    await this.prisma.game.update({
      where: { id: game.id },
      data: { status: 'active', startedAt: new Date() },
    });

    this.pubRedis!.publish(MATCHMAKER_PAIRED_CHANNEL, JSON.stringify({
      tournamentId: t.id, gameId: game.id, whiteId, blackId,
    })).catch((e: any) => this.logger.error(`Publish error: ${e.message}`));
  }

  // ========== Regular Matchmaking ==========

  private async processRegularQueues(): Promise<void> {
    for (const category of REGULAR_QUEUE_CATEGORIES) {
      await this.processRegularQueue(category);
    }
  }

  private async processRegularQueue(category: string): Promise<void> {
    const key = regularQueueKey(category);
    const members = await this.redis.zrange(key, 0, -1);
    if (members.length < 2) return;

    const entries: QueueEntry[] = [];
    for (const raw of members) {
      try { entries.push(JSON.parse(raw)); } catch { /* skip */ }
    }
    if (entries.length < 2) return;

    const paired = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      if (paired.has(entries[i].userId)) continue;
      const seeker = entries[i];

      for (let j = i + 1; j < entries.length; j++) {
        if (paired.has(entries[j].userId)) continue;
        const candidate = entries[j];

        if (candidate.timeInitialSec !== seeker.timeInitialSec ||
            candidate.timeIncrementSec !== seeker.timeIncrementSec) continue;
        if (Math.abs(seeker.rating - candidate.rating) > 200) continue;
        if (seeker.ratingRange &&
            (candidate.rating < seeker.ratingRange.min || candidate.rating > seeker.ratingRange.max)) continue;
        if (candidate.ratingRange &&
            (seeker.rating < candidate.ratingRange.min || seeker.rating > candidate.ratingRange.max)) continue;

        paired.add(seeker.userId);
        paired.add(candidate.userId);
        await this.redis.zrem(key, members[i], members[j]);

        const whiteId = Math.random() < 0.5 ? seeker.userId : candidate.userId;
        const blackId = whiteId === seeker.userId ? candidate.userId : seeker.userId;

        try {
          const game = await this.prisma.game.create({
            data: {
              whiteId, blackId, status: 'waiting',
              timeControlType: category as any,
              timeInitialSec: seeker.timeInitialSec,
              timeIncrementSec: seeker.timeIncrementSec,
            },
          });

          const timeMs = seeker.timeInitialSec * 1000;
          await this.redis.hset(`game:${game.id}:state`, {
            fen: INITIAL_FEN, moves: '[]', status: 'active', active_color: 'white',
            white_id: whiteId, black_id: blackId,
            time_increment_sec: String(seeker.timeIncrementSec),
          });
          await this.redis.hset(`game:${game.id}:clocks`, {
            white_ms: String(timeMs), black_ms: String(timeMs),
            last_tick: '0', running: '0',
          });
          await this.redis.zadd('game:join_deadlines', Date.now() + 30_000, game.id);

          await this.prisma.game.update({
            where: { id: game.id },
            data: { status: 'active', startedAt: new Date() },
          });

          const seekerUser = await this.prisma.user.findUnique({ where: { id: seeker.userId }, select: { id: true, username: true } });
          const candidateUser = await this.prisma.user.findUnique({ where: { id: candidate.userId }, select: { id: true, username: true } });

          this.pubRedis!.publish(MATCHMAKER_FOUND_CHANNEL, JSON.stringify({
            gameId: game.id, category,
            timeInitial: seeker.timeInitialSec, increment: seeker.timeIncrementSec,
            white: { id: whiteId, username: whiteId === seeker.userId ? seekerUser?.username : candidateUser?.username },
            black: { id: blackId, username: blackId === seeker.userId ? seekerUser?.username : candidateUser?.username },
          })).catch((e: any) => this.logger.error(`Publish error: ${e.message}`));

          this.logger.log(`Regular ${category}: ${seeker.userId.slice(0, 8)} vs ${candidate.userId.slice(0, 8)}`);
        } catch (e: any) {
          this.logger.error(`Regular game creation failed: ${e.message}`);
        }
        break;
      }
    }
  }
}
