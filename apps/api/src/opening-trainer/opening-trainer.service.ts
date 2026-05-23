import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Chess } from 'chess.js';
import {
  OPENING_REPERTOIRE_LIMITS,
  type OpeningRepertoireDto,
  type OpeningRepertoireDetailDto,
  type OpeningRepertoireWithStatsDto,
  type OpeningTrainerSessionDto,
  type OpeningTrainerMoveResponse,
  type OpeningTrainerHintResponse,
  type OpeningTrainerGiveupResponse,
  type OpeningTrainerUndoResponse,
  type OpeningTrainerFinishResponse,
  type StartOpeningTrainerSessionResponse,
  type GetOpeningTrainerSessionResponse,
  type ListOpeningRepertoiresResponse,
  type DeleteOpeningRepertoireResponse,
  type RepertoireTree,
  type RepertoireEdge,
} from '@kingside/shared';
import { OpeningTrainerRepository } from './opening-trainer.repository';
import {
  RepertoireBuilderService,
  RepertoireLimitExceededError,
  RepertoirePgnError,
} from './repertoire-builder.service';
import { pickBotMove } from './bot-picker';
import { computeScoreDelta } from './scoring';
import {
  CreateRepertoireDto,
  MoveDto,
  StartSessionDto,
  UpdateRepertoireDto,
} from './dto/repertoire.dto';

/**
 * KS-3272 (ADR-077 §3, §6). Главный сервис Opening Trainer'а —
 * оркестрирует репозиторий, builder, бот-picker и scoring.
 *
 * Owner-check: для каждой entity сравниваем `entity.userId === actorId`
 * и при mismatch'е выдаём `NotFoundException` (404, без 403 — не светим
 * существование чужих репертуаров).
 *
 * Не содержит контроллер-уровневой логики (JWT, HTTP-headers) — это
 * `OpeningTrainerController`.
 */
@Injectable()
export class OpeningTrainerService {
  private readonly logger = new Logger(OpeningTrainerService.name);

  constructor(
    private readonly repo: OpeningTrainerRepository,
    private readonly builder: RepertoireBuilderService,
  ) {}

  // ── Repertoire CRUD ────────────────────────────────────────────

  async createRepertoire(
    userId: string,
    dto: CreateRepertoireDto,
  ): Promise<OpeningRepertoireDetailDto> {
    // Лимит количества репертуаров на пользователя (ADR §4).
    const count = await this.repo.countRepertoiresByUser(userId);
    if (count >= OPENING_REPERTOIRE_LIMITS.maxRepertoiresPerUser) {
      throw new ConflictException(
        `Repertoire limit reached: ${OPENING_REPERTOIRE_LIMITS.maxRepertoiresPerUser} per user`,
      );
    }

    // Парсим PGN → tree (бросает RepertoirePgnError / RepertoireLimitExceededError).
    let tree: RepertoireTree;
    try {
      tree = this.builder.buildTree(dto.pgn);
    } catch (err) {
      if (err instanceof RepertoirePgnError) {
        throw new BadRequestException(err.message);
      }
      if (err instanceof RepertoireLimitExceededError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    const row = await this.repo.createRepertoire({
      userId,
      title: dto.title,
      description: dto.description ?? null,
      pgn: dto.pgn,
      tree: tree as unknown as object,
      nodeCount: tree.meta.nodeCount,
      edgeCount: tree.meta.edgeCount,
      maxDepth: tree.meta.maxDepth,
    });

    return rowToRepertoireDetailDto(row, tree);
  }

  async listRepertoires(
    userId: string,
    includeStats: boolean,
  ): Promise<ListOpeningRepertoiresResponse> {
    const rows = await this.repo.listRepertoires(userId);
    const repertoires: Array<
      OpeningRepertoireDto | OpeningRepertoireWithStatsDto
    > = rows.map((row) => {
      const dto = rowToRepertoireDto(row);
      if (!includeStats) return dto;
      // M1: stats = нули (OpeningLineProgress появится в M2).
      return {
        ...dto,
        stats: {
          masteredLines: 0,
          learningLines: 0,
          wrongLines: 0,
          totalLines: 0,
        },
      } as OpeningRepertoireWithStatsDto;
    });
    return { repertoires };
  }

  async getRepertoire(
    userId: string,
    id: string,
  ): Promise<OpeningRepertoireDetailDto> {
    const row = await this.requireRepertoire(userId, id);
    const tree = jsonToTree(row.tree);
    return rowToRepertoireDetailDto(row, tree);
  }

  async updateRepertoire(
    userId: string,
    id: string,
    dto: UpdateRepertoireDto,
  ): Promise<OpeningRepertoireDetailDto> {
    const row = await this.requireRepertoire(userId, id);

    let tree: RepertoireTree | null = null;
    const updateData: Parameters<typeof this.repo.updateRepertoire>[1] = {};
    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.pgn !== undefined && dto.pgn !== row.pgn) {
      try {
        tree = this.builder.buildTree(dto.pgn);
      } catch (err) {
        if (
          err instanceof RepertoirePgnError ||
          err instanceof RepertoireLimitExceededError
        ) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
      updateData.pgn = dto.pgn;
      updateData.tree = tree as unknown as object;
      updateData.nodeCount = tree.meta.nodeCount;
      updateData.edgeCount = tree.meta.edgeCount;
      updateData.maxDepth = tree.meta.maxDepth;
    }

    const updated = await this.repo.updateRepertoire(id, updateData);
    return rowToRepertoireDetailDto(
      updated,
      tree ?? jsonToTree(updated.tree),
    );
  }

  async deleteRepertoire(
    userId: string,
    id: string,
  ): Promise<DeleteOpeningRepertoireResponse> {
    await this.requireRepertoire(userId, id);
    const now = new Date();
    const deleted = await this.repo.softDeleteRepertoire(id, now);
    return {
      id: deleted.id,
      deletedAt: (deleted.deletedAt ?? now).toISOString(),
    };
  }

  // ── Session lifecycle ──────────────────────────────────────────

  async startSession(
    userId: string,
    repertoireId: string,
    dto: StartSessionDto,
  ): Promise<StartOpeningTrainerSessionResponse> {
    const repertoire = await this.requireRepertoire(userId, repertoireId);

    const activeCount = await this.repo.countActiveSessionsByUser(userId);
    if (activeCount >= OPENING_REPERTOIRE_LIMITS.maxActiveSessionsPerUser) {
      throw new ConflictException(
        `Active session limit reached (${OPENING_REPERTOIRE_LIMITS.maxActiveSessionsPerUser}); finish one before starting new.`,
      );
    }

    const tree = jsonToTree(repertoire.tree);
    let session = await this.repo.createSession({
      userId,
      repertoireId,
      side: dto.side,
      mode: dto.mode,
      repeatMode: dto.repeatMode,
      currentFen: tree.rootFen,
    });

    // Если играем чёрными — бот делает первый ход (белыми).
    let initialBotMove: StartOpeningTrainerSessionResponse['initialBotMove'] =
      null;
    if (dto.side === 'black') {
      const rootEdges = tree.nodes[tree.rootFen]?.edges ?? [];
      const pick = pickBotMove({
        edges: rootEdges,
        playedChildFens: [],
        repeatMode: session.repeatMode as 'cycle' | 'complete',
      });
      if (pick.pick) {
        const newPlayedLines = {
          [tree.rootFen]: pick.cycled
            ? [pick.pick.childFen]
            : [pick.pick.childFen],
        };
        const newPath = [pick.pick.moveUci];
        session = await this.repo.updateSession(session.id, {
          playedLines: newPlayedLines,
          currentFen: pick.pick.childFen,
          currentPath: newPath,
          lastActivityAt: new Date(),
        });
        initialBotMove = {
          moveUci: pick.pick.moveUci,
          moveSan: pick.pick.moveSan,
          newFen: pick.pick.childFen,
        };
      }
    }

    return {
      session: sessionRowToDto(session),
      initialBotMove,
    };
  }

  async getSession(
    userId: string,
    sessionId: string,
  ): Promise<GetOpeningTrainerSessionResponse> {
    const session = await this.requireSession(userId, sessionId);
    return { session: sessionRowToDto(session) };
  }

  async makeMove(
    userId: string,
    sessionId: string,
    dto: MoveDto,
  ): Promise<OpeningTrainerMoveResponse> {
    const session = await this.requireSession(userId, sessionId);
    if (session.status !== 'active') {
      throw new BadRequestException(`Session is ${session.status}`);
    }
    const repertoire = await this.repo.findRepertoireById(session.repertoireId);
    if (!repertoire) {
      throw new NotFoundException('Repertoire not found');
    }
    const tree = jsonToTree(repertoire.tree);
    const edges = tree.nodes[session.currentFen]?.edges ?? [];
    const matched = edges.find((e) => e.moveUci === dto.moveUci);
    const now = new Date();
    const hintUsed = session.pendingHintFen === session.currentFen;

    if (!matched) {
      // Wrong move.
      const scoreRes = computeScoreDelta({
        correct: false,
        hintUsed,
        currentStreak: session.currentStreak,
        responseTimeMs: dto.responseTimeMs,
        currentScore: session.score,
      });
      await this.repo.createAttempt({
        sessionId,
        positionFen: session.currentFen,
        expectedMoves: edges.map((e) => e.moveUci),
        userMove: dto.moveUci,
        correct: false,
        hintUsed,
        scoreDelta: scoreRes.scoreDelta,
        responseTimeMs: dto.responseTimeMs,
      });
      const newScore = Math.max(0, session.score + scoreRes.scoreDelta);
      const updated = await this.repo.updateSession(sessionId, {
        score: newScore,
        wrongMoves: session.wrongMoves + 1,
        currentStreak: scoreRes.newStreak,
        pendingHintFen: null,
        lastActivityAt: now,
      });
      return {
        result: 'wrong',
        applied: false,
        scoreDelta: scoreRes.scoreDelta,
        expectedMoves: edges.map((e) => ({
          moveUci: e.moveUci,
          moveSan: e.moveSan,
        })),
        session: sessionRowToDto(updated),
      };
    }

    // Correct move.
    const scoreRes = computeScoreDelta({
      correct: true,
      hintUsed,
      currentStreak: session.currentStreak,
      responseTimeMs: dto.responseTimeMs,
      currentScore: session.score,
    });
    const newScoreAfterUser = Math.max(0, session.score + scoreRes.scoreDelta);
    const newPathAfterUser = [
      ...readUciArray(session.currentPath),
      matched.moveUci,
    ];
    const playedLines = readPlayedLines(session.playedLines);
    const fenAfterUser = matched.childFen;

    // Бот-ход.
    const botEdges = tree.nodes[fenAfterUser]?.edges ?? [];
    const playedFromHere = playedLines[fenAfterUser] ?? [];
    const botPick = pickBotMove({
      edges: botEdges,
      playedChildFens: playedFromHere,
      repeatMode: session.repeatMode as 'cycle' | 'complete',
    });

    await this.repo.createAttempt({
      sessionId,
      positionFen: session.currentFen,
      expectedMoves: edges.map((e) => e.moveUci),
      userMove: dto.moveUci,
      correct: true,
      hintUsed,
      scoreDelta: scoreRes.scoreDelta,
      responseTimeMs: dto.responseTimeMs,
    });

    const newStreak = scoreRes.newStreak;
    const newStreakMax = Math.max(session.streakMax, newStreak);
    const baseUpdate = {
      score: newScoreAfterUser,
      correctMoves: session.correctMoves + 1,
      movesPlayed: session.movesPlayed + 1,
      currentStreak: newStreak,
      streakMax: newStreakMax,
      pendingHintFen: null as string | null,
      lastActivityAt: now,
    };

    if (botPick.pick) {
      const newPlayedLines = {
        ...playedLines,
        [fenAfterUser]: botPick.cycled
          ? [botPick.pick.childFen]
          : [...playedFromHere, botPick.pick.childFen],
      };
      const newPath = [...newPathAfterUser, botPick.pick.moveUci];
      const updated = await this.repo.updateSession(sessionId, {
        ...baseUpdate,
        currentFen: botPick.pick.childFen,
        currentPath: newPath,
        playedLines: newPlayedLines,
      });
      return {
        result: 'correct',
        applied: true,
        scoreDelta: scoreRes.scoreDelta,
        newFen: botPick.pick.childFen,
        botMove: {
          moveUci: botPick.pick.moveUci,
          moveSan: botPick.pick.moveSan,
          newFen: botPick.pick.childFen,
        },
        session: sessionRowToDto(updated),
      };
    }

    // Line complete (нет edges из позиции после нашего хода, либо все
    // пройдены при repeatMode='complete'). Финишируем сессию.
    const updated = await this.repo.updateSession(sessionId, {
      ...baseUpdate,
      currentFen: fenAfterUser,
      currentPath: newPathAfterUser,
      status: 'finished',
      finishedAt: now,
    });
    return {
      result: 'line-complete',
      applied: true,
      scoreDelta: scoreRes.scoreDelta,
      newFen: fenAfterUser,
      session: sessionRowToDto(updated),
    };
  }

  async hint(
    userId: string,
    sessionId: string,
  ): Promise<OpeningTrainerHintResponse> {
    const session = await this.requireSession(userId, sessionId);
    if (session.status !== 'active') {
      throw new BadRequestException(`Session is ${session.status}`);
    }
    const repertoire = await this.repo.findRepertoireById(session.repertoireId);
    if (!repertoire) throw new NotFoundException('Repertoire not found');
    const tree = jsonToTree(repertoire.tree);
    const edges = tree.nodes[session.currentFen]?.edges ?? [];
    if (edges.length === 0) {
      throw new BadRequestException(
        'No hint available — current position has no moves in repertoire',
      );
    }
    const pick = edges[Math.floor(Math.random() * edges.length)];
    const updated = await this.repo.updateSession(sessionId, {
      hintsUsed: session.hintsUsed + 1,
      pendingHintFen: session.currentFen,
      lastActivityAt: new Date(),
    });
    return {
      hint: { moveUci: pick.moveUci, moveSan: pick.moveSan },
      session: sessionRowToDto(updated),
    };
  }

  async giveup(
    userId: string,
    sessionId: string,
  ): Promise<OpeningTrainerGiveupResponse> {
    const session = await this.requireSession(userId, sessionId);
    if (session.status !== 'active') {
      throw new BadRequestException(`Session is ${session.status}`);
    }
    const repertoire = await this.repo.findRepertoireById(session.repertoireId);
    if (!repertoire) throw new NotFoundException('Repertoire not found');
    const tree = jsonToTree(repertoire.tree);
    const edges = tree.nodes[session.currentFen]?.edges ?? [];
    if (edges.length === 0) {
      throw new BadRequestException(
        'Nothing to giveup — current position has no expected moves',
      );
    }
    const now = new Date();
    // Записываем как wrong-attempt с userMove='giveup'.
    await this.repo.createAttempt({
      sessionId,
      positionFen: session.currentFen,
      expectedMoves: edges.map((e) => e.moveUci),
      userMove: '(giveup)',
      correct: false,
      hintUsed: false,
      scoreDelta: 0, // giveup сам по себе не штрафует — но и счёт не растёт
      responseTimeMs: 0,
    });

    // Применяем «правильный» ход (первый из edges) от имени пользователя,
    // затем бот отвечает.
    const userMove = edges[0];
    const fenAfterUser = userMove.childFen;
    const playedLines = readPlayedLines(session.playedLines);
    const botEdges = tree.nodes[fenAfterUser]?.edges ?? [];
    const playedFromHere = playedLines[fenAfterUser] ?? [];
    const botPick = pickBotMove({
      edges: botEdges,
      playedChildFens: playedFromHere,
      repeatMode: session.repeatMode as 'cycle' | 'complete',
    });

    const newPath = [
      ...readUciArray(session.currentPath),
      userMove.moveUci,
      ...(botPick.pick ? [botPick.pick.moveUci] : []),
    ];
    const newPlayedLines = botPick.pick
      ? {
          ...playedLines,
          [fenAfterUser]: botPick.cycled
            ? [botPick.pick.childFen]
            : [...playedFromHere, botPick.pick.childFen],
        }
      : playedLines;
    const updated = await this.repo.updateSession(sessionId, {
      currentFen: botPick.pick ? botPick.pick.childFen : fenAfterUser,
      currentPath: newPath,
      playedLines: newPlayedLines,
      wrongMoves: session.wrongMoves + 1,
      currentStreak: 0,
      pendingHintFen: null,
      lastActivityAt: now,
      ...(botPick.pick === null
        ? { status: 'finished' as const, finishedAt: now }
        : {}),
    });

    return {
      expectedMoves: edges.map((e) => ({
        moveUci: e.moveUci,
        moveSan: e.moveSan,
      })),
      botMove: botPick.pick
        ? {
            moveUci: botPick.pick.moveUci,
            moveSan: botPick.pick.moveSan,
            newFen: botPick.pick.childFen,
          }
        : null,
      newFen: botPick.pick ? botPick.pick.childFen : fenAfterUser,
      session: sessionRowToDto(updated),
    };
  }

  async undo(
    userId: string,
    sessionId: string,
  ): Promise<OpeningTrainerUndoResponse> {
    const session = await this.requireSession(userId, sessionId);
    if (session.status !== 'active') {
      throw new BadRequestException(`Session is ${session.status}`);
    }
    const last = await this.repo.findLastAttempt(sessionId);
    if (!last) {
      throw new BadRequestException('Nothing to undo');
    }

    const now = new Date();
    // Revert score (clamp to 0).
    const newScore = Math.max(0, session.score - last.scoreDelta);
    // Counters revert.
    const newCorrect = last.correct
      ? Math.max(0, session.correctMoves - 1)
      : session.correctMoves;
    const newWrong = !last.correct
      ? Math.max(0, session.wrongMoves - 1)
      : session.wrongMoves;
    const newMovesPlayed = last.correct
      ? Math.max(0, session.movesPlayed - 1)
      : session.movesPlayed;

    // currentFen → position перед undone move.
    // Для correct-attempts надо ОТКАТИТЬ и user-ход, и последовавший бот-ход.
    // Для wrong-attempt — position не двигался, ничего не откатываем в fen/path.
    let newCurrentFen = session.currentFen;
    let newCurrentPath = readUciArray(session.currentPath);
    if (last.correct) {
      newCurrentFen = last.positionFen;
      // pop последние 2 элемента (user + bot) — но bot мог не быть
      // (line-complete). Безопасно popим до длины ДО последнего user-хода.
      // Эвристика: pop пока currentPath не короче чем pathLength соответствующий
      // positionFen. M1: pop минимум 1, максимум 2.
      newCurrentPath = newCurrentPath.slice(
        0,
        Math.max(0, newCurrentPath.length - 2),
      );
    }

    // Streak: для простоты пересчитываем по всем attempts (минус последняя).
    // Маленький запрос, M1.
    const attemptsAll = await this.repo.listAttemptsBySession(sessionId);
    const attemptsWithoutLast = attemptsAll.filter((a) => a.id !== last.id);
    let newStreak = 0;
    for (let i = attemptsWithoutLast.length - 1; i >= 0; i--) {
      if (attemptsWithoutLast[i].correct) newStreak++;
      else break;
    }

    await this.repo.deleteAttempt(last.id);
    const updated = await this.repo.updateSession(sessionId, {
      score: newScore,
      correctMoves: newCorrect,
      wrongMoves: newWrong,
      movesPlayed: newMovesPlayed,
      currentStreak: newStreak,
      currentFen: newCurrentFen,
      currentPath: newCurrentPath,
      pendingHintFen: null,
      lastActivityAt: now,
    });

    return {
      newFen: newCurrentFen,
      scoreDelta: -last.scoreDelta,
      session: sessionRowToDto(updated),
    };
  }

  async finish(
    userId: string,
    sessionId: string,
  ): Promise<OpeningTrainerFinishResponse> {
    const session = await this.requireSession(userId, sessionId);
    const now = new Date();
    let updated = session;
    if (session.status === 'active') {
      updated = await this.repo.updateSession(sessionId, {
        status: 'finished',
        finishedAt: now,
        lastActivityAt: now,
      });
    }
    // M1: linesCompleted = 0 (нет агрегатора, OpeningLineProgress в M2).
    return {
      session: sessionRowToDto(updated),
      summary: {
        score: updated.score,
        movesPlayed: updated.movesPlayed,
        correctMoves: updated.correctMoves,
        wrongMoves: updated.wrongMoves,
        hintsUsed: updated.hintsUsed,
        linesCompleted: 0,
      },
    };
  }

  // ── Internal helpers ──────────────────────────────────────────

  /**
   * Читает репертуар + проверяет ownership. 404 если не существует
   * или принадлежит другому. 410 (Gone) если soft-deleted.
   */
  private async requireRepertoire(userId: string, id: string) {
    const row = await this.repo.findRepertoireById(id);
    if (!row || row.userId !== userId) {
      throw new NotFoundException(`Repertoire ${id} not found`);
    }
    if (row.deletedAt !== null) {
      throw new ForbiddenException(
        `Repertoire ${id} was deleted at ${row.deletedAt.toISOString()}`,
      );
    }
    return row;
  }

  private async requireSession(userId: string, sessionId: string) {
    const row = await this.repo.findSessionById(sessionId);
    if (!row || row.userId !== userId) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    return row;
  }
}

// ─── Mappers (Prisma row → shared DTO) ─────────────────────────────

interface RepertoireRow {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  pgn: string;
  tree: unknown;
  nodeCount: number;
  edgeCount: number;
  maxDepth: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface SessionRow {
  id: string;
  userId: string;
  repertoireId: string;
  side: string;
  mode: string;
  repeatMode: string;
  status: string;
  playedLines: unknown;
  currentFen: string;
  currentPath: unknown;
  score: number;
  movesPlayed: number;
  correctMoves: number;
  wrongMoves: number;
  hintsUsed: number;
  currentStreak: number;
  streakMax: number;
  pendingHintFen: string | null;
  startedAt: Date;
  lastActivityAt: Date;
  finishedAt: Date | null;
}

function rowToRepertoireDto(row: RepertoireRow): OpeningRepertoireDto {
  return {
    id: row.id,
    ownerId: row.userId,
    title: row.title,
    description: row.description,
    nodeCount: row.nodeCount,
    edgeCount: row.edgeCount,
    maxDepth: row.maxDepth,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToRepertoireDetailDto(
  row: RepertoireRow,
  tree: RepertoireTree,
): OpeningRepertoireDetailDto {
  return {
    ...rowToRepertoireDto(row),
    pgn: row.pgn,
    tree,
  };
}

function sessionRowToDto(row: SessionRow): OpeningTrainerSessionDto {
  return {
    id: row.id,
    repertoireId: row.repertoireId,
    side: row.side as 'white' | 'black',
    mode: row.mode as 'learn' | 'review' | 'mistakes' | 'free',
    repeatMode: row.repeatMode as 'cycle' | 'complete',
    status: row.status as 'active' | 'finished' | 'expired',
    currentFen: row.currentFen,
    currentPath: readUciArray(row.currentPath),
    score: row.score,
    movesPlayed: row.movesPlayed,
    correctMoves: row.correctMoves,
    wrongMoves: row.wrongMoves,
    hintsUsed: row.hintsUsed,
    startedAt: row.startedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function jsonToTree(json: unknown): RepertoireTree {
  // Prisma возвращает Json как unknown — наш контент гарантирован,
  // потому что builder его и пишет. Защитный fallback: empty tree.
  if (
    json &&
    typeof json === 'object' &&
    'rootFen' in json &&
    'nodes' in json &&
    'meta' in json
  ) {
    return json as RepertoireTree;
  }
  const chess = new Chess();
  return {
    rootFen: chess.fen(),
    nodes: { [chess.fen()]: { fen: chess.fen(), edges: [] } },
    meta: { nodeCount: 1, edgeCount: 0, maxDepth: 0 },
  };
}

function readPlayedLines(json: unknown): Record<string, string[]> {
  if (json && typeof json === 'object') {
    return json as Record<string, string[]>;
  }
  return {};
}

function readUciArray(json: unknown): string[] {
  if (Array.isArray(json)) return json as string[];
  return [];
}

// Re-export типы для тестов / других модулей.
export type { RepertoireEdge };
