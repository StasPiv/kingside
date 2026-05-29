/**
 * KS-3409 / ADR-086 §9 B2. Сервис guess-the-move.
 *
 * Server-trust (ADR-086 §8): движок на сервере НЕ запускается. Клиент
 * присылает WDL-замеры, сервер ПЕРЕСЧИТЫВАЕТ все метрики
 * (loss/accuracy/class/verdict) через `compareGuessMove` (S2) — клиентским
 * accuracy/verdict не доверяем, доверяем только сырым WDL.
 *
 * Агрегаты сессии (score/streak/betterThanPlayerCount/точности)
 * пересчитываются из persisted `guess_moves` — единый источник истины.
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import {
  compareGuessMove,
  aggregateAccuracies,
  type GuessVerdict,
  type PrecisionMoveClass,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import type {
  StartGuessSessionResponse,
  SubmitGuessMoveResponse,
  FinishGuessSessionResponse,
  GetGuessSessionResponse,
  GuessHistoryResponse,
  GuessSessionDto,
  GuessMoveDto,
} from '@kingside/shared';
import type { StartGuessSessionDto, SubmitGuessMoveDto } from './dto/guess.dto';

/** ADR-086 §5. Очки за ход по вердикту. */
const VERDICT_SCORE: Record<GuessVerdict, number> = {
  strongest: 10,
  betterThanPlayer: 7,
  asPlayer: 5,
  weaker: 1,
};

/** Вердикты, считающиеся «успехом» для стрика (≥ уровня игрока). */
const STREAK_OK: ReadonlySet<GuessVerdict> = new Set<GuessVerdict>([
  'strongest',
  'betterThanPlayer',
  'asPlayer',
]);

/** Вердикты «нашёл не хуже / лучше реального» — для betterThanPlayerCount. */
const BETTER_THAN_PLAYER: ReadonlySet<GuessVerdict> = new Set<GuessVerdict>([
  'strongest',
  'betterThanPlayer',
]);

// Минимальная форма prisma-строки guess_move (избегаем зависимости от
// прямого Prisma-типа в сигнатурах).
interface GuessMoveRow {
  ply: number;
  fenBefore: string;
  playedUci: string;
  userUci: string;
  bestUci: string;
  eBefore: number;
  eAfterPlayed: number;
  eAfterUser: number;
  lossPlayer: number;
  lossUser: number;
  accuracyPlayer: number;
  accuracyUser: number;
  userClass: string;
  verdict: string;
}

interface GuessSessionRow {
  id: string;
  userId: string;
  gameSource: string;
  gameRef: string | null;
  pgn: string | null;
  side: string;
  status: string;
  userAccuracy: number | null;
  playerAccuracy: number | null;
  userStars: number | null;
  score: number;
  bestStreak: number;
  betterThanPlayerCount: number;
  startedAt: Date;
  finishedAt: Date | null;
}

@Injectable()
export class GuessService {
  private readonly logger = new Logger(GuessService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── start ────────────────────────────────────────────────────────

  async startSession(
    userId: string,
    dto: StartGuessSessionDto,
  ): Promise<StartGuessSessionResponse> {
    // Ровно один источник: gameRef (archive/own/broadcast) ЛИБО pgn.
    const hasRef = !!dto.gameRef;
    const hasPgn = !!dto.pgn;
    if (dto.gameSource === 'pgn') {
      if (!hasPgn) {
        throw new BadRequestException("gameSource='pgn' requires pgn");
      }
    } else if (!hasRef) {
      throw new BadRequestException(
        `gameSource='${dto.gameSource}' requires gameRef`,
      );
    }

    const session = (await this.prisma.guessSession.create({
      data: {
        userId,
        gameSource: dto.gameSource,
        gameRef: dto.gameRef ?? null,
        pgn: dto.pgn ?? null,
        side: dto.side,
        status: 'active',
      },
    })) as GuessSessionRow;

    return { session: this.toSessionDto(session) };
  }

  // ─── submit move ───────────────────────────────────────────────────

  async submitMove(
    userId: string,
    sessionId: string,
    dto: SubmitGuessMoveDto,
  ): Promise<SubmitGuessMoveResponse> {
    await this.loadOwnedActive(userId, sessionId);

    // Server-trust: пересчёт метрик из присланных WDL через S2.
    const cmp = compareGuessMove(dto.playedUci, dto.userUci, {
      wdlBefore: dto.wdlBefore,
      wdlAfterPlayed: dto.wdlAfterPlayed,
      wdlAfterUser: dto.wdlAfterUser ?? null,
      bestUci: dto.bestUci,
    });

    await this.prisma.guessMove.upsert({
      where: { sessionId_ply: { sessionId, ply: dto.ply } },
      create: {
        sessionId,
        ply: dto.ply,
        fenBefore: dto.fenBefore,
        playedUci: dto.playedUci,
        userUci: dto.userUci,
        bestUci: dto.bestUci,
        eBefore: cmp.eBefore,
        eAfterPlayed: cmp.eAfterPlayed,
        eAfterUser: cmp.eAfterUser,
        lossPlayer: cmp.lossPlayer,
        lossUser: cmp.lossUser,
        accuracyPlayer: cmp.accuracyPlayer,
        accuracyUser: cmp.accuracyUser,
        userClass: cmp.userClass,
        verdict: cmp.verdict,
      },
      update: {
        fenBefore: dto.fenBefore,
        playedUci: dto.playedUci,
        userUci: dto.userUci,
        bestUci: dto.bestUci,
        eBefore: cmp.eBefore,
        eAfterPlayed: cmp.eAfterPlayed,
        eAfterUser: cmp.eAfterUser,
        lossPlayer: cmp.lossPlayer,
        lossUser: cmp.lossUser,
        accuracyPlayer: cmp.accuracyPlayer,
        accuracyUser: cmp.accuracyUser,
        userClass: cmp.userClass,
        verdict: cmp.verdict,
      },
    });

    // Пересчёт агрегатов из ВСЕХ persisted-ходов (единый источник истины).
    const moves = (await this.prisma.guessMove.findMany({
      where: { sessionId },
      orderBy: { ply: 'asc' },
    })) as GuessMoveRow[];

    const score = moves.reduce(
      (acc, m) => acc + (VERDICT_SCORE[m.verdict as GuessVerdict] ?? 0),
      0,
    );
    const currentStreak = this.trailingStreak(moves);
    const bestStreak = this.maxStreak(moves);
    const betterThanPlayerCount = moves.filter((m) =>
      BETTER_THAN_PLAYER.has(m.verdict as GuessVerdict),
    ).length;

    // KS-3429. Live-точности: та же формула aggregateAccuracies, что в
    // finish — user с worst-class cap, player без cap (его classification
    // не храним). При наличии хотя бы одного хода scorePct — number;
    // защитный `?? 0` на крайний случай null от aggregator.
    const currentUserAccuracy =
      aggregateAccuracies(
        moves.map((m) => m.accuracyUser),
        this.worstUserClass(moves),
      ).scorePct ?? 0;
    const currentPlayerAccuracy =
      aggregateAccuracies(
        moves.map((m) => m.accuracyPlayer),
        null,
      ).scorePct ?? 0;

    await this.prisma.guessSession.update({
      where: { id: sessionId },
      data: { score, bestStreak, betterThanPlayerCount },
    });

    return {
      move: this.toMoveDto({
        ply: dto.ply,
        fenBefore: dto.fenBefore,
        playedUci: dto.playedUci,
        userUci: dto.userUci,
        bestUci: dto.bestUci,
        eBefore: cmp.eBefore,
        eAfterPlayed: cmp.eAfterPlayed,
        eAfterUser: cmp.eAfterUser,
        lossPlayer: cmp.lossPlayer,
        lossUser: cmp.lossUser,
        accuracyPlayer: cmp.accuracyPlayer,
        accuracyUser: cmp.accuracyUser,
        userClass: cmp.userClass,
        verdict: cmp.verdict,
      }),
      score,
      currentStreak,
      betterThanPlayerCount,
      currentUserAccuracy,
      currentPlayerAccuracy,
    };
  }

  // ─── finish ────────────────────────────────────────────────────────

  async finish(
    userId: string,
    sessionId: string,
  ): Promise<FinishGuessSessionResponse> {
    const session = await this.loadOwned(userId, sessionId);
    if (session.status === 'finished') {
      // Идемпотентно: уже финализирована — отдаём как есть.
      return {
        session: this.toSessionDto(session),
        outcome: this.outcome(session.userAccuracy, session.playerAccuracy),
      };
    }

    const moves = (await this.prisma.guessMove.findMany({
      where: { sessionId },
      orderBy: { ply: 'asc' },
    })) as GuessMoveRow[];

    // Точность пользователя — композит mean+min с cap по worst-class
    // (переиспуем aggregateAccuracies из precision-score).
    const userAcc = aggregateAccuracies(
      moves.map((m) => m.accuracyUser),
      this.worstUserClass(moves),
    );
    // Точность реального игрока — та же формула, без class-cap (его
    // классификацию не храним; звёзды игроку не присваиваем).
    const playerAcc = aggregateAccuracies(
      moves.map((m) => m.accuracyPlayer),
      null,
    );

    const updated = (await this.prisma.guessSession.update({
      where: { id: sessionId },
      data: {
        status: 'finished',
        userAccuracy: userAcc.scorePct,
        playerAccuracy: playerAcc.scorePct,
        userStars: userAcc.stars,
        finishedAt: new Date(),
      },
    })) as GuessSessionRow;

    return {
      session: this.toSessionDto(updated),
      outcome: this.outcome(userAcc.scorePct, playerAcc.scorePct),
    };
  }

  // ─── review / history ──────────────────────────────────────────────

  async getSession(
    userId: string,
    sessionId: string,
  ): Promise<GetGuessSessionResponse> {
    const session = await this.loadOwned(userId, sessionId);
    const moves = await this.loadMoves(sessionId);
    return {
      session: this.toSessionDto(session),
      moves: moves.map((m) => this.toMoveDto(m)),
    };
  }

  async history(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<GuessHistoryResponse> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safeOffset = Math.max(offset, 0);
    const [rows, total] = await Promise.all([
      this.prisma.guessSession.findMany({
        where: { userId },
        orderBy: { startedAt: 'desc' },
        take: safeLimit,
        skip: safeOffset,
      }),
      this.prisma.guessSession.count({ where: { userId } }),
    ]);
    return {
      // pgn в списке не отдаём (размер); toSessionDto его опускает.
      items: (rows as GuessSessionRow[]).map((s) =>
        this.toSessionDto(s, { includePgn: false }),
      ),
      total,
    };
  }

  // ─── helpers ───────────────────────────────────────────────────────

  private async loadOwned(
    userId: string,
    sessionId: string,
  ): Promise<GuessSessionRow> {
    const session = (await this.prisma.guessSession.findUnique({
      where: { id: sessionId },
    })) as GuessSessionRow | null;
    if (!session) throw new NotFoundException('guess session not found');
    if (session.userId !== userId) {
      throw new ForbiddenException('not your guess session');
    }
    return session;
  }

  private async loadOwnedActive(
    userId: string,
    sessionId: string,
  ): Promise<GuessSessionRow> {
    const session = await this.loadOwned(userId, sessionId);
    if (session.status !== 'active') {
      throw new BadRequestException(
        `session is ${session.status}, not active`,
      );
    }
    return session;
  }

  private async loadMoves(sessionId: string): Promise<GuessMoveRow[]> {
    return (await this.prisma.guessMove.findMany({
      where: { sessionId },
      orderBy: { ply: 'asc' },
    })) as GuessMoveRow[];
  }

  /** Длина «хвостового» стрика успешных ходов (с конца по ply). */
  private trailingStreak(moves: GuessMoveRow[]): number {
    let s = 0;
    for (let i = moves.length - 1; i >= 0; i--) {
      if (STREAK_OK.has(moves[i].verdict as GuessVerdict)) s++;
      else break;
    }
    return s;
  }

  /** Максимальный непрерывный стрик успешных ходов за сессию. */
  private maxStreak(moves: GuessMoveRow[]): number {
    let best = 0;
    let cur = 0;
    for (const m of moves) {
      if (STREAK_OK.has(m.verdict as GuessVerdict)) {
        cur++;
        if (cur > best) best = cur;
      } else {
        cur = 0;
      }
    }
    return best;
  }

  private worstUserClass(moves: GuessMoveRow[]): PrecisionMoveClass | null {
    const order: PrecisionMoveClass[] = [
      'best',
      'good',
      'inaccuracy',
      'mistake',
      'blunder',
    ];
    let idx = -1;
    for (const m of moves) {
      const i = order.indexOf(m.userClass as PrecisionMoveClass);
      if (i > idx) idx = i;
    }
    return idx >= 0 ? order[idx] : null;
  }

  private outcome(
    userAcc: number | null,
    playerAcc: number | null,
  ): 'userBetter' | 'playerBetter' | 'tie' {
    if (userAcc == null || playerAcc == null) return 'tie';
    const diff = userAcc - playerAcc;
    if (Math.abs(diff) < 0.5) return 'tie';
    return diff > 0 ? 'userBetter' : 'playerBetter';
  }

  private toSessionDto(
    s: GuessSessionRow,
    opts: { includePgn?: boolean } = { includePgn: true },
  ): GuessSessionDto {
    return {
      id: s.id,
      gameSource: s.gameSource as GuessSessionDto['gameSource'],
      gameRef: s.gameRef,
      ...(opts.includePgn !== false ? { pgn: s.pgn } : {}),
      side: s.side as GuessSessionDto['side'],
      status: s.status as GuessSessionDto['status'],
      userAccuracy: s.userAccuracy,
      playerAccuracy: s.playerAccuracy,
      userStars: s.userStars,
      score: s.score,
      bestStreak: s.bestStreak,
      betterThanPlayerCount: s.betterThanPlayerCount,
      startedAt: s.startedAt.toISOString(),
      finishedAt: s.finishedAt ? s.finishedAt.toISOString() : null,
    };
  }

  private toMoveDto(m: GuessMoveRow): GuessMoveDto {
    return {
      ply: m.ply,
      fenBefore: m.fenBefore,
      playedUci: m.playedUci,
      userUci: m.userUci,
      bestUci: m.bestUci,
      eBefore: m.eBefore,
      eAfterPlayed: m.eAfterPlayed,
      eAfterUser: m.eAfterUser,
      lossPlayer: m.lossPlayer,
      lossUser: m.lossUser,
      accuracyUser: m.accuracyUser,
      accuracyPlayer: m.accuracyPlayer,
      userClass: m.userClass as GuessMoveDto['userClass'],
      verdict: m.verdict as GuessVerdict,
    };
  }
}
