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
} from '@kingside/shared';
import { JwtPayload } from '../auth/jwt.strategy';
import { LiveAnalysisService } from './live-analysis.service';
import {
  ClosePayloadDto,
  MovePayloadDto,
  ResetPayloadDto,
  StatePatchPayloadDto,
  SubscribePayloadDto,
  SyncRequestPayloadDto,
  UnsubscribePayloadDto,
} from './dto/ws-payload.dto';

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

  constructor(
    private readonly jwtService: JwtService,
    private readonly service: LiveAnalysisService,
    private readonly config: ConfigService,
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
        pgn: data.pgn,
        headers: data.headers,
        currentPly: data.currentPly,
        orientation: data.orientation,
      });
    } catch (e) {
      this.emitError(client, e);
    }
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
    // KS-3744 / ADR-111: hard cap PGN ловится двумя путями — либо
    // BadRequestException('pgn-too-large') из сервиса, либо
    // MaxLength-нарушение от ValidationPipe (text содержит "pgn"
    // и "longer than"). Мапим оба варианта в один код события.
    const validationMessages = Array.isArray(err?.response?.message)
      ? (err!.response!.message as string[]).join(' ').toLowerCase()
      : (err?.response?.message ?? '').toString().toLowerCase();
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
    if (msg.includes('invalid pgn')) {
      return { code: 'invalid-payload', message: err.message ?? 'Invalid PGN' };
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
