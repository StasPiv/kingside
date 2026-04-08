import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
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

const PLAYER_QUEUES_KEY = 'matchmaking:player_queues';

@WebSocketGateway({ namespace: '/matchmaking', cors: { origin: '*' } })
export class MatchmakingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(MatchmakingGateway.name);

  constructor(
    private readonly matchmakingService: MatchmakingService,
    private readonly jwtService: JwtService,
    private readonly i18n: I18nService,
    private readonly redis: RedisService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token || client.handshake.query?.token;
      if (!token) {
        client.disconnect();
        return;
      }
      const payload = this.jwtService.verify<JwtPayload>(String(token));
      client.data.user = { id: payload.sub, username: payload.username };
      this.logger.log(`Matchmaking client connected: ${payload.username} (${client.id})`);
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

    const isOnline = async (userId: string): Promise<boolean> => {
      const sockets = await this.server.fetchSockets();
      return sockets.some((s) => s.data.user?.id === userId);
    };

    let result: Awaited<ReturnType<typeof this.matchmakingService.joinQueue>>;
    try {
      result = await this.matchmakingService.joinQueue(
        user.id,
        data.timeInitial,
        data.increment,
        isOnline,
        data.ratingFilter,
      );
    } catch (e: unknown) {
      this.logger.error(`joinQueue failed for ${user.username}: ${(e as Error).message}`);
      await this.redis.hdel(PLAYER_QUEUES_KEY, user.id);
      client.emit(MatchmakingEvents.ERROR, { code: 'MATCHMAKING_ERROR', message: 'Failed to join queue' });
      return;
    }

    if (result) {
      await this.redis.hdel(PLAYER_QUEUES_KEY, user.id);

      const matchData = {
        gameId: result.gameId,
        timeControl: timeControlType,
        timeInitial: data.timeInitial,
        increment: data.increment,
      };

      const color = result.color as 'white' | 'black';

      const initiatorPayload: WsMatchmakingFoundPayload = {
        ...matchData,
        color,
        opponent: result.opponent,
      };

      const opponentPayload: WsMatchmakingFoundPayload = {
        ...matchData,
        color: color === 'white' ? 'black' : 'white',
        opponent: { id: user.id, username: user.username },
      };

      // Fetch all sockets once and deliver to ALL sockets of each player
      // (handles multiple tabs / reconnects)
      const allSockets = await this.server.fetchSockets();

      let initiatorDelivered = 0;
      let opponentDelivered = 0;

      for (const sock of allSockets) {
        const sockUserId = sock.data.user?.id;
        if (sockUserId === user.id) {
          sock.emit(MatchmakingEvents.FOUND, initiatorPayload);
          initiatorDelivered++;
        } else if (sockUserId === result.opponent?.id) {
          sock.emit(MatchmakingEvents.FOUND, opponentPayload);
          opponentDelivered++;
        }
      }

      if (opponentDelivered > 0) {
        await this.redis.hdel(PLAYER_QUEUES_KEY, result.opponent!.id);
      }

      this.logger.log(
        `Match found: ${result.gameId} — delivered to initiator: ${initiatorDelivered}, opponent: ${opponentDelivered} socket(s)`,
      );

      if (opponentDelivered === 0) {
        this.logger.warn(
          `Match ${result.gameId}: opponent ${result.opponent?.id} has NO connected sockets!`,
        );
      }
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
