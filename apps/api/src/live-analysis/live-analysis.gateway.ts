import {
  ForbiddenException,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import {
  LiveAnalysisEvents,
  type LiveAnalysisClosedEvent,
  type LiveAnalysisCloseReason,
  type LiveAnalysisErrorEvent,
  type LiveAnalysisMoveEvent,
  type LiveAnalysisSyncSnapshot,
  type LiveAnalysisViewersEvent,
  type WebRTCAnswerEvent,
  type WebRTCCapacityExceededEvent,
  type WebRTCIceEvent,
  type WebRTCOfferEvent,
  type WebRTCPeerJoinedEvent,
  type WebRTCPeerLeftEvent,
} from '@kingside/shared';
import { JwtPayload } from '../auth/jwt.strategy';
import { LiveAnalysisService } from './live-analysis.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ClosePayloadDto,
  MovePayloadDto,
  ResetPayloadDto,
  StatePatchPayloadDto,
  SubscribePayloadDto,
  SyncRequestPayloadDto,
  UnsubscribePayloadDto,
} from './dto/ws-payload.dto';
import {
  WebRTCAnswerDto,
  WebRTCIceDto,
  WebRTCOfferDto,
  WebRTCPeerJoinedDto,
  WebRTCPeerLeftDto,
} from './dto/webrtc-payload.dto';

/**
 * KS-3732 / ADR-110 §2.2, §2.6: WebSocket gateway live-трансляции.
 *
 * Namespace `/live-analysis`. JWT в handshake опционален:
 *   - есть и валиден → `client.data.user = {id, username}` (потенциальный автор);
 *   - нет / невалиден → `client.data.user = null` (анонимный зритель).
 *
 * Pub/sub: подписан на `live-analysis:move|sync|closed` через отдельное
 * Redis-соединение (общий RedisService нельзя — `subscribe` блокирует
 * соединение для команд). Это даёт multi-instance готовность: ход,
 * сделанный на инстансе A, через канал прилетает на инстанс B и
 * эмитится в комнату.
 */
/**
 * KS-3744 / ADR-111 §2.8 п.11–12, §8:
 *   - `perMessageDeflate: true` — сжатие WS-фреймов. Annotated PGN —
 *     текст с повторами (NAG-теги, повторяющиеся имена клеток,
 *     дублирующиеся комментарии в вариантах), жмётся 5× и выше.
 *     CPU-цена при 5 эмитах/сек на инстанс несущественна.
 *   - `maxHttpBufferSize: 512_000` (512 KB) — вдвое больше жёсткого
 *     лимита PGN (256 KB) из `applyStatePatch`. Запас на JSON-обвязку
 *     (slug, headers, currentPly, orientation) и на накладные расходы
 *     протокола.
 */
@WebSocketGateway({
  namespace: LiveAnalysisEvents.NAMESPACE,
  cors: { origin: '*' },
  transports: ['websocket'],
  pingTimeout: 30000,
  connectTimeout: 60000,
  perMessageDeflate: true,
  maxHttpBufferSize: 512_000,
})
export class LiveAnalysisGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(LiveAnalysisGateway.name);
  private subRedis: Redis | null = null;

  /** Throttle для эмита `viewers` per-slug: не чаще раза в N мс. */
  private static readonly VIEWERS_THROTTLE_MS = 2000;
  private readonly viewersThrottle = new Map<string, number>();

  // ─── KS-3836 / ADR-116 §2.2: WebRTC-сигналинг ───────────────────────
  //
  // Peer-list per lecture: владелец-publisher (≤1 socket) и
  // subscriber'ы (capacity 15). Хранится в памяти инстанса — для
  // multi-instance setup'а потребуется Redis pub/sub (вынесено за
  // рамки этой задачи; в проде сейчас один API-инстанс).
  //
  // `ownerSocketId` = null означает, что publisher ещё не подключился
  // (subscriber'ы могут уже стоять в очереди — capacity всё равно
  // считаем). При смене socket'а publisher'а (reconnect) старый id
  // вытесняется новым.
  /** Жёсткий потолок подписчиков на лекцию (ADR-116 §2.2). */
  static readonly WEBRTC_MAX_SUBSCRIBERS = 15;

  private readonly webrtcPeers = new Map<
    string,
    { ownerSocketId: string | null; subscribers: Set<string> }
  >();

  constructor(
    private readonly jwtService: JwtService,
    private readonly service: LiveAnalysisService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const redisHost = this.config.get<string>('REDIS_HOST', 'localhost');
    const redisPort = Number(this.config.get<number>('REDIS_PORT', 6380));
    this.subRedis = new Redis({ host: redisHost, port: redisPort });

    await this.subRedis
      .subscribe(
        LiveAnalysisService.CHANNEL_MOVE,
        LiveAnalysisService.CHANNEL_SYNC,
        LiveAnalysisService.CHANNEL_CLOSED,
      )
      .catch((e) =>
        this.logger.error(`Redis subscribe failed: ${(e as Error).message}`),
      );

    this.subRedis.on('message', (channel: string, message: string) => {
      try {
        const payload = JSON.parse(message);
        if (!payload || typeof payload.slug !== 'string') return;
        const room = this.roomFor(payload.slug);
        if (channel === LiveAnalysisService.CHANNEL_MOVE) {
          this.server.to(room).emit(LiveAnalysisEvents.MOVE, payload as LiveAnalysisMoveEvent);
        } else if (channel === LiveAnalysisService.CHANNEL_SYNC) {
          this.server.to(room).emit(LiveAnalysisEvents.SYNC, payload as LiveAnalysisSyncSnapshot);
        } else if (channel === LiveAnalysisService.CHANNEL_CLOSED) {
          this.server
            .to(room)
            .emit(LiveAnalysisEvents.CLOSED, payload as LiveAnalysisClosedEvent);
          this.server.in(room).socketsLeave(room);
        }
      } catch (e) {
        this.logger.warn(`pub/sub parse error: ${(e as Error).message}`);
      }
    });

    this.logger.log('Subscribed to Redis live-analysis channels');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subRedis) {
      await this.subRedis.unsubscribe().catch(() => {});
      await this.subRedis.quit().catch(() => {});
      this.subRedis = null;
    }
  }

  async handleConnection(client: Socket): Promise<void> {
    // KS-3734 / ADR §6: лимит 10 одновременных WS-коннектов на IP.
    const ip = this.extractClientIp(client);
    client.data.ip = ip;
    const allowed = await this.service.tryAcquireIpSlot(ip);
    if (!allowed) {
      this.logger.warn(`Reject WS connection from ip=${ip} (cap exceeded)`);
      // Сообщаем причину и закрываем — клиент увидит error до disconnect.
      const errPayload: LiveAnalysisErrorEvent = {
        code: 'rate-limit',
        message: 'IP connection limit exceeded',
      };
      client.emit(LiveAnalysisEvents.ERROR, errPayload);
      client.disconnect(true);
      return;
    }
    client.data.ipSlotAcquired = true;

    try {
      const rawToken = client.handshake.auth?.token ?? client.handshake.query?.token;
      if (rawToken) {
        const payload = this.jwtService.verify<JwtPayload>(String(rawToken));
        client.data.user = { id: payload.sub, username: payload.username };
      } else {
        client.data.user = null;
      }
    } catch {
      // Невалидный токен в публичном namespace — НЕ disconnect (ADR §2.2).
      // Падаем в анонимный режим: смотреть всё ещё можно.
      client.data.user = null;
    }
    client.data.subscribedSlugs = new Set<string>();
    // KS-3836: для очистки peer-list'ов на disconnect.
    client.data.webrtcLectures = new Set<string>();
    // KS-3836: per-socket кеш ownership (lectureId → owner?). Заполняется
    // в `webrtc:peer-joined` (там же возможна 1 БД-выборка
    // Lecture.ownerId), используется при offer для дешёвой проверки
    // «sender является владельцем лекции».
    client.data.webrtcOwnedLectures = new Set<string>();
  }

  /**
   * Извлечь IP клиента. Приоритет: X-Forwarded-For (за ALB/proxy),
   * затем `handshake.address`. Берём первый IP из XFF — это исходный
   * клиент (последующие — цепочка прокси).
   */
  private extractClientIp(client: Socket): string {
    const xff = client.handshake.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0].trim();
    }
    if (Array.isArray(xff) && xff.length > 0) {
      return String(xff[0]).split(',')[0].trim();
    }
    return client.handshake.address || 'unknown';
  }

  async handleDisconnect(client: Socket): Promise<void> {
    // KS-3734: освобождаем slot IP-counter'а.
    if (client.data?.ipSlotAcquired && client.data?.ip) {
      try {
        await this.service.releaseIpSlot(String(client.data.ip));
      } catch (e) {
        this.logger.warn(
          `releaseIpSlot failed ip=${client.data.ip}: ${(e as Error).message}`,
        );
      }
    }
    // KS-3836: чистим WebRTC peer-list'ы лекций, в которых socket
    // числился, и уведомляем оставшихся.
    const webrtcLectures: Set<string> | undefined =
      client.data?.webrtcLectures;
    if (webrtcLectures && webrtcLectures.size > 0) {
      for (const lectureId of webrtcLectures) {
        try {
          this.removePeer(lectureId, client.id);
        } catch (e) {
          this.logger.warn(
            `webrtc cleanup failed lecture=${lectureId} socket=${client.id}: ${(e as Error).message}`,
          );
        }
      }
    }
    const subs: Set<string> | undefined = client.data?.subscribedSlugs;
    if (!subs || subs.size === 0) return;
    for (const slug of subs) {
      try {
        const count = await this.service.decrementViewer(slug);
        this.emitViewers(slug, count);
      } catch (e) {
        this.logger.warn(
          `decrementViewer failed slug=${slug}: ${(e as Error).message}`,
        );
      }
    }
  }

  /** Публичный метод для контроллера — broadcast close без round-trip
   *  через Redis (быстрее на одиночном инстансе). */
  broadcastClosed(slug: string, reason: LiveAnalysisCloseReason): void {
    const room = this.roomFor(slug);
    const payload: LiveAnalysisClosedEvent = { slug, reason };
    this.server.to(room).emit(LiveAnalysisEvents.CLOSED, payload);
    this.server.in(room).socketsLeave(room);
  }

  // ─── Handlers: client → server ─────────────────────────────────────

  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage(LiveAnalysisEvents.SUBSCRIBE)
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SubscribePayloadDto,
  ): Promise<void> {
    try {
      // KS-3734: лимит зрителей на трансляцию (capacity 1000). Сначала
      // пытаемся занять слот; если переполнено — не отдаём sync и не
      // присоединяем к комнате.
      const count = await this.service.tryAcquireViewerSlot(data.slug);
      if (count === null) {
        const errPayload: LiveAnalysisErrorEvent = {
          code: 'rate-limit',
          message: 'Viewer capacity reached',
        };
        client.emit(LiveAnalysisEvents.ERROR, errPayload);
        return;
      }
      const snapshot = await this.service.getSyncSnapshot(data.slug);
      await client.join(this.roomFor(data.slug));
      (client.data.subscribedSlugs as Set<string>).add(data.slug);
      client.emit(LiveAnalysisEvents.SYNC, snapshot);
      this.emitViewers(data.slug, count);
    } catch (e) {
      this.emitError(client, e);
    }
  }

  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage(LiveAnalysisEvents.UNSUBSCRIBE)
  async handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: UnsubscribePayloadDto,
  ): Promise<void> {
    const room = this.roomFor(data.slug);
    if (!client.rooms.has(room)) return;
    await client.leave(room);
    (client.data.subscribedSlugs as Set<string>)?.delete(data.slug);
    try {
      const count = await this.service.decrementViewer(data.slug);
      this.emitViewers(data.slug, count);
    } catch {
      // dec/emit ошибки — не критичны, пропускаем.
    }
  }

  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage(LiveAnalysisEvents.MOVE)
  async handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: MovePayloadDto,
  ): Promise<void> {
    const user = client.data?.user;
    if (!user) {
      this.emitError(client, new ForbiddenException('Authenticated owner required'));
      return;
    }
    try {
      // applyMove сам делает publish → broadcast в комнату придёт
      // через pub/sub-обработчик ниже. Дублировать `emit` здесь не надо.
      await this.service.applyMove(data.slug, user.id, data.uci);
    } catch (e) {
      this.emitError(client, e);
    }
  }

  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage(LiveAnalysisEvents.RESET)
  async handleReset(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ResetPayloadDto,
  ): Promise<void> {
    const user = client.data?.user;
    if (!user) {
      this.emitError(client, new ForbiddenException('Authenticated owner required'));
      return;
    }
    try {
      await this.service.applyReset(data.slug, user.id, data.fen);
    } catch (e) {
      this.emitError(client, e);
    }
  }

  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage(LiveAnalysisEvents.CLOSE)
  async handleClose(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: ClosePayloadDto,
  ): Promise<void> {
    const user = client.data?.user;
    if (!user) {
      this.emitError(client, new ForbiddenException('Authenticated owner required'));
      return;
    }
    try {
      await this.service.closeBySlug(data.slug, user.id, 'by_owner');
      // Pub/sub-обработчик расселит CLOSED-event по комнате.
    } catch (e) {
      this.emitError(client, e);
    }
  }

  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage(LiveAnalysisEvents.SYNC_REQUEST)
  async handleSyncRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SyncRequestPayloadDto,
  ): Promise<void> {
    try {
      const snapshot = await this.service.getSyncSnapshot(data.slug);
      client.emit(LiveAnalysisEvents.SYNC, snapshot);
    } catch (e) {
      this.emitError(client, e);
    }
  }

  /**
   * KS-3744 / ADR-111 §2.2. Автор присылает обновлённое содержимое
   * окна анализа. Проверка владельца — по JWT в `client.data.user`
   * (handshake выставил, см. `handleConnection`). Сам `applyStatePatch`
   * валидирует длину PGN, грамматику, частоту, синхронизирует
   * moves-list и публикует `live-analysis:sync` через Redis pub/sub —
   * pub/sub-обработчик гейтвея разошлёт snapshot в комнату.
   */
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage(LiveAnalysisEvents.STATE_PATCH)
  async handleStatePatch(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: StatePatchPayloadDto,
  ): Promise<void> {
    const user = client.data?.user;
    if (!user) {
      this.emitError(client, new ForbiddenException('Authenticated owner required'));
      return;
    }
    try {
      await this.service.applyStatePatch(data.slug, user.id, {
        tree: data.tree,
        orientation: data.orientation,
        currentGlobalIndex: data.currentGlobalIndex,
      });
    } catch (e) {
      this.emitError(client, e);
    }
  }

  // ─── KS-3836 / ADR-116 §2.2: WebRTC-сигналинг ─────────────────────
  //
  // Events:
  //   client → server:  webrtc:peer-joined { lectureId }
  //                     webrtc:peer-left   { lectureId }
  //                     webrtc:offer       { lectureId, toSocketId, sdp }
  //                     webrtc:answer      { lectureId, toSocketId, sdp }
  //                     webrtc:ice         { lectureId, toSocketId, candidate }
  //
  //   server → client:  webrtc:peer-joined        { lectureId, fromSocketId }
  //                     webrtc:peer-left          { lectureId, fromSocketId }
  //                     webrtc:offer/answer/ice   (то же + fromSocketId)
  //                     webrtc:capacity-exceeded  { lectureId, currentSubscribers, max }
  //
  // Owner определяется по JWT (handshake): `client.data.user.id ===
  // Lecture.ownerId`. Lecture.ownerId читаем один раз при первом
  // peer-joined для (socket, lecture) и кешируем в
  // `client.data.webrtcOwnedLectures`.

  static readonly WEBRTC_PEER_JOINED = 'webrtc:peer-joined';
  static readonly WEBRTC_PEER_LEFT = 'webrtc:peer-left';
  static readonly WEBRTC_OFFER = 'webrtc:offer';
  static readonly WEBRTC_ANSWER = 'webrtc:answer';
  static readonly WEBRTC_ICE = 'webrtc:ice';
  static readonly WEBRTC_CAPACITY_EXCEEDED = 'webrtc:capacity-exceeded';

  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage('webrtc:peer-joined')
  async handleWebRTCPeerJoined(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WebRTCPeerJoinedDto,
  ): Promise<void> {
    // KS-3888. Раньше anon (`client.data.user === null`) сразу получал
    // 403 «Authenticated user required», и его socket НЕ попадал в
    // `peers.subscribers`. На публичной лекции это означало: зритель
    // без логина никогда не регистрируется → publisher (тренер) после
    // саморегистрации видит пустой набор подписчиков → replay-цикл из
    // KS-3883 ничего не повторяет → у зрителя `publisherSocketId=`.
    //
    // Теперь anon = subscriber по умолчанию: owner может быть только
    // авторизованным юзером с `userId === Lecture.ownerId`. Это
    // согласовано с REST'ом `peer-failed`, который тоже принимает anon.
    const user = client.data?.user ?? null;
    try {
      const lecture = await this.prisma.lecture.findUnique({
        where: { id: data.lectureId },
        select: { id: true, ownerId: true },
      });
      if (!lecture) {
        this.emitError(
          client,
          new NotFoundException(`Lecture "${data.lectureId}" not found`),
        );
        return;
      }
      // Owner — только тот, кто залогинен и совпадает с Lecture.ownerId.
      // Anon — всегда subscriber.
      const isOwner = user !== null && lecture.ownerId === user.id;
      const peers = this.getOrCreateLecturePeers(data.lectureId);
      // KS-3888 диагностический лог: каждое peer-joined пишем в info
      // одной строкой. Удобно матчить из CloudWatch когда зрители
      // снова жалуются на «нет звука».
      this.logger.log(
        `webrtc:peer-joined lecture=${data.lectureId} socket=${client.id} ` +
          `userId=${user?.id ?? 'anon'} isOwner=${isOwner} ` +
          `priorOwner=${peers.ownerSocketId ?? '-'} subscribers=${peers.subscribers.size}`,
      );

      // Capacity-check для подписчиков. Owner — отдельный слот, в
      // лимит 15 не входит. Если этот socket уже подписан — переучёт
      // не делаем.
      if (!isOwner && !peers.subscribers.has(client.id)) {
        if (peers.subscribers.size >= LiveAnalysisGateway.WEBRTC_MAX_SUBSCRIBERS) {
          const payload: WebRTCCapacityExceededEvent = {
            lectureId: data.lectureId,
            currentSubscribers: peers.subscribers.size,
            max: LiveAnalysisGateway.WEBRTC_MAX_SUBSCRIBERS,
          };
          client.emit(
            LiveAnalysisGateway.WEBRTC_CAPACITY_EXCEEDED,
            payload,
          );
          this.logger.warn(
            `webrtc capacity exceeded: lecture=${data.lectureId} cur=${peers.subscribers.size}`,
          );
          return;
        }
        peers.subscribers.add(client.id);
        // Нотификация publisher'а (если он есть): «появился новый
        // подписчик, ему можно слать offer».
        if (peers.ownerSocketId) {
          const ownerSocket = this.server.sockets.sockets.get(
            peers.ownerSocketId,
          );
          if (ownerSocket) {
            const payload: WebRTCPeerJoinedEvent = {
              lectureId: data.lectureId,
              fromSocketId: client.id,
            };
            ownerSocket.emit(
              LiveAnalysisGateway.WEBRTC_PEER_JOINED,
              payload,
            );
          }
        }
      } else if (isOwner) {
        // Owner-socket: запоминаем (вытесняем старый, если был reconnect).
        if (peers.ownerSocketId && peers.ownerSocketId !== client.id) {
          this.logger.log(
            `webrtc owner reconnect: lecture=${data.lectureId} old=${peers.ownerSocketId} new=${client.id}`,
          );
        }
        peers.ownerSocketId = client.id;
        (client.data.webrtcOwnedLectures as Set<string>).add(data.lectureId);
        // KS-3883. Уведомить publisher'а о всех subscriber'ах, которые
        // подключились РАНЬШЕ него — без этого зрители, пришедшие до
        // тренера, остаются «в воздухе»: publisher не знает их socketId,
        // не шлёт offer, ICE handshake не стартует.
        // Каждому существующему subscriber'у отправляем виртуальный
        // peer-joined как будто он только что подключился — publisher
        // обработает его обычным путём (отправит offer на toSocketId).
        for (const subscriberSocketId of peers.subscribers) {
          const payload: WebRTCPeerJoinedEvent = {
            lectureId: data.lectureId,
            fromSocketId: subscriberSocketId,
          };
          client.emit(LiveAnalysisGateway.WEBRTC_PEER_JOINED, payload);
        }
        if (peers.subscribers.size > 0) {
          this.logger.log(
            `webrtc publisher registered: lecture=${data.lectureId} replayed ${peers.subscribers.size} pre-joined subscribers`,
          );
        }
      }

      (client.data.webrtcLectures as Set<string>).add(data.lectureId);
    } catch (e) {
      this.emitError(client, e);
    }
  }

  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage('webrtc:peer-left')
  handleWebRTCPeerLeft(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WebRTCPeerLeftDto,
  ): void {
    this.removePeer(data.lectureId, client.id);
    (client.data.webrtcLectures as Set<string>)?.delete(data.lectureId);
    (client.data.webrtcOwnedLectures as Set<string>)?.delete(data.lectureId);
  }

  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage('webrtc:offer')
  handleWebRTCOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WebRTCOfferDto,
  ): void {
    // Offer может слать только владелец лекции. Cache —
    // `webrtcOwnedLectures` (заполнен в peer-joined). Если sender не в
    // нём — silently drop (по требованию задачи: «отбрасывать»).
    const owned: Set<string> | undefined =
      client.data?.webrtcOwnedLectures;
    if (!owned || !owned.has(data.lectureId)) {
      this.logger.warn(
        `webrtc offer dropped (not owner): lecture=${data.lectureId} socket=${client.id}`,
      );
      return;
    }
    const peers = this.webrtcPeers.get(data.lectureId);
    if (!peers || !peers.subscribers.has(data.toSocketId)) {
      this.logger.warn(
        `webrtc offer dropped (target not registered): lecture=${data.lectureId} to=${data.toSocketId}`,
      );
      return;
    }
    const target = this.server.sockets.sockets.get(data.toSocketId);
    if (!target) return;
    const payload: WebRTCOfferEvent = {
      lectureId: data.lectureId,
      toSocketId: data.toSocketId,
      fromSocketId: client.id,
      sdp: data.sdp,
    };
    target.emit(LiveAnalysisGateway.WEBRTC_OFFER, payload);
  }

  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage('webrtc:answer')
  handleWebRTCAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WebRTCAnswerDto,
  ): void {
    // Answer шлёт subscriber обратно publisher'у. Проверяем что pair
    // (owner=toSocketId, subscriber=client.id) зарегистрирована.
    const peers = this.webrtcPeers.get(data.lectureId);
    if (!peers) return;
    if (peers.ownerSocketId !== data.toSocketId) {
      this.logger.warn(
        `webrtc answer dropped (target not owner): lecture=${data.lectureId} to=${data.toSocketId}`,
      );
      return;
    }
    if (!peers.subscribers.has(client.id)) {
      this.logger.warn(
        `webrtc answer dropped (sender not in peer-list): lecture=${data.lectureId} from=${client.id}`,
      );
      return;
    }
    const target = this.server.sockets.sockets.get(data.toSocketId);
    if (!target) return;
    const payload: WebRTCAnswerEvent = {
      lectureId: data.lectureId,
      toSocketId: data.toSocketId,
      fromSocketId: client.id,
      sdp: data.sdp,
    };
    target.emit(LiveAnalysisGateway.WEBRTC_ANSWER, payload);
  }

  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @SubscribeMessage('webrtc:ice')
  handleWebRTCIce(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WebRTCIceDto,
  ): void {
    // ICE — двусторонний обмен (publisher ↔ subscriber). Проксируем
    // без хранения. Минимальная проверка: target существует в комнате
    // peers лекции (owner или subscriber).
    const peers = this.webrtcPeers.get(data.lectureId);
    if (!peers) return;
    const isTargetOwner = peers.ownerSocketId === data.toSocketId;
    const isTargetSubscriber = peers.subscribers.has(data.toSocketId);
    if (!isTargetOwner && !isTargetSubscriber) return;
    const target = this.server.sockets.sockets.get(data.toSocketId);
    if (!target) return;
    const payload: WebRTCIceEvent = {
      lectureId: data.lectureId,
      toSocketId: data.toSocketId,
      fromSocketId: client.id,
      candidate: data.candidate,
    };
    target.emit(LiveAnalysisGateway.WEBRTC_ICE, payload);
  }

  /**
   * Удалить socket из peer-list лекции (owner или subscriber) и
   * уведомить оставшихся. Используется и при явном `webrtc:peer-left`,
   * и при `disconnect`. Если в лекции после удаления никого нет —
   * чистим запись из `webrtcPeers` (минимизируем долгоживущие
   * пустые Set'ы).
   */
  private removePeer(lectureId: string, socketId: string): void {
    const peers = this.webrtcPeers.get(lectureId);
    if (!peers) return;
    let changed = false;
    if (peers.ownerSocketId === socketId) {
      peers.ownerSocketId = null;
      changed = true;
    }
    if (peers.subscribers.delete(socketId)) {
      changed = true;
    }
    if (!changed) return;
    // Уведомляем оставшихся (owner и всех subscriber'ов).
    const payload: WebRTCPeerLeftEvent = {
      lectureId,
      fromSocketId: socketId,
    };
    const targets: string[] = [];
    if (peers.ownerSocketId) targets.push(peers.ownerSocketId);
    for (const sid of peers.subscribers) targets.push(sid);
    for (const sid of targets) {
      const s = this.server.sockets.sockets.get(sid);
      if (s) s.emit(LiveAnalysisGateway.WEBRTC_PEER_LEFT, payload);
    }
    if (!peers.ownerSocketId && peers.subscribers.size === 0) {
      this.webrtcPeers.delete(lectureId);
    }
  }

  private getOrCreateLecturePeers(lectureId: string): {
    ownerSocketId: string | null;
    subscribers: Set<string>;
  } {
    let peers = this.webrtcPeers.get(lectureId);
    if (!peers) {
      peers = { ownerSocketId: null, subscribers: new Set() };
      this.webrtcPeers.set(lectureId, peers);
    }
    return peers;
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private roomFor(slug: string): string {
    return `live-analysis:${slug}`;
  }

  /** Throttled emit `viewers` per-slug. */
  private emitViewers(slug: string, count: number): void {
    const now = Date.now();
    const last = this.viewersThrottle.get(slug) ?? 0;
    if (now - last < LiveAnalysisGateway.VIEWERS_THROTTLE_MS) return;
    this.viewersThrottle.set(slug, now);
    const payload: LiveAnalysisViewersEvent = { slug, count };
    this.server.to(this.roomFor(slug)).emit(LiveAnalysisEvents.VIEWERS, payload);
  }

  private emitError(client: Socket, e: unknown): void {
    const payload: LiveAnalysisErrorEvent = this.mapErrorToPayload(e);
    client.emit(LiveAnalysisEvents.ERROR, payload);
  }

  private mapErrorToPayload(e: unknown): LiveAnalysisErrorEvent {
    if (e instanceof NotFoundException) {
      return { code: 'slug-not-found', message: (e.message as string) || 'Not found' };
    }
    if (e instanceof ForbiddenException) {
      return { code: 'forbidden', message: (e.message as string) || 'Forbidden' };
    }
    const err = e as { message?: string; status?: number; response?: { message?: string | string[] } };
    const msg = (err?.message ?? '').toLowerCase();
    const validationMessages = Array.isArray(err?.response?.message)
      ? (err!.response!.message as string[]).join(' ').toLowerCase()
      : (err?.response?.message ?? '').toString().toLowerCase();
    // KS-3780: hard cap длины tree (256 KB) ловится двумя путями —
    // BadRequestException('tree-too-large') из сервиса либо
    // MaxLength-нарушение от ValidationPipe на поле tree.
    if (
      msg.includes('tree-too-large') ||
      (validationMessages.includes('tree') &&
        (validationMessages.includes('longer than') ||
          validationMessages.includes('maxlength')))
    ) {
      return {
        code: 'tree-too-large',
        message: err?.message ?? 'Tree exceeds 256 KB limit',
      };
    }
    // KS-3744 / ADR-111. До KS-3780 — для annotated PGN. Сохранено
    // на случай legacy-клиентов, новые трансляции этого кода уже
    // не получат.
    if (
      msg.includes('pgn-too-large') ||
      (validationMessages.includes('pgn') &&
        (validationMessages.includes('longer than') ||
          validationMessages.includes('maxlength')))
    ) {
      return {
        code: 'pgn-too-large',
        message: err?.message ?? 'PGN exceeds 256 KB limit',
      };
    }
    if (msg.includes('illegal')) {
      return { code: 'illegal-move', message: err.message ?? 'Illegal move' };
    }
    if (msg.includes('rate limit')) {
      return { code: 'rate-limit', message: err.message ?? 'Rate limit' };
    }
    if (err?.status === 400) {
      return { code: 'invalid-payload', message: err.message ?? 'Invalid payload' };
    }
    this.logger.warn(`Unhandled WS error: ${err?.message ?? String(e)}`);
    return { code: 'invalid-payload', message: err?.message ?? 'Internal error' };
  }
}
