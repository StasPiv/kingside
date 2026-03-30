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
  JOIN: 'tournament:join',
  SEEK: 'tournament:seek',
  LEAVE: 'tournament:leave',
  PAIRED: 'tournament:paired',
  STANDINGS: 'tournament:standings',
  STARTED: 'tournament:started',
  FINISHED: 'tournament:finished',
  PLAYER_JOINED: 'tournament:player_joined',
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
    if (userId && tid) {
      await this.arenaService.leaveSeeking(tid, userId);
    }
  }

  @SubscribeMessage(TOURNAMENT_EVENTS.JOIN)
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tournamentId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    await client.join(`tournament:${data.tournamentId}`);
    client.data.tournamentId = data.tournamentId;

    // Auto-join entry
    await this.arenaService.join(data.tournamentId, userId);

    // Notify room
    this.server.to(`tournament:${data.tournamentId}`).emit(TOURNAMENT_EVENTS.PLAYER_JOINED, {
      userId,
      username: client.data.user.username,
    });
  }

  @SubscribeMessage(TOURNAMENT_EVENTS.SEEK)
  async handleSeek(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tournamentId: string },
  ) {
    const userId = client.data.user?.id;
    if (!userId) return;

    const result = await this.arenaService.seekOpponent(data.tournamentId, userId);

    if (result) {
      // Notify both players
      const payload = { gameId: result.gameId, tournamentId: data.tournamentId };

      client.emit(TOURNAMENT_EVENTS.PAIRED, payload);

      // Find opponent's socket
      const allSockets = await this.server.fetchSockets();
      for (const s of allSockets) {
        if (s.data.user?.id === result.opponentId) {
          s.emit(TOURNAMENT_EVENTS.PAIRED, payload);
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

    await this.arenaService.leaveSeeking(data.tournamentId, userId);
    await client.leave(`tournament:${data.tournamentId}`);
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
    const standings = await this.arenaService.getStandings(tournamentId);
    this.server.to(`tournament:${tournamentId}`).emit(TOURNAMENT_EVENTS.STANDINGS, { standings });
  }
}
