import { Logger, UseGuards } from '@nestjs/common';
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
import { GameService } from './game.service';
import { JwtPayload } from '../auth/jwt.strategy';

@WebSocketGateway({ namespace: '/game' })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(GameGateway.name);

  constructor(
    private readonly gameService: GameService,
    private readonly jwtService: JwtService,
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
      this.logger.log(`Client connected: ${payload.username} (${client.id})`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('game:join')
  async handleJoinGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    await client.join(`game:${data.gameId}`);

    const { state, clocks, whiteId, blackId } = await this.gameService.getGameState(data.gameId);
    const color = userId === whiteId ? 'white' : userId === blackId ? 'black' : undefined;
    client.emit('game:state', {
      gameId: data.gameId,
      fen: state.fen,
      moves: state.moves,
      clocks: { whiteMs: clocks.whiteMs, blackMs: clocks.blackMs },
      status: state.status,
      color,
    });
  }

  @SubscribeMessage('game:move')
  async handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string; uci: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    try {
      const result = await this.gameService.makeMove(data.gameId, userId, data.uci);

      this.server.to(`game:${data.gameId}`).emit('game:move', {
        uci: data.uci,
        san: result.san,
        fen: result.fen,
        clocks: { whiteMs: result.clocks.whiteMs, blackMs: result.clocks.blackMs },
      });

      if (result.gameOver) {
        this.server.to(`game:${data.gameId}`).emit('game:end', {
          result: result.result,
          termination: result.termination,
        });
      }
    } catch (e: any) {
      client.emit('error', { code: 'INVALID_MOVE', message: e.message });

      if (e.message === 'Invalid move') {
        const { state, clocks } = await this.gameService.getGameState(data.gameId);
        client.emit('game:state', {
          gameId: data.gameId,
          fen: state.fen,
          moves: state.moves,
          clocks: { whiteMs: clocks.whiteMs, blackMs: clocks.blackMs },
          status: state.status,
        });
      }
    }
  }

  @SubscribeMessage('game:resign')
  async handleResign(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    try {
      const result = await this.gameService.resign(data.gameId, userId);
      this.server.to(`game:${data.gameId}`).emit('game:end', {
        result: result.result,
        termination: result.termination,
      });
    } catch (e: any) {
      client.emit('error', { code: 'RESIGN_ERROR', message: e.message });
    }
  }

  @SubscribeMessage('game:draw:offer')
  async handleDrawOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    try {
      await this.gameService.handleDrawOffer(data.gameId, userId);
      client.to(`game:${data.gameId}`).emit('game:draw:offered', { gameId: data.gameId });
    } catch (e: any) {
      client.emit('error', { code: 'DRAW_OFFER_ERROR', message: e.message });
    }
  }

  @SubscribeMessage('game:draw:accept')
  async handleDrawAccept(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    try {
      const result = await this.gameService.handleDrawAccept(data.gameId, userId);
      this.server.to(`game:${data.gameId}`).emit('game:end', {
        result: result.result,
        termination: result.termination,
      });
    } catch (e: any) {
      client.emit('error', { code: 'DRAW_ACCEPT_ERROR', message: e.message });
    }
  }

  @SubscribeMessage('game:draw:decline')
  async handleDrawDecline(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    await this.gameService.handleDrawDecline(data.gameId, userId);
  }

  emitGameStart(gameId: string, payload: any) {
    this.server.to(`game:${gameId}`).emit('game:state', payload);
  }
}
