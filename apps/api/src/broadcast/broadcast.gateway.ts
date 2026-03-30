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
import { PrismaService } from '../prisma/prisma.service';
import { SubscribeRoundDto, UnsubscribeRoundDto } from './dto/broadcast.dto';

const BroadcastEvents = {
  SUBSCRIBE: 'broadcast:subscribe',
  UNSUBSCRIBE: 'broadcast:unsubscribe',
  MOVE: 'broadcast:move',
  SYNC: 'broadcast:sync',
  ERROR: 'error',
} as const;

type WsBroadcastMovePayload = {
  roundId: string;
  gameIndex: number;
  uci: string;
  fen: string;
  whitePlayer: string;
  blackPlayer: string;
};

@WebSocketGateway({ namespace: '/broadcast', cors: { origin: '*' } })
export class BroadcastGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(BroadcastGateway.name);

  constructor(private readonly prisma: PrismaService) {}

  handleConnection(client: Socket): void {
    this.logger.log(`Broadcast client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Broadcast client disconnected: ${client.id}`);
  }

  @SubscribeMessage(BroadcastEvents.SUBSCRIBE)
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SubscribeRoundDto,
  ): Promise<void> {
    const { roundId } = data;
    await client.join(`broadcast:${roundId}`);
    this.logger.log(`Client ${client.id} subscribed to round ${roundId}`);

    // Send current state of all games in the round
    const round = await this.prisma.broadcastRound.findUnique({
      where: { id: roundId },
      include: { games: true },
    });
    if (!round) return;

    const syncPayload = {
      roundId,
      games: round.games.map((g, idx) => ({
        gameIndex: idx,
        fen: g.currentFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        whitePlayer: g.whitePlayer ?? 'Unknown',
        blackPlayer: g.blackPlayer ?? 'Unknown',
        result: g.result ?? null,
        pgn: g.pgn ?? null,
      })),
    };

    client.emit(BroadcastEvents.SYNC, syncPayload);
  }

  @SubscribeMessage(BroadcastEvents.UNSUBSCRIBE)
  async handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: UnsubscribeRoundDto,
  ): Promise<void> {
    const { roundId } = data;
    await client.leave(`broadcast:${roundId}`);
    this.logger.log(`Client ${client.id} unsubscribed from round ${roundId}`);
  }

  emitMove(roundId: string, payload: WsBroadcastMovePayload): void {
    this.server.to(`broadcast:${roundId}`).emit(BroadcastEvents.MOVE, payload);
  }

  emitSync(roundId: string, payload: { roundId: string; games: Array<{ gameIndex: number; fen: string; whitePlayer: string; blackPlayer: string; result: string | null; pgn: string | null }> }): void {
    this.server.to(`broadcast:${roundId}`).emit(BroadcastEvents.SYNC, payload);
  }
}
