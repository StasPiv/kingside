import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { RedisService } from '../redis/redis.service';
import {
  BROADCAST_MOVE_CHANNEL,
  BROADCAST_SYNC_CHANNEL,
} from '../sync/broadcast-channels';
import {
  SubscribeRoundDto,
  UnsubscribeRoundDto,
} from './dto/broadcast.dto';

/**
 * KS-4846 / ADR-157 §2.3. Redis-хеш для agregированного счётчика
 * WS-подписок per round — используется `evaluateStreamPriorities` в
 * `broadcast-sync.service.ts` для выбора топ-8 стримов.
 */
const WS_SUBS_HASH_KEY = 'broadcast:ws-subs';
const WS_ROOM_PREFIX = 'broadcast:';
/**
 * KS-4846 / ADR-157 §2.3. Периодическая уборка ключей с count <= 0 —
 * защита от кумулятивного дрейфа при крашах реплики (когда disconnect
 * не успел прибавить -1). Раз в 5 мин.
 */
const WS_SUBS_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * KS-4846 / ADR-157 §2.3 (упрощение). Ежесуточный сброс хеша в 04:00 UTC
 * (минимальная нагрузка). Событийный подсчёт сразу пересобирает хеш.
 */
const WS_SUBS_RESET_HOUR_UTC = 4;
const WS_SUBS_RESET_CHECK_INTERVAL_MS = 60 * 60 * 1000; // раз в час

const BroadcastEvents = {
  SUBSCRIBE: 'broadcast:subscribe',
  UNSUBSCRIBE: 'broadcast:unsubscribe',
  MOVE: 'broadcast:move',
  SYNC: 'broadcast:sync',
  ERROR: 'error',
} as const;

type WsBroadcastMovePayload = {
  roundId: string;
  gameIndex: number;
  uci: string;
  fen: string;
  whitePlayer: string;
  blackPlayer: string;
  /** KS-2798. ISO wall-clock этого хода; null если ход не новый. */
  lastMoveAt?: string | null;
};

/**
 * WS gateway для трансляций (ADR-021 §2.3).
 *
 * KS-1702: namespace убран (subdomain `broadcasts.kingside.site` уже выражает
 * домен) — используется default `/`. transports=['websocket']. Клиент
 * подписывается на `broadcast:{roundId}` room через event `broadcast:subscribe`.
 * Источник обновлений — Redis pub/sub каналы, которые пишет sync-loop
 * (`BroadcastSyncService`) в том же процессе.
 *
 * Multi-instance safe: socket.io настроен с `RedisIoAdapter`
 * (см. `apps/broadcast-service/src/redis/redis-io.adapter.ts`), так что
 * room-events доставляются через все реплики.
 */
@WebSocketGateway({
  cors: { origin: '*' },
  transports: ['websocket'],
  pingTimeout: 30000,
  connectTimeout: 60000,
})
export class BroadcastGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(BroadcastGateway.name);
  private subRedis: Redis | null = null;
  // KS-4846 / ADR-157 §2.3. Таймеры уборки и суточного сброса хеша
  // WS-подписок. Держим ссылки, чтобы snять в onModuleDestroy.
  private wsSubsCleanupTimer: NodeJS.Timeout | null = null;
  private wsSubsResetTimer: NodeJS.Timeout | null = null;
  private lastWsSubsResetDayUtc = -1;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    // KS-4846 / ADR-157 §2.3. Общий Redis-клиент для агрегированного
    // счётчика WS-подписок (broadcast:ws-subs).
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Dedicated subscriber: не используем общий RedisService, чтобы
    // команды (subscribe) не блокировали обычные read/write операции.
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6380', 10);
    this.subRedis = new Redis({ host: redisHost, port: redisPort });

    this.subRedis
      .subscribe(BROADCAST_MOVE_CHANNEL, BROADCAST_SYNC_CHANNEL)
      .catch((e) =>
        this.logger.error(`Redis subscribe failed: ${e.message}`),
      );

    this.subRedis.on('message', (channel: string, message: string) => {
      try {
        const payload = JSON.parse(message);
        if (channel === BROADCAST_MOVE_CHANNEL && payload.roundId) {
          this.metrics.incRedisMessage(BROADCAST_MOVE_CHANNEL);
          this.server
            .to(`broadcast:${payload.roundId}`)
            .emit(BroadcastEvents.MOVE, payload);
        } else if (channel === BROADCAST_SYNC_CHANNEL && payload.roundId) {
          this.metrics.incRedisMessage(BROADCAST_SYNC_CHANNEL);
          this.server
            .to(`broadcast:${payload.roundId}`)
            .emit(BroadcastEvents.SYNC, payload);
        }
      } catch (e: unknown) {
        this.logger.error(
          `Redis message parse error: ${(e as Error).message}`,
        );
      }
    });

    this.logger.log('Subscribed to Redis broadcast channels');

    // KS-4846 / ADR-157 §2.3. Периодическая уборка Redis-хеша от
    // «мусорных» записей и суточный полный сброс.
    this.wsSubsCleanupTimer = setInterval(() => {
      this.cleanupWsSubs().catch((e: Error) =>
        this.logger.warn(`ws-subs cleanup failed: ${e.message}`),
      );
    }, WS_SUBS_CLEANUP_INTERVAL_MS);
    this.wsSubsResetTimer = setInterval(() => {
      this.maybeResetWsSubs().catch((e: Error) =>
        this.logger.warn(`ws-subs reset failed: ${e.message}`),
      );
    }, WS_SUBS_RESET_CHECK_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.wsSubsCleanupTimer) clearInterval(this.wsSubsCleanupTimer);
    if (this.wsSubsResetTimer) clearInterval(this.wsSubsResetTimer);
    if (this.subRedis) {
      await this.subRedis.unsubscribe().catch(() => {});
      await this.subRedis.quit().catch(() => {});
      this.subRedis = null;
    }
  }

  handleConnection(client: Socket): void {
    this.metrics.incWsConnection();
    this.logger.log(`Broadcast client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.metrics.decWsConnection();
    // KS-4846 / ADR-157 §2.3. При разрыве соединения декрементируем
    // счётчик для КАЖДОЙ комнаты `broadcast:*`, в которой клиент был.
    // handleUnsubscribe в этом сценарии не вызывается — socket.io просто
    // рвёт соединение, поэтому подсчёт должен идти прямо здесь.
    for (const room of client.rooms) {
      if (typeof room === 'string' && room.startsWith(WS_ROOM_PREFIX)) {
        const roundId = room.slice(WS_ROOM_PREFIX.length);
        if (roundId) {
          this.redis
            .hincrby(WS_SUBS_HASH_KEY, roundId, -1)
            .catch((e: Error) =>
              this.logger.warn(
                `ws-subs hincrby(disconnect ${roundId}) failed: ${e.message}`,
              ),
            );
        }
      }
    }
    this.logger.log(`Broadcast client disconnected: ${client.id}`);
  }

  @SubscribeMessage(BroadcastEvents.SUBSCRIBE)
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SubscribeRoundDto,
  ): Promise<void> {
    const { roundId } = data;
    await client.join(`broadcast:${roundId}`);
    this.metrics.incSubscribe(roundId);
    // KS-4846 / ADR-157 §2.3. Инкремент агрегированного счётчика
    // Redis-хеша broadcast:ws-subs — вход в приоритизацию стримов.
    await this.redis
      .hincrby(WS_SUBS_HASH_KEY, roundId, 1)
      .catch((e: Error) =>
        this.logger.warn(
          `ws-subs hincrby(sub ${roundId}) failed: ${e.message}`,
        ),
      );
    this.logger.log(`Client ${client.id} subscribed to round ${roundId}`);

    const round = await this.prisma.broadcastRound.findUnique({
      where: { id: roundId },
      include: { games: true },
    });
    if (!round) return;

    const syncPayload = {
      roundId,
      games: round.games.map((g, idx) => ({
        // KS-2774. UUID партии — фронт использует для кликабельных
        // карточек на странице тура (Boolean(game.id) check). Без
        // этого поля sync затирает id из REST-выборки.
        id: g.id,
        gameIndex: idx,
        fen:
          g.currentFen ??
          'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        whitePlayer: g.whitePlayer ?? 'Unknown',
        blackPlayer: g.blackPlayer ?? 'Unknown',
        result: g.result ?? null,
        pgn: g.pgn ?? null,
        // KS-2699: clocks для live-таймера на фронте.
        whiteClockMs:
          g.whiteClockMs !== null && g.whiteClockMs !== undefined
            ? Number(g.whiteClockMs)
            : null,
        blackClockMs:
          g.blackClockMs !== null && g.blackClockMs !== undefined
            ? Number(g.blackClockMs)
            : null,
        clockUpdatedAt: g.clockUpdatedAt
          ? g.clockUpdatedAt.toISOString()
          : null,
        // KS-2798: wall-clock последнего хода (см. schema-comment).
        lastMoveAt: g.lastMoveAt ? g.lastMoveAt.toISOString() : null,
      })),
    };

    client.emit(BroadcastEvents.SYNC, syncPayload);
  }

  @SubscribeMessage(BroadcastEvents.UNSUBSCRIBE)
  async handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: UnsubscribeRoundDto,
  ): Promise<void> {
    const { roundId } = data;
    await client.leave(`broadcast:${roundId}`);
    // KS-4846 / ADR-157 §2.3. Декремент счётчика — симметрично subscribe.
    await this.redis
      .hincrby(WS_SUBS_HASH_KEY, roundId, -1)
      .catch((e: Error) =>
        this.logger.warn(
          `ws-subs hincrby(unsub ${roundId}) failed: ${e.message}`,
        ),
      );
    this.logger.log(`Client ${client.id} unsubscribed from round ${roundId}`);
  }

  /**
   * KS-4846 / ADR-157 §2.3. Периодическая уборка Redis-хеша от ключей с
   * count <= 0 (защита от расхождений при крашах реплики или гонках
   * disconnect). Читает через HGETALL, HDEL по батчу — hash небольшой
   * (типично 20–30 записей).
   */
  private async cleanupWsSubs(): Promise<void> {
    const raw = await this.redis.hgetall(WS_SUBS_HASH_KEY);
    const toDelete: string[] = [];
    for (const [roundId, value] of Object.entries(raw)) {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) toDelete.push(roundId);
    }
    if (toDelete.length > 0) {
      await this.redis.hdel(WS_SUBS_HASH_KEY, ...toDelete);
      this.logger.log(`ws-subs cleanup: removed ${toDelete.length} zero/negative rounds`);
    }
  }

  /**
   * KS-4846 / ADR-157 §2.3. Полный сброс хеша раз в сутки в 04:00 UTC —
   * защита от кумулятивного дрейфа. Событийный подсчёт (subscribe/
   * unsubscribe/disconnect) сразу пересобирает хеш от нуля.
   */
  private async maybeResetWsSubs(): Promise<void> {
    const now = new Date();
    if (now.getUTCHours() !== WS_SUBS_RESET_HOUR_UTC) return;
    const day = now.getUTCDate();
    if (day === this.lastWsSubsResetDayUtc) return;
    this.lastWsSubsResetDayUtc = day;
    await this.redis.del(WS_SUBS_HASH_KEY);
    this.logger.log('ws-subs daily reset done');
  }

  /** @deprecated Используй Redis pub/sub из `BroadcastSyncService`. */
  emitMove(roundId: string, payload: WsBroadcastMovePayload): void {
    this.server
      .to(`broadcast:${roundId}`)
      .emit(BroadcastEvents.MOVE, payload);
  }

  /** @deprecated Используй Redis pub/sub из `BroadcastSyncService`. */
  emitSync(
    roundId: string,
    payload: {
      roundId: string;
      games: Array<{
        gameIndex: number;
        fen: string;
        whitePlayer: string;
        blackPlayer: string;
        result: string | null;
        pgn: string | null;
        whiteClockMs?: number | null;
        blackClockMs?: number | null;
        clockUpdatedAt?: string | null;
        /** KS-2798. ISO wall-clock последнего хода в партии. */
        lastMoveAt?: string | null;
      }>;
    },
  ): void {
    this.server
      .to(`broadcast:${roundId}`)
      .emit(BroadcastEvents.SYNC, payload);
  }
}
