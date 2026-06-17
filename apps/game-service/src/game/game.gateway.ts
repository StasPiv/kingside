import { Logger, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { GameClockService } from './game-clock.service';
import { RedisService } from '../redis/redis.service';
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
  type WsSpectateJoinPayload,
  type WsSpectateLeavePayload,
  type GameStatus,
  type GameResult,
} from '@kingside/shared';

/** Default spectator delay in milliseconds (дублируем вместо мёртвого LiveGameService). */
const DEFAULT_SPECTATOR_DELAY_MS = 5000;

@WebSocketGateway({ namespace: '/game', cors: { origin: '*' }, transports: ['websocket'], pingInterval: 300000, pingTimeout: 300000, connectTimeout: 60000 })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(GameGateway.name);
  /** Grace period before ending bot games on disconnect (ms) */
  private static readonly BOT_DISCONNECT_GRACE_MS = 30_000;
  private readonly botDisconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly spectatorDelayMs: number;

  constructor(
    private readonly gameService: GameService,
    private readonly botGameService: BotGameService,
    private readonly jwtService: JwtService,
    private readonly chatService: ChatService,
    private readonly config: ConfigService,
    private readonly clockService: GameClockService,
    private readonly redis: RedisService,
  ) {
    const delaySec = this.config.get<number>('SPECTATOR_DELAY_SEC');
    this.spectatorDelayMs = delaySec ? delaySec * 1000 : DEFAULT_SPECTATOR_DELAY_MS;
  }

  private readonly instanceId = require('../instance-logger').INSTANCE_ID;

  async handleConnection(client: Socket) {
    // Log ALL incoming events for diagnostics (KS-1378)
    client.onAny((event: string, ...args: unknown[]) => {
      const user = client.data.user?.username || 'anon';
      this.logger.log(`[event] ${user} ${event} ${JSON.stringify(args).slice(0, 120)}`);
    });

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
      client.emit('server:instance', { instanceId: this.instanceId });
    } catch {
      // Invalid token — allow connection for spectating (no user set)
      this.logger.log(`Client connected with invalid token: ${client.id}`);
    }
  }

  async handleDisconnect(client: Socket) {
    const userId = client.data.user?.id;
    this.logger.log(`Client disconnected: ${client.id}`);

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

    this.logger.log(`handleJoinGame[1]: user=${client.data.user?.username} game=${data.gameId.slice(0, 8)} joined room`);

    try {
      const { state, clocks, whiteId, blackId, players, isBot, botLevel } = await this.gameService.getGameState(data.gameId);
      this.logger.log(`handleJoinGame[2]: getGameState OK status=${state.status} fen=${state.fen.slice(0, 20)}`);

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
      this.logger.log(`handleJoinGame[3]: emitted game:state to ${client.data.user?.username}`);

      // Track player joins — start clocks when both players have joined
      if (color && state.status === 'active' && !clocks.running) {
        if (isBot) {
          // Bot doesn't join via WS — count as 2 joins immediately
          const joinKey = `game:${data.gameId}:joins`;
          await this.redis.hset(joinKey, 'count', '2');
          await this.redis.expire(joinKey, 120);
          await this.clockService.startClock(data.gameId);
          this.logger.warn(`handleJoinGame: bot game clocks STARTED game=${data.gameId.slice(0, 8)}`);
        } else {
          this.logger.warn(`handleJoinGame: calling maybeStartClocks user=${client.data.user?.username} game=${data.gameId.slice(0, 8)} color=${color} clocksRunning=${clocks.running}`);
          await this.maybeStartClocks(data.gameId, color, whiteId, blackId);
        }
      }

    } catch (e: unknown) {
      this.logger.error(`handleJoinGame: game=${data.gameId.slice(0, 8)} ERROR: ${(e as Error).message}`);
      client.emit(GameEvents.ERROR, { code: 'JOIN_ERROR', message: (e as Error).message });
    }
  }

  @SubscribeMessage(GameEvents.MOVE)
  async handleMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: WsGameMovePayload,
  ) {
    this.logger.log(`handleMove: user=${client.data.user?.username} game=${data?.gameId?.slice(0, 8)} uci=${data?.uci}`);
    const userId = client.data.user?.id;
    if (!userId) {
      this.logger.warn(`handleMove: no userId for client ${client.id}`);
      return;
    }

    try {
      const result = await this.gameService.makeMove(data.gameId, userId, data.uci);

      const movePayload: WsGameMoveServerPayload = {
        uci: data.uci,
        san: result.san,
        fen: result.fen,
        clocks: { whiteMs: result.clocks.whiteMs, blackMs: result.clocks.blackMs },
        moveFlags: result.moveFlags,
      };
      this.server.to(`game:${data.gameId}`).emit(GameEvents.MOVE_SERVER, movePayload);
      this.emitToSpectatorsDelayed(data.gameId, SpectatorEvents.SPECTATE_MOVE, movePayload);

      if (result.gameOver) {
        const endPayload: WsGameEndPayload = {
          result: result.result as GameResult,
          termination: result.termination!,
          ...(result.ratingChange ? { ratingChange: result.ratingChange } : {}),
        };
        this.server.to(`game:${data.gameId}`).emit(GameEvents.END, endPayload);
        this.emitToSpectatorsDelayed(data.gameId, SpectatorEvents.SPECTATE_END, endPayload);
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
    const delay = this.spectatorDelayMs;
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

  @SubscribeMessage('game:bot-move')
  async handleBotMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string; uci: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    try {
      const dbGame = await this.gameService.getGame(data.gameId);

      if (!dbGame.isBot) {
        client.emit(GameEvents.ERROR, { code: 'BOT_MOVE_ERROR', message: 'Not a bot game' });
        return;
      }

      // Determine bot player ID
      const botPlayerId = this.botGameService.isBotPlayer(dbGame.whiteId) ? dbGame.whiteId
        : this.botGameService.isBotPlayer(dbGame.blackId) ? dbGame.blackId : null;
      if (!botPlayerId) {
        client.emit(GameEvents.ERROR, { code: 'BOT_MOVE_ERROR', message: 'No bot player found' });
        return;
      }

      // Verify it's the bot's turn
      const { state } = await this.gameService.getGameState(data.gameId);
      const nextPlayerId = state.activeColor === 'white' ? dbGame.whiteId : dbGame.blackId;
      if (nextPlayerId !== botPlayerId) {
        client.emit(GameEvents.ERROR, { code: 'BOT_MOVE_ERROR', message: 'Not bot turn' });
        return;
      }

      // Make the move on behalf of the bot
      const result = await this.gameService.makeMove(data.gameId, botPlayerId, data.uci);

      const movePayload: WsGameMoveServerPayload = {
        uci: data.uci,
        san: result.san,
        fen: result.fen,
        clocks: { whiteMs: result.clocks.whiteMs, blackMs: result.clocks.blackMs },
        moveFlags: result.moveFlags,
      };
      this.server.to(`game:${data.gameId}`).emit(GameEvents.MOVE_SERVER, movePayload);
      this.emitToSpectatorsDelayed(data.gameId, SpectatorEvents.SPECTATE_MOVE, movePayload);

      if (result.gameOver) {
        const endPayload: WsGameEndPayload = {
          result: result.result as GameResult,
          termination: result.termination!,
        };
        this.server.to(`game:${data.gameId}`).emit(GameEvents.END, endPayload);
        this.emitToSpectatorsDelayed(data.gameId, SpectatorEvents.SPECTATE_END, endPayload);
      }
    } catch (e: any) {
      client.emit(GameEvents.ERROR, { code: 'BOT_MOVE_ERROR', message: e.message });
    }
  }

  /**
   * Track player joins. When both players have joined, start the clocks.
   * Uses Redis HINCRBY on game:{gameId}:joins as atomic counter.
   */
  private async maybeStartClocks(
    gameId: string,
    color: 'white' | 'black',
    whiteId: string,
    blackId: string,
  ): Promise<void> {
    const joinKey = `game:${gameId}:joins`;
    // Atomically increment join count; returns new count
    const count = await this.redis.hincrby(joinKey, 'count', 1);
    await this.redis.expire(joinKey, 120); // safety TTL

    this.logger.warn(`maybeStartClocks: game=${gameId.slice(0, 8)} color=${color} whiteId=${whiteId.slice(0, 8)} blackId=${blackId.slice(0, 8)} count=${count} joinKey=${joinKey}`);

    if (count === 1) {
      this.logger.log(`maybeStartClocks: game=${gameId.slice(0, 8)} waiting for second player`);
    } else if (count >= 2) {
      await this.clockService.startClock(gameId);
      this.logger.warn(`maybeStartClocks: game=${gameId.slice(0, 8)} clocks STARTED count=${count} triggeredBy=${color}`);

      const raw = await this.redis.hgetall(`game:${gameId}:clocks`);
      const updatedClocks = { whiteMs: Number(raw.white_ms), blackMs: Number(raw.black_ms) };

      const clockUpdate = {
        gameId,
        clocks: updatedClocks,
        clocksRunning: true,
      };
      this.server.to(`game:${gameId}`).emit('game:clock_started', clockUpdate);
    }
  }
}
