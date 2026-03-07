import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
  ) {}

  async updateSettings(userId: string, dto: UpdateSettingsDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { locale: dto.locale },
      select: { id: true, locale: true },
    });
    return user;
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException(
        this.i18n.t('messages.user.wrongPassword'),
      );
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    return { success: true };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        ratingBullet: true,
        ratingBlitz: true,
        ratingRapid: true,
        ratingClassical: true,
        createdAt: true,
        lastSeenAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    return user;
  }

  async getUserGames(userId: string, take = 20, skip = 0) {
    const games = await this.prisma.game.findMany({
      where: {
        OR: [{ whiteId: userId }, { blackId: userId }],
        status: 'finished',
      },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: {
        white: { select: { id: true, username: true } },
        black: { select: { id: true, username: true } },
      },
    });

    return games;
  }
}
