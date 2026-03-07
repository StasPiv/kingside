import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  async sendMessage(gameId: string, userId: string, content: string) {
    const message = await this.prisma.chatMessage.create({
      data: {
        gameId,
        userId,
        content,
      },
      include: {
        user: { select: { id: true, username: true } },
      },
    });

    return {
      userId: message.user.id,
      username: message.user.username,
      content: message.content,
      timestamp: message.createdAt.toISOString(),
    };
  }
}
