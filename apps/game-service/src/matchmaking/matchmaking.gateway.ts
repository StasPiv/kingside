import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, UsePipes, ValidationPipe, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { JwtService } from '@nestjs/jwt';
import { I18nService } from 'nestjs-i18n';
import { MatchmakingService } from './matchmaking.service';
import { JoinQueueDto } from './dto/join-queue.dto';
import { JwtPayload } from '../auth/jwt.strategy';
import { RedisService } from '../redis/redis.service';
import {
  classifyTimeControl,
  MatchmakingEvents,
  type TimeControlCategory,
  type WsMatchmakingJoinPayload,
  type WsMatchmakingFoundPayload,
  type WsErrorPayload,
} from '@kingside/shared';

/** Redis pub/sub channel from matchmaker worker */
const MATCHMAKER_FOUND_CHANNEL = 'matchmaker:found';

const PLAYER_QUEUES_KEY = 'matchmaking:player_queues';

@WebSocketGateway({ namespace: '/matchmaking', cors: { origin: '*' }, transports: ['websocket'], pingInterval: 300000, pingTimeout: 300000, connectTimeout: 60000 })
export class MatchmakingGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(MatchmakingGateway.name);
  private subRedis: Redis | null = null;

  constructor(
    private readonly matchmakingService: MatchmakingService,
    private readonly jwtService: JwtService,
    private readonly i18n: I18nService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6380', 10);
    this.subRedis = new Redis({ host: redisHost, port: redisPort });

    this.subRedis.subscribe(MATCHMAKER_FOUND_CHANNEL).catch((e) =>
      this.logger.error(`Redis subscribe failed: ${e.message}`),
    );

    this.subRedis.on('message', (channel: string, message: string) => {
      if (channel !== MATCHMAKER_FOUND_CHANNEL) return;
      try {
        const data = JSON.parse(message);
        const matchData = {
          gameId: data.gameId,
          timeControl: data.category,
          timeInitial: data.timeInitial,
          increment: data.increment,
        };

        // Emit to white player
        const whitePayload: WsMatchmakingFoundPayload = {
          ...matchData, color: 'white', opponent: data.black,
        };
        this.server.to(`user:${data.white.id}`).emit(MatchmakingEvents.FOUND, whitePayload);

        // Emit to black player
        const blackPayload: WsMatchmakingFoundPayload = {
          ...matchData, color: 'black', opponent: data.white,
        };
        this.server.to(`user:${data.black.id}`).emit(MatchmakingEvents.FOUND, blackPayload);

        // Clean up player queue tracking
        this.redis.hdel(PLAYER_QUEUES_KEY, data.white.id).catch(() => {});
        this.redis.hdel(PLAYER_QUEUES_KEY, data.black.id).catch(() => {});

        this.logger.log(`matchmaker:found → game=${data.gameId.slice(0, 8)}`);
      } catch (e: any) {
        this.logger.error(`Redis message parse error: ${e.message}`);
      }
    });

    this.logger.log('Subscribed to matchmaker:found Redis channel');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subRedis) {
      await this.subRedis.unsubscribe().catch(() => {});
      await this.subRedis.quit().catch(() => {});
      this.subRedis = null;
    }
  }

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token || client.handshake.query?.token;
      if (!token) {
        client.disconnect();
        return;
      }
      const payload = this.jwtService.verify<JwtPayload>(String(token));
      client.data.user = { id: payload.sub, username: payload.username };
      await client.join(`user:${payload.sub}`);
      this.logger.log(`Matchmaking client connected: ${payload.username} (${client.id})`);
      client.emit('server:instance', { instanceId: require('../instance-logger').INSTANCE_ID });
    } catch {
      client.disconnect();
    }
  }

  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage(MatchmakingEvents.JOIN)
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: JoinQueueDto,
  ) {
    const user = client.data.user;
    if (!user) return;

    const existingQueue = await this.redis.hget(PLAYER_QUEUES_KEY, user.id);
    if (existingQueue) {
      const errorPayload: WsErrorPayload = { code: 'ALREADY_IN_QUEUE', message: this.i18n.t('messages.matchmaking.alreadyInQueue') };
      client.emit(MatchmakingEvents.ERROR, errorPayload);
      return;
    }

    const timeControlType = classifyTimeControl(data.timeInitial, data.increment);
    await this.redis.hset(PLAYER_QUEUES_KEY, user.id, timeControlType);
    this.logger.log(`${user.username} joined ${timeControlType} queue (${data.timeInitial}+${data.increment})`);

    // Only add to queue — matchmaker worker handles pairing via Redis pub/sub
    try {
      await this.matchmakingService.joinQueue(
        user.id,
        data.timeInitial,
        data.increment,
        undefined,
        data.ratingFilter,
      );
    } catch (e: unknown) {
      this.logger.error(`joinQueue failed for ${user.username}: ${(e as Error).message}`);
      await this.redis.hdel(PLAYER_QUEUES_KEY, user.id);
      client.emit(MatchmakingEvents.ERROR, { code: 'MATCHMAKING_ERROR', message: 'Failed to join queue' });
    }
  }

  @SubscribeMessage(MatchmakingEvents.LEAVE)
  async handleLeave(@ConnectedSocket() client: Socket) {
    const user = client.data.user;
    if (!user) return;

    const timeControl = await this.redis.hget(PLAYER_QUEUES_KEY, user.id) as TimeControlCategory | null;
    if (!timeControl) return;

    await this.matchmakingService.leaveQueue(user.id, timeControl);
    await this.redis.hdel(PLAYER_QUEUES_KEY, user.id);
    this.logger.log(`${user.username} left ${timeControl} queue`);
  }

  async handleDisconnect(client: Socket) {
    const user = client.data?.user;
    if (!user) return;

    const timeControl = await this.redis.hget(PLAYER_QUEUES_KEY, user.id) as TimeControlCategory | null;
    if (timeControl) {
      await this.matchmakingService.leaveQueue(user.id, timeControl);
      await this.redis.hdel(PLAYER_QUEUES_KEY, user.id);
      this.logger.log(`${user.username} disconnected, removed from ${timeControl} queue`);
    }
  }
}
