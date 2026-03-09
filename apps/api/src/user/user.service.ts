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
        gamesPlayedBullet: true,
        gamesPlayedBlitz: true,
        gamesPlayedRapid: true,
        gamesPlayedClassical: true,
        createdAt: true,
        lastSeenAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    const PROVISIONAL_THRESHOLD = 20;

    return {
      ...user,
      provisionalBullet: user.gamesPlayedBullet < PROVISIONAL_THRESHOLD,
      provisionalBlitz: user.gamesPlayedBlitz < PROVISIONAL_THRESHOLD,
      provisionalRapid: user.gamesPlayedRapid < PROVISIONAL_THRESHOLD,
      provisionalClassical: user.gamesPlayedClassical < PROVISIONAL_THRESHOLD,
    };
  }

  async getPuzzleRushStats(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    const [best3, best5, totalSessions] = await Promise.all([
      this.prisma.puzzleRushScore.findFirst({
        where: { userId, timeMode: '3' },
        orderBy: { score: 'desc' },
        select: { score: true },
      }),
      this.prisma.puzzleRushScore.findFirst({
        where: { userId, timeMode: '5' },
        orderBy: { score: 'desc' },
        select: { score: true },
      }),
      this.prisma.puzzleRushScore.count({
        where: { userId },
      }),
    ]);

    return {
      best3: best3?.score ?? 0,
      best5: best5?.score ?? 0,
      totalSessions,
    };
  }

  async getUserGames(userId: string, take = 20, skip = 0) {
    const safeTake = Math.min(take, 50);

    const where = {
      OR: [{ whiteId: userId }, { blackId: userId }],
      status: 'finished' as const,
    };

    const [games, total] = await Promise.all([
      this.prisma.game.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: safeTake,
        skip,
        select: {
          id: true,
          result: true,
          termination: true,
          timeControlType: true,
          timeInitialSec: true,
          timeIncrementSec: true,
          eco: true,
          createdAt: true,
          whiteRatingBefore: true,
          whiteRatingAfter: true,
          blackRatingBefore: true,
          blackRatingAfter: true,
          white: { select: { id: true, username: true } },
          black: { select: { id: true, username: true } },
          _count: { select: { moves: true } },
        },
      }),
      this.prisma.game.count({ where }),
    ]);

    const data = games.map((game) => ({
      id: game.id,
      white: game.white,
      black: game.black,
      result: this.formatResult(game.result),
      termination: game.termination,
      timeControlType: game.timeControlType,
      timeControl: this.formatTimeControl(game.timeInitialSec, game.timeIncrementSec),
      eco: game.eco,
      totalMoves: game._count.moves,
      createdAt: game.createdAt,
      whiteRatingBefore: game.whiteRatingBefore,
      whiteRatingAfter: game.whiteRatingAfter,
      blackRatingBefore: game.blackRatingBefore,
      blackRatingAfter: game.blackRatingAfter,
    }));

    return {
      data,
      total,
      hasMore: skip + safeTake < total,
    };
  }

  private formatResult(result: string | null): string {
    switch (result) {
      case 'white': return '1-0';
      case 'black': return '0-1';
      case 'draw': return '1/2-1/2';
      default: return '*';
    }
  }

  private formatTimeControl(initialSec: number, incrementSec: number): string {
    const minutes = Math.floor(initialSec / 60);
    return `${minutes}+${incrementSec}`;
  }
}
