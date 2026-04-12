import { Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
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
import Redis from 'ioredis';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from '../auth/jwt.strategy';
import { ArenaService } from './arena.service';
import { RedisService } from '../redis/redis.service';
import { MatchmakerWorkerService } from '../matchmaker-worker/matchmaker-worker.service';

/** Redis pub/sub channel from matchmaker worker */
const MATCHMAKER_PAIRED_CHANNEL = 'matchmaker:paired';

const TOURNAMENT_EVENTS = {
  SUBSCRIBE: 'tournament:subscribe',
  JOIN: 'tournament:join',
  SEEK: 'tournament:seek',
  LEAVE: 'tournament:leave',
  PAIRED: 'tournament:paired',
  STANDINGS: 'tournament:standings',
  STARTED: 'tournament:started',
  FINISHED: 'tournament:finished',
  PLAYER_JOINED: 'tournament:player_joined',
  PLAYER_LEFT: 'tournament:player_left',
  GAME_END: 'tournament:game_end',
  GAME_FINISHED: 'tournament:gameFinished',
  GAME_STARTED: 'tournament:gameStarted',
  ROUND_START: 'tournament:round_start',
  ROUND_END: 'tournament:round_end',
};

@WebSocketGateway({ namespace: '/tournament', cors: { origin: '*' }, transports: ['websocket'], pingInterval: 300000, pingTimeout: 300000, connectTimeout: 60000 })
export class ArenaGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ArenaGateway.name);
  /** Local cache of userId → username, populated on connect */
  private readonly usernames = new Map<string, string>();
  private subRedis: Redis | null = null;

  constructor(
    private readonly jwtService: JwtService,
    private readonly arenaService: ArenaService,
    private readonly redis: RedisService,
    private readonly matchmaker: MatchmakerWorkerService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Guard: subscribe only once (onModuleInit may be called multiple times)
    if (this.subRedis) {
      this.logger.warn('onModuleInit called again — already subscribed, skipping');
      return;
    }

    try {
      const redisHost = process.env.REDIS_HOST || 'localhost';
      const redisPort = parseInt(process.env.REDIS_PORT || '6380', 10);
      this.subRedis = new Redis({ host: redisHost, port: redisPort });

      await this.subRedis.subscribe(MATCHMAKER_PAIRED_CHANNEL);

      this.subRedis.on('message', async (channel: string, message: string) => {
        if (channel !== MATCHMAKER_PAIRED_CHANNEL) return;
        try {
          const data = JSON.parse(message) as {
            tournamentId: string; gameId: string; whiteId: string; blackId: string;
          };

          // Distributed dedup: only one instance emits paired per game
          const acquired = await this.redis.set(`paired:emitted:${data.gameId}`, '1', 'EX', 60, 'NX');
          if (!acquired) {
            this.logger.log(`matchmaker:paired DEDUP skipped game=${data.gameId.slice(0, 8)}`);
            return;
          }

          // Emit tournament:paired to both players via user rooms
          const whiteRoom = (this.server.adapter as any).rooms?.get(`user:${data.whiteId}`);
          const blackRoom = (this.server.adapter as any).rooms?.get(`user:${data.blackId}`);
          this.logger.warn(`paired EMIT game=${data.gameId.slice(0, 8)} whiteRoomSize=${whiteRoom?.size ?? 0} blackRoomSize=${blackRoom?.size ?? 0}`);

          // Mark both players as playing — blocks seek until game ends
          await this.redis.set(`arena:${data.tournamentId}:playing:${data.whiteId}`, data.gameId, 'EX', 600).catch(() => {});
          await this.redis.set(`arena:${data.tournamentId}:playing:${data.blackId}`, data.gameId, 'EX', 600).catch(() => {});

          // Store pending paired in Redis (re-delivered on reconnect/subscribe)
          await this.redis.set(
            `arena:${data.tournamentId}:paired:${data.whiteId}`,
            JSON.stringify({ gameId: data.gameId, color: 'white' }), 'EX', 120,
          ).catch(() => {});
          await this.redis.set(
            `arena:${data.tournamentId}:paired:${data.blackId}`,
            JSON.stringify({ gameId: data.gameId, color: 'black' }), 'EX', 120,
          ).catch(() => {});

          const beforeEmit = Date.now();
          this.server.to(`user:${data.whiteId}`).emit(TOURNAMENT_EVENTS.PAIRED, {
            gameId: data.gameId, tournamentId: data.tournamentId, color: 'white',
          });
          this.server.to(`user:${data.blackId}`).emit(TOURNAMENT_EVENTS.PAIRED, {
            gameId: data.gameId, tournamentId: data.tournamentId, color: 'black',
          });
          const afterEmit = Date.now();
          this.logger.warn(`paired EMIT TIMING game=${data.gameId.slice(0, 8)} before=${beforeEmit} after=${afterEmit} took=${afterEmit - beforeEmit}ms`);

          // Emit tournament:gameStarted to all subscribers
          const whiteUsername = this.usernames.get(data.whiteId) ?? '';
          const blackUsername = this.usernames.get(data.blackId) ?? '';
          this.emitGameStarted(data.tournamentId, {
            gameId: data.gameId,
            white: { id: data.whiteId, username: whiteUsername },
            black: { id: data.blackId, username: blackUsername },
          });

          this.logger.log(`matchmaker:paired → game=${data.gameId.slice(0, 8)} white=${data.whiteId.slice(0, 8)} black=${data.blackId.slice(0, 8)}`);
        } catch (e: any) {
          this.logger.error(`Redis message parse error: ${e.message}`);
        }
      });

      this.logger.log('Subscribed to matchmaker:paired Redis channel');
    } catch (e: any) {
      this.logger.warn(`matchmaker:paired Redis subscribe failed (non-fatal): ${e.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subRedis) {
      await this.subRedis.unsubscribe().catch(() => {});
      await this.subRedis.quit().catch(() => {});
      this.subRedis = null;
    }
  }

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token || client.handshake.query?.token;
      if (!token) { client.disconnect(); return; }
      const payload = this.jwtService.verify<JwtPayload>(String(token));
      client.data.user = { id: payload.sub, username: payload.username };
      await client.join(`user:${payload.sub}`);
      this.usernames.set(payload.sub, payload.username ?? '');
      this.logger.log(`Tournament client connected: ${payload.username} (${client.id})`);
      client.emit('server:instance', { instanceId: require('../instance-logger').INSTANCE_ID });
      client.on('disconnect', (reason: string) => {
        this.logger.warn(`Tournament WS disconnect: ${payload.username} reason=${reason}`);
      });
    } catch {
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    const userId = client.data.user?.id;
    const tid = client.data.tournamentId;
    this.logger.log(`Tournament client disconnected: ${client.data.user?.username ?? '?'} (${client.id}), tournamentId=${tid ?? 'none'}`);
    if (userId && tid) {
      await this.arenaService.leaveSeeking(tid, userId);
    }
  }

  @SubscribeMessage(TOURNAMENT_EVENTS.SUBSCRIBE)
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tournamentId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    const roomName = `tournament:${data.tournamentId}`;
    await client.join(roomName);
    client.data.tournamentId = data.tournamentId;

    const roomSize = (this.server?.adapter as any)?.rooms?.get(roomName)?.size ?? 0;
    this.logger.log(`handleSubscribe: ${client.data.user.username} (${client.id}) subscribed to ${roomName}, room size=${roomSize}`);

    // Send current tournament status to late joiners (handles API restart / slow WS connect)
    try {
      const tournament = await this.arenaService.findOne(data.tournamentId);
      if (tournament.status === 'active') {
        client.emit(TOURNAMENT_EVENTS.STARTED, { tournamentId: data.tournamentId });
        this.logger.log(`handleSubscribe: sent tournament:started (late join) to ${client.data.user.username}`);

        // Re-deliver pending paired event if user has active game in this tournament
        const activeGame = await this.redis.get(`arena:${data.tournamentId}:paired:${userId}`);
        if (activeGame) {
          try {
            const paired = JSON.parse(activeGame) as { gameId: string; color: string };
            client.emit(TOURNAMENT_EVENTS.PAIRED, { gameId: paired.gameId, tournamentId: data.tournamentId, color: paired.color });
            this.logger.warn(`handleSubscribe: re-delivered paired game=${paired.gameId.slice(0, 8)} to ${client.data.user.username}`);
          } catch { /* ignore parse errors */ }
        }
      } else if (tournament.status === 'finished') {
        client.emit(TOURNAMENT_EVENTS.FINISHED, { tournamentId: data.tournamentId });
      }
    } catch { /* tournament not found — ignore */ }
  }

  @SubscribeMessage(TOURNAMENT_EVENTS.JOIN)
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tournamentId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    const roomName = `tournament:${data.tournamentId}`;
    // NOTE: do NOT join tournament room here — subscribe does that for spectators/frontend.
    // This keeps players out of the broadcast flood (gameFinished/gameStarted).
    client.data.tournamentId = data.tournamentId;

    // Join tournament entry
    try {
      await this.arenaService.join(data.tournamentId, userId);
    } catch (e: unknown) {
      this.logger.warn(`handleJoin: join entry failed for ${userId}: ${(e as Error).message}`);
      return;
    }

    this.logger.log(`handleJoin: ${client.data.user.username} joined tournament ${data.tournamentId}`);

    // Notify tournament room (spectators/frontend)
    this.server.to(roomName).emit(TOURNAMENT_EVENTS.PLAYER_JOINED, {
      userId,
      username: client.data.user.username,
    });
    this.logger.log(`handleJoin: emitted player_joined to room ${roomName}`);

    // Deliver tournament:started to user room if tournament is already active
    try {
      const tournament = await this.arenaService.findOne(data.tournamentId);
      if (tournament.status === 'active') {
        client.emit(TOURNAMENT_EVENTS.STARTED, { tournamentId: data.tournamentId });
        this.logger.log(`handleJoin: sent tournament:started to ${client.data.user.username} via user room`);

        // Re-deliver pending paired event
        const activeGame = await this.redis.get(`arena:${data.tournamentId}:paired:${userId}`);
        if (activeGame) {
          try {
            const paired = JSON.parse(activeGame) as { gameId: string; color: string };
            client.emit(TOURNAMENT_EVENTS.PAIRED, { gameId: paired.gameId, tournamentId: data.tournamentId, color: paired.color });
            this.logger.warn(`handleJoin: re-delivered paired game=${paired.gameId.slice(0, 8)} to ${client.data.user.username}`);
          } catch { /* ignore parse errors */ }
        }
      } else if (tournament.status === 'finished') {
        client.emit(TOURNAMENT_EVENTS.FINISHED, { tournamentId: data.tournamentId });
      }
    } catch { /* tournament not found — ignore */ }

    // Update standings so all players see the new entry
    await this.emitStandings(data.tournamentId);
  }

  @SubscribeMessage(TOURNAMENT_EVENTS.SEEK)
  async handleSeek(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tournamentId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    // Fast Redis check: reject seek if player already in a game
    const playingKey = `arena:${data.tournamentId}:playing:${userId}`;
    const playing = await this.redis.get(playingKey);
    if (playing) {
      this.logger.warn(`handleSeek BLOCKED: ${client.data.user?.username} already playing game=${playing.slice(0, 8)}`);
      return;
    }

    const seekStart = Date.now();
    await this.arenaService.addToSeekQueue(data.tournamentId, userId);
    const queuedAt = Date.now();
    await this.matchmaker.tryPairArena(data.tournamentId);
    const pairDone = Date.now();
    this.logger.log(`handleSeek: ${client.data.user?.username} queued=${queuedAt - seekStart}ms pair=${pairDone - queuedAt}ms total=${pairDone - seekStart}ms`);
  }

  @SubscribeMessage(TOURNAMENT_EVENTS.LEAVE)
  async handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tournamentId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    const roomName = `tournament:${data.tournamentId}`;
    const roomSize = (this.server?.adapter as any)?.rooms?.get(roomName)?.size ?? 0;
    this.logger.log(`handleLeave: ${client.data.user?.username} (${client.id}) leaving room ${roomName}, room size=${roomSize}`);

    await this.arenaService.leaveSeeking(data.tournamentId, userId);

    // Notify room before leaving
    this.emitPlayerLeft(data.tournamentId, userId);
    await this.emitStandings(data.tournamentId);

    await client.leave(roomName);
    client.data.tournamentId = null;
  }

  // Called by scheduler when tournament starts/finishes
  async emitTournamentStarted(tournamentId: string) {
    // Broadcast to tournament room (spectators/frontend)
    this.server.to(`tournament:${tournamentId}`).emit(TOURNAMENT_EVENTS.STARTED, { tournamentId });
    // Also emit to each participant's user room (players who skipped subscribe)
    try {
      const participantIds = await this.arenaService.getParticipantIds(tournamentId);
      for (const userId of participantIds) {
        this.server.to(`user:${userId}`).emit(TOURNAMENT_EVENTS.STARTED, { tournamentId });
      }
      this.logger.log(`emitTournamentStarted: room + ${participantIds.length} user rooms`);
    } catch (e: any) {
      this.logger.error(`emitTournamentStarted user rooms failed: ${e.message}`);
    }
  }

  async emitTournamentFinished(tournamentId: string) {
    // Broadcast to tournament room (spectators/frontend)
    this.server.to(`tournament:${tournamentId}`).emit(TOURNAMENT_EVENTS.FINISHED, { tournamentId });
    // Also emit to each participant's user room (players who skipped subscribe)
    try {
      const participantIds = await this.arenaService.getParticipantIds(tournamentId);
      for (const userId of participantIds) {
        this.server.to(`user:${userId}`).emit(TOURNAMENT_EVENTS.FINISHED, { tournamentId });
      }
      this.logger.log(`emitTournamentFinished: room + ${participantIds.length} user rooms`);
    } catch (e: any) {
      this.logger.error(`emitTournamentFinished user rooms failed: ${e.message}`);
    }
  }

  async emitStandings(tournamentId: string) {
    const roomName = `tournament:${tournamentId}`;
    const roomSize = (this.server?.adapter as any)?.rooms?.get(roomName)?.size ?? 0;
    const standings = await this.arenaService.getStandings(tournamentId);
    this.server.to(roomName).emit(TOURNAMENT_EVENTS.STANDINGS, { standings });
    this.logger.log(`emitStandings: room ${roomName}, size=${roomSize}, entries=${standings.length}`);
  }

  emitRoundStart(tournamentId: string, roundNumber: number, pairings?: { whiteId: string; blackId: string | null; gameId: string | null; board: number }[]) {
    this.server.to(`tournament:${tournamentId}`).emit(TOURNAMENT_EVENTS.ROUND_START, { tournamentId, roundNumber, pairings: pairings ?? [] });
  }

  emitRoundEnd(tournamentId: string, roundNumber: number, nextRoundStartsAt?: string | null) {
    this.server.to(`tournament:${tournamentId}`).emit(TOURNAMENT_EVENTS.ROUND_END, { tournamentId, roundNumber, nextRoundStartsAt: nextRoundStartsAt ?? null });
  }

  emitGameEnd(tournamentId: string, gameId: string, result: string, pairingId: string) {
    this.server.to(`tournament:${tournamentId}`).emit(TOURNAMENT_EVENTS.GAME_END, { gameId, result, pairingId });
  }

  async emitGameFinished(
    tournamentId: string,
    data: {
      gameId: string;
      result: string;
      white: { id: string; username: string };
      black: { id: string; username: string };
      pairingId: string | null;
    },
  ) {
    const roomName = `tournament:${tournamentId}`;
    const roomSize = (this.server?.adapter as any)?.rooms?.get(roomName)?.size ?? 0;
    const standings = await this.arenaService.getStandings(tournamentId);
    const payload = {
      gameId: data.gameId,
      result: data.result,
      white: data.white,
      black: data.black,
      pairingId: data.pairingId,
      standings,
    };

    // Emit to tournament room
    this.server.to(roomName).emit(TOURNAMENT_EVENTS.GAME_FINISHED, payload);
    this.logger.log(`emitGameFinished: room=${roomName} size=${roomSize} game=${data.gameId.slice(0, 8)} result=${data.result} standings=${standings.length}`);
  }

  async emitGameStarted(
    tournamentId: string,
    data: {
      gameId: string;
      white: { id: string; username: string };
      black: { id: string; username: string };
    },
  ) {
    const roomName = `tournament:${tournamentId}`;
    const roomSize = (this.server?.adapter as any)?.rooms?.get(roomName)?.size ?? 0;
    const payload = {
      gameId: data.gameId,
      white: data.white,
      black: data.black,
    };

    // Emit to tournament room
    this.server.to(roomName).emit(TOURNAMENT_EVENTS.GAME_STARTED, payload);
    this.logger.log(`emitGameStarted: room=${roomName} size=${roomSize} game=${data.gameId.slice(0, 8)} white=${data.white.username} black=${data.black.username}`);
  }

  async emitPaired(tournamentId: string, gameId: string, whiteId: string, blackId: string | null) {
    if (!blackId) return;
    const acquired = await this.redis.set(`paired:emitted:${gameId}`, '1', 'EX', 60, 'NX');
    if (!acquired) {
      this.logger.log(`emitPaired DEDUP skipped game=${gameId.slice(0, 8)}`);
      return;
    }
    this.server.to(`user:${whiteId}`).emit(TOURNAMENT_EVENTS.PAIRED, { gameId, tournamentId, color: 'white' });
    this.server.to(`user:${blackId}`).emit(TOURNAMENT_EVENTS.PAIRED, { gameId, tournamentId, color: 'black' });
    this.logger.log(`emitPaired: game ${gameId.slice(0, 8)}, white=${whiteId.slice(0, 8)}, black=${blackId.slice(0, 8)}`);
  }

  emitPlayerLeft(tournamentId: string, userId: string) {
    const roomName = `tournament:${tournamentId}`;
    const roomSize = (this.server?.adapter as any)?.rooms?.get(roomName)?.size ?? 0;
    this.server.to(roomName).emit(TOURNAMENT_EVENTS.PLAYER_LEFT, { tournamentId, userId });
    this.logger.log(`emitPlayerLeft: userId=${userId}, room=${roomName}, size=${roomSize}`);
  }
}
