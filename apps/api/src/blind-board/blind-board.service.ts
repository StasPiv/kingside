/**
 * KS-3441 / ADR-088 §11 B2. Сервис blind-board.
 *
 * Принципы (ADR-088 §5, §10):
 *  - Позиция держится ТОЛЬКО на сервере. Клиенту отдаём агрегаты
 *    (round/streak/bestStreak/status/finishReason) + координаты `{from, to}`
 *    текущего хода компьютера. Никаких типов фигур и FEN наружу.
 *  - Каждый ход компа выбирается так, что после хода ровно ОДНА другая
 *    фигура «вовлечена» (атакует to или атакована); эту вовлечённую
 *    фигуру и должен опознать игрок (`{square, pieceType}`).
 *  - На правильный ответ — она становится target_piece следующего раунда.
 *  - dead-end (нет ходов с |involved|=1 у target_piece) — финал с
 *    `finishReason='dead-end'`, текущий streak засчитывается.
 *  - В M1 обязательная аутентификация: гость без persist (контроллер
 *    под JwtAuthGuard, сервис не публикует guest-ветку).
 *
 * Старт сессии (до 20 попыток): случайные 5 фигур (Q,R,N,B,B) на 5
 * уникальных пустых клетках. Для рандомной target_piece из этой расстановки
 * ищем `findUniqueTargetMoves`; если есть кандидаты — выбираем случайный.
 * Если за 20 попыток валидную стартовую позицию найти не удалось —
 * `ServiceUnavailableException` (крайне маловероятно при правильной
 * рандомизации; ловим в логах).
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  findUniqueTargetMoves,
  type BlindBoardPiece,
  type BlindBoardPieceType,
  type BlindBoardSquare,
  type BlindBoardMove,
  type BlindBoardSessionDto,
  type BlindBoardSessionStatus,
  type BlindBoardFinishReason,
  type StartBlindBoardSessionResponse,
  type SubmitBlindBoardAnswerResponse,
  type BlindBoardLeaderboardResponse,
} from '@kingside/shared';
import { Prisma } from '@kingside/db';
import { PrismaService } from '../prisma/prisma.service';

/** Фигуры стартовой расстановки (ADR-088 §2.1): 1×Q, 1×R, 1×N, 2×B. */
const START_PIECE_TYPES: ReadonlyArray<BlindBoardPieceType> = [
  'Q',
  'R',
  'N',
  'B',
  'B',
];

/** Все 64 клетки доски — для рандомизации стартовой расстановки. */
const ALL_SQUARES: ReadonlyArray<BlindBoardSquare> = (() => {
  const files = 'abcdefgh';
  const out: BlindBoardSquare[] = [];
  for (const f of files) {
    for (let r = 1; r <= 8; r++) {
      out.push(`${f}${r}` as BlindBoardSquare);
    }
  }
  return out;
})();

/** Максимум попыток для генерации валидной стартовой позиции. */
const MAX_START_ATTEMPTS = 20;

/** Минимальная форма prisma-строки `blind_board_sessions`. */
interface BlindBoardSessionRow {
  id: string;
  userId: string | null;
  startPosition: unknown;
  currentPosition: unknown;
  nextTargetPiece: unknown;
  currentCompMove: unknown;
  streak: number;
  bestStreak: number;
  status: string;
  finishReason: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/** Тип для инжектируемого источника случайности (тестируемость). */
export type RandomFn = () => number;

@Injectable()
export class BlindBoardService {
  private readonly logger = new Logger(BlindBoardService.name);
  /** Источник случайности — Math.random в проде, переопределяется в тестах. */
  private random: RandomFn = Math.random;

  constructor(private readonly prisma: PrismaService) {}

  /** Тестовый seam: подменить рандом (в тестах — детерминированный). */
  setRandom(fn: RandomFn): void {
    this.random = fn;
  }

  // ─── start ────────────────────────────────────────────────────────

  async createSession(userId: string): Promise<StartBlindBoardSessionResponse> {
    const start = this.generateValidStart();
    if (!start) {
      this.logger.error(
        `failed to generate valid blind-board start after ${MAX_START_ATTEMPTS} attempts`,
      );
      throw new ServiceUnavailableException(
        'failed to generate blind-board start position',
      );
    }
    const { position, target, compMove, nextInvolved } = start;

    // На активной фазе: позиция уже сделана (target ходит из start на compMove.to);
    // currentPosition = после хода. nextTargetPiece = вовлечённая (которую
    // должен опознать игрок) — именно она станет target в следующем раунде.
    const after = applyMove(position, target.square, compMove.to);

    const created = (await this.prisma.blindBoardSession.create({
      data: {
        userId,
        startPosition: position as unknown as Prisma.InputJsonValue,
        currentPosition: after as unknown as Prisma.InputJsonValue,
        nextTargetPiece: nextInvolved as unknown as Prisma.InputJsonValue,
        currentCompMove: compMove as unknown as Prisma.InputJsonValue,
        streak: 0,
        bestStreak: 0,
        status: 'active',
      },
    })) as unknown as BlindBoardSessionRow;

    // Audit per-round: round=1, expected = nextInvolved.
    await this.prisma.blindBoardAttempt.create({
      data: {
        sessionId: created.id,
        round: 1,
        compMoveFrom: compMove.from,
        compMoveTo: compMove.to,
        expectedSquare: nextInvolved.square,
        expectedPieceType: nextInvolved.type,
        userSquare: null,
        userPieceType: null,
        correct: false,
      },
    });

    return { session: this.toSessionDto(created, 1) };
  }

  // ─── submit answer ─────────────────────────────────────────────────

  async submitAnswer(
    userId: string,
    sessionId: string,
    answer: { square: BlindBoardSquare; pieceType: BlindBoardPieceType },
  ): Promise<SubmitBlindBoardAnswerResponse> {
    const row = await this.loadOwnedActive(userId, sessionId);

    const expected = row.nextTargetPiece as BlindBoardPiece | null;
    const currentMove = row.currentCompMove as BlindBoardMove | null;
    const currentPosition = row.currentPosition as BlindBoardPiece[];
    if (!expected || !currentMove) {
      throw new BadRequestException('session has no pending answer');
    }

    const correct =
      answer.square === expected.square &&
      answer.pieceType === expected.type;

    // Номер ТЕКУЩЕГО раунда (на который пришёл ответ) — последний attempt.
    const attempts = await this.prisma.blindBoardAttempt.findMany({
      where: { sessionId },
      orderBy: { round: 'desc' },
      take: 1,
    });
    const currentRound = attempts[0]?.round ?? 1;

    // Audit: записываем фактический ответ в текущий attempt.
    await this.prisma.blindBoardAttempt.updateMany({
      where: { sessionId, round: currentRound },
      data: {
        userSquare: answer.square,
        userPieceType: answer.pieceType,
        correct,
      },
    });

    if (!correct) {
      const finished = (await this.prisma.blindBoardSession.update({
        where: { id: sessionId },
        data: {
          status: 'finished',
          finishReason: 'wrong-answer',
          finishedAt: new Date(),
          // Анти-чит: после финала «текущий ход» больше не актуален.
          currentCompMove: Prisma.DbNull,
          nextTargetPiece: Prisma.DbNull,
        },
      })) as unknown as BlindBoardSessionRow;
      await this.maybeUpdateUserBestStreak(userId, finished.bestStreak);
      return {
        correct: false,
        expectedSquare: expected.square,
        expectedPieceType: expected.type,
        revealedPosition: row.startPosition as BlindBoardPiece[],
        session: this.toSessionDto(finished, currentRound),
      };
    }

    // Правильно. Опознанная фигура (expected) становится target для
    // следующего раунда. Ищем ход с |involved|=1.
    const newStreak = row.streak + 1;
    const newBest = Math.max(row.bestStreak, newStreak);
    const candidates = findUniqueTargetMoves(currentPosition, expected.square);

    if (candidates.length === 0) {
      // dead-end: текущая серия засчитывается.
      const finished = (await this.prisma.blindBoardSession.update({
        where: { id: sessionId },
        data: {
          status: 'finished',
          finishReason: 'dead-end',
          finishedAt: new Date(),
          streak: newStreak,
          bestStreak: newBest,
          currentCompMove: Prisma.DbNull,
          nextTargetPiece: Prisma.DbNull,
        },
      })) as unknown as BlindBoardSessionRow;
      await this.maybeUpdateUserBestStreak(userId, finished.bestStreak);
      return {
        correct: true,
        revealedPosition: currentPosition,
        session: this.toSessionDto(finished, currentRound),
      };
    }

    // Выбираем ход случайно из кандидатов.
    const pick = candidates[this.randInt(candidates.length)];
    const nextCompMove: BlindBoardMove = {
      from: expected.square,
      to: pick.to,
    };
    const nextPosition = applyMove(currentPosition, expected.square, pick.to);
    const nextInvolved = pick.target;

    const nextRound = currentRound + 1;
    const updated = (await this.prisma.blindBoardSession.update({
      where: { id: sessionId },
      data: {
        currentPosition: nextPosition as unknown as Prisma.InputJsonValue,
        currentCompMove: nextCompMove as unknown as Prisma.InputJsonValue,
        nextTargetPiece: nextInvolved as unknown as Prisma.InputJsonValue,
        streak: newStreak,
        bestStreak: newBest,
      },
    })) as unknown as BlindBoardSessionRow;

    await this.prisma.blindBoardAttempt.create({
      data: {
        sessionId,
        round: nextRound,
        compMoveFrom: nextCompMove.from,
        compMoveTo: nextCompMove.to,
        expectedSquare: nextInvolved.square,
        expectedPieceType: nextInvolved.type,
        userSquare: null,
        userPieceType: null,
        correct: false,
      },
    });

    return {
      correct: true,
      session: this.toSessionDto(updated, nextRound),
    };
  }

  // ─── leaderboard ──────────────────────────────────────────────────

  async leaderboard(limit = 20): Promise<BlindBoardLeaderboardResponse> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    // Топ по User.blindBoardBestStreak. achievedAt — finishedAt последней
    // сессии, в которой best был достигнут. Для простоты в M1 берём
    // последний finishedAt пользователя (если best ≥ 1) — UI это явно
    // помечает как «дата достижения».
    const users = (await this.prisma.user.findMany({
      where: {
        blindBoardBestStreak: { gt: 0 },
        username: { not: null },
      },
      orderBy: { blindBoardBestStreak: 'desc' },
      take: safeLimit,
      select: {
        id: true,
        username: true,
        blindBoardBestStreak: true,
      },
    })) as ReadonlyArray<{
      id: string;
      username: string | null;
      blindBoardBestStreak: number;
    }>;

    if (users.length === 0) return { entries: [] };

    // Для каждого пользователя берём дату последней finished сессии с
    // streak ≥ его best (точка достижения рекорда). Если такой нет —
    // первый старт.
    const entries = await Promise.all(
      users.map(async (u) => {
        const session = await this.prisma.blindBoardSession.findFirst({
          where: {
            userId: u.id,
            status: 'finished',
            bestStreak: u.blindBoardBestStreak,
          },
          orderBy: { finishedAt: 'desc' },
          select: { finishedAt: true },
        });
        return {
          userId: u.id,
          username: u.username ?? 'Anonymous',
          bestStreak: u.blindBoardBestStreak,
          achievedAt: (session?.finishedAt ?? new Date()).toISOString(),
        };
      }),
    );

    return { entries };
  }

  // ─── helpers ───────────────────────────────────────────────────────

  private async loadOwned(
    userId: string,
    sessionId: string,
  ): Promise<BlindBoardSessionRow> {
    const row = (await this.prisma.blindBoardSession.findUnique({
      where: { id: sessionId },
    })) as unknown as BlindBoardSessionRow | null;
    if (!row) throw new NotFoundException('blind-board session not found');
    if (row.userId !== userId) {
      throw new ForbiddenException('not your blind-board session');
    }
    return row;
  }

  private async loadOwnedActive(
    userId: string,
    sessionId: string,
  ): Promise<BlindBoardSessionRow> {
    const row = await this.loadOwned(userId, sessionId);
    if (row.status !== 'active') {
      throw new BadRequestException(
        `session is ${row.status}, not active`,
      );
    }
    return row;
  }

  /** Обновляет User.blindBoardBestStreak, если новый > сохранённого. */
  private async maybeUpdateUserBestStreak(
    userId: string,
    candidate: number,
  ): Promise<void> {
    if (candidate <= 0) return;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { blindBoardBestStreak: true },
    });
    if (!user) return;
    if (candidate > user.blindBoardBestStreak) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { blindBoardBestStreak: candidate },
      });
    }
  }

  /**
   * Генерация валидной стартовой расстановки + первого хода компа.
   * До MAX_START_ATTEMPTS попыток. Возвращает null если не получилось.
   */
  generateValidStart(): {
    position: BlindBoardPiece[];
    target: BlindBoardPiece;
    compMove: BlindBoardMove;
    nextInvolved: BlindBoardPiece;
  } | null {
    for (let i = 0; i < MAX_START_ATTEMPTS; i++) {
      const position = this.randomStartPosition();
      // Перебор target в случайном порядке (по shuffled индексам).
      const idxs = this.shuffleIndices(position.length);
      for (const idx of idxs) {
        const target = position[idx];
        const cands = findUniqueTargetMoves(position, target.square);
        if (cands.length === 0) continue;
        const pick = cands[this.randInt(cands.length)];
        return {
          position,
          target,
          compMove: { from: target.square, to: pick.to },
          nextInvolved: pick.target,
        };
      }
    }
    return null;
  }

  /** Случайная расстановка 5 фигур (Q,R,N,B,B) на 5 уникальных клетках. */
  private randomStartPosition(): BlindBoardPiece[] {
    const pool = ALL_SQUARES.slice();
    // Шаффл-первых-5 (партиальный Fisher–Yates).
    for (let i = 0; i < START_PIECE_TYPES.length; i++) {
      const j = i + this.randInt(pool.length - i);
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return START_PIECE_TYPES.map((type, i) => ({
      square: pool[i],
      type,
    }));
  }

  /** Случайный int [0..n). */
  private randInt(n: number): number {
    return Math.floor(this.random() * n);
  }

  /** Перемешанный массив индексов 0..n-1. */
  private shuffleIndices(n: number): number[] {
    const a = Array.from({ length: n }, (_, i) => i);
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.randInt(i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  private toSessionDto(
    row: BlindBoardSessionRow,
    round: number,
  ): BlindBoardSessionDto {
    return {
      id: row.id,
      status: row.status as BlindBoardSessionStatus,
      finishReason: (row.finishReason ?? null) as BlindBoardFinishReason | null,
      round,
      streak: row.streak,
      bestStreak: row.bestStreak,
      nextMove: (row.currentCompMove as BlindBoardMove | null) ?? null,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    };
  }
}

/** Применить ход в позиции: перенести фигуру `from → to`. */
function applyMove(
  position: BlindBoardPiece[],
  from: BlindBoardSquare,
  to: BlindBoardSquare,
): BlindBoardPiece[] {
  return position.map((p) =>
    p.square === from ? { square: to, type: p.type } : p,
  );
}
