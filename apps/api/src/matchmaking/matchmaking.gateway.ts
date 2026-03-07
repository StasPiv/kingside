import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { MatchmakingService } from './matchmaking.service';
import { JoinQueueDto } from './dto/join-queue.dto';
import { TimeControlType } from '../generated/prisma/enums';

@WebSocketGateway({ namespace: '/game' })
export class MatchmakingGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(MatchmakingGateway.name);
  private playerQueues = new Map<string, TimeControlType>();

  constructor(private readonly matchmakingService: MatchmakingService) {}

  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage('matchmaking:join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: JoinQueueDto,
  ) {
    const user = client.data.user;
    if (!user) return;

    if (this.playerQueues.has(user.id)) {
      client.emit('error', { code: 'ALREADY_IN_QUEUE', message: 'Already in matchmaking queue' });
      return;
    }

    this.playerQueues.set(user.id, data.timeControl);
    this.logger.log(`${user.username} joined ${data.timeControl} queue`);

    const result = await this.matchmakingService.joinQueue(
      user.id,
      data.timeControl,
      data.timeInitial,
      data.increment,
    );

    if (result) {
      this.playerQueues.delete(user.id);

      const matchData = {
        gameId: result.gameId,
        timeControl: data.timeControl,
        timeInitial: data.timeInitial,
        increment: data.increment,
      };

      client.emit('matchmaking:found', {
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
        opponentSocket.emit('matchmaking:found', {
          ...matchData,
          color: result.color === 'white' ? 'black' : 'white',
          opponent: { id: user.id, username: user.username },
        });
      }

      this.logger.log(`Match found: ${result.gameId}`);
    }
  }

  @SubscribeMessage('matchmaking:leave')
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
