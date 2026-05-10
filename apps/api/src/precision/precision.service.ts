/**
 * KS-2718 / ADR-056 §5 B5–B6. Precision-метрики Уровня А и детали
 * одной попытки для PostGameReview.
 *
 * Таблицы (KS-2717):
 *   - `puzzle_attempts` — один к одному с `precision_attempts`.
 *   - `precision_attempts` — агрегаты PVE-попытки.
 *   - `precision_attempt_moves` — per-move детали.
 */
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  PrecisionAttemptDetail,
  PrecisionStatsResponse,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrecisionService {
  private readonly logger = new Logger(PrecisionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Уровень А (ADR-056 §2.1): top-блок `/precision` страницы.
   * `since` — опц. ISO-date для фильтрации «за период».
   */
  async getStatsForUser(
    userId: string,
    since?: Date,
  ): Promise<PrecisionStatsResponse> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Базовый фильтр: PVE-attempts текущего пользователя.
    // Через relation puzzle.solutionMode='play-vs-engine' (KS-2716/B1
    // подтвердил что relation-фильтр работает корректно).
    const baseFilter: {
      userId: string;
      puzzle: { is: { solutionMode: 'play-vs-engine' } };
      createdAt?: { gte?: Date };
    } = {
      userId,
      puzzle: { is: { solutionMode: 'play-vs-engine' } },
    };
    if (since) {
      baseFilter.createdAt = { gte: since };
    }

    // Counters по puzzle_attempts.
    const [totalAttempts, preservedCount, todayAttempts, todayPreserved] =
      await Promise.all([
        this.prisma.puzzleAttempt.count({ where: baseFilter }),
        this.prisma.puzzleAttempt.count({
          where: { ...baseFilter, solved: true },
        }),
        this.prisma.puzzleAttempt.count({
          where: {
            userId,
            puzzle: { is: { solutionMode: 'play-vs-engine' } },
            createdAt: { gte: today },
          },
        }),
        this.prisma.puzzleAttempt.count({
          where: {
            userId,
            puzzle: { is: { solutionMode: 'play-vs-engine' } },
            createdAt: { gte: today },
            solved: true,
          },
        }),
      ]);

    const lostCount = Math.max(0, totalAttempts - preservedCount);
    const preservedRate =
      totalAttempts > 0 ? preservedCount / totalAttempts : 0;

    // Аггрегаты по precision_attempts: AVG(accuracy), AVG(wdlLeak/halfMoves),
    // AVG(firstMistakePly).
    //
    // Связь PrecisionAttempt → PuzzleAttempt 1:1 через attemptId. Чтобы
    // фильтровать по userId + since + solutionMode (PVE), идём через
    // relation `attempt`.
    const precisionFilter: {
      attempt: {
        userId: string;
        puzzle: { is: { solutionMode: 'play-vs-engine' } };
        createdAt?: { gte: Date };
      };
    } = {
      attempt: {
        userId,
        puzzle: { is: { solutionMode: 'play-vs-engine' } },
      },
    };
    if (since) {
      precisionFilter.attempt.createdAt = { gte: since };
    }

    const [accuracyAgg, leakRows, firstMistakeAgg] = await Promise.all([
      this.prisma.precisionAttempt.aggregate({
        where: precisionFilter,
        _avg: { accuracyPercent: true },
      }),
      // wdlLeakSum / halfMovesPlayed — нужно посчитать как ratio, не
      // SUM/SUM (иначе попытки с разной длиной зазвешиваются по
      // длине). По ADR-056 §2.1 формула — `Σ(wdlBefore-wdlAfter) /
      // totalUserMoves`. Это эквивалентно AVG(leakSum/halfMovesPlayed)
      // взвешенному по halfMovesPlayed; для простоты усредняем
      // плоским `AVG`, метрика — оценочная.
      this.prisma.precisionAttempt.findMany({
        where: { ...precisionFilter, halfMovesPlayed: { gt: 0 } },
        select: { wdlLeakSum: true, halfMovesPlayed: true },
      }),
      this.prisma.precisionAttempt.aggregate({
        where: { ...precisionFilter, firstMistakePly: { not: null } },
        _avg: { firstMistakePly: true },
      }),
    ]);

    let avgWdlLeakPerMove = 0;
    if (leakRows.length > 0) {
      let totalLeak = 0;
      let totalMoves = 0;
      for (const r of leakRows) {
        totalLeak += r.wdlLeakSum;
        totalMoves += r.halfMovesPlayed;
      }
      avgWdlLeakPerMove = totalMoves > 0 ? totalLeak / totalMoves : 0;
    }

    return {
      totalAttempts,
      preservedCount,
      lostCount,
      preservedRate,
      avgAccuracyPercent: accuracyAgg._avg.accuracyPercent ?? 0,
      avgWdlLeakPerMove,
      avgHalfMovesUntilFirstMistake:
        firstMistakeAgg._avg.firstMistakePly ?? null,
      todayAttempts,
      todayPreserved,
    };
  }

  /**
   * Уровень Б (ADR-056 §2.2): детали одной PVE-попытки.
   *
   * Доступ: только владелец attempt'а или админ. 404 если attempt
   * не существует или это не PVE.
   */
  async getAttemptDetail(
    attemptId: string,
    requestingUserId: string,
    isAdmin: boolean,
  ): Promise<PrecisionAttemptDetail> {
    const attempt = await this.prisma.puzzleAttempt.findUnique({
      where: { id: attemptId },
      include: {
        precisionAttempt: { include: { moves: { orderBy: { ply: 'asc' } } } },
        puzzle: { select: { id: true, solutionMode: true } },
      },
    });

    if (!attempt || !attempt.precisionAttempt) {
      throw new NotFoundException(`Precision attempt ${attemptId} not found`);
    }
    if (attempt.puzzle.solutionMode !== 'play-vs-engine') {
      throw new NotFoundException(
        `Attempt ${attemptId} is not a play-vs-engine attempt`,
      );
    }
    if (!isAdmin && attempt.userId !== requestingUserId) {
      throw new ForbiddenException(
        'You do not have access to this precision attempt',
      );
    }

    const pa = attempt.precisionAttempt;
    return {
      attemptId: attempt.id,
      puzzleId: attempt.puzzleId,
      attemptedAt: attempt.createdAt.toISOString(),
      solved: attempt.solved,
      endReason: pa.endReason,
      halfMovesPlayed: pa.halfMovesPlayed,
      halfMovesTarget: pa.halfMovesTarget,
      accuracyPercent: pa.accuracyPercent,
      classCounts: {
        best: pa.bestMovesCount,
        good: pa.goodMovesCount,
        inaccuracy: pa.inaccuraciesCount,
        mistake: pa.mistakesCount,
        blunder: pa.blundersCount,
      },
      wdlAtStart: pa.wdlAtStartSigned,
      wdlAtEnd: pa.wdlAtEndSigned,
      wdlLeakSum: pa.wdlLeakSum,
      firstMistakePly: pa.firstMistakePly,
      moves: pa.moves.map((m) => ({
        ply: m.ply,
        fenBefore: m.fenBefore,
        playedUci: m.playedUci,
        bestUci: m.bestUci,
        cpBefore: m.cpBefore,
        cpAfter: m.cpAfter,
        // Преобразуем W/D/L per-mille → signed [-1..+1] от лица
        // решающего/предыдущего хода. Это удобнее для фронта.
        wdlBefore: signedFromTriple(m.wdlBeforeW, m.wdlBeforeL),
        wdlAfter: signedFromTriple(m.wdlAfterW, m.wdlAfterL),
        depth: m.depth,
        classification: m.classification as PrecisionAttemptDetail['moves'][number]['classification'],
      })),
    };
  }
}

function signedFromTriple(
  w: number | null,
  l: number | null,
): number | null {
  if (w == null || l == null) return null;
  return (w - l) / 1000;
}
