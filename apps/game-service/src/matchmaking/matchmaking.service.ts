import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  classifyTimeControl,
  type TimeControlCategory,
  type RatingFilter,
} from '@kingside/shared';
import { SyntheticSchedulerService } from './synthetic/synthetic-scheduler.service';
import { syntheticInQueueKey } from './synthetic/live-queue-stats';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MATCHMAKER_FOUND_CHANNEL = 'matchmaker:found';
const POLL_INTERVAL_MS = 2000;
/**
 * KS-2165 (B6). Окно ожидания live-партнёра до запроса synthetic'а.
 * Jittered per entry (`liveWaitMs(entry.userId)`), default 5..15 сек.
 * Замена 30-секундного fallback'а на client-side bot из старого
 * `MATCHMAKING_FALLBACK_SEC` (дефолтно был 30 с).
 */
const LIVE_WAIT_MIN_MS = parseInt(
  process.env.MATCHMAKING_LIVE_WAIT_MIN_MS || '5000',
  10,
);
const LIVE_WAIT_MAX_MS = parseInt(
  process.env.MATCHMAKING_LIVE_WAIT_MAX_MS || '15000',
  10,
);
/**
 * KS-2176. Семантика отличается от остальных synthetic-флагов
 * (`SYNTHETIC_*_ENABLED` — opt-in `=== 'true'`): здесь default = ON
 * (`!== 'false'`). Намеренно — это emergency kill-switch для Pass 2
 * fallback-логики matchmaker'а. Активация фичи всё равно требует
 * `SYNTHETIC_SCHEDULER_ENABLED=true` (без него `allocateSynthetic`
 * возвращает null, Pass 2 — no-op), а этот флаг существует для
 * быстрого аварийного отключения synthetic-pairing'а в проде без
 * перезапуска scheduler'а.
 */
const SYNTHETIC_FALLBACK_ENABLED =
  process.env.MATCHMAKING_SYNTHETIC_FALLBACK_ENABLED !== 'false';
const CATEGORIES: TimeControlCategory[] = ['bullet', 'blitz', 'rapid', 'classical'];

function liveWaitMsForEntry(joinedAt: number): number {
  // Детерминирован на основе joinedAt — одна и та же запись каждый
  // tick получает одинаковый «свой» порог ожидания. Без шума пара
  // синтет/живой в углу 15 секунд была бы синхронной для всех.
  const span = Math.max(0, LIVE_WAIT_MAX_MS - LIVE_WAIT_MIN_MS);
  if (span === 0) return LIVE_WAIT_MIN_MS;
  return LIVE_WAIT_MIN_MS + (joinedAt % (span + 1));
}

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
    /**
     * KS-2165: synthetic scheduler инжектится Optional, потому что в
     * unit-тестах MatchmakingService может конструироваться без
     * synthetic-модуля. На проде scheduler всегда есть (см.
     * MatchmakingModule).
     */
    @Optional() private readonly syntheticScheduler?: SyntheticSchedulerService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.processAllQueues(), POLL_INTERVAL_MS);
    this.logger.log(
      `Matchmaker started (poll=${POLL_INTERVAL_MS}ms, ` +
        `liveWait=${LIVE_WAIT_MIN_MS}..${LIVE_WAIT_MAX_MS}ms, ` +
        `syntheticFallback=${SYNTHETIC_FALLBACK_ENABLED ? 'enabled' : 'disabled'})`,
    );
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
    const now = Date.now();

    // KS-2165: для live-приоритета определяем кто из entries — synthetic.
    const syntheticUserIds = await this.redis
      .smembers(syntheticInQueueKey(category))
      .catch(() => [] as string[]);
    const syntheticSet = new Set(syntheticUserIds);
    const isLiveEntry = (e: QueueEntry): boolean => !syntheticSet.has(e.userId);

    this.logger.log(
      `processQueue ${category}: ${entries.length} entries (live=${entries.filter(isLiveEntry).length} synthetic=${syntheticSet.size})`,
    );

    // Pass 1a (KS-2165): live-vs-live имеет приоритет — спариваем только
    // двух live-entries между собой. Synthetic'и пропускаются на этом
    // этапе. Это покрывает acceptance §1: «2 живых сматчиваются друг с
    // другом, synthetic остаётся в очереди».
    for (let i = 0; i < entries.length; i++) {
      if (paired.has(entries[i].userId)) continue;
      const a = entries[i];
      if (!isLiveEntry(a)) continue;
      for (let j = i + 1; j < entries.length; j++) {
        if (paired.has(entries[j].userId)) continue;
        const b = entries[j];
        if (!isLiveEntry(b)) continue;
        if (!this.isRatingCompatible(a, b)) continue;
        paired.add(a.userId);
        paired.add(b.userId);
        await this.redis.zrem(queueKey, members[i], members[j]);
        await this.createMatchedGame(a, b, category, false);
        break;
      }
    }

    // Pass 1b: live ↔ synthetic, который УЖЕ стоит в очереди
    // (scheduler заранее завёл синтета). Это покрывает acceptance §2
    // «без 5–15с ожидания».
    for (let i = 0; i < entries.length; i++) {
      if (paired.has(entries[i].userId)) continue;
      const a = entries[i];
      if (!isLiveEntry(a)) continue;
      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue;
        if (paired.has(entries[j].userId)) continue;
        const b = entries[j];
        if (isLiveEntry(b)) continue; // только synthetic
        if (!this.isRatingCompatible(a, b)) continue;
        paired.add(a.userId);
        paired.add(b.userId);
        await this.redis.zrem(queueKey, members[i], members[j]);
        await this.createMatchedGame(a, b, category, true);
        break;
      }
    }

    // Pass 2 (KS-2165): для long-waiting live (>= 5..15 сек, jittered)
    // запрашиваем synthetic'а через scheduler.allocateSynthetic.
    // Раньше здесь был bot-fallback с client-side Stockfish — он удалён.
    if (!SYNTHETIC_FALLBACK_ENABLED || !this.syntheticScheduler) {
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      if (paired.has(entries[i].userId)) continue;
      const entry = entries[i];
      if (!isLiveEntry(entry)) continue; // synthetic-к-synthetic не миксуем
      const waitMs = now - (entry.joinedAt || 0);
      const threshold = liveWaitMsForEntry(entry.joinedAt || 0);
      if (waitMs < threshold) continue;

      try {
        const synth = await this.syntheticScheduler.allocateSynthetic(
          entry.rating,
          category,
        );
        if (!synth) {
          this.logger.log(
            `live-wait expired for ${entry.userId.slice(0, 8)} (${waitMs}ms) — no synthetic available, keep waiting`,
          );
          continue;
        }
        paired.add(entry.userId);
        await this.redis.zrem(queueKey, members[i]);
        const synthEntry: QueueEntry = {
          userId: synth.userId,
          rating: synth.rating,
          timeInitialSec: entry.timeInitialSec,
          timeIncrementSec: entry.timeIncrementSec,
          joinedAt: now,
        };
        await this.createMatchedGame(entry, synthEntry, category, true);
        this.logger.log(
          `synthetic fallback: ${entry.userId.slice(0, 8)} ↔ synth ${synth.username} (rating=${synth.rating})`,
        );
      } catch (err) {
        this.logger.warn(
          `synthetic fallback failed for ${entry.userId.slice(0, 8)}: ${(err as Error).message}`,
        );
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
  // Теперь Pass 2 в processQueue запрашивает synthetic-юзера через
  // SyntheticSchedulerService.allocateSynthetic; партия создаётся через
  // тот же createMatchedGame с `isSyntheticOpponent=true`. См. ADR-034 §1.
}
