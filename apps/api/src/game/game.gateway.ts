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
import { GameClockService } from './game-clock.service';
import { JwtPayload } from '../auth/jwt.strategy';
import {
  GameEvents,
  SpectatorEvents,
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
  type WsSpectateJoinPayload,
  type WsSpectateLeavePayload,
  type GameStatus,
  type GameResult,
} from '@kingside/shared';
import { LiveGameService } from './live-game.service';

@WebSocketGateway({ namespace: '/game', cors: { origin: '*' }, transports: ['websocket'], pingTimeout: 30000, connectTimeout: 60000 })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(GameGateway.name);
  private readonly analysisSessions = new Map<string, AbortController>();
  /** Grace period before ending bot games on disconnect (ms) */
  private static readonly BOT_DISCONNECT_GRACE_MS = 30_000;
  private readonly botDisconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly gameService: GameService,
    private readonly botGameService: BotGameService,
    private readonly jwtService: JwtService,
    private readonly chatService: ChatService,
    private readonly stockfishService: StockfishService,
    private readonly liveGameService: LiveGameService,
    private readonly clockService: GameClockService,
  ) {}

  async handleConnection(client: Socket) {
    const token = client.handshake.auth?.token || client.handshake.query?.token;
    if (!token) {
      // Anonymous connection — allowed for spectating
      this.logger.log(`Anonymous client connected: ${client.id}`);
      return;
    }
    try {
      const payload = this.jwtService.verify<JwtPayload>(String(token));
      client.data.user = { id: payload.sub, username: payload.username };
      await client.join(`user:${payload.sub}`);
      this.logger.log(`Client connected: ${payload.username} (${client.id})`);
    } catch {
      // Invalid token — allow connection for spectating (no user set)
      this.logger.log(`Client connected with invalid token: ${client.id}`);
    }
  }

  async handleDisconnect(client: Socket) {
    const userId = client.data.user?.id;
    this.logger.log(`Client disconnected: ${client.id}`);

    this.stopAnalysisSession(client.id);

    if (userId) {
      this.scheduleBotGameEnd(userId);
    }
  }

  private scheduleBotGameEnd(userId: string): void {
    // Cancel any existing timer for this user
    const existing = this.botDisconnectTimers.get(userId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.botDisconnectTimers.delete(userId);

      // Check if user reconnected (has active sockets in user room)
      const userRoom = (this.server?.adapter as any)?.rooms?.get(`user:${userId}`);
      const reconnected = userRoom && userRoom.size > 0;
      if (reconnected) {
        this.logger.log(`User ${userId} reconnected, skipping bot game end`);
        return;
      }

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
    }, GameGateway.BOT_DISCONNECT_GRACE_MS);

    this.botDisconnectTimers.set(userId, timer);
  }

  @SubscribeMessage(GameEvents.JOIN)
  async handleJoinGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsGameJoinPayload,
  ) {
    const userId = client.data.user?.id;
    if (!userId) {
      this.logger.warn(`handleJoinGame: no userId for client ${client.id}, auth missing`);
      client.emit(GameEvents.ERROR, { code: 'AUTH_REQUIRED', message: 'Authentication required. Reconnect with valid token.' });
      return;
    }

    // Cancel pending bot game end timer on reconnect
    const pendingTimer = this.botDisconnectTimers.get(userId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.botDisconnectTimers.delete(userId);
      this.logger.log(`Cancelled bot disconnect timer for ${userId} (reconnected)`);
    }

    await client.join(`game:${data.gameId}`);

    try {
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
      this.logger.log(`handleJoinGame: game=${data.gameId.slice(0, 8)} user=${client.data.user?.username} status=${state.status} fen=${state.fen.slice(0, 20)}`);

      if (isBot && state.moves.length === 0 && state.status === 'active') {
        this.triggerBotReply(data.gameId);
      }
    } catch (e: unknown) {
      this.logger.error(`handleJoinGame: game=${data.gameId.slice(0, 8)} error: ${(e as Error).message}`);
      client.emit(GameEvents.ERROR, { code: 'JOIN_ERROR', message: (e as Error).message });
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
      this.emitToSpectatorsDelayed(data.gameId, SpectatorEvents.SPECTATE_MOVE, movePayload);

      if (result.gameOver) {
        const endPayload: WsGameEndPayload = {
          result: result.result as GameResult,
          termination: result.termination!,
          ...(result.ratingChange ? { ratingChange: result.ratingChange } : {}),
        };
        this.server.to(`game:${data.gameId}`).emit(GameEvents.END, endPayload);
        this.emitToSpectatorsDelayed(data.gameId, SpectatorEvents.SPECTATE_END, endPayload);
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

    this.logger.log(`handleResign: game=${data.gameId} user=${userId} (${client.data.user?.username})`);
    try {
      const result = await this.gameService.resign(data.gameId, userId);
      const endPayload: WsGameEndPayload = {
        result: result.result as GameResult,
        termination: result.termination,
        ...(result.ratingChange ? { ratingChange: result.ratingChange } : {}),
      };
      this.server.to(`game:${data.gameId}`).emit(GameEvents.END, endPayload);
      this.emitToSpectatorsDelayed(data.gameId, SpectatorEvents.SPECTATE_END, endPayload);
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
      this.emitToSpectatorsDelayed(data.gameId, SpectatorEvents.SPECTATE_END, endPayload);
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

  @SubscribeMessage('game:berserk')
  async handleBerserk(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    try {
      const dbGame = await this.gameService.getGame(data.gameId);

      // Must be a tournament game
      if (!dbGame.tournamentId) {
        client.emit(GameEvents.ERROR, { code: 'BERSERK_ERROR', message: 'Berserk only in tournament games' });
        return;
      }

      // Must be active
      if (dbGame.status !== 'active') return;

      // Determine color
      const isWhite = userId === dbGame.whiteId;
      const isBlack = userId === dbGame.blackId;
      if (!isWhite && !isBlack) return;

      // Must be before player's first move: white moves===0, black moves<=1
      const { state } = await this.gameService.getGameState(data.gameId);
      const maxMoves = isWhite ? 0 : 1;
      if (state.moves.length > maxMoves) {
        client.emit(GameEvents.ERROR, { code: 'BERSERK_ERROR', message: 'Berserk only before first move' });
        return;
      }

      const alreadyBerserk = isWhite ? dbGame.whiteBerserk : dbGame.blackBerserk;
      if (alreadyBerserk) return;

      // Save berserk flag
      const color = isWhite ? 'white' : 'black';
      await this.gameService.setBerserk(data.gameId, color);

      // Halve clock
      const clocks = await this.clockService.halveClock(data.gameId, color);

      // Emit to both players + spectators
      const berserkPayload = { gameId: data.gameId, color, clocks: { whiteMs: clocks.whiteMs, blackMs: clocks.blackMs } };
      this.server.to(`game:${data.gameId}`).emit('game:berserk', berserkPayload);
      this.emitToSpectatorsDelayed(data.gameId, 'spectate:berserk', berserkPayload);

      this.logger.log(`Berserk: game=${data.gameId.slice(0, 8)} ${color} by ${client.data.user?.username}`);
    } catch (e: unknown) {
      this.logger.error(`Berserk error: ${(e as Error).message}`);
      client.emit(GameEvents.ERROR, { code: 'BERSERK_ERROR', message: (e as Error).message });
    }
  }

  @SubscribeMessage('game:claim-timeout')
  async handleClaimTimeout(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    try {
      // Check DB status to avoid race conditions with other endGame calls
      const dbGame = await this.gameService.getGame(data.gameId);
      if (dbGame.status !== 'active') return;

      const { state } = await this.gameService.getGameState(data.gameId);
      if (state.status !== 'active') return;

      const activeColor = state.fen.split(' ')[1] === 'w' ? 'white' : 'black';
      const { timedOut } = await this.clockService.checkTimeout(
        data.gameId,
        activeColor,
      );

      if (timedOut) {
        const result = activeColor === 'white' ? 'black' : 'white';
        const ratingChange = await this.gameService.endGame(data.gameId, result, 'timeout');
        const endPayload: WsGameEndPayload = {
          result: result as GameResult,
          termination: 'timeout',
          ...(ratingChange ? { ratingChange } : {}),
        };
        this.server.to(`game:${data.gameId}`).emit(GameEvents.END, endPayload);
        this.emitToSpectatorsDelayed(data.gameId, SpectatorEvents.SPECTATE_END, endPayload);
      }
    } catch (e: any) {
      this.logger.error(`Claim timeout failed for game ${data.gameId}: ${e.message}`);
    }
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

  @SubscribeMessage(SpectatorEvents.SPECTATE_JOIN)
  async handleSpectateJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsSpectateJoinPayload,
  ) {
    await client.join(`spectate:${data.gameId}`);
    this.logger.log(`Spectator ${client.id} joined game ${data.gameId}`);

    try {
      const { state, clocks, players } = await this.gameService.getGameState(data.gameId);
      // For finished games, fetch result from DB
      let result: string | undefined;
      if (state.status === 'finished') {
        const dbGame = await this.gameService.getGame(data.gameId);
        result = dbGame.result ?? undefined;
      }
      const statePayload: WsGameStatePayload = {
        gameId: data.gameId,
        fen: state.fen,
        moves: state.moves.map((m) => m.san),
        clocks: { whiteMs: clocks.whiteMs, blackMs: clocks.blackMs },
        status: state.status as GameStatus,
        ...(result ? { result: result as GameResult } : {}),
        players,
      };
      client.emit(SpectatorEvents.SPECTATE_STATE, statePayload);
    } catch (e: any) {
      client.emit(GameEvents.ERROR, { code: 'SPECTATE_ERROR', message: e.message });
    }
  }

  @SubscribeMessage(SpectatorEvents.SPECTATE_LEAVE)
  async handleSpectateLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsSpectateLeavePayload,
  ) {
    await client.leave(`spectate:${data.gameId}`);
    this.logger.log(`Spectator ${client.id} left game ${data.gameId}`);
  }

  /** Emit a move to spectators with configured delay */
  private emitToSpectatorsDelayed(gameId: string, event: string, payload: unknown): void {
    const delay = this.liveGameService.spectatorDelayMs;
    setTimeout(() => {
      this.server.to(`spectate:${gameId}`).emit(event, payload);
    }, delay);
  }

  emitGameStart(gameId: string, payload: any) {
    this.server.to(`game:${gameId}`).emit(GameEvents.STATE, payload);
  }

  async emitGameEnd(gameId: string, result: GameResult, termination: string, ratingChange?: WsGameEndPayload['ratingChange']) {
    const endPayload: WsGameEndPayload = {
      result,
      termination,
      ...(ratingChange ? { ratingChange } : {}),
    };
    // Emit to room (for clients that joined via game:join)
    this.server.to(`game:${gameId}`).emit(GameEvents.END, endPayload);
    this.emitToSpectatorsDelayed(gameId, SpectatorEvents.SPECTATE_END, endPayload);

    // Also emit to player user rooms (fallback for missed game room join)
    try {
      const game = await this.gameService.getGame(gameId);
      for (const playerId of [game.whiteId, game.blackId].filter(Boolean)) {
        this.server.to(`user:${playerId}`).emit(GameEvents.END, endPayload);
      }
    } catch { /* game may already be cleaned up */ }
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
      this.emitToSpectatorsDelayed(gameId, SpectatorEvents.SPECTATE_MOVE, movePayload);

      if (botResult.gameOver) {
        const endPayload: WsGameEndPayload = {
          result: botResult.result as GameResult,
          termination: botResult.termination!,
        };
        this.server.to(`game:${gameId}`).emit(GameEvents.END, endPayload);
        this.emitToSpectatorsDelayed(gameId, SpectatorEvents.SPECTATE_END, endPayload);
      }
    } catch (e: any) {
      this.logger.error(`Bot reply failed for game ${gameId}: ${e.message}`);
    }
  }
}
