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
import { StockfishService } from '../engine/stockfish.service';
import { JwtPayload } from '../auth/jwt.strategy';
import {
  GameEvents,
  type WsGameJoinPayload,
  type WsGameMovePayload,
  type WsGameResignPayload,
  type WsGameDrawOfferPayload,
  type WsGameDrawAcceptPayload,
  type WsGameDrawDeclinePayload,
  type WsChatSendPayload,
  type WsGameStatePayload,
  type WsGameMoveServerPayload,
  type WsGameEndPayload,
  type WsGameDrawOfferedPayload,
  type WsErrorPayload,
  type WsAnalysisStartPayload,
  type WsAnalysisLinePayload,
  type WsAnalysisDonePayload,
  type GameStatus,
  type GameResult,
} from '@kingside/shared';

@WebSocketGateway({ namespace: '/game', cors: { origin: '*' } })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(GameGateway.name);
  private readonly analysisSessions = new Map<string, AbortController>();

  constructor(
    private readonly gameService: GameService,
    private readonly botGameService: BotGameService,
    private readonly jwtService: JwtService,
    private readonly chatService: ChatService,
    private readonly stockfishService: StockfishService,
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

  async handleDisconnect(client: Socket) {
    const userId = client.data.user?.id;
    this.logger.log(`Client disconnected: ${client.id}`);

    this.stopAnalysisSession(client.id);

    if (userId) {
      try {
        const endedGameIds = await this.gameService.endBotGameOnDisconnect(userId);
        for (const gameId of endedGameIds) {
          this.server.to(`game:${gameId}`).emit('game:end', {
            result: 'black',
            termination: 'abandon',
          });
        }
      } catch (e: any) {
        this.logger.error(`Failed to end bot games on disconnect: ${e.message}`);
      }
    }
  }

  @SubscribeMessage(GameEvents.JOIN)
  async handleJoinGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsGameJoinPayload,
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    await client.join(`game:${data.gameId}`);

    const { state, clocks, whiteId, blackId, players, isBot, botLevel } = await this.gameService.getGameState(data.gameId);
    const color = userId === whiteId ? 'white' : userId === blackId ? 'black' : undefined;
    const statePayload: WsGameStatePayload = {
      gameId: data.gameId,
      fen: state.fen,
      moves: state.moves.map((m) => m.san),
      clocks: { whiteMs: clocks.whiteMs, blackMs: clocks.blackMs },
      status: state.status as GameStatus,
      color,
      players,
      isBot,
      botLevel,
    };
    client.emit(GameEvents.STATE, statePayload);

    if (isBot && state.moves.length === 0 && state.status === 'active') {
      this.triggerBotReply(data.gameId);
    }
  }

  @SubscribeMessage(GameEvents.MOVE)
  async handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsGameMovePayload,
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    try {
      const result = await this.gameService.makeMove(data.gameId, userId, data.uci);

      const movePayload: WsGameMoveServerPayload = {
        uci: data.uci,
        san: result.san,
        fen: result.fen,
        clocks: { whiteMs: result.clocks.whiteMs, blackMs: result.clocks.blackMs },
        moveFlags: result.moveFlags,
      };
      client.to(`game:${data.gameId}`).emit(GameEvents.MOVE_SERVER, movePayload);

      if (result.gameOver) {
        const endPayload: WsGameEndPayload = {
          result: result.result as GameResult,
          termination: result.termination!,
          ...(result.ratingChange ? { ratingChange: result.ratingChange } : {}),
        };
        this.server.to(`game:${data.gameId}`).emit(GameEvents.END, endPayload);
      } else {
        this.triggerBotReply(data.gameId);
      }
    } catch (e: any) {
      const errorPayload: WsErrorPayload = { code: 'INVALID_MOVE', message: e.message };
      client.emit(GameEvents.ERROR, errorPayload);

      if (e.message === 'Invalid move') {
        const { state, clocks } = await this.gameService.getGameState(data.gameId);
        const statePayload: WsGameStatePayload = {
          gameId: data.gameId,
          fen: state.fen,
          moves: state.moves.map((m) => m.san),
          clocks: { whiteMs: clocks.whiteMs, blackMs: clocks.blackMs },
          status: state.status as GameStatus,
        };
        client.emit(GameEvents.STATE, statePayload);
      }
    }
  }

  @SubscribeMessage(GameEvents.RESIGN)
  async handleResign(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsGameResignPayload,
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    try {
      const result = await this.gameService.resign(data.gameId, userId);
      const endPayload: WsGameEndPayload = {
        result: result.result as GameResult,
        termination: result.termination,
        ...(result.ratingChange ? { ratingChange: result.ratingChange } : {}),
      };
      this.server.to(`game:${data.gameId}`).emit(GameEvents.END, endPayload);
    } catch (e: any) {
      const errorPayload: WsErrorPayload = { code: 'RESIGN_ERROR', message: e.message };
      client.emit(GameEvents.ERROR, errorPayload);
    }
  }

  @SubscribeMessage(GameEvents.DRAW_OFFER)
  async handleDrawOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsGameDrawOfferPayload,
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    try {
      await this.gameService.handleDrawOffer(data.gameId, userId);
      const offeredPayload: WsGameDrawOfferedPayload = { gameId: data.gameId };
      client.to(`game:${data.gameId}`).emit(GameEvents.DRAW_OFFERED, offeredPayload);
    } catch (e: any) {
      const errorPayload: WsErrorPayload = { code: 'DRAW_OFFER_ERROR', message: e.message };
      client.emit(GameEvents.ERROR, errorPayload);
    }
  }

  @SubscribeMessage(GameEvents.DRAW_ACCEPT)
  async handleDrawAccept(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsGameDrawAcceptPayload,
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    try {
      const result = await this.gameService.handleDrawAccept(data.gameId, userId);
      const endPayload: WsGameEndPayload = {
        result: result.result as GameResult,
        termination: result.termination,
        ...(result.ratingChange ? { ratingChange: result.ratingChange } : {}),
      };
      this.server.to(`game:${data.gameId}`).emit(GameEvents.END, endPayload);
    } catch (e: any) {
      const errorPayload: WsErrorPayload = { code: 'DRAW_ACCEPT_ERROR', message: e.message };
      client.emit(GameEvents.ERROR, errorPayload);
    }
  }

  @SubscribeMessage(GameEvents.DRAW_DECLINE)
  async handleDrawDecline(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsGameDrawDeclinePayload,
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    await this.gameService.handleDrawDecline(data.gameId, userId);
  }

  @SubscribeMessage(GameEvents.CHAT_SEND)
  async handleChatSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsChatSendPayload,
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    try {
      const message = await this.chatService.sendMessage(data.gameId, userId, data.content);
      this.server.to(`game:${data.gameId}`).emit(GameEvents.CHAT_MESSAGE, message);
    } catch (e: any) {
      const errorPayload: WsErrorPayload = { code: 'CHAT_ERROR', message: e.message };
      client.emit(GameEvents.ERROR, errorPayload);
    }
  }

  @SubscribeMessage(GameEvents.ANALYSIS_START)
  async handleAnalysisStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsAnalysisStartPayload,
  ) {
    if (!client.data.user?.id) return;

    // Stop any existing session for this client first
    this.stopAnalysisSession(client.id);

    const controller = new AbortController();
    this.analysisSessions.set(client.id, controller);
    const depth = data.depth ?? 20;

    try {
      const result = await this.stockfishService.streamAnalysis(
        data.fen,
        depth,
        (line) => {
          const linePayload: WsAnalysisLinePayload = {
            depth: line.depth,
            score: line.score,
            bestMove: line.bestMove,
          };
          client.emit(GameEvents.ANALYSIS_LINE, linePayload);
        },
        controller.signal,
      );

      if (!controller.signal.aborted) {
        const donePayload: WsAnalysisDonePayload = {
          bestMove: result.bestMove,
          ponder: result.ponder,
          score: result.score,
          depth: result.depth,
        };
        client.emit(GameEvents.ANALYSIS_DONE, donePayload);
      }
    } catch (e: any) {
      if (!controller.signal.aborted) {
        const errorPayload: WsErrorPayload = { code: 'ANALYSIS_ERROR', message: e.message };
        client.emit(GameEvents.ERROR, errorPayload);
      }
    } finally {
      this.analysisSessions.delete(client.id);
    }
  }

  @SubscribeMessage(GameEvents.ANALYSIS_STOP)
  handleAnalysisStop(@ConnectedSocket() client: Socket) {
    this.stopAnalysisSession(client.id);
  }

  private stopAnalysisSession(clientId: string): void {
    const controller = this.analysisSessions.get(clientId);
    if (controller) {
      controller.abort();
      this.analysisSessions.delete(clientId);
    }
  }

  emitGameStart(gameId: string, payload: any) {
    this.server.to(`game:${gameId}`).emit(GameEvents.STATE, payload);
  }

  private async triggerBotReply(gameId: string): Promise<void> {
    try {
      const botResult = await this.botGameService.maybeBotReply(gameId);
      if (!botResult) return;

      const movePayload: WsGameMoveServerPayload = {
        uci: botResult.uci,
        san: botResult.san,
        fen: botResult.fen,
        clocks: { whiteMs: botResult.clocks.whiteMs, blackMs: botResult.clocks.blackMs },
        moveFlags: botResult.moveFlags,
      };
      this.server.to(`game:${gameId}`).emit(GameEvents.MOVE_SERVER, movePayload);

      if (botResult.gameOver) {
        const endPayload: WsGameEndPayload = {
          result: botResult.result as GameResult,
          termination: botResult.termination!,
        };
        this.server.to(`game:${gameId}`).emit(GameEvents.END, endPayload);
      }
    } catch (e: any) {
      this.logger.error(`Bot reply failed for game ${gameId}: ${e.message}`);
    }
  }
}
