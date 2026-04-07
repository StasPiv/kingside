import { Logger } from '@nestjs/common';
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
import { ArenaService } from './arena.service';

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
  ROUND_START: 'tournament:round_start',
  ROUND_END: 'tournament:round_end',
};

@WebSocketGateway({ namespace: '/tournament', cors: { origin: '*' } })
export class ArenaGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ArenaGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly arenaService: ArenaService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token || client.handshake.query?.token;
      if (!token) { client.disconnect(); return; }
      const payload = this.jwtService.verify<JwtPayload>(String(token));
      client.data.user = { id: payload.sub, username: payload.username };
      this.logger.log(`Tournament client connected: ${payload.username} (${client.id})`);
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

    const roomSize = this.server?.sockets?.adapter?.rooms?.get(roomName)?.size ?? 0;
    this.logger.log(`handleSubscribe: ${client.data.user.username} (${client.id}) subscribed to ${roomName}, room size=${roomSize}`);

    // If tournament already active, send started event (handles API restart / late join)
    try {
      const tournament = await this.arenaService.findOne(data.tournamentId);
      if (tournament.status === 'active') {
        client.emit(TOURNAMENT_EVENTS.STARTED, { tournamentId: data.tournamentId });
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
    await client.join(roomName);
    client.data.tournamentId = data.tournamentId;

    // Join tournament entry
    try {
      await this.arenaService.join(data.tournamentId, userId);
    } catch (e: unknown) {
      this.logger.warn(`handleJoin: join entry failed for ${userId}: ${(e as Error).message}`);
      return;
    }

    this.logger.log(`handleJoin: ${client.data.user.username} joined tournament ${data.tournamentId}`);

    // Notify room
    this.server.to(roomName).emit(TOURNAMENT_EVENTS.PLAYER_JOINED, {
      userId,
      username: client.data.user.username,
    });
    this.logger.log(`handleJoin: emitted player_joined to room ${roomName}`);

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

    const result = await this.arenaService.seekOpponent(data.tournamentId, userId);
    this.logger.log(`handleSeek: user=${client.data.user?.username} tournament=${data.tournamentId.slice(0, 8)} result=${result ? 'paired(game=' + result.gameId.slice(0, 8) + ')' : 'null'}`);

    if (result) {
      // Notify both players with their color
      const seekerColor = userId === result.whiteId ? 'white' : 'black';
      const opponentColor = seekerColor === 'white' ? 'black' : 'white';
      const base = { gameId: result.gameId, tournamentId: data.tournamentId };

      client.emit(TOURNAMENT_EVENTS.PAIRED, { ...base, color: seekerColor });

      // Find opponent's socket
      const allSockets = await this.server.fetchSockets();
      for (const s of allSockets) {
        if (s.data.user?.id === result.opponentId) {
          s.emit(TOURNAMENT_EVENTS.PAIRED, { ...base, color: opponentColor });
        }
      }
    }
  }

  @SubscribeMessage(TOURNAMENT_EVENTS.LEAVE)
  async handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tournamentId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    const roomName = `tournament:${data.tournamentId}`;
    const roomSize = this.server?.sockets?.adapter?.rooms?.get(roomName)?.size ?? 0;
    this.logger.log(`handleLeave: ${client.data.user?.username} (${client.id}) leaving room ${roomName}, room size=${roomSize}`);

    await this.arenaService.leaveSeeking(data.tournamentId, userId);

    // Notify room before leaving
    this.emitPlayerLeft(data.tournamentId, userId);
    await this.emitStandings(data.tournamentId);

    await client.leave(roomName);
    client.data.tournamentId = null;
  }

  // Called by scheduler when tournament starts/finishes
  emitTournamentStarted(tournamentId: string) {
    this.server.to(`tournament:${tournamentId}`).emit(TOURNAMENT_EVENTS.STARTED, { tournamentId });
  }

  emitTournamentFinished(tournamentId: string) {
    this.server.to(`tournament:${tournamentId}`).emit(TOURNAMENT_EVENTS.FINISHED, { tournamentId });
  }

  async emitStandings(tournamentId: string) {
    const roomName = `tournament:${tournamentId}`;
    const roomSize = this.server?.sockets?.adapter?.rooms?.get(roomName)?.size ?? 0;
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
    const roomSize = this.server?.sockets?.adapter?.rooms?.get(roomName)?.size ?? 0;
    const standings = await this.arenaService.getStandings(tournamentId);
    this.server.to(roomName).emit(TOURNAMENT_EVENTS.GAME_FINISHED, {
      gameId: data.gameId,
      result: data.result,
      white: data.white,
      black: data.black,
      pairingId: data.pairingId,
      standings,
    });
    this.logger.log(`emitGameFinished: room=${roomName} size=${roomSize} game=${data.gameId.slice(0, 8)} result=${data.result} standings=${standings.length}`);
  }

  async emitPaired(tournamentId: string, gameId: string, whiteId: string, blackId: string | null) {
    if (!blackId) return; // bye — no game
    const allSockets = await this.server.fetchSockets();
    let notified = 0;
    for (const s of allSockets) {
      if (s.data.user?.id === whiteId) {
        s.emit(TOURNAMENT_EVENTS.PAIRED, { gameId, tournamentId, color: 'white' });
        notified++;
      } else if (s.data.user?.id === blackId) {
        s.emit(TOURNAMENT_EVENTS.PAIRED, { gameId, tournamentId, color: 'black' });
        notified++;
      }
    }
    this.logger.log(`emitPaired: game ${gameId}, white=${whiteId}, black=${blackId}, sockets=${allSockets.length}, notified=${notified}`);
  }

  emitPlayerLeft(tournamentId: string, userId: string) {
    const roomName = `tournament:${tournamentId}`;
    const roomSize = this.server?.sockets?.adapter?.rooms?.get(roomName)?.size ?? 0;
    this.server.to(roomName).emit(TOURNAMENT_EVENTS.PLAYER_LEFT, { tournamentId, userId });
    this.logger.log(`emitPlayerLeft: userId=${userId}, room=${roomName}, size=${roomSize}`);
  }
}
