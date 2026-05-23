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
      // KS-3278: всегда cycle (см. handleLineComplete) — на старте сессии
      // playedLines пустой, разница не критична, но соблюдаем единый паттерн.
      const pick = pickBotMove({
        edges: rootEdges,
        playedChildFens: [],
        repeatMode: 'cycle',
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
        // KS-3277: помечаем линию как «грязную» — она не попадёт в
        // cleanPlayedLines при line-complete, останется в очереди.
        currentLineHadWrong: true,
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
    const cleanLines = readPlayedLines(session.cleanPlayedLines);
    const fenAfterUser = matched.childFen;

    // KS-3277: бот выбирает ТОЛЬКО из непройденных-чисто edges. Если
    // все edges позиции уже clean — этот узел полностью изучен, бот не
    // должен туда возвращаться → trigger line-restart.
    const allBotEdges = tree.nodes[fenAfterUser]?.edges ?? [];
    const cleanFromHere = cleanLines[fenAfterUser] ?? [];
    const uncleanEdges = allBotEdges.filter(
      (e) => !cleanFromHere.includes(e.childFen),
    );
    const playedFromHere = playedLines[fenAfterUser] ?? [];
    // KS-3278: всегда cycle. Если есть unclean edges, бот ОБЯЗАН что-то
    // сыграть — иначе мы вернёмся через handleLineComplete и зацикливаемся
    // на том же fen. SessionPlayedLines только для разнообразия в пределах
    // одной серии вариантов, не для условия завершения.
    const botPick =
      uncleanEdges.length > 0
        ? pickBotMove({
            edges: uncleanEdges,
            playedChildFens: playedFromHere,
            repeatMode: 'cycle',
          })
        : { pick: null, cycled: false, lineComplete: true };

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
      // Линия продолжается — бот сделал свой ход.
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

    // KS-3277: line-complete — бот не нашёл непройденного варианта.
    // Если линия была clean — записываем её edges в cleanPlayedLines.
    // Затем ищем следующую развилку с непройденными edges. Если нашли —
    // line-restart. Если всё дерево clean — tree-complete.
    return this.handleLineComplete({
      session,
      tree,
      newPath: newPathAfterUser,
      fenAfterUser,
      cleanLines,
      baseUpdate,
      scoreDelta: scoreRes.scoreDelta,
      now,
    });
  }

  /**
   * KS-3277. Логика «линия закончилась — что дальше».
   *
   * Шаги:
   *   1. Если в текущей линии не было ошибок (`!currentLineHadWrong`),
   *      проходим по `newPath[lineStartIndex..]`, добавляем каждый edge
   *      в `cleanPlayedLines`. Линия зарегистрирована как пройденная.
   *   2. `findNextUnexploredBranch` — walk currentPath сверху-вниз,
   *      ищем позицию, у которой ещё есть непройденные (не clean) edges.
   *   3. Если нашли — line-restart: currentFen/path/lineStartIndex
   *      обновляются, бот делает ход из новой позиции (если ему ходить).
   *   4. Если нет — tree-complete: status=finished, finishedAt=now.
   */
  private async handleLineComplete(args: {
    session: {
      id: string;
      side: string;
      currentLineHadWrong: boolean;
      lineStartIndex: number;
      playedLines: unknown;
      repeatMode: string;
    };
    tree: RepertoireTree;
    /** currentPath после применения user-хода (но без bot-хода). */
    newPath: string[];
    /** FEN после user-хода — позиция, в которой бот не нашёл ходов. */
    fenAfterUser: string;
    cleanLines: Record<string, string[]>;
    baseUpdate: Record<string, unknown>;
    scoreDelta: number;
    now: Date;
  }): Promise<OpeningTrainerMoveResponse> {
    const { session, tree, newPath, fenAfterUser, baseUpdate, scoreDelta, now } =
      args;
    let cleanLines = args.cleanLines;

    // 1. Если линия чистая — добавляем edges в cleanPlayedLines.
    if (!session.currentLineHadWrong) {
      cleanLines = addLineToClean(cleanLines, newPath, session.lineStartIndex);
    }

    // 2. Ищем следующую развилку.
    const next = findNextUnexploredBranch(tree, newPath, cleanLines);

    if (!next) {
      // tree-complete: всё дерево clean.
      const updated = await this.repo.updateSession(session.id, {
        ...baseUpdate,
        currentFen: fenAfterUser,
        currentPath: newPath,
        cleanPlayedLines: cleanLines,
        currentLineHadWrong: false,
        status: 'finished',
        finishedAt: now,
      });
      return {
        result: 'tree-complete',
        applied: true,
        scoreDelta,
        newFen: fenAfterUser,
        session: sessionRowToDto(updated),
      };
    }

    // 3. line-restart: откатываем доску к next.fen.
    const restartPath = newPath.slice(0, next.depth);
    const playedLines = readPlayedLines(session.playedLines);

    // Бот должен сделать ход, если в restart-позиции его очередь.
    // Очередь определяется длиной пути и стороной пользователя:
    //   userSide='white' → user играет на чётных индексах (0, 2, ...).
    //     Бот ходит, если restartPath.length % 2 === 1
    //     ... нет, если path длина 0 — ход белых, играет ЮЗЕР (если он white).
    //     Игрок играет когда path.length % 2 === 0 для white, == 1 для black.
    //   userSide='black' → инверсно.
    const userPliesAreEven = session.side === 'white';
    const isUserTurn =
      restartPath.length % 2 === (userPliesAreEven ? 0 : 1);

    let finalFen = next.fen;
    let finalPath = restartPath;
    let initialBotMove: {
      moveUci: string;
      moveSan: string;
      newFen: string;
    } | null = null;
    let updatedPlayedLines = playedLines;

    if (!isUserTurn) {
      // Бот делает первый ход из restart-позиции.
      const botEdges = tree.nodes[next.fen]?.edges ?? [];
      const cleanFromHere = cleanLines[next.fen] ?? [];
      const uncleanEdges = botEdges.filter(
        (e) => !cleanFromHere.includes(e.childFen),
      );
      const sessionPlayedFromHere = playedLines[next.fen] ?? [];
      // KS-3278: всегда cycle на restart-bot-play; см. комментарий выше.
      const botPick = pickBotMove({
        edges: uncleanEdges,
        playedChildFens: sessionPlayedFromHere,
        repeatMode: 'cycle',
      });
      if (botPick.pick) {
        updatedPlayedLines = {
          ...playedLines,
          [next.fen]: botPick.cycled
            ? [botPick.pick.childFen]
            : [...sessionPlayedFromHere, botPick.pick.childFen],
        };
        finalFen = botPick.pick.childFen;
        finalPath = [...restartPath, botPick.pick.moveUci];
        initialBotMove = {
          moveUci: botPick.pick.moveUci,
          moveSan: botPick.pick.moveSan,
          newFen: botPick.pick.childFen,
        };
      }
      // Если botPick.pick === null — мы пришли в позицию, где у бота
      // тоже нет ходов. Реверсивно triggerим handleLineComplete... но
      // это unlikely (findNextUnexploredBranch уже отфильтровал такие).
      // Безопасно: просто оставляем пользователю эту fen (он сделает
      // что-то и снова попадём в handleLineComplete).
    }

    const updated = await this.repo.updateSession(session.id, {
      ...baseUpdate,
      currentFen: finalFen,
      currentPath: finalPath,
      cleanPlayedLines: cleanLines,
      playedLines: updatedPlayedLines,
      currentLineHadWrong: false,
      lineStartIndex: restartPath.length,
    });
    return {
      result: 'line-restart',
      applied: true,
      scoreDelta,
      newFen: finalFen,
      newPath: finalPath,
      botMove: initialBotMove,
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
      // KS-3278: cycle для bot moves (см. handleLineComplete).
      repeatMode: 'cycle',
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
  // KS-3277:
  cleanPlayedLines: unknown;
  currentLineHadWrong: boolean;
  lineStartIndex: number;
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

/**
 * KS-3277. Добавляет edges из `path[lineStartIndex..]` в
 * `cleanPlayedLines`. Для каждого ply: получаем FEN _до_ хода через
 * chess.js, применяем ход, получаем FEN _после_. `cleanLines[fenBefore]`
 * пополняется значением `fenAfter`.
 *
 * Используется при чистом line-complete (без wrong-attempts).
 */
export function addLineToClean(
  cleanLines: Record<string, string[]>,
  path: string[],
  lineStartIndex: number,
): Record<string, string[]> {
  const result: Record<string, string[]> = { ...cleanLines };
  const chess = new Chess();
  for (let i = 0; i < path.length; i++) {
    const fenBefore = chess.fen();
    let move: ReturnType<Chess['move']>;
    try {
      move = chess.move(uciToSan(chess, path[i]));
    } catch {
      // Невалидный путь — должен быть невозможен (мы сами его записали),
      // но на всякий случай прерываемся, не мутируя.
      return cleanLines;
    }
    if (!move) return cleanLines;
    if (i >= lineStartIndex) {
      const fenAfter = chess.fen();
      const arr = result[fenBefore] ?? [];
      if (!arr.includes(fenAfter)) {
        result[fenBefore] = [...arr, fenAfter];
      }
    }
  }
  return result;
}

/**
 * KS-3277. Walk `path` от конца к началу: возвращает первую (наиближайшую
 * к концу) позицию, в которой есть edges, не покрытые `cleanLines[fen]`.
 *
 * Возвращает `{fen, depth}`, где `depth` = длина `path` до этой
 * позиции (т.е. `path.slice(0, depth)` — точный prefix до новой
 * стартовой fen).
 *
 * `null` — все edges на пути уже clean (tree-complete).
 */
export function findNextUnexploredBranch(
  tree: RepertoireTree,
  path: string[],
  cleanLines: Record<string, string[]>,
): { fen: string; depth: number } | null {
  // Сначала вычисляем FEN на каждой глубине (включая depth=0=rootFen).
  const fens: string[] = [tree.rootFen];
  const chess = new Chess();
  for (let i = 0; i < path.length; i++) {
    try {
      chess.move(uciToSan(chess, path[i]));
    } catch {
      break;
    }
    fens.push(chess.fen());
  }
  // Walk от ПРЕДПОСЛЕДНЕЙ позиции (path.length − 1) к корню. Текущий
  // конец (path.length) пропускаем намеренно: KS-3278 — мы попали сюда
  // потому что бот не нашёл хода из current end. Возвращать туда же =
  // зацикливание (newFen == прежний currentFen → доска не двигается).
  // Всегда ищем точку ВЫШЕ по path.
  for (let depth = fens.length - 2; depth >= 0; depth--) {
    const fen = fens[depth];
    const edges = tree.nodes[fen]?.edges ?? [];
    const cleanHere = cleanLines[fen] ?? [];
    const uncleanCount = edges.filter(
      (e) => !cleanHere.includes(e.childFen),
    ).length;
    if (uncleanCount > 0) return { fen, depth };
  }
  return null;
}

/**
 * KS-3277 helper: chess.move() принимает SAN, а мы храним UCI.
 * Конвертация: chess.moves({verbose:true}) даёт все ходы в текущей
 * позиции с `from`/`to`/`promotion`/`san`; находим тот, у которого
 * совпадает UCI.
 */
function uciToSan(chess: Chess, uci: string): string {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : undefined;
  const moves = chess.moves({ verbose: true }) as Array<{
    from: string;
    to: string;
    promotion?: string;
    san: string;
  }>;
  const found = moves.find(
    (m) =>
      m.from === from &&
      m.to === to &&
      (promotion ? m.promotion === promotion : !m.promotion),
  );
  if (!found) {
    throw new Error(`UCI ${uci} not legal at ${chess.fen()}`);
  }
  return found.san;
}

// Re-export типы для тестов / других модулей.
export type { RepertoireEdge };
