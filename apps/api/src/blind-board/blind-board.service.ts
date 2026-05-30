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
          levelUp = { newLevel, newPiece, newSquare };
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

    const next = this.pickNextCompMove(positionForNextMove, expected.square);
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
        return {
          userId: u.id,
          username: u.username ?? 'Anonymous',
          bestStreak: u.blindBoardBestStreak,
          achievedAt: (session?.finishedAt ?? new Date()).toISOString(),
          // KS-3484: maxLevel — derived formula по architect-recommendation
          // (без отдельного столбца). 1..10 → L1, 11..20 → L2, ...
          maxLevel: Math.floor(u.blindBoardBestStreak / 10) + 1,
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
   * KS-3453: выбор следующего хода компа после правильного ответа.
   * Сначала пытаемся ходить опознанной фигурой (`preferredSquare`).
   * Если у неё нет валидного хода — fallback: перебираем оставшиеся
   * фигуры в случайном порядке и берём первую с ходом. Возвращает
   * `null` только если ни у одной из 5 фигур нет валидного хода
   * (теоретически почти невозможно при 5 фигурах на пустой доске).
   */
  private pickNextCompMove(
    position: BlindBoardPiece[],
    preferredSquare: BlindBoardSquare,
  ): { piece: BlindBoardPiece; candidate: UniqueTargetMove } | null {
    // 1) Сначала — опознанная игроком фигура.
    const preferred = position.find((p) => p.square === preferredSquare);
    if (preferred) {
      const cands = findUniqueTargetMoves(position, preferredSquare);
      if (cands.length > 0) {
        const pick = cands[this.randInt(cands.length)];
        return { piece: preferred, candidate: pick };
      }
    }
    // 2) Fallback: любая другая фигура в случайном порядке.
    const others = position.filter((p) => p.square !== preferredSquare);
    const order = this.shuffleIndices(others.length);
    for (const idx of order) {
      const piece = others[idx];
      const cands = findUniqueTargetMoves(position, piece.square);
      if (cands.length > 0) {
        const pick = cands[this.randInt(cands.length)];
        return { piece, candidate: pick };
      }
    }
    return null;
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
