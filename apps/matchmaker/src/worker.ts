import { PrismaClient } from './generated/prisma/client.js';
import Redis from 'ioredis';

const POLL_INTERVAL_MS = 500;
const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Redis pub/sub channel for paired events */
export const MATCHMAKER_PAIRED_CHANNEL = 'matchmaker:paired';
/** Redis pub/sub channel for regular matchmaking */
export const MATCHMAKER_FOUND_CHANNEL = 'matchmaker:found';

/** Arena seek queue key pattern */
const arenaSeekKey = (tournamentId: string) => `arena:${tournamentId}:seeking`;
const lastOpponentKey = (tournamentId: string, a: string) => `arena:${tournamentId}:last:${a}`;
/** Redis set of players with active games in a tournament (fast O(1) check) */
const activePlayers = (tournamentId: string) => `arena:${tournamentId}:active_players`;

/** Regular matchmaking queue keys */
const REGULAR_QUEUE_CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical'] as const;
const regularQueueKey = (category: string) => `matchmaking:${category}`;

interface QueueEntry {
  userId: string;
  rating: number;
  timeInitialSec: number;
  timeIncrementSec: number;
  ratingRange?: { min: number; max: number };
}

export class MatchmakerWorker {
  private readonly prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  private readonly redis: Redis;
  private readonly pubRedis: Redis;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor() {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6380', 10);
    this.redis = new Redis({ host: redisHost, port: redisPort });
    this.pubRedis = new Redis({ host: redisHost, port: redisPort });
  }

  async start(): Promise<void> {
    console.log('[matchmaker] Starting...');
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    console.log(`[matchmaker] Running (poll every ${POLL_INTERVAL_MS}ms)`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.redis.quit().catch(() => {});
    await this.pubRedis.quit().catch(() => {});
    await this.prisma.$disconnect();
    console.log('[matchmaker] Stopped');
  }

  private async poll(): Promise<void> {
    try {
      // Skip pairing when server is busy (scale-up in progress)
      const busy = await this.redis.get('server:busy');
      if (busy) {
        return;
      }

      await this.processArenaTournaments();
      await this.processRegularQueues();
    } catch (e: any) {
      console.error(`[matchmaker] Poll error: ${e.message}`);
    }
  }

  // ========== Arena Tournament Pairing ==========

  private async processArenaTournaments(): Promise<void> {
    const activeTournaments = await this.prisma.arenaTournament.findMany({
      where: { status: 'active' },
      select: { id: true, timeControlType: true, timeInitialSec: true, timeIncrementSec: true },
    });

    for (const t of activeTournaments) {
      await this.processArenaQueue(t);
    }
  }

  private async processArenaQueue(t: {
    id: string; timeControlType: string; timeInitialSec: number; timeIncrementSec: number;
  }): Promise<void> {
    const key = arenaSeekKey(t.id);
    const apKey = activePlayers(t.id);
    const members = await this.redis.zrange(key, 0, -1);
    if (members.length < 2) return;

    // Filter: only players NOT in the active_players set
    const available: string[] = [];
    for (const userId of members) {
      const isActive = await this.redis.sismember(apKey, userId);
      if (isActive) {
        // Player has active game — remove from seek queue
        await this.redis.zrem(key, userId);
      } else {
        available.push(userId);
      }
    }

    if (available.length < 2) return;

    // Sequential pairing: greedily pair available players
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
        const candidateId = available[j];
        if (candidateId === lastOpp) {
          fallbackMatch = fallbackMatch ?? candidateId;
        } else {
          bestMatch = candidateId;
          break;
        }
      }

      const match = bestMatch ?? fallbackMatch;
      if (!match) continue;

      paired.add(userId);
      paired.add(match);
      pairs.push([userId, match]);
    }

    // Create games for all pairs
    for (const [a, b] of pairs) {
      try {
        // Mark BOTH players as active BEFORE creating game (prevents re-pairing)
        await this.redis.sadd(apKey, a, b);
        await this.createArenaGame(t, key, a, b);
      } catch (e: any) {
        console.error(`[matchmaker] Arena game creation failed: ${e.message}`);
        // Rollback active_players on failure
        await this.redis.srem(apKey, a, b);
      }
    }

    if (pairs.length > 0) {
      console.log(`[matchmaker] Arena ${t.id.slice(0, 8)}: paired ${pairs.length} games from ${available.length} seekers`);
    }
  }

  private async createArenaGame(
    t: { id: string; timeControlType: string; timeInitialSec: number; timeIncrementSec: number },
    key: string,
    userId: string,
    candidateId: string,
  ): Promise<void> {
    // Remove both from queue
    await this.redis.zrem(key, userId, candidateId);

    // Record last opponents
    await this.redis.set(lastOpponentKey(t.id, userId), candidateId, 'EX', 300);
    await this.redis.set(lastOpponentKey(t.id, candidateId), userId, 'EX', 300);

    // Random colors
    const whiteId = Math.random() < 0.5 ? userId : candidateId;
    const blackId = whiteId === userId ? candidateId : userId;

    const game = await this.prisma.game.create({
      data: {
        whiteId, blackId, status: 'waiting',
        timeControlType: t.timeControlType as 'bullet' | 'blitz' | 'rapid' | 'classical',
        timeInitialSec: t.timeInitialSec,
        timeIncrementSec: t.timeIncrementSec,
        tournamentId: t.id,
      },
    });

    // Init game state in Redis — clocks NOT running (wait for both players to join)
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
    // Do NOT add to deadlines — clocks start when both players join
    // Set 30s join deadline — game aborted if both players don't join in time
    await this.redis.zadd('game:join_deadlines', Date.now() + 30_000, game.id);

    await this.prisma.game.update({
      where: { id: game.id },
      data: { status: 'active', startedAt: new Date() },
    });

    // Players stay in active_players set — removed when game ends (see below)

    // Publish paired event
    this.pubRedis.publish(MATCHMAKER_PAIRED_CHANNEL, JSON.stringify({
      tournamentId: t.id, gameId: game.id, whiteId, blackId,
    })).catch((e) => console.error(`[matchmaker] Publish error: ${e.message}`));
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

    // Parse entries
    const entries: QueueEntry[] = [];
    for (const raw of members) {
      try { entries.push(JSON.parse(raw)); } catch { /* skip malformed */ }
    }
    if (entries.length < 2) return;

    const paired = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      if (paired.has(entries[i].userId)) continue;
      const seeker = entries[i];

      for (let j = i + 1; j < entries.length; j++) {
        if (paired.has(entries[j].userId)) continue;
        const candidate = entries[j];

        // Must match time control
        if (candidate.timeInitialSec !== seeker.timeInitialSec ||
            candidate.timeIncrementSec !== seeker.timeIncrementSec) continue;

        // Rating range check (±200)
        if (Math.abs(seeker.rating - candidate.rating) > 200) continue;

        // Mutual rating filter check
        if (seeker.ratingRange) {
          if (candidate.rating < seeker.ratingRange.min || candidate.rating > seeker.ratingRange.max) continue;
        }
        if (candidate.ratingRange) {
          if (seeker.rating < candidate.ratingRange.min || seeker.rating > candidate.ratingRange.max) continue;
        }

        // Match found
        paired.add(seeker.userId);
        paired.add(candidate.userId);

        // Remove both from queue
        await this.redis.zrem(key, members[i], members[j]);

        const whiteId = Math.random() < 0.5 ? seeker.userId : candidate.userId;
        const blackId = whiteId === seeker.userId ? candidate.userId : seeker.userId;

        try {
          const game = await this.prisma.game.create({
            data: {
              whiteId, blackId, status: 'waiting',
              timeControlType: category as 'bullet' | 'blitz' | 'rapid' | 'classical',
              timeInitialSec: seeker.timeInitialSec,
              timeIncrementSec: seeker.timeIncrementSec,
            },
          });

          // Init game state — clocks NOT running (wait for both players to join)
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
          // Set 30s join deadline — game aborted if both players don't join in time
          await this.redis.zadd('game:join_deadlines', Date.now() + 30_000, game.id);

          await this.prisma.game.update({
            where: { id: game.id },
            data: { status: 'active', startedAt: new Date() },
          });

          // Look up opponent info
          const seekerUser = await this.prisma.user.findUnique({ where: { id: seeker.userId }, select: { id: true, username: true } });
          const candidateUser = await this.prisma.user.findUnique({ where: { id: candidate.userId }, select: { id: true, username: true } });

          this.pubRedis.publish(MATCHMAKER_FOUND_CHANNEL, JSON.stringify({
            gameId: game.id, category,
            timeInitial: seeker.timeInitialSec, increment: seeker.timeIncrementSec,
            white: { id: whiteId, username: whiteId === seeker.userId ? seekerUser?.username : candidateUser?.username },
            black: { id: blackId, username: blackId === seeker.userId ? seekerUser?.username : candidateUser?.username },
          })).catch((e) => console.error(`[matchmaker] Publish error: ${e.message}`));

          console.log(`[matchmaker] Regular ${category}: ${seeker.userId.slice(0, 8)} vs ${candidate.userId.slice(0, 8)}, game=${game.id.slice(0, 8)}`);
        } catch (e: any) {
          console.error(`[matchmaker] Regular game creation failed: ${e.message}`);
        }

        break; // seeker is paired, move to next
      }
    }
  }
}
