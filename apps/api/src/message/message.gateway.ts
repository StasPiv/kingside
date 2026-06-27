import { Logger, Inject, forwardRef } from '@nestjs/common';
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
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from '../auth/jwt.strategy';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import { GameService } from '../game/game.service';
import {
  MessageEvents,
  FriendEvents,
  ChallengeEvents,
  type WsChallengeSendPayload,
  type WsChallengeAcceptPayload,
  type WsChallengeDeclinePayload,
} from '@kingside/shared';
import { randomUUID } from 'crypto';
import { NotificationService } from '../notification/notification.service';

const CHALLENGE_TTL_SEC = 60;
const ONLINE_SET_KEY = 'online_users';
const DISCONNECT_GRACE_MS = 5_000;

@WebSocketGateway({ namespace: '/messages', cors: { origin: '*' }, transports: ['websocket'], pingTimeout: 30000, connectTimeout: 60000 })
export class MessageGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(MessageGateway.name);
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly gameService: GameService,
    @Inject(forwardRef(() => NotificationService)) private readonly notifications: NotificationService,
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
      await client.join(`user:${payload.sub}`);

      // Cancel pending offline timer
      const pending = this.disconnectTimers.get(payload.sub);
      if (pending) {
        clearTimeout(pending);
        this.disconnectTimers.delete(payload.sub);
      }

      // Track online + notify friends
      const wasOnline = await this.redis.sismember(ONLINE_SET_KEY, payload.sub);
      await this.redis.sadd(ONLINE_SET_KEY, payload.sub);
      if (!wasOnline) {
        this.broadcastFriendStatus(payload.sub, payload.username ?? '', FriendEvents.STATUS_ONLINE);
      }

      this.logger.log(`Messages client connected: ${payload.username} (${client.id})`);
    } catch {
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    const user = client.data?.user;
    this.logger.log(`Messages client disconnected: ${client.id}`);

    if (user?.id) {
      // Grace period — user may reconnect quickly (page reload)
      const timer = setTimeout(async () => {
        this.disconnectTimers.delete(user.id);
        // Check if user reconnected (has other sockets in user room)
        const userRoom = (this.server?.adapter as any)?.rooms?.get(`user:${user.id}`);
        const stillConnected = !!(userRoom && userRoom.size > 0);
        if (!stillConnected) {
          await this.redis.srem(ONLINE_SET_KEY, user.id);
          this.broadcastFriendStatus(user.id, user.username ?? '', FriendEvents.STATUS_OFFLINE);
        }
      }, DISCONNECT_GRACE_MS);
      this.disconnectTimers.set(user.id, timer);
    }
  }

  private async broadcastFriendStatus(userId: string, username: string, event: string) {
    try {
      const friendships = await this.prisma.friendship.findMany({
        where: {
          status: 'ACCEPTED',
          OR: [{ requesterId: userId }, { addresseeId: userId }],
        },
        select: { requesterId: true, addresseeId: true },
      });
      const friendIds = friendships.map((f) =>
        f.requesterId === userId ? f.addresseeId : f.requesterId,
      );
      for (const friendId of friendIds) {
        this.server.to(`user:${friendId}`).emit(event, { userId, username });
      }
    } catch (e: unknown) {
      this.logger.warn(`Failed to broadcast friend status: ${(e as Error).message}`);
    }
  }

  // ─── Messages ──────────────────────────────────────────────────────

  notifyNewMessage(
    message: {
      id: string;
      senderId: string;
      receiverId: string;
      text: string;
      createdAt: string;
      readAt: string | null;
    },
    senderUsername: string,
  ) {
    this.server.to(`user:${message.receiverId}`).emit(MessageEvents.NEW_MESSAGE, {
      ...message,
      senderUsername,
    });
  }

  // ─── Friends ───────────────────────────────────────────────────────

  notifyFriendRequestReceived(
    addresseeId: string,
    payload: { requestId: string; user: { id: string; username: string } },
  ) {
    this.server.to(`user:${addresseeId}`).emit(FriendEvents.REQUEST_RECEIVED, payload);
  }

  notifyFriendRequestAccepted(
    requesterId: string,
    payload: { requestId: string; user: { id: string; username: string } },
  ) {
    this.server.to(`user:${requesterId}`).emit(FriendEvents.REQUEST_ACCEPTED, payload);
  }

  notifyFriendStatus(
    userId: string,
    event: typeof FriendEvents.STATUS_ONLINE | typeof FriendEvents.STATUS_OFFLINE,
    payload: { userId: string; username: string },
  ) {
    this.server.to(`user:${userId}`).emit(event, payload);
  }

  /**
   * KS-4701 / ADR-147 §4.1. Push контекстной подсказки авторизованному
   * пользователю. Event-name `hint:show`, payload — `HintShowPayload`
   * из shared (T7). Эмитится HintsService.checkFor после `markShown`
   * для actor.type === 'user'.
   */
  emitHintShow(userId: string, payload: unknown): void {
    this.server.to(`user:${userId}`).emit('hint:show', payload);
  }

  // ─── Challenge ─────────────────────────────────────────────────────

  @SubscribeMessage(ChallengeEvents.SEND)
  async handleChallengeSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsChallengeSendPayload,
  ) {
    const user = client.data.user;
    if (!user) return;

    const challengeId = randomUUID();
    const challenge = {
      id: challengeId,
      fromId: user.id,
      fromUsername: user.username,
      targetUserId: data.targetUserId,
      timeInitial: data.timeInitial,
      increment: data.increment,
      color: data.color ?? 'random',
    };

    try {
      await this.redis.set(
        `challenge:${challengeId}`,
        JSON.stringify(challenge),
        'EX',
        CHALLENGE_TTL_SEC,
      );

      this.server.to(`user:${data.targetUserId}`).emit(ChallengeEvents.RECEIVED, {
        challengeId,
        from: { id: user.id, username: user.username, rating: 1500 },
        timeInitial: data.timeInitial,
        increment: data.increment,
      });

      this.notifications.create(data.targetUserId, 'challenge_received', {
        challengeId,
        fromId: user.id,
        fromUsername: user.username,
        timeInitial: data.timeInitial,
        increment: data.increment,
      }).catch(() => {});

      this.logger.log(`Challenge ${challengeId}: ${user.username} -> ${data.targetUserId}`);
    } catch (e: unknown) {
      client.emit(ChallengeEvents.ERROR, {
        message: 'Failed to send challenge',
      });
    }
  }

  @SubscribeMessage(ChallengeEvents.ACCEPT)
  async handleChallengeAccept(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsChallengeAcceptPayload,
  ) {
    const user = client.data.user;
    if (!user) return;

    try {
      const raw = await this.redis.get(`challenge:${data.challengeId}`);
      if (!raw) {
        client.emit(ChallengeEvents.ERROR, { message: 'Challenge expired or not found' });
        return;
      }

      const challenge = JSON.parse(raw);
      if (challenge.targetUserId !== user.id) {
        client.emit(ChallengeEvents.ERROR, { message: 'Not your challenge' });
        return;
      }

      await this.redis.del(`challenge:${data.challengeId}`);

      // Determine colors
      let whiteId: string;
      let blackId: string;
      if (challenge.color === 'white') {
        whiteId = challenge.fromId;
        blackId = user.id;
      } else if (challenge.color === 'black') {
        whiteId = user.id;
        blackId = challenge.fromId;
      } else {
        if (Math.random() < 0.5) {
          whiteId = challenge.fromId;
          blackId = user.id;
        } else {
          whiteId = user.id;
          blackId = challenge.fromId;
        }
      }

      const game = await this.gameService.createGame(
        whiteId,
        blackId,
        challenge.timeInitial,
        challenge.increment,
      );
      await this.gameService.initGame(game.id);

      // Notify both players
      const challengerColor = whiteId === challenge.fromId ? 'white' : 'black';
      const accepterColor = whiteId === user.id ? 'white' : 'black';

      this.server.to(`user:${challenge.fromId}`).emit(ChallengeEvents.STARTED, {
        gameId: game.id,
        color: challengerColor,
        opponent: { id: user.id, username: user.username },
        timeInitial: challenge.timeInitial,
        increment: challenge.increment,
      });

      client.emit(ChallengeEvents.STARTED, {
        gameId: game.id,
        color: accepterColor,
        opponent: { id: challenge.fromId, username: challenge.fromUsername },
        timeInitial: challenge.timeInitial,
        increment: challenge.increment,
      });

      this.logger.log(`Challenge ${data.challengeId} accepted → game ${game.id}`);
    } catch (e: unknown) {
      client.emit(ChallengeEvents.ERROR, { message: 'Failed to accept challenge' });
    }
  }

  @SubscribeMessage(ChallengeEvents.DECLINE)
  async handleChallengeDecline(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsChallengeDeclinePayload,
  ) {
    const user = client.data.user;
    if (!user) return;

    const raw = await this.redis.get(`challenge:${data.challengeId}`);
    if (raw) {
      const challenge = JSON.parse(raw);
      await this.redis.del(`challenge:${data.challengeId}`);
      this.server.to(`user:${challenge.fromId}`).emit(ChallengeEvents.DECLINE, {
        challengeId: data.challengeId,
        declinedBy: { id: user.id, username: user.username },
      });
    }
  }
}
