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
import {
  classifyTimeControl,
  MatchmakingEvents,
  type TimeControlCategory,
  type WsMatchmakingJoinPayload,
  type WsMatchmakingFoundPayload,
  type WsErrorPayload,
} from '@kingside/shared';

@WebSocketGateway({ namespace: '/matchmaking', cors: { origin: '*' } })
export class MatchmakingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(MatchmakingGateway.name);
  private playerQueues = new Map<string, TimeControlCategory>();

  constructor(
    private readonly matchmakingService: MatchmakingService,
    private readonly jwtService: JwtService,
    private readonly i18n: I18nService,
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

    if (this.playerQueues.has(user.id)) {
      const errorPayload: WsErrorPayload = { code: 'ALREADY_IN_QUEUE', message: this.i18n.t('messages.matchmaking.alreadyInQueue') };
      client.emit(MatchmakingEvents.ERROR, errorPayload);
      return;
    }

    const timeControlType = classifyTimeControl(data.timeInitial, data.increment);
    this.playerQueues.set(user.id, timeControlType);
    this.logger.log(`${user.username} joined ${timeControlType} queue (${data.timeInitial}+${data.increment})`);

    const isOnline = async (userId: string): Promise<boolean> => {
      const sockets = await this.server.fetchSockets();
      return sockets.some((s) => s.data.user?.id === userId);
    };

    const ratingFilter =
      data.ratingMin !== undefined ||
      data.ratingMax !== undefined ||
      data.ratingDelta !== undefined
        ? {
            ratingMin: data.ratingMin,
            ratingMax: data.ratingMax,
            ratingDelta: data.ratingDelta,
          }
        : undefined;

    const result = await this.matchmakingService.joinQueue(
      user.id,
      data.timeInitial,
      data.increment,
      isOnline,
      ratingFilter,
    );

    if (result) {
      this.playerQueues.delete(user.id);

      const matchData = {
        gameId: result.gameId,
        timeControl: timeControlType,
        timeInitial: data.timeInitial,
        increment: data.increment,
      };

      client.emit(MatchmakingEvents.FOUND, {
        ...matchData,
        color: result.color,
        opponent: result.opponent,
      });

      const opponentSockets = await this.server.fetchSockets();
      const opponentSocket = opponentSockets.find(
        (s) => s.data.user?.id === result.opponent.id,
      );

      if (opponentSocket) {
        this.playerQueues.delete(result.opponent.id);
        opponentSocket.emit(MatchmakingEvents.FOUND, {
          ...matchData,
          color: result.color === 'white' ? 'black' : 'white',
          opponent: { id: user.id, username: user.username },
        });
      }

      this.logger.log(`Match found: ${result.gameId}`);
    }
  }

  @SubscribeMessage(MatchmakingEvents.LEAVE)
  async handleLeave(@ConnectedSocket() client: Socket) {
    const user = client.data.user;
    if (!user) return;

    const timeControl = this.playerQueues.get(user.id);
    if (!timeControl) return;

    await this.matchmakingService.leaveQueue(user.id, timeControl);
    this.playerQueues.delete(user.id);
    this.logger.log(`${user.username} left ${timeControl} queue`);
  }

  async handleDisconnect(client: Socket) {
    const user = client.data?.user;
    if (!user) return;

    const timeControl = this.playerQueues.get(user.id);
    if (timeControl) {
      await this.matchmakingService.leaveQueue(user.id, timeControl);
      this.playerQueues.delete(user.id);
      this.logger.log(`${user.username} disconnected, removed from ${timeControl} queue`);
    }
  }
}
