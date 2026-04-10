import { Injectable } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
  ) {}

  async sendMessage(gameId: string, userId: string, content: string) {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { whiteId: true, blackId: true },
    });

    if (userId !== game.whiteId && userId !== game.blackId) {
      throw new Error(this.i18n.t('messages.game.notAPlayer'));
    }

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
