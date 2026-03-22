import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from '../auth/jwt.strategy';
import { MessageEvents, FriendEvents } from '@kingside/shared';

@WebSocketGateway({ namespace: '/messages', cors: { origin: '*' } })
export class MessageGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(MessageGateway.name);

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token || client.handshake.query?.token;
      if (!token) {
        client.disconnect();
        return;
      }
      const payload = this.jwtService.verify<JwtPayload>(String(token));
      client.data.user = { id: payload.sub, username: payload.username };
      await client.join(`user:${payload.sub}`);
      this.logger.log(`Messages client connected: ${payload.username} (${client.id})`);
    } catch {
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Messages client disconnected: ${client.id}`);
  }

  notifyNewMessage(
    message: {
      id: string;
      senderId: string;
      receiverId: string;
      text: string;
      createdAt: string;
      readAt: string | null;
    },
    senderUsername: string,
  ) {
    this.server.to(`user:${message.receiverId}`).emit(MessageEvents.NEW_MESSAGE, {
      ...message,
      senderUsername,
    });
  }

  notifyFriendRequestReceived(
    addresseeId: string,
    payload: { requestId: string; user: { id: string; username: string } },
  ) {
    this.server.to(`user:${addresseeId}`).emit(FriendEvents.REQUEST_RECEIVED, payload);
  }

  notifyFriendRequestAccepted(
    requesterId: string,
    payload: { requestId: string; user: { id: string; username: string } },
  ) {
    this.server.to(`user:${requesterId}`).emit(FriendEvents.REQUEST_ACCEPTED, payload);
  }

  notifyFriendStatus(
    userId: string,
    event: typeof FriendEvents.STATUS_ONLINE | typeof FriendEvents.STATUS_OFFLINE,
    payload: { userId: string; username: string },
  ) {
    this.server.to(`user:${userId}`).emit(event, payload);
  }
}
