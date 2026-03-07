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
import { BotGameService } from './bot-game.service';
import { ChatService } from '../chat/chat.service';
import { JwtPayload } from '../auth/jwt.strategy';

@WebSocketGateway({ namespace: '/game', cors: { origin: '*' } })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(GameGateway.name);

  constructor(
    private readonly gameService: GameService,
    private readonly botGameService: BotGameService,
    private readonly jwtService: JwtService,
    private readonly chatService: ChatService,
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

    const { state, clocks, whiteId, blackId, players, isBot, botLevel } = await this.gameService.getGameState(data.gameId);
    const color = userId === whiteId ? 'white' : userId === blackId ? 'black' : undefined;
    client.emit('game:state', {
      gameId: data.gameId,
      fen: state.fen,
      moves: state.moves.map((m) => m.san),
      clocks: { whiteMs: clocks.whiteMs, blackMs: clocks.blackMs },
      status: state.status,
      color,
      players,
      isBot,
      botLevel,
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

      client.to(`game:${data.gameId}`).emit('game:move', {
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
      } else {
        this.triggerBotReply(data.gameId);
      }
    } catch (e: any) {
      client.emit('error', { code: 'INVALID_MOVE', message: e.message });

      if (e.message === 'Invalid move') {
        const { state, clocks } = await this.gameService.getGameState(data.gameId);
        client.emit('game:state', {
          gameId: data.gameId,
          fen: state.fen,
          moves: state.moves.map((m) => m.san),
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

  @SubscribeMessage('chat:send')
  async handleChatSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string; content: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    try {
      const message = await this.chatService.sendMessage(data.gameId, userId, data.content);
      this.server.to(`game:${data.gameId}`).emit('chat:message', message);
    } catch (e: any) {
      client.emit('error', { code: 'CHAT_ERROR', message: e.message });
    }
  }

  emitGameStart(gameId: string, payload: any) {
    this.server.to(`game:${gameId}`).emit('game:state', payload);
  }

  private async triggerBotReply(gameId: string): Promise<void> {
    try {
      const botResult = await this.botGameService.maybeBotReply(gameId);
      if (!botResult) return;

      this.server.to(`game:${gameId}`).emit('game:move', {
        uci: botResult.uci,
        san: botResult.san,
        fen: botResult.fen,
        clocks: { whiteMs: botResult.clocks.whiteMs, blackMs: botResult.clocks.blackMs },
      });

      if (botResult.gameOver) {
        this.server.to(`game:${gameId}`).emit('game:end', {
          result: botResult.result,
          termination: botResult.termination,
        });
      }
    } catch (e: any) {
      this.logger.error(`Bot reply failed for game ${gameId}: ${e.message}`);
    }
  }
}
