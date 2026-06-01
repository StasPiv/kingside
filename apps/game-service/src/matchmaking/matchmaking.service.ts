import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  classifyTimeControl,
  type TimeControlCategory,
  type RatingFilter,
} from '@kingside/shared';
import { BotGameService } from '../game/bot-game.service';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MATCHMAKER_FOUND_CHANNEL = 'matchmaker:found';
/**
 * KS-2197. Канал Redis pub/sub для уведомлений «истёк таймаут пустой
 * очереди». `MatchmakingService` публикует события сюда; подписчик —
 * `MatchmakingGateway` (см. `matchmaking.gateway.ts`), который шлёт WS
 * `matchmaking:no_opponents` пользователю и чистит свой `PLAYER_QUEUES_KEY`-индекс.
 *
 * Канал отдельный (а не reuse `matchmaker:found`), чтобы gateway мог
 * различать сценарии без if'ов по полям.
 */
export const MATCHMAKER_NO_OPPONENTS_CHANNEL = 'matchmaker:no_opponents';
const POLL_INTERVAL_MS = 2000;
const CATEGORIES: TimeControlCategory[] = ['bullet', 'blitz', 'rapid', 'classical'];

/**
 * KS-2197. Дефолтный таймаут пустой очереди — 60 секунд (ADR-034-v2 §6.6,
 * описание задачи KS-2197). После него матчмейкер шлёт пользователю
 * `MATCHMAKING_NO_OPPONENTS` и автоматически выкидывает из очереди.
 *
 * Перебивается ENV `MATCHMAKING_NO_OPPONENTS_TIMEOUT_MS` (целое число
 * миллисекунд). Невалидное значение → fallback на дефолт.
 *
 * KS-3559: остаётся как safety-net на случай если bot-fallback (см.
 * `readBotTimeoutMs` ниже) упал/выбросил исключение. Дефолт 60s >
 * bot-таймаута (30s), так что в нормальном flow до no-opponents
 * дело не доходит.
 */
export const DEFAULT_NO_OPPONENTS_TIMEOUT_MS = 60_000;

export function readNoOpponentsTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MATCHMAKING_NO_OPPONENTS_TIMEOUT_MS;
  if (!raw) return DEFAULT_NO_OPPONENTS_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_NO_OPPONENTS_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

/**
 * KS-3559. Дефолтный таймаут до bot-fallback'а — 30 секунд (восстановлено
 * из KS-1467 после отката synthetic users в KS-2165). После него
 * `createBotGame` пикает бота из `MATCHMAKING_BOTS` и поднимает партию
 * с `Game.botClientSide=true` — фронт играет ходы через локальный
 * Stockfish 18 WASM.
 *
 * Перебивается ENV `MATCHMAKING_BOT_TIMEOUT_MS`. Невалидное значение →
 * дефолт. Установка в `0` или отрицательное значение НЕ отключает
 * fallback — для отключения нужен `MATCHMAKING_BOT_FALLBACK_ENABLED=false`.
 */
export const DEFAULT_BOT_TIMEOUT_MS = 30_000;

export function readBotTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MATCHMAKING_BOT_TIMEOUT_MS;
  if (!raw) return DEFAULT_BOT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BOT_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

/** KS-3559. Глобальный switch bot-fallback'а. Default ON. */
export function readBotFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MATCHMAKING_BOT_FALLBACK_ENABLED !== 'false';
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
    private readonly botGameService: BotGameService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.processAllQueues(), POLL_INTERVAL_MS);
    const botEnabled = readBotFallbackEnabled();
    this.logger.log(
      `Matchmaker started (poll=${POLL_INTERVAL_MS}ms, ` +
        `botFallback=${botEnabled ? `${readBotTimeoutMs()}ms` : 'disabled'}, ` +
        `noOpponentsTimeout=${readNoOpponentsTimeoutMs()}ms)`,
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

    this.logger.log(`processQueue ${category}: ${entries.length} entries`);

    // Pass 1: live↔live pairing внутри rating range.
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

    // Pass 2 (KS-3559): bot fallback. Возвращено старое client-side
    // поведение из KS-1467 — игроки, провисевшие в очереди дольше
    // MATCHMAKING_BOT_TIMEOUT_MS (default 30s), получают пару с одним
    // из `MATCHMAKING_BOTS` (closest-3 по рейтингу, random). Партия
    // создаётся с `Game.botClientSide=true` — фронт играет Stockfish'ем
    // в браузере. Synthetic users (KS-2165 → revert) тут не задействован.
    if (readBotFallbackEnabled()) {
      await this.runBotFallbackPass(category, queueKey, entries, members, paired);
    }

    // KS-2197 (ADR-034-v2 §6.6). Safety-net: sweep непарированных,
    // провисевших дольше `MATCHMAKING_NO_OPPONENTS_TIMEOUT_MS`
    // (default 60s > bot-таймаут 30s). В нормальном flow до него не
    // доходит — bot-fallback подбирает раньше. Срабатывает только если
    // `MATCHMAKING_BOT_FALLBACK_ENABLED=false` или `createBotGame`
    // выбросил исключение.
    await this.sweepNoOpponents(category, queueKey, entries, members, paired);
  }

  /**
   * KS-3559. Bot-fallback pass: для каждого непарированного entry,
   * провисевшего ≥ `MATCHMAKING_BOT_TIMEOUT_MS`, создаёт партию против
   * случайного бота из `MATCHMAKING_BOTS` (рейтинг-close, top-3).
   *
   * Параметры `entries`/`members` синхронны (одинаковая длина и
   * порядок) — это нужно, чтобы `zrem(queueKey, members[i])` удалил
   * ровно ту строку, которую мы добавили в `joinQueue`.
   */
  private async runBotFallbackPass(
    category: TimeControlCategory,
    queueKey: string,
    entries: QueueEntry[],
    members: string[],
    paired: Set<string>,
  ): Promise<void> {
    const now = Date.now();
    const timeoutMs = readBotTimeoutMs();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (paired.has(entry.userId)) continue;
      const waitedMs = now - entry.joinedAt;
      if (waitedMs < timeoutMs) continue;

      // Сначала ZREM, потом создание партии. Если createBotGame упадёт —
      // user уже не в очереди, fallback не зациклится. Если успех —
      // pub/sub уведомит gateway.
      try {
        await this.redis.zrem(queueKey, members[i]);
        paired.add(entry.userId);
        await this.createBotGame(entry, category);
      } catch (e: unknown) {
        this.logger.error(
          `bot-fallback ${entry.userId}: ${(e as Error).message}`,
        );
      }
    }
  }

  /**
   * KS-2197. Выкидывает из очереди `entries`, провисевшие дольше
   * `MATCHMAKING_NO_OPPONENTS_TIMEOUT_MS` без пары, и публикует
   * `MATCHMAKER_NO_OPPONENTS_CHANNEL` для каждого. Подписчик
   * (`MatchmakingGateway`) шлёт WS-event пользователю и чистит
   * `PLAYER_QUEUES_KEY`-hash.
   *
   * Параметры `entries` и `members` синхронны (одинаковая длина и
   * порядок), это нужно, чтобы вызвать `zrem(queueKey, members[i])` —
   * Redis ждёт ровно тот же сериализованный JSON, который мы добавили.
   *
   * Если вход уже спарен в текущем тике — пропускаем, он попадёт в
   * `createMatchedGame` flow.
   */
  private async sweepNoOpponents(
    category: TimeControlCategory,
    queueKey: string,
    entries: QueueEntry[],
    members: string[],
    paired: Set<string>,
  ): Promise<void> {
    const now = Date.now();
    const timeoutMs = readNoOpponentsTimeoutMs();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (paired.has(entry.userId)) continue;
      const waitedMs = now - entry.joinedAt;
      if (waitedMs < timeoutMs) continue;

      // Сначала удаляем из zset — на случай, если pub/sub упадёт,
      // мы хотя бы не оставим зомби-юзера в очереди (он не будет
      // получать события каждые POLL_INTERVAL_MS, забивая лог).
      await this.redis.zrem(queueKey, members[i]).catch((e: unknown) => {
        this.logger.error(
          `sweepNoOpponents.zrem ${entry.userId}: ${(e as Error).message}`,
        );
      });

      const payload = {
        userId: entry.userId,
        category,
        timeInitial: entry.timeInitialSec,
        increment: entry.timeIncrementSec,
        waitedMs,
      };
      await this.redis
        .publish(MATCHMAKER_NO_OPPONENTS_CHANNEL, JSON.stringify(payload))
        .catch((e: unknown) => {
          this.logger.error(
            `sweepNoOpponents.publish ${entry.userId}: ${(e as Error).message}`,
          );
        });

      this.logger.log(
        `no_opponents: ${entry.userId} waited ${waitedMs}ms in ${category}`,
      );
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

  /**
   * KS-3559. Создаёт партию между entry-игроком и ботом из
   * `MATCHMAKING_BOTS`. Партия маркируется `botClientSide=true` —
   * фронт играет Stockfish'ем локально. Цвета — рандом 50/50.
   *
   * Pub/sub `matchmaker:found` уведомляет gateway, тот шлёт игроку
   * WS-событие со ссылкой на новую партию.
   */
  private async createBotGame(
    entry: QueueEntry,
    category: TimeControlCategory,
  ): Promise<void> {
    const bot = this.botGameService.pickBotForRating(entry.rating);
    const whiteId = Math.random() < 0.5 ? entry.userId : bot.id;
    const blackId = whiteId === entry.userId ? bot.id : entry.userId;

    const game = await this.prisma.game.create({
      data: {
        whiteId,
        blackId,
        status: 'active',
        timeControlType: category,
        timeInitialSec: entry.timeInitialSec,
        timeIncrementSec: entry.timeIncrementSec,
        isBot: true,
        // KS-3559: маркер партии с client-side Stockfish'ем. Фронт по
        // этому полю поднимает локальный WASM-движок вместо ожидания
        // серверных bot-ходов.
        botClientSide: true,
        botLevel: bot.botLevel,
        startedAt: new Date(),
      },
    });

    const timeMs = entry.timeInitialSec * 1000;
    await this.redis.hset(`game:${game.id}:state`, {
      fen: INITIAL_FEN,
      moves: '[]',
      status: 'active',
      active_color: 'white',
      white_id: whiteId,
      black_id: blackId,
      time_increment_sec: String(entry.timeIncrementSec),
    });
    await this.redis.hset(`game:${game.id}:clocks`, {
      white_ms: String(timeMs),
      black_ms: String(timeMs),
      last_tick: '0',
      running: '0',
    });

    const user = await this.prisma.user.findUnique({
      where: { id: entry.userId },
      select: { username: true },
    });
    const playerData = {
      id: entry.userId,
      username: user?.username ?? '',
      rating: entry.rating,
    };
    const botData = {
      id: bot.id,
      username: bot.username,
      rating: bot.rating,
    };

    await this.redis.publish(
      MATCHMAKER_FOUND_CHANNEL,
      JSON.stringify({
        gameId: game.id,
        category,
        timeInitial: entry.timeInitialSec,
        increment: entry.timeIncrementSec,
        white: whiteId === entry.userId ? playerData : botData,
        black: blackId === entry.userId ? playerData : botData,
        isBot: true,
        botClientSide: true,
        botLevel: bot.botLevel,
      }),
    );

    this.logger.log(
      `Bot fallback: ${entry.userId.slice(0, 8)} vs ${bot.username}` +
        `(L${bot.botLevel}) game=${game.id.slice(0, 8)} ${category}`,
    );
  }
}
