import { Logger, Inject, Optional, forwardRef } from '@nestjs/common';
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
import { HintsService } from '../hints/hints.service';
import { HintsMetricsService } from '../hints/hints-metrics.service';

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
    // KS-4786: replay контекстных подсказок на handleConnection.
    @Inject(forwardRef(() => HintsService)) private readonly hints: HintsService,
    // KS-4807 / ADR-153 §2.2. Метрики наблюдаемости emit hint:show:
    // room-size + empty-counter. `@Optional` — unit-spec'и могут
    // конструировать gateway без HintsModule.
    @Optional() private readonly hintsMetrics?: HintsMetricsService,
  ) {}

  /**
   * KS-4814. Диагностика: сравнить размеры room `user:<id>` в **двух**
   * namespace'ах — root `/` и `/messages`. Если сокет реально joined
   * в `/messages` (как и должно быть по handleConnection), а у root
   * пусто — значит наш `emit hint:show` через `this.server.to(room)`
   * адресуется не туда (метод `to()` на корневом Server'е работает с
   * root namespace, не с namespace gateway'а).
   *
   * Также возвращает общее число rooms в каждом namespace — sanity для
   * понимания «вообще ли есть какие-то join'ы».
   */
  async inspectRoom(userId: string): Promise<{
    room: string;
    root_size: number;
    messages_size: number;
    root_total_rooms: number;
    messages_total_rooms: number;
    messages_ns_sockets: number;
    engine_clients_total: number;
    /** KS-4814: `await server.of('/messages').in(room).fetchSockets()`
     *  — глобальный список сокетов в room (через Redis-adapter
     *  pub/sub при `WS_USE_REDIS_ADAPTER=true`). Авторитативный
     *  источник по сравнению с локальной `adapter.rooms.get`. */
    messages_fetch_sockets_count: number;
    messages_fetch_socket_ids: string[];
    /** KS-4818 diag: что Nest подсунул через `@WebSocketServer()`. */
    server_constructor_name: string;
    server_name: string | null;
    /** KS-4818 diag: прямые показатели adapter на `this.server`
     *  (без `.of('/messages')` и без `.sockets`). Если `this.server`
     *  это namespace `/messages`, тогда это и есть его собственный
     *  adapter. */
    direct_adapter_rooms_size: number;
    direct_adapter_room_size: number;
    direct_fetch_sockets_count: number;
    direct_fetch_socket_ids: string[];
  }> {
    const room = `user:${userId}`;
    const server: any = this.server as any;
    const rootNs = server?.sockets?.adapter;
    const msgNs = server?.of?.('/messages')?.adapter;
    const msgNsSocketsMap = server?.of?.('/messages')?.sockets;

    let fetchCount = 0;
    let fetchIds: string[] = [];
    try {
      const sockets = await server?.of?.('/messages')?.in?.(room)?.fetchSockets?.();
      if (Array.isArray(sockets)) {
        fetchCount = sockets.length;
        fetchIds = sockets.map((s: any) => String(s?.id ?? '?')).slice(0, 16);
      }
    } catch {
      /* fetchSockets may throw if adapter not configured; treat as 0 */
    }

    // KS-4818: прямой замер adapter на this.server — без .of('/messages')
    // и без .sockets. Если this.server это Namespace, это даст истинные
    // числа сокетов в /messages. Если this.server это root Server —
    // это будет root-adapter.
    const directAdapter = server?.adapter;
    const directRoomsSize: number = directAdapter?.rooms?.size ?? 0;
    const directRoomSize: number = directAdapter?.rooms?.get(room)?.size ?? 0;
    let directFetchCount = 0;
    let directFetchIds: string[] = [];
    try {
      const sockets = await server?.in?.(room)?.fetchSockets?.();
      if (Array.isArray(sockets)) {
        directFetchCount = sockets.length;
        directFetchIds = sockets.map((s: any) => String(s?.id ?? '?')).slice(0, 16);
      }
    } catch {
      /* ignore */
    }

    return {
      room,
      root_size: rootNs?.rooms?.get(room)?.size ?? 0,
      messages_size: msgNs?.rooms?.get(room)?.size ?? 0,
      root_total_rooms: rootNs?.rooms?.size ?? 0,
      messages_total_rooms: msgNs?.rooms?.size ?? 0,
      messages_ns_sockets: typeof msgNsSocketsMap?.size === 'number'
        ? msgNsSocketsMap.size
        : 0,
      engine_clients_total: server?.engine?.clientsCount ?? 0,
      messages_fetch_sockets_count: fetchCount,
      messages_fetch_socket_ids: fetchIds,
      server_constructor_name: server?.constructor?.name ?? 'unknown',
      server_name: typeof server?.name === 'string' ? server.name : null,
      direct_adapter_rooms_size: directRoomsSize,
      direct_adapter_room_size: directRoomSize,
      direct_fetch_sockets_count: directFetchCount,
      direct_fetch_socket_ids: directFetchIds,
    };
  }

  async handleConnection(client: Socket) {
    // KS-4814: подробный лог каждого attempt'а. По нему в CloudWatch
    // видно: дошёл ли token в handshake, какой namespace, успешен ли
    // verify, дошли ли до client.join, итоговые rooms.
    const hasAuthToken = !!(client.handshake?.auth as any)?.token;
    const hasQueryToken = !!(client.handshake?.query as any)?.token;
    const nspName = (client.nsp as any)?.name ?? '?';
    this.logger.log(
      `[KS-4814] handleConnection enter: sid=${client.id} nsp=${nspName} `
        + `authToken=${hasAuthToken} queryToken=${hasQueryToken}`,
    );
    try {
      const token = client.handshake.auth?.token || client.handshake.query?.token;
      if (!token) {
        this.logger.warn(
          `[KS-4814] handleConnection: no token, disconnect sid=${client.id} nsp=${nspName}`,
        );
        client.disconnect();
        return;
      }
      const payload = this.jwtService.verify<JwtPayload>(String(token));
      client.data.user = { id: payload.sub, username: payload.username };
      await client.join(`user:${payload.sub}`);
      // KS-4818 diag: что именно за объект this.server, и видит ли его
      // adapter этот join сразу после `client.join`.
      const srv: any = this.server as any;
      const srvCtor = srv?.constructor?.name ?? 'unknown';
      const srvName = typeof srv?.name === 'string' ? srv.name : '?';
      const directRoomSize = srv?.adapter?.rooms?.get(`user:${payload.sub}`)?.size ?? 0;
      const directRoomsTotal = srv?.adapter?.rooms?.size ?? 0;
      const ofMsgRoomSize = srv?.of?.('/messages')?.adapter?.rooms?.get(`user:${payload.sub}`)?.size ?? 0;
      this.logger.log(
        `[KS-4814] handleConnection joined: sid=${client.id} nsp=${nspName} `
          + `sub=${payload.sub} rooms=[${[...client.rooms].join(',')}] `
          + `serverCtor=${srvCtor} serverName=${srvName} `
          + `directAdapterRoomSize=${directRoomSize} directAdapterRoomsTotal=${directRoomsTotal} `
          + `ofMessagesRoomSize=${ofMsgRoomSize}`,
      );

      // KS-4788 / ADR-151. Replay контекстных подсказок, потерянных из-за
      // гонки primary-emit (DSL match) vs WS-handshake. Отдельный путь
      // данных: НЕ оценивает DSL, НЕ применяет throttle/session-лимиты,
      // НЕ правит state. Источник — `ActorHintState.lastShownAt` vs
      // `shownAckAt`: если сервер пытался эмитнуть, но клиент не ack-нул
      // в окне `replayWindowSec` (default 60s) — на handshake получит
      // тот же hint. Per-handshake/multi-tab дубли дедупит frontend
      // `<HintHost>` по hintId.
      //
      // Прежний вариант (KS-4786) делал `checkFor({triggerEventType:'ws_connected'})`
      // — полный pipeline c DSL и canShow. Глобальный throttle 600s после
      // первого матча давал `canShow=false` на ws_connected → replay не
      // срабатывал. Новый путь решает это явно.
      try {
        const replays = await this.hints.replayPending({ type: 'user', id: payload.sub });
        for (const p of replays) {
          this.emitHintShow(payload.sub, p);
        }
      } catch (err) {
        this.logger.debug?.(`replayPending failed for user=${payload.sub}: ${(err as Error).message}`);
      }

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
    } catch (err) {
      // KS-4814: лог детали exception, чтобы было видно почему disconnect.
      this.logger.warn(
        `[KS-4814] handleConnection catch: sid=${client.id} nsp=${nspName} `
          + `error=${(err as Error)?.message ?? err}`,
      );
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
   * KS-4701 / ADR-147 §4.1 + KS-4807 / ADR-153 §2.2. Push контекстной
   * подсказки авторизованному пользователю. Event-name `hint:show`,
   * payload — `HintShowPayload` из shared (T7). Эмитится из
   * `HintsService.checkFor` после `upsert lastShownAt + markShown` для
   * `actor.type === 'user'`, а также из `handleConnection` (replay
   * по ADR-151).
   *
   * Перед `emit` снимаем размер Socket.IO room `user:<id>`. Если room
   * пуста — payload всё равно дроп, fail-soft. `lastShownAt` уже
   * записан выше → replay-on-connect (ADR-151) подхватит на следующем
   * handshake. Метрики `hints_emit_room_empty_total` /
   * `hints_emit_room_size` делают факт наблюдаемым на Prometheus.
   *
   * Возвращает `{ delivered }` для будущего callers'а (если кому-то
   * нужен явный сигнал — пока никто не использует, метрики важнее).
   */
  emitHintShow(
    userId: string,
    payload: unknown,
    actorType: 'user' | 'guest' = 'user',
  ): { delivered: boolean } {
    const room = `user:${userId}`;
    const size = this.server?.sockets?.adapter?.rooms?.get(room)?.size ?? 0;
    this.hintsMetrics?.emitRoomSize.observe({ actor_type: actorType }, size);
    if (size === 0) {
      this.hintsMetrics?.emitRoomEmpty.inc({ actor_type: actorType });
      this.logger.warn(
        `emitHintShow: room ${room} empty (actor_type=${actorType}), payload dropped — `
          + `replay-on-connect (ADR-151) will pick it up on next handshake.`,
      );
      return { delivered: false };
    }
    this.server.to(room).emit('hint:show', payload);
    return { delivered: true };
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
