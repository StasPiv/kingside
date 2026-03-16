import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { EcoService } from '../game/eco.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
    private readonly eco: EcoService,
  ) {}

  private readonly SETTINGS_SELECT = {
    id: true,
    locale: true,
    boardTheme: true,
    pieceSet: true,
    soundEnabled: true,
  } as const;

  async checkUsername(username: string): Promise<{ available: boolean }> {
    const existing = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    return { available: !existing };
  }

  async setUsername(userId: string, username: string) {
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      throw new BadRequestException('Invalid username format');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, requiresUsernameSetup: true },
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    if (!user.requiresUsernameSetup) {
      throw new BadRequestException('Username already set');
    }

    const conflict = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });

    if (conflict) {
      throw new ConflictException('Username already taken');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { username, requiresUsernameSetup: false },
      select: {
        id: true,
        username: true,
        email: true,
        requiresUsernameSetup: true,
        ratingBullet: true,
        ratingBlitz: true,
        ratingRapid: true,
        ratingClassical: true,
        createdAt: true,
      },
    });

    return updated;
  }

  async getSettings(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: this.SETTINGS_SELECT,
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    return user;
  }

  async updateSettings(userId: string, dto: UpdateSettingsDto) {
    const data: Record<string, unknown> = {};
    if (dto.locale !== undefined) data.locale = dto.locale;
    if (dto.boardTheme !== undefined) data.boardTheme = dto.boardTheme;
    if (dto.pieceSet !== undefined) data.pieceSet = dto.pieceSet;
    if (dto.soundEnabled !== undefined) data.soundEnabled = dto.soundEnabled;

    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: this.SETTINGS_SELECT,
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

    if (!user.passwordHash) {
      throw new UnauthorizedException(
        this.i18n.t('messages.user.wrongPassword'),
      );
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

  async getUserGames(
    userId: string,
    filters: {
      opponent?: string;
      color?: 'white' | 'black';
      result?: 'win' | 'loss' | 'draw';
      eco?: string;
      dateFrom?: string;
      dateTo?: string;
      take?: number;
      skip?: number;
    } = {},
  ) {
    const {
      opponent, color, result, eco, dateFrom, dateTo,
      take = 20, skip = 0,
    } = filters;
    const safeTake = Math.min(take, 50);

    const where: Record<string, any> = { status: 'finished' };

    // Color filter: user played as white or black
    if (color === 'white') {
      where.whiteId = userId;
    } else if (color === 'black') {
      where.blackId = userId;
    } else {
      where.OR = [{ whiteId: userId }, { blackId: userId }];
    }

    // Opponent filter: search by username (case-insensitive)
    if (opponent) {
      const opponentCondition = {
        username: { contains: opponent, mode: 'insensitive' as const },
      };
      if (color === 'white') {
        where.black = opponentCondition;
      } else if (color === 'black') {
        where.white = opponentCondition;
      } else {
        where.AND = [
          {
            OR: [
              { white: opponentCondition },
              { black: opponentCondition },
            ],
          },
        ];
      }
    }

    // Result filter relative to the user
    if (result) {
      if (result === 'draw') {
        where.result = 'draw';
      } else if (result === 'win') {
        const winConditions = [
          { whiteId: userId, result: 'white' },
          { blackId: userId, result: 'black' },
        ];
        where.AND = [...(where.AND || []), { OR: winConditions }];
      } else if (result === 'loss') {
        const lossConditions = [
          { whiteId: userId, result: 'black' },
          { blackId: userId, result: 'white' },
        ];
        where.AND = [...(where.AND || []), { OR: lossConditions }];
      }
    }

    // ECO code filter
    if (eco) {
      where.eco = { startsWith: eco, mode: 'insensitive' };
    }

    // Date range filter
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    const [games, total] = await Promise.all([
      this.prisma.game.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: safeTake,
        skip,
        select: {
          id: true,
          whiteId: true,
          blackId: true,
          result: true,
          termination: true,
          timeControlType: true,
          timeInitialSec: true,
          timeIncrementSec: true,
          eco: true,
          createdAt: true,
          finishedAt: true,
          whiteRatingBefore: true,
          whiteRatingAfter: true,
          blackRatingBefore: true,
          blackRatingAfter: true,
          white: { select: { id: true, username: true } },
          black: { select: { id: true, username: true } },
          moves: {
            orderBy: { moveNumber: 'asc' },
            take: 20,
            select: { san: true },
          },
          _count: { select: { moves: true } },
        },
      }),
      this.prisma.game.count({ where }),
    ]);

    const data = games.map((game) => {
      const isWhite = game.whiteId === userId;
      const playerColor = isWhite ? 'white' : 'black';
      const gameOpponent = isWhite ? game.black : game.white;
      const opponentRatingBefore = isWhite
        ? game.blackRatingBefore
        : game.whiteRatingBefore;

      const sanMoves = game.moves.map((m: { san: string }) => m.san);
      const opening = this.eco.classify(sanMoves);

      let playerResult: 'win' | 'loss' | 'draw' | null;
      if (game.result === null) {
        playerResult = null;
      } else if (game.result === 'draw') {
        playerResult = 'draw';
      } else if (game.result === playerColor) {
        playerResult = 'win';
      } else {
        playerResult = 'loss';
      }

      return {
        id: game.id,
        playerColor,
        playerResult,
        opponent: {
          id: gameOpponent.id,
          username: gameOpponent.username,
          ratingBefore: opponentRatingBefore,
        },
        ecoCode: opening.code,
        openingName: opening.name,
        result: this.formatPlayerResult(playerResult),
        termination: game.termination,
        timeControlType: game.timeControlType,
        timeControl: this.formatTimeControl(game.timeInitialSec, game.timeIncrementSec),
        totalMoves: game._count.moves,
        createdAt: game.createdAt,
        finishedAt: game.finishedAt,
        whiteRatingBefore: game.whiteRatingBefore,
        whiteRatingAfter: game.whiteRatingAfter,
        blackRatingBefore: game.blackRatingBefore,
        blackRatingAfter: game.blackRatingAfter,
      };
    });

    return {
      data,
      total,
      hasMore: skip + safeTake < total,
    };
  }

  private formatPlayerResult(playerResult: 'win' | 'loss' | 'draw' | null): string {
    switch (playerResult) {
      case 'win': return '1-0';
      case 'loss': return '0-1';
      case 'draw': return '1/2-1/2';
      default: return '*';
    }
  }

  private formatTimeControl(initialSec: number, incrementSec: number): string {
    const minutes = Math.floor(initialSec / 60);
    return `${minutes}+${incrementSec}`;
  }
}
