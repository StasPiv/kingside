import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ProtectionResult {
  allowed: boolean;
  reason?: string;
}

const MAX_PAIR_GAMES_PER_DAY = 3;
const SANDBAGGING_WINDOW = 20;
const SANDBAGGING_LOSS_THRESHOLD = 15;
const SANDBAGGING_SHORT_GAME_MOVES = 10;
const BOOSTING_WINDOW_HOURS = 24;
const BOOSTING_PAIR_GAME_THRESHOLD = 6;
const BOOSTING_ONE_SIDED_RATIO = 0.85;

@Injectable()
export class RatingProtectionService {
  private readonly logger = new Logger(RatingProtectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async validateGame(gameId: string): Promise<ProtectionResult> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: {
        id: true,
        whiteId: true,
        blackId: true,
        result: true,
        termination: true,
        timeControlType: true,
        moves: { select: { id: true } },
      },
    });

    const moveCount = game.moves.length;

    const minMovesResult = this.checkMinimumMoves(
      moveCount,
      game.termination,
    );
    if (!minMovesResult.allowed) {
      this.logSuspiciousPattern(gameId, game.whiteId, game.blackId, minMovesResult.reason!);
      return minMovesResult;
    }

    const pairResult = await this.checkPairLimit(
      game.whiteId,
      game.blackId,
      gameId,
    );
    if (!pairResult.allowed) {
      this.logSuspiciousPattern(gameId, game.whiteId, game.blackId, pairResult.reason!);
    }

    const loserId = game.result === 'white' ? game.blackId : game.result === 'black' ? game.whiteId : null;
    if (loserId) {
      const sandbagging = await this.detectSandbagging(loserId);
      if (sandbagging) {
        this.logSuspiciousPattern(gameId, game.whiteId, game.blackId, `sandbagging detected for ${loserId}`);
      }
    }

    const boosting = await this.detectBoosting(game.whiteId, game.blackId);
    if (boosting) {
      this.logSuspiciousPattern(gameId, game.whiteId, game.blackId, 'boosting pattern detected');
    }

    return { allowed: true };
  }

  checkMinimumMoves(
    _moveCount: number,
    _termination: string | null,
  ): ProtectionResult {
    return { allowed: true };
  }

  async checkPairLimit(
    whiteId: string,
    blackId: string,
    currentGameId: string,
  ): Promise<ProtectionResult> {
    const since = new Date();
    since.setHours(since.getHours() - 24);

    const recentPairGames = await this.prisma.game.count({
      where: {
        id: { not: currentGameId },
        status: 'finished',
        isBot: false,
        finishedAt: { gte: since },
        whiteRatingAfter: { not: null },
        OR: [
          { whiteId, blackId },
          { whiteId: blackId, blackId: whiteId },
        ],
      },
    });

    if (recentPairGames >= MAX_PAIR_GAMES_PER_DAY) {
      this.logger.warn(
        `Pair limit: white=${whiteId} black=${blackId} recentGames=${recentPairGames} limit=${MAX_PAIR_GAMES_PER_DAY}`,
      );
      return {
        allowed: false,
        reason: `pair limit exceeded (${recentPairGames + 1}/${MAX_PAIR_GAMES_PER_DAY})`,
      };
    }

    return { allowed: true };
  }

  async detectSandbagging(playerId: string): Promise<boolean> {
    const recentGames = await this.prisma.game.findMany({
      where: {
        status: 'finished',
        isBot: false,
        OR: [{ whiteId: playerId }, { blackId: playerId }],
      },
      orderBy: { finishedAt: 'desc' },
      take: SANDBAGGING_WINDOW,
      select: {
        whiteId: true,
        result: true,
        termination: true,
        moves: { select: { id: true } },
      },
    });

    if (recentGames.length < SANDBAGGING_WINDOW) return false;

    let shortLosses = 0;
    for (const game of recentGames) {
      const isWhite = game.whiteId === playerId;
      const lost = (isWhite && game.result === 'black') || (!isWhite && game.result === 'white');
      const isShort = game.moves.length < SANDBAGGING_SHORT_GAME_MOVES;
      const isResignOrTimeout = game.termination === 'resignation' || game.termination === 'timeout';

      if (lost && isShort && isResignOrTimeout) {
        shortLosses++;
      }
    }

    return shortLosses >= SANDBAGGING_LOSS_THRESHOLD;
  }

  async detectBoosting(
    whiteId: string,
    blackId: string,
  ): Promise<boolean> {
    const since = new Date();
    since.setHours(since.getHours() - BOOSTING_WINDOW_HOURS);

    const pairGames = await this.prisma.game.findMany({
      where: {
        status: 'finished',
        isBot: false,
        finishedAt: { gte: since },
        OR: [
          { whiteId, blackId },
          { whiteId: blackId, blackId: whiteId },
        ],
      },
      select: {
        whiteId: true,
        result: true,
      },
    });

    if (pairGames.length < BOOSTING_PAIR_GAME_THRESHOLD) return false;

    let winsForPlayer1 = 0;
    for (const game of pairGames) {
      const player1IsWhite = game.whiteId === whiteId;
      if (
        (player1IsWhite && game.result === 'white') ||
        (!player1IsWhite && game.result === 'black')
      ) {
        winsForPlayer1++;
      }
    }

    const ratio = winsForPlayer1 / pairGames.length;
    return ratio >= BOOSTING_ONE_SIDED_RATIO || ratio <= 1 - BOOSTING_ONE_SIDED_RATIO;
  }

  private logSuspiciousPattern(
    gameId: string,
    whiteId: string,
    blackId: string,
    reason: string,
  ): void {
    this.logger.warn(
      `Rating protection: game=${gameId} white=${whiteId} black=${blackId} reason="${reason}"`,
    );
  }
}
