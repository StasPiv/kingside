import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  classifyTimeControl,
  type TimeControlCategory,
  type RatingFilter,
} from '@kingside/shared';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MATCHMAKER_FOUND_CHANNEL = 'matchmaker:found';
const POLL_INTERVAL_MS = 2000;
const CATEGORIES: TimeControlCategory[] = ['bullet', 'blitz', 'rapid', 'classical'];

/**
 * Synthetic-flow (KS-2165 Pass 1b/Pass 2 → `SyntheticSchedulerService.
 * allocateSynthetic`) откатан 30.04 вместе с остальной embedded
 * synthetic-архитектурой (см. `matchmaking.module.ts`). До появления
 * нового WS-bot-fleet решения матчмейкер делает только live↔live —
 * нет fallback'а на бота вообще (это согласовано с пользователем,
 * 30-сек client-side Stockfish удалён насовсем в KS-2165).
 */

interface RatingRange {
  min: number;
  max: number;
}

interface QueueEntry {
  userId: string;
  rating: number;
  timeInitialSec: number;
  timeIncrementSec: number;
  joinedAt: number;
  ratingRange?: RatingRange;
}

@Injectable()
export class MatchmakingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchmakingService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.processAllQueues(), POLL_INTERVAL_MS);
    this.logger.log(`Matchmaker started (poll=${POLL_INTERVAL_MS}ms)`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Add player to matchmaking queue. Matching is handled by matchmaker worker.
   */
  async joinQueue(
    userId: string,
    timeInitialSec: number,
    timeIncrementSec: number,
    _isOnline?: (userId: string) => Promise<boolean>,
    ratingFilter?: RatingFilter,
  ): Promise<null> {
    const timeControlType = classifyTimeControl(timeInitialSec, timeIncrementSec);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const ratingField = this.ratingFieldForCategory(timeControlType);
    const rating = user[ratingField];
    const ratingRange = this.resolveRatingRange(rating, ratingFilter);

    const queueKey = `matchmaking:${timeControlType}`;

    const entry: QueueEntry = {
      userId,
      rating,
      timeInitialSec,
      timeIncrementSec,
      joinedAt: Date.now(),
      ratingRange,
    };

    await this.redis.zadd(queueKey, rating, JSON.stringify(entry));
    this.logger.log(`joinQueue: ${userId} (rating ${rating}) added to ${queueKey}`);
    return null;
  }

  async leaveQueue(userId: string, category: TimeControlCategory) {
    const queueKey = `matchmaking:${category}`;
    const members = await this.redis.zrange(queueKey, 0, -1);

    for (const member of members) {
      const entry: QueueEntry = JSON.parse(member);
      if (entry.userId === userId) {
        await this.redis.zrem(queueKey, member);
        return true;
      }
    }

    return false;
  }

  private resolveRatingRange(
    playerRating: number,
    filter?: RatingFilter,
  ): RatingRange | undefined {
    if (!filter) return undefined;

    const { minRating, maxRating, ratingDelta } = filter;

    if (ratingDelta !== undefined) {
      return {
        min: playerRating - ratingDelta,
        max: playerRating + ratingDelta,
      };
    }

    if (minRating !== undefined || maxRating !== undefined) {
      return {
        min: minRating ?? 0,
        max: maxRating ?? Infinity,
      };
    }

    return undefined;
  }

  private ratingFieldForCategory(
    category: TimeControlCategory,
  ): 'ratingBullet' | 'ratingBlitz' | 'ratingRapid' | 'ratingClassical' {
    const map = {
      bullet: 'ratingBullet' as const,
      blitz: 'ratingBlitz' as const,
      rapid: 'ratingRapid' as const,
      classical: 'ratingClassical' as const,
    };
    return map[category];
  }

  // --- Pairing logic ---

  private async processAllQueues(): Promise<void> {
    for (const cat of CATEGORIES) {
      try {
        await this.processQueue(cat);
      } catch (e: any) {
        this.logger.error(`processQueue ${cat}: ${e.message}`);
      }
    }
  }

  private async processQueue(category: TimeControlCategory): Promise<void> {
    const queueKey = `matchmaking:${category}`;
    const members = await this.redis.zrange(queueKey, 0, -1);
    if (members.length === 0) return;

    const entries: QueueEntry[] = members.map((m) => JSON.parse(m));
    const paired = new Set<string>();

    this.logger.log(`processQueue ${category}: ${entries.length} entries`);

    // Live↔live pairing within rating range. Synthetic-fallback (Pass
    // 1b/Pass 2 из KS-2165) откатан 30.04 вместе с embedded
    // synthetic-архитектурой — до WS-bot-fleet остаётся только этот
    // pass. Старый 30-секундный client-side Stockfish fallback удалён
    // насовсем (KS-2165 решение пользователя).
    for (let i = 0; i < entries.length; i++) {
      if (paired.has(entries[i].userId)) continue;
      const a = entries[i];
      for (let j = i + 1; j < entries.length; j++) {
        if (paired.has(entries[j].userId)) continue;
        const b = entries[j];
        if (!this.isRatingCompatible(a, b)) continue;
        paired.add(a.userId);
        paired.add(b.userId);
        await this.redis.zrem(queueKey, members[i], members[j]);
        await this.createMatchedGame(a, b, category, false);
        break;
      }
    }
  }

  private isRatingCompatible(a: QueueEntry, b: QueueEntry): boolean {
    const defaultRange = 300;
    const aMin = a.ratingRange?.min ?? (a.rating - defaultRange);
    const aMax = a.ratingRange?.max ?? (a.rating + defaultRange);
    const bMin = b.ratingRange?.min ?? (b.rating - defaultRange);
    const bMax = b.ratingRange?.max ?? (b.rating + defaultRange);

    return b.rating >= aMin && b.rating <= aMax && a.rating >= bMin && a.rating <= bMax;
  }

  private async createMatchedGame(
    a: QueueEntry,
    b: QueueEntry,
    category: TimeControlCategory,
    isSyntheticOpponent: boolean,
  ): Promise<void> {
    const whiteId = Math.random() < 0.5 ? a.userId : b.userId;
    const blackId = whiteId === a.userId ? b.userId : a.userId;

    const game = await this.prisma.game.create({
      data: {
        whiteId, blackId, status: 'active',
        timeControlType: category,
        timeInitialSec: a.timeInitialSec,
        timeIncrementSec: a.timeIncrementSec,
        // KS-2165: маркер партии с synthetic'ом. Используется для
        // аудита/админки. KS-2167 (исключение из чартов) отменена —
        // фильтра в публичных листингах нет.
        isSyntheticOpponent,
        startedAt: new Date(),
      },
    });

    const timeMs = a.timeInitialSec * 1000;
    await this.redis.hset(`game:${game.id}:state`, {
      fen: INITIAL_FEN, moves: '[]', status: 'active', active_color: 'white',
      white_id: whiteId, black_id: blackId,
      time_increment_sec: String(a.timeIncrementSec),
    });
    await this.redis.hset(`game:${game.id}:clocks`, {
      white_ms: String(timeMs), black_ms: String(timeMs),
      last_tick: '0', running: '0',
    });

    const white = await this.prisma.user.findUnique({ where: { id: whiteId }, select: { username: true, ratingBullet: true, ratingBlitz: true, ratingRapid: true, ratingClassical: true } });
    const black = await this.prisma.user.findUnique({ where: { id: blackId }, select: { username: true, ratingBullet: true, ratingBlitz: true, ratingRapid: true, ratingClassical: true } });
    const ratingField = this.ratingFieldForCategory(category);

    await this.redis.publish(MATCHMAKER_FOUND_CHANNEL, JSON.stringify({
      gameId: game.id, category,
      timeInitial: a.timeInitialSec, increment: a.timeIncrementSec,
      white: { id: whiteId, username: white?.username ?? '', rating: white?.[ratingField] ?? 1500 },
      black: { id: blackId, username: black?.username ?? '', rating: black?.[ratingField] ?? 1500 },
      isBot: false,
    }));

    this.logger.log(`Matched: ${whiteId.slice(0, 8)} vs ${blackId.slice(0, 8)} game=${game.id.slice(0, 8)} ${category}`);
  }

  // KS-2165: createBotGame удалён вместе с client-side bot fallback (`botClientSide`).
  // Pass 2 (synthetic-fallback через SyntheticSchedulerService) откатан
  // 30.04 — embedded-вариант признан неверным. Замена — WS-bot-fleet,
  // спроектированный в ADR-034 v2 (синтетики подключаются как обычные
  // WS-клиенты, попадают в общую очередь и пересекаются с live↔live
  // pairing'ом естественным образом).
}
