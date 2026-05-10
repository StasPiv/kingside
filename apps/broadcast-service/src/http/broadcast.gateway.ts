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
import {
  BROADCAST_MOVE_CHANNEL,
  BROADCAST_SYNC_CHANNEL,
} from '../sync/broadcast-channels';
import {
  SubscribeRoundDto,
  UnsubscribeRoundDto,
} from './dto/broadcast.dto';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
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
  }

  async onModuleDestroy(): Promise<void> {
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
    this.logger.log(`Client ${client.id} subscribed to round ${roundId}`);

    const round = await this.prisma.broadcastRound.findUnique({
      where: { id: roundId },
      include: { games: true },
    });
    if (!round) return;

    const syncPayload = {
      roundId,
      games: round.games.map((g, idx) => ({
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
    this.logger.log(`Client ${client.id} unsubscribed from round ${roundId}`);
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
      }>;
    },
  ): void {
    this.server
      .to(`broadcast:${roundId}`)
      .emit(BroadcastEvents.SYNC, payload);
  }
}
