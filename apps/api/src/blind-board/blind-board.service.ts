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
  BLIND_BOARD_LIMITS,
  DEFAULT_BLIND_BOARD_CONFIG,
  type UniqueTargetMove,
  type BlindBoardPiece,
  type BlindBoardPieceType,
  type BlindBoardSquare,
  type BlindBoardMove,
  type BlindBoardConfig,
  type BlindBoardSessionDto,
  type BlindBoardSessionStatus,
  type BlindBoardFinishReason,
  type StartBlindBoardSessionResponse,
  type SubmitBlindBoardAnswerResponse,
  type BlindBoardLeaderboardResponse,
  type BlindBoardStatsResponse,
  type BlindBoardTrendsResponse,
  type BlindBoardBreakdownsResponse,
  type BlindBoardHistoryResponse,
  type BlindBoardSessionReviewResponse,
  type BlindBoardAttemptDto,
  type StatsTrendsBucket,
} from '@kingside/shared';
import { Prisma } from '@kingside/db';
import { PrismaService } from '../prisma/prisma.service';

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

/**
 * KS-3519. Сколько предыдущих compMove'ов учитывать как «недавно
 * посещённые» при выборе следующего хода. 3 — достаточно чтобы
 * отсечь immediate back-and-forth (A→B→A) и короткие циклы (A→B→C→A).
 * Больше тянуть бессмысленно: позиций мало, фильтр слишком агрессивный.
 */
const RECENT_HISTORY_LEN = 3;

/** Минимальная форма prisma-строки `blind_board_sessions`. */
interface BlindBoardSessionRow {
  id: string;
  userId: string | null;
  startPosition: unknown;
  currentPosition: unknown;
  nextTargetPiece: unknown;
  currentCompMove: unknown;
  /** KS-3485. Snapshot конфига на момент старта. */
  startConfig: unknown;
  /** KS-3485. Текущий уровень сессии (≥1). */
  level: number;
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

  async createSession(
    userId: string,
    inputConfig?: BlindBoardConfig,
  ): Promise<StartBlindBoardSessionResponse> {
    // KS-3486: применяем DEFAULT когда клиент не прислал config; иначе
    // валидируем переданный (квоты, длины, memorizeTimeSec).
    const config = inputConfig ?? DEFAULT_BLIND_BOARD_CONFIG;
    this.validateConfig(config);

    const start = this.generateValidStart(config.startPieces);
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
        // KS-3485: snapshot конфига и стартовый уровень.
        startConfig: config as unknown as Prisma.InputJsonValue,
        level: 1,
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

    // KS-3448: клиенту нужна стартовая расстановка для фазы memorize.
    // Это единственный момент, когда сервер раскрывает позицию: дальше
    // в /answer currentPosition остаётся скрыт (анти-чит §5).
    return {
      session: this.toSessionDto(created, 1),
      startPosition: position,
      level: 1,
      config,
    };
  }

  /**
   * KS-3486. Валидация конфига (квоты по типам, минимум/максимум фигур,
   * memorizeTimeSec из whitelist). Бросает BadRequest с понятным
   * сообщением — клиент видит конкретное нарушение.
   */
  private validateConfig(config: BlindBoardConfig): void {
    const { startPieces, addOrder, memorizeTimeSec } = config;
    if (!Array.isArray(startPieces) || !Array.isArray(addOrder)) {
      throw new BadRequestException('config.startPieces and config.addOrder must be arrays');
    }
    if (startPieces.length < BLIND_BOARD_LIMITS.minStart) {
      throw new BadRequestException(
        `config.startPieces requires at least ${BLIND_BOARD_LIMITS.minStart} pieces`,
      );
    }
    const total = startPieces.length + addOrder.length;
    if (total > BLIND_BOARD_LIMITS.maxTotal) {
      throw new BadRequestException(
        `config: startPieces+addOrder total ${total} exceeds maxTotal ${BLIND_BOARD_LIMITS.maxTotal}`,
      );
    }
    if (startPieces.length > BLIND_BOARD_LIMITS.maxTotal) {
      throw new BadRequestException(
        `config.startPieces ${startPieces.length} exceeds maxTotal ${BLIND_BOARD_LIMITS.maxTotal}`,
      );
    }
    // Квоты по типам — считаем суммарно (start + add), не должны быть
    // превышены ни при старте, ни на финальном level-up.
    const counts: Record<BlindBoardPieceType, number> = { Q: 0, R: 0, B: 0, N: 0 };
    for (const t of [...startPieces, ...addOrder]) {
      if (!isPieceType(t)) {
        throw new BadRequestException(`config: invalid piece type '${t}'`);
      }
      counts[t]++;
    }
    for (const t of Object.keys(counts) as BlindBoardPieceType[]) {
      const cap = BLIND_BOARD_LIMITS.maxByType[t];
      if (counts[t] > cap) {
        throw new BadRequestException(
          `config: type ${t} count ${counts[t]} exceeds quota ${cap}`,
        );
      }
    }
    // memorizeTimeSec — whitelist.
    if (
      !(BLIND_BOARD_LIMITS.memorizeOptions as readonly number[]).includes(
        memorizeTimeSec,
      )
    ) {
      throw new BadRequestException(
        `config.memorizeTimeSec ${memorizeTimeSec} not in ${BLIND_BOARD_LIMITS.memorizeOptions.join('/')}`,
      );
    }
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
    // KS-3519 + KS-3527 fix. Тянем последние N attempts для recentMoves.
    //
    // Ранее (buggy) брали N+1 и `.slice(1, 1+N)` — пропуская
    // currentRound. Но currentRound's compMove — это РОВНО предыдущий
    // ход (тот, на который только что ответил пользователь). При выборе
    // СЛЕДУЮЩЕГО compMove'а он — самый свежий «previous mover».
    // Пропускали его → previousMoverSquare указывал на round R-1, и
    // фильтр KS-3524 пропускал реального previous mover'а. Подтверждено
    // на сессии пользователя Stanislav (KS-3527): Q ходила в раундах
    // 3,7,8,9,10 подряд + r10 g2→g6 был ещё и анти-возвратом (g6
    // — откуда Q ушла в r9).
    const attempts = await this.prisma.blindBoardAttempt.findMany({
      where: { sessionId },
      orderBy: { round: 'desc' },
      take: RECENT_HISTORY_LEN,
    });
    const currentRound = attempts[0]?.round ?? 1;
    // chronological asc: самый старый первый, currentRound последний.
    // recentMoves[last] = ход который СЕЙЧАС обыгрывает пользователь.
    const recentMoves: Array<{ from: BlindBoardSquare; to: BlindBoardSquare }> =
      attempts
        .map((a) => ({
          from: a.compMoveFrom as BlindBoardSquare,
          to: a.compMoveTo as BlindBoardSquare,
        }))
        .reverse();

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

    // Правильно. Ищем следующий ход компа.
    // KS-3453: игра бесконечная. Сначала пробуем ту фигуру, которую
    // игрок опознал (expected) — это «логичное продолжение». Если у неё
    // нет валидного хода (|involved|=1 + novelty) — fallback на любую
    // другую из оставшихся в случайном порядке.
    const newStreak = row.streak + 1;
    const newBest = Math.max(row.bestStreak, newStreak);

    // KS-3487 (ADR-088 V2 §15). Level-up на каждый 10-й правильный
    // streak. ДО pickNextCompMove: добавляем новую фигуру в
    // currentPosition (если addOrder не исчерпан) — следующий ход
    // компа выбирается уже в расширенной позиции.
    const currentLevel = row.level ?? 1;
    let newLevel = currentLevel;
    let levelUp: SubmitBlindBoardAnswerResponse['levelUp'];
    let positionForNextMove = currentPosition;

    if (newStreak > 0 && newStreak % 10 === 0) {
      const startConfig = row.startConfig as BlindBoardConfig | null;
      const addOrder = startConfig?.addOrder ?? [];
      const addIdx = currentLevel - 1; // level=1 → addOrder[0], level=2 → addOrder[1] и т.д.
      if (addIdx < addOrder.length) {
        const newPiece = addOrder[addIdx];
        const newSquare = this.pickEmptySquare(currentPosition, newPiece);
        if (newSquare) {
          positionForNextMove = [
            ...currentPosition,
            { square: newSquare, type: newPiece },
          ];
          newLevel = currentLevel + 1;
          // KS-3520: фиксируем snapshot ВСЕХ фигур (вкл. только что
          // добавленную) для overlay-памяти. Клиент использует это
          // вместо локально накопленного `piecesOnBoard`.
          // KS-3525: используем структурный клон через JSON, чтобы
          // отдать клиенту полностью независимую копию (не shared
          // референс с persisted nextPosition после applyMove ниже).
          // Сам positionForNextMove дальше переиспользуется как база
          // для applyMove, но возвращаемый boardPosition не должен
          // быть к нему привязан.
          const boardPositionSnapshot: BlindBoardPiece[] = positionForNextMove.map(
            (p) => ({ square: p.square, type: p.type }),
          );
          levelUp = {
            newLevel,
            newPiece,
            newSquare,
            boardPosition: boardPositionSnapshot,
          };
          // KS-3525: diagnostic log — содержимое boardPosition'а для
          // последующего сравнения с тем что показывает клиент. Если
          // фронт жалуется на mismatch — grep по sessionId.
          this.logger.log(
            `[blind-board] level-up session=${sessionId} ` +
              `level=${currentLevel}→${newLevel} newPiece=${newPiece}@${newSquare} ` +
              `boardPosition=${JSON.stringify(boardPositionSnapshot)}`,
          );
        } else {
          // Невероятный edge-case: квота нарушена (например, addOrder содержит
          // 3-й B при уже 2 B на доске). Лог + продолжаем без level-up.
          this.logger.warn(
            `[blind-board] level-up skipped for session ${sessionId}: ` +
              `cannot place new piece ${newPiece} (quota or no empty square of required color)`,
          );
        }
      }
      // else: addOrder исчерпан → продолжаем без level-up (level стоит).
    }

    const next = this.pickNextCompMove(positionForNextMove, recentMoves);
    if (!next) {
      // Теоретически недостижимо. Если случилось — это инфраструктурная
      // проблема, лог + 503; сессия НЕ финишируется dead-end.
      this.logger.error(
        `blind-board: no valid next move for session ${sessionId} ` +
          `(pieces=${positionForNextMove.length} dead)`,
      );
      throw new ServiceUnavailableException(
        'no valid blind-board move available',
      );
    }
    const { piece: nextTargetForComp, candidate: pick } = next;
    const nextCompMove: BlindBoardMove = {
      from: nextTargetForComp.square,
      to: pick.to,
    };
    const nextPosition = applyMove(
      positionForNextMove,
      nextTargetForComp.square,
      pick.to,
    );
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
        level: newLevel,
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
      ...(levelUp ? { levelUp } : {}),
    };
  }

  /**
   * KS-3487. Подбор свободной клетки для новой фигуры с color-constraint.
   *
   * Для `B`: цвет клетки должен быть ПРОТИВОПОЛОЖНЫМ цвету уже стоящего
   * на доске B (расширение KS-3449). Если на доске уже два B на разных
   * цветах — третий B запрещён квотой (валидация config), сюда не дойдёт.
   *
   * Для Q/R/N — любая свободная клетка.
   *
   * Возвращает `null` если подходящей клетки нет (теоретически невозможно
   * на пустой доске 64 клетки vs ≤6 уже занятых).
   */
  private pickEmptySquare(
    position: BlindBoardPiece[],
    type: BlindBoardPieceType,
  ): BlindBoardSquare | null {
    const occupied = new Set(position.map((p) => p.square));
    const candidates: BlindBoardSquare[] = [];
    let bishopColorConstraint: boolean | null = null;
    if (type === 'B') {
      const existingBishops = position.filter((p) => p.type === 'B');
      if (existingBishops.length > 0) {
        // Противоположный цвет первому существующему B.
        bishopColorConstraint = !isLightSquare(existingBishops[0].square);
      }
    }
    for (const sq of ALL_SQUARES) {
      if (occupied.has(sq)) continue;
      if (bishopColorConstraint !== null) {
        if (isLightSquare(sq) !== bishopColorConstraint) continue;
      }
      candidates.push(sq);
    }
    if (candidates.length === 0) return null;
    return candidates[this.randInt(candidates.length)];
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
        // KS-3550 (V3 шаг 1): bestLevel + isDefaultConfig — пока считаем
        // в V2-режиме (levelDurationRounds=10, всегда default), потому
        // что миграция per-session config (KS-3551 / B-update) ещё не
        // прошла. После B-update формула станет
        // `floor(bestStreak / sessionConfig.levelDurationRounds) + 1`
        // и `isDefaultConfig` будет читаться из сохранённого config'а.
        const bestLevel = Math.floor(u.blindBoardBestStreak / 10) + 1;
        return {
          userId: u.id,
          username: u.username ?? 'Anonymous',
          bestStreak: u.blindBoardBestStreak,
          achievedAt: (session?.finishedAt ?? new Date()).toISOString(),
          // KS-3484: maxLevel — derived formula по architect-recommendation
          // (без отдельного столбца). 1..10 → L1, 11..20 → L2, ...
          maxLevel: bestLevel,
          bestLevel,
          isDefaultConfig: true,
        };
      }),
    );

    return { entries };
  }

  /**
   * KS-3530. Удаление blind-board сессии пользователем. Каскадно чистит
   * `blind_board_attempts` (FK onDelete:Cascade). После удаления
   * пересчитываем `User.blindBoardBestStreak = max(bestStreak)` среди
   * оставшихся finished-сессий этого юзера. Если ничего не осталось —
   * ставим 0.
   */
  async deleteSession(userId: string, sessionId: string): Promise<void> {
    await this.loadOwned(userId, sessionId); // 404 / 403 + проверка
    await this.prisma.blindBoardSession.delete({ where: { id: sessionId } });

    // Пересчёт User.blindBoardBestStreak.
    const agg = await this.prisma.blindBoardSession.aggregate({
      where: { userId, status: 'finished' },
      _max: { bestStreak: true },
    });
    const newBest = agg._max.bestStreak ?? 0;
    await this.prisma.user.update({
      where: { id: userId },
      data: { blindBoardBestStreak: newBest },
    });
    this.logger.log(
      `[blind-board] KS-3530 deleted session ${sessionId} ` +
        `(user=${userId.slice(0, 8)}, newBestStreak=${newBest})`,
    );
  }

  // ─── Stats (ADR-093 / KS-3509) ────────────────────────────────────

  /**
   * `GET /blind-board/stats/me` — агрегаты по finished-сессиям userId.
   * `maxLevelReached` — derived `floor(bestStreak/10) + 1` от
   * User.blindBoardBestStreak (global best). `currentStreak` — streak
   * последней активной сессии или 0.
   */
  async statsForUser(userId: string): Promise<BlindBoardStatsResponse> {
    const [agg, user, lastActive] = await Promise.all([
      this.prisma.blindBoardSession.aggregate({
        where: { userId, status: 'finished' },
        _count: { _all: true },
        _max: { bestStreak: true },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { blindBoardBestStreak: true },
      }),
      this.prisma.blindBoardSession.findFirst({
        where: { userId, status: 'active' },
        orderBy: { startedAt: 'desc' },
        select: { streak: true },
      }),
    ]);

    // avgRoundsPerSession + wrongAnswerCount + deadEndCount считаем через raw
    // (Prisma не даёт groupBy по finishReason + total rounds через JOIN).
    const detailRows = (await this.prisma.$queryRawUnsafe<
      Array<{ avg_rounds: number | null; wrong_count: bigint | number; dead_end: bigint | number }>
    >(
      `SELECT
         AVG(rounds.round_count)::float                        AS avg_rounds,
         SUM(CASE WHEN s.finish_reason = 'wrong-answer' THEN 1 ELSE 0 END)::bigint AS wrong_count,
         SUM(CASE WHEN s.finish_reason = 'dead-end'    THEN 1 ELSE 0 END)::bigint AS dead_end
         FROM blind_board_sessions s
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS round_count
             FROM blind_board_attempts a
            WHERE a.session_id = s.id
         ) rounds ON true
        WHERE s.user_id = $1::uuid AND s.status = 'finished'`,
      userId,
    )) as Array<{ avg_rounds: number | null; wrong_count: bigint | number; dead_end: bigint | number }>;
    const detail = detailRows[0] ?? {
      avg_rounds: null,
      wrong_count: 0,
      dead_end: 0,
    };

    const globalBest = user?.blindBoardBestStreak ?? 0;
    return {
      totalSessions: agg._count._all,
      bestStreak: globalBest,
      currentStreak: lastActive?.streak ?? 0,
      // KS-3484 derive: 1..10 → L1, 11..20 → L2, и т.д.
      maxLevelReached: Math.floor(globalBest / 10) + 1,
      avgRoundsPerSession: detail.avg_rounds,
      wrongAnswerCount: Number(detail.wrong_count ?? 0),
      deadEndCount: Number(detail.dead_end ?? 0),
    };
  }

  /**
   * `GET /blind-board/trends/me?bucket=...` — time-series. Per-bucket
   * count сессий и максимальный bestStreak в бакете.
   */
  async trendsForUser(
    userId: string,
    bucketRaw: string | undefined,
  ): Promise<BlindBoardTrendsResponse> {
    const bucket: StatsTrendsBucket = normalizeStatsBucket(bucketRaw);
    const rows = (await this.prisma.$queryRawUnsafe<
      Array<{ bucket: Date; sessions: bigint | number; best_streak: number | null }>
    >(
      `SELECT date_trunc($1, finished_at) AS bucket,
              COUNT(*)::bigint           AS sessions,
              MAX(best_streak)::int      AS best_streak
         FROM blind_board_sessions
        WHERE user_id = $2::uuid
          AND status = 'finished'
          AND finished_at IS NOT NULL
        GROUP BY 1
        ORDER BY 1 ASC`,
      bucket,
      userId,
    )) as Array<{ bucket: Date; sessions: bigint | number; best_streak: number | null }>;

    return {
      bucket,
      points: rows.map((r) => ({
        date: (r.bucket instanceof Date ? r.bucket : new Date(r.bucket))
          .toISOString()
          .slice(0, 10),
        sessions: Number(r.sessions),
        bestStreak: Number(r.best_streak ?? 0),
      })),
    };
  }

  /**
   * `GET /blind-board/breakdowns/me` — распределение ошибок по типу
   * фигуры (на каких чаще ошибается). Считается из BlindBoardAttempt
   * WHERE correct=false (то есть момент ошибки, на котором сессия
   * заканчивается через wrong-answer).
   *
   * Опц. `deadEndsByLevel` — для legacy-сессий с finishReason='dead-end',
   * разбивка по level.
   */
  async breakdownsForUser(
    userId: string,
  ): Promise<BlindBoardBreakdownsResponse> {
    const [pieceRows, deadEndRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ pt: string; c: bigint | number }>>(
        `SELECT a.expected_piece_type AS pt, COUNT(*)::bigint AS c
           FROM blind_board_attempts a
           JOIN blind_board_sessions s ON s.id = a.session_id
          WHERE s.user_id = $1::uuid
            AND s.status = 'finished'
            AND a.correct = FALSE
            AND a.user_square IS NOT NULL
          GROUP BY a.expected_piece_type`,
        userId,
      ),
      this.prisma.$queryRawUnsafe<Array<{ level: number; c: bigint | number }>>(
        `SELECT level, COUNT(*)::bigint AS c
           FROM blind_board_sessions
          WHERE user_id = $1::uuid
            AND status = 'finished'
            AND finish_reason = 'dead-end'
          GROUP BY level`,
        userId,
      ),
    ]);

    const total = (pieceRows as Array<{ c: bigint | number }>).reduce(
      (s, r) => s + Number(r.c),
      0,
    );
    const wrongByPieceType: BlindBoardBreakdownsResponse['wrongByPieceType'] = {
      Q: { count: 0, share: 0 },
      R: { count: 0, share: 0 },
      B: { count: 0, share: 0 },
      N: { count: 0, share: 0 },
    };
    for (const r of pieceRows as Array<{ pt: string; c: bigint | number }>) {
      const k = r.pt as BlindBoardPieceType;
      if (k in wrongByPieceType) {
        const c = Number(r.c);
        wrongByPieceType[k] = { count: c, share: total ? c / total : 0 };
      }
    }
    const deadEndsByLevel: Record<string, number> = {};
    for (const r of deadEndRows as Array<{ level: number; c: bigint | number }>) {
      deadEndsByLevel[String(r.level)] = Number(r.c);
    }
    return {
      wrongByPieceType,
      ...(Object.keys(deadEndsByLevel).length > 0 ? { deadEndsByLevel } : {}),
    };
  }

  /**
   * `GET /blind-board/history?cursor=&limit=` — список finished-сессий
   * пользователя, sort `finishedAt DESC`. Cursor — opaque base64-JSON
   * `{t: ISO, g: UUID}` (последний показанный элемент).
   */
  async historyForUser(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<BlindBoardHistoryResponse> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    type Cursor = { t: string; g: string };
    let decoded: Cursor | null = null;
    if (cursor) {
      try {
        const text = Buffer.from(cursor, 'base64').toString('utf8');
        const obj = JSON.parse(text) as Partial<Cursor>;
        if (typeof obj.t === 'string' && typeof obj.g === 'string') {
          decoded = { t: obj.t, g: obj.g };
        }
      } catch {
        // Невалидный cursor → игнорируем, возвращаем первую страницу.
      }
    }

    // Берём limit+1 для определения hasMore.
    const rows = await this.prisma.blindBoardSession.findMany({
      where: {
        userId,
        status: 'finished',
        finishedAt: { not: null },
        ...(decoded
          ? {
              OR: [
                { finishedAt: { lt: new Date(decoded.t) } },
                {
                  finishedAt: new Date(decoded.t),
                  id: { lt: decoded.g },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
      take: safeLimit + 1,
      select: {
        id: true,
        level: true,
        bestStreak: true,
        finishReason: true,
        startedAt: true,
        finishedAt: true,
      },
    });

    const hasMore = rows.length > safeLimit;
    const items = (hasMore ? rows.slice(0, safeLimit) : rows).map((r) => ({
      id: r.id,
      level: r.level ?? 1,
      bestStreak: r.bestStreak,
      finishReason: (r.finishReason ?? null) as BlindBoardFinishReason | null,
      startedAt: r.startedAt.toISOString(),
      finishedAt: (r.finishedAt as Date).toISOString(),
    }));
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ t: last.finishedAt, g: last.id }),
          ).toString('base64')
        : null;
    return { items, nextCursor, hasMore };
  }

  /**
   * KS-3517. `GET /blind-board/sessions/:id` — review одной сессии.
   *
   *  - JwtAuthGuard на контроллере. Owner-check через `loadOwned`
   *    (Forbidden для чужой / NotFound для несуществующей).
   *  - Работает для любого статуса (active/finished).
   *  - Для finished — раскрывает `startPosition` (после финала анти-чит
   *    §5 не действует, расстановка уже была видна игроку в
   *    `revealedPosition` при wrong-answer-финале).
   *  - Для active — `startPosition` НЕ возвращается (игрок ещё играет).
   *  - `currentPosition` НЕ возвращаем никогда (это рабочая «горячая»
   *    позиция компа — анти-чит).
   *  - attempts отсортированы по round ASC.
   *  - В `session.round` (расчёт в toSessionDto) ставим номер
   *    последнего attempt'а — для активной это номер открытого
   *    раунда, для finished — последний сыгранный.
   */
  async reviewSession(
    userId: string,
    sessionId: string,
  ): Promise<BlindBoardSessionReviewResponse> {
    const row = await this.loadOwned(userId, sessionId);
    const attempts = await this.prisma.blindBoardAttempt.findMany({
      where: { sessionId },
      orderBy: { round: 'asc' },
    });
    const lastRound = attempts.length > 0 ? attempts[attempts.length - 1].round : 1;

    const config = (row.startConfig as BlindBoardConfig) ?? DEFAULT_BLIND_BOARD_CONFIG;
    const attemptDtos: BlindBoardAttemptDto[] = attempts.map((a) => ({
      round: a.round,
      compMove: { from: a.compMoveFrom as BlindBoardSquare, to: a.compMoveTo as BlindBoardSquare },
      expectedSquare: a.expectedSquare as BlindBoardSquare,
      expectedPieceType: a.expectedPieceType as BlindBoardPieceType,
      userSquare: (a.userSquare ?? null) as BlindBoardSquare | null,
      userPieceType: (a.userPieceType ?? null) as BlindBoardPieceType | null,
      correct: a.correct,
      createdAt: a.createdAt.toISOString(),
    }));

    const result: BlindBoardSessionReviewResponse = {
      session: this.toSessionDto(row, lastRound),
      config,
      attempts: attemptDtos,
    };
    // Анти-чит §5: startPosition раскрываем ТОЛЬКО для finished.
    if (row.status === 'finished') {
      result.startPosition = row.startPosition as BlindBoardPiece[];
    }
    return result;
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
   * KS-3519 / KS-3524. Выбор следующего хода компа.
   *
   * Раньше (KS-3453) приоритет был у опознанной игроком target-фигуры:
   * если у неё были ходы — выбирался её случайный. С novelty-check
   * (KS-3451) target часто бил себя по той же связке туда-сюда:
   * A→B→A→B... — пользователь видел одну и ту же фигуру.
   *
   * Текущая стратегия:
   *   1) **KS-3524 previous-mover exclusion.** Фигура, ходившая в
   *      предыдущем раунде, отсеивается первой. Это запрещает повтор
   *      той же фигуры дважды подряд. Исключение — если у ВСЕХ остальных
   *      фигур нет валидных ходов с novelty: тогда previous mover
   *      допускается (вырожденный случай). «Previous mover» определяется
   *      как фигура на клетке `to` последнего compMove'а.
   *   2) Среди оставшихся — собираем все (piece, candidate) пары.
   *   3) **KS-3519 анти-возврат.** Для каждой фигуры P на клетке S
   *      смотрим recentMoves; ходы P → previously-departed-from-S
   *      идут в `fallback`-пул. Если есть `fresh` (не возвратные) —
   *      выбираем uniform из них; иначе — из fallback.
   *
   * Возвращает `null` только когда ни у одной фигуры нет валидных
   * ходов с novelty (теоретически почти невозможно).
   */
  pickNextCompMove(
    position: BlindBoardPiece[],
    recentMoves: Array<{ from: BlindBoardSquare; to: BlindBoardSquare }>,
  ): { piece: BlindBoardPiece; candidate: UniqueTargetMove } | null {
    // KS-3524: «previous mover» — фигура на клетке `to` последнего compMove'а.
    const lastMove = recentMoves[recentMoves.length - 1];
    const previousMoverSquare = lastMove?.to ?? null;

    // KS-3519 forbiddenByPiece: для каждой фигуры — множество клеток-возвратов.
    const forbiddenByPiece = new Map<BlindBoardSquare, Set<BlindBoardSquare>>();
    for (const p of position) {
      const set = new Set<BlindBoardSquare>();
      for (const rm of recentMoves) {
        if (rm.to === p.square) set.add(rm.from);
      }
      forbiddenByPiece.set(p.square, set);
    }

    const collectPairs = (
      pieces: BlindBoardPiece[],
    ): {
      fresh: Array<{ piece: BlindBoardPiece; candidate: UniqueTargetMove }>;
      fallback: Array<{ piece: BlindBoardPiece; candidate: UniqueTargetMove }>;
    } => {
      const fresh: Array<{ piece: BlindBoardPiece; candidate: UniqueTargetMove }> = [];
      const fallback: Array<{ piece: BlindBoardPiece; candidate: UniqueTargetMove }> = [];
      for (const piece of pieces) {
        const cands = findUniqueTargetMoves(position, piece.square);
        if (cands.length === 0) continue;
        const forbidden = forbiddenByPiece.get(piece.square) ?? new Set();
        for (const candidate of cands) {
          const pair = { piece, candidate };
          if (forbidden.has(candidate.to)) {
            fallback.push(pair);
          } else {
            fresh.push(pair);
          }
        }
      }
      return { fresh, fallback };
    };

    // KS-3524 шаг 1: попытка БЕЗ previous mover'а.
    if (previousMoverSquare) {
      const others = position.filter((p) => p.square !== previousMoverSquare);
      const { fresh, fallback } = collectPairs(others);
      const pool = fresh.length > 0 ? fresh : fallback;
      if (pool.length > 0) {
        return pool[this.randInt(pool.length)];
      }
      // Все остальные заблокированы — fall through, разрешаем previous mover.
    }

    // Шаг 2: previous mover'а нет (первый раунд) ИЛИ остальные
    // заблокированы — собираем по всей доске.
    const { fresh, fallback } = collectPairs(position);
    const pool = fresh.length > 0 ? fresh : fallback;
    if (pool.length === 0) return null;
    return pool[this.randInt(pool.length)];
  }

  /**
   * Генерация валидной стартовой расстановки + первого хода компа.
   * KS-3486: принимает кастомный `startPieces` из BlindBoardConfig.
   * До MAX_START_ATTEMPTS попыток. Возвращает null если не получилось.
   */
  generateValidStart(
    startPieces: BlindBoardPieceType[] = ['Q', 'R', 'N', 'B', 'B'],
  ): {
    position: BlindBoardPiece[];
    target: BlindBoardPiece;
    compMove: BlindBoardMove;
    nextInvolved: BlindBoardPiece;
  } | null {
    for (let i = 0; i < MAX_START_ATTEMPTS; i++) {
      const position = this.randomStartPosition(startPieces);
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

  /**
   * Случайная расстановка `startPieces` фигур на уникальных клетках.
   *
   * KS-3486: набор фигур приходит из `BlindBoardConfig.startPieces`
   * (раньше был фиксирован Q,R,N,B,B). Длина 3..7, квоты валидируются
   * в `validateConfig` до вызова.
   *
   * KS-3449: если в наборе ≥2 B — они ОБЯЗАНЫ стоять на полях разного
   * цвета. Алгоритм: общий шаффл pool, потом для второго (и любого
   * последующего) B принудительный swap на клетку нужного цвета.
   */
  randomStartPosition(
    startPieces: BlindBoardPieceType[] = ['Q', 'R', 'N', 'B', 'B'],
  ): BlindBoardPiece[] {
    const n = startPieces.length;
    const pool = ALL_SQUARES.slice();
    // Партиальный Fisher–Yates: гарантирует уникальность первых n клеток.
    for (let i = 0; i < n; i++) {
      const j = i + this.randInt(pool.length - i);
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    // KS-3449: пройдёмся по слотам B; для каждого B после первого —
    // принудительно противоположный цвет первому B.
    let firstBishopLight: boolean | null = null;
    for (let i = 0; i < n; i++) {
      if (startPieces[i] !== 'B') continue;
      if (firstBishopLight === null) {
        firstBishopLight = isLightSquare(pool[i]);
        continue;
      }
      // Если pool[i] уже противоположный — ок. Иначе ищем swap в хвосте.
      const wanted = !firstBishopLight;
      if (isLightSquare(pool[i]) === wanted) continue;
      const candidates: number[] = [];
      for (let k = i + 1; k < pool.length; k++) {
        if (isLightSquare(pool[k]) === wanted) candidates.push(k);
      }
      if (candidates.length === 0) continue; // не должно случаться
      const pick = candidates[this.randInt(candidates.length)];
      const tmp = pool[i];
      pool[i] = pool[pick];
      pool[pick] = tmp;
    }
    return startPieces.map((type, i) => ({
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
      level: row.level ?? 1,
      nextMove: (row.currentCompMove as BlindBoardMove | null) ?? null,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    };
  }
}

/** KS-3486: type-guard для `BlindBoardPieceType`. */
function isPieceType(v: unknown): v is BlindBoardPieceType {
  return v === 'Q' || v === 'R' || v === 'B' || v === 'N';
}

/**
 * KS-3449. Светлое поле доски (a1 — тёмное). `(file + rank) % 2 === 1` →
 * светлое. file ∈ {a..h} = 0..7 (charCode-97), rank ∈ {1..8} = 0..7.
 */
export function isLightSquare(sq: BlindBoardSquare): boolean {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  return (file + rank) % 2 === 1;
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

/** KS-3509. Whitelist bucket'а; дефолт `week`. */
function normalizeStatsBucket(raw: string | undefined): 'day' | 'week' | 'month' {
  if (raw === 'day' || raw === 'month') return raw;
  return 'week';
}
