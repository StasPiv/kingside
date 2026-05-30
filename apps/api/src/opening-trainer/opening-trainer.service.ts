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
import { OpeningLineProgressService } from './opening-line-progress.service';
import { pathHash } from './path-hash';
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
    // KS-3289 (M2 B3): per-path прогресс линий. Записывает на каждый
    // user-attempt КРОМЕ mode='free' (§2.7).
    private readonly progress: OpeningLineProgressService,
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

    // KS-3326 / ADR-078: поддержка двух форматов body.
    // 1. New: { sources: [...] }
    // 2. Legacy: { pgn } → конвертируем в [{ pgn, name: null }]
    // Указывать одновременно → 400.
    if (dto.pgn !== undefined && dto.sources !== undefined) {
      throw new BadRequestException(
        'Specify either `pgn` (legacy) or `sources` (new), not both',
      );
    }
    // KS-3475: вместе с pgn/name проносим sourceKind/archiveGameId
    // (опц.). Backend проставляет default 'pgn-upload' если не указан.
    const sourceInputs: Array<{
      pgn: string;
      name?: string | null;
      sourceKind?:
        | 'pgn-upload'
        | 'workshop-analysis'
        | 'legacy-import'
        | 'archive-position';
      archiveGameId?: string | null;
    }> = [];
    if (dto.sources && dto.sources.length > 0) {
      for (const s of dto.sources) {
        sourceInputs.push({
          pgn: s.pgn,
          name: s.name ?? null,
          sourceKind: s.sourceKind,
          archiveGameId: s.archiveGameId ?? null,
        });
      }
    } else if (dto.pgn !== undefined && dto.pgn.length > 0) {
      sourceInputs.push({ pgn: dto.pgn, name: null });
    } else {
      throw new BadRequestException(
        'At least one source is required (use `sources` array or legacy `pgn`)',
      );
    }
    if (
      sourceInputs.length > OPENING_REPERTOIRE_LIMITS.maxSourcesPerRepertoire
    ) {
      throw new BadRequestException(
        `Too many sources: ${sourceInputs.length} > ${OPENING_REPERTOIRE_LIMITS.maxSourcesPerRepertoire}`,
      );
    }

    // Создаём репертуар-shell (без tree пока), потом INSERT всех sources,
    // потом rebuild tree через builder с реальными sourceId'ями, потом
    // update tree-полей в репертуаре.
    const concatPgn = sourceInputs
      .map((s) => s.pgn)
      .join('\n\n')
      .trim();
    const shell = await this.repo.createRepertoire({
      userId,
      title: dto.title,
      description: dto.description ?? null,
      pgn: concatPgn,
      tree: { rootFen: '', nodes: {}, meta: { nodeCount: 0, edgeCount: 0, maxDepth: 0 } } as unknown as object,
      nodeCount: 0,
      edgeCount: 0,
      maxDepth: 0,
      side: dto.side ?? 'white',
    });

    try {
      const sources = [];
      for (const s of sourceInputs) {
        // KS-3475 (ADR-090 §8). sourceKind/archiveGameId — опц., default
        // 'pgn-upload'. archiveGameId сохраняем только для archive-position.
        const sk = (s.sourceKind ?? 'pgn-upload') as
          | 'pgn-upload'
          | 'workshop-analysis'
          | 'legacy-import'
          | 'archive-position';
        const row = await this.repo.createSource({
          repertoireId: shell.id,
          pgn: s.pgn,
          name: s.name ?? null,
          sourceKind: sk,
          archiveGameId:
            sk === 'archive-position' ? s.archiveGameId ?? null : null,
        });
        sources.push(row);
      }
      const tree = this.buildTreeOrThrow(
        sources.map((s) => ({ sourceId: s.id, pgn: s.pgn })),
      );
      const updated = await this.repo.updateRepertoire(shell.id, {
        pgn: concatPgn,
        tree: tree as unknown as object,
        nodeCount: tree.meta.nodeCount,
        edgeCount: tree.meta.edgeCount,
        maxDepth: tree.meta.maxDepth,
      });
      return rowToRepertoireDetailDto(updated, tree, sources);
    } catch (err) {
      // Атомарность: если builder упал — откатываем репертуар.
      // (CASCADE удалит созданные sources вместе с ним.)
      await this.repo
        .softDeleteRepertoire(shell.id, new Date())
        .catch(() => null);
      throw err;
    }
  }

  /**
   * KS-3326. Обёртка над builder с конвертацией ошибок в HTTP 400.
   */
  private buildTreeOrThrow(
    sources: Array<{ sourceId: string; pgn: string }>,
  ): RepertoireTree {
    try {
      return this.builder.buildTreeFromSources(sources);
    } catch (err) {
      if (
        err instanceof RepertoirePgnError ||
        err instanceof RepertoireLimitExceededError
      ) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /**
   * KS-3326. После любой source-операции (add/edit/delete) — пересобрать
   * tree, обновить репертуар (tree + denormalized pgn + meta) и
   * прогнать orphan-pruning по новым validHashes.
   */
  private async rebuildAndSyncTree(
    repertoireId: string,
  ): Promise<{ row: RepertoireRow; tree: RepertoireTree; sources: SourceRow[] }> {
    const sources = await this.repo.listSourcesByRepertoire(repertoireId);
    if (sources.length === 0) {
      throw new BadRequestException(
        'Repertoire has no sources — cannot rebuild tree',
      );
    }
    const tree = this.buildTreeOrThrow(
      sources.map((s) => ({ sourceId: s.id, pgn: s.pgn })),
    );
    const concatPgn = sources
      .map((s) => s.pgn)
      .join('\n\n')
      .trim();
    const updated = await this.repo.updateRepertoire(repertoireId, {
      pgn: concatPgn,
      tree: tree as unknown as object,
      nodeCount: tree.meta.nodeCount,
      edgeCount: tree.meta.edgeCount,
      maxDepth: tree.meta.maxDepth,
    });
    // Orphan-pruning: legacy-линии могли стать orphan'ами / воскреснуть.
    const validHashes = Array.from(enumerateTreePathHashes(tree));
    const r = await this.repo.markOrphans(repertoireId, validHashes);
    this.logger.log(
      `[rebuildAndSyncTree] rep=${repertoireId.slice(0, 8)}: ` +
        `markedOrphan=${r.markedOrphan} resurrected=${r.resurrected}`,
    );
    return { row: updated as RepertoireRow, tree, sources };
  }

  // ── KS-3326 / ADR-078: source endpoints ────────────────────────

  async listRepertoireSources(
    userId: string,
    repertoireId: string,
  ): Promise<import('@kingside/shared').OpeningRepertoireSourceDto[]> {
    await this.requireRepertoire(userId, repertoireId);
    const rows = await this.repo.listSourcesByRepertoire(repertoireId);
    return rows.map((r, idx) => sourceRowToDto(r, idx));
  }

  async getRepertoireSource(
    userId: string,
    repertoireId: string,
    sourceId: string,
  ): Promise<import('@kingside/shared').OpeningRepertoireSourceDto> {
    await this.requireRepertoire(userId, repertoireId);
    const rows = await this.repo.listSourcesByRepertoire(repertoireId);
    const idx = rows.findIndex((r) => r.id === sourceId);
    if (idx === -1) {
      throw new NotFoundException(`Source ${sourceId} not found`);
    }
    return sourceRowToDto(rows[idx], idx);
  }

  async addRepertoireSource(
    userId: string,
    repertoireId: string,
    input: {
      pgn: string;
      name?: string | null;
      sourceKind?:
        | 'pgn-upload'
        | 'workshop-analysis'
        | 'legacy-import'
        | 'archive-position';
      sourceAnalysisId?: string | null;
      /** KS-3475 (ADR-090 §8). Только для `sourceKind='archive-position'`. */
      archiveGameId?: string | null;
    },
  ): Promise<OpeningRepertoireDetailDto> {
    await this.requireRepertoire(userId, repertoireId);
    const existing = await this.repo.countSourcesByRepertoire(repertoireId);
    if (existing >= OPENING_REPERTOIRE_LIMITS.maxSourcesPerRepertoire) {
      throw new ConflictException(
        `Source limit reached: ${OPENING_REPERTOIRE_LIMITS.maxSourcesPerRepertoire} per repertoire`,
      );
    }
    const sk = input.sourceKind ?? 'pgn-upload';
    await this.repo.createSource({
      repertoireId,
      pgn: input.pgn,
      name: input.name ?? null,
      sourceKind: sk,
      sourceAnalysisId: input.sourceAnalysisId ?? null,
      archiveGameId:
        sk === 'archive-position' ? input.archiveGameId ?? null : null,
    });
    const { row, tree, sources } = await this.rebuildAndSyncTree(repertoireId);
    return rowToRepertoireDetailDto(row, tree, sources);
  }

  async updateRepertoireSource(
    userId: string,
    repertoireId: string,
    sourceId: string,
    input: { pgn?: string; name?: string | null },
  ): Promise<OpeningRepertoireDetailDto> {
    await this.requireRepertoire(userId, repertoireId);
    const src = await this.repo.findSourceById(sourceId);
    if (!src || src.repertoireId !== repertoireId) {
      throw new NotFoundException(`Source ${sourceId} not found`);
    }
    if (input.pgn === undefined && input.name === undefined) {
      throw new BadRequestException(
        'Specify at least one of: pgn, name',
      );
    }
    await this.repo.updateSource(sourceId, {
      ...(input.pgn !== undefined ? { pgn: input.pgn } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
    });
    // Если только name изменилось — пересборка не нужна, но мы всё равно
    // прогоняем для атомарности и единообразия (cheap для маленьких tree'ев).
    const { row, tree, sources } = await this.rebuildAndSyncTree(repertoireId);
    return rowToRepertoireDetailDto(row, tree, sources);
  }

  async deleteRepertoireSource(
    userId: string,
    repertoireId: string,
    sourceId: string,
  ): Promise<OpeningRepertoireDetailDto> {
    await this.requireRepertoire(userId, repertoireId);
    const src = await this.repo.findSourceById(sourceId);
    if (!src || src.repertoireId !== repertoireId) {
      throw new NotFoundException(`Source ${sourceId} not found`);
    }
    const count = await this.repo.countSourcesByRepertoire(repertoireId);
    if (count <= 1) {
      throw new ConflictException(
        'Cannot delete the last source — at least one is required',
      );
    }
    await this.repo.deleteSource(sourceId);
    const { row, tree, sources } = await this.rebuildAndSyncTree(repertoireId);
    return rowToRepertoireDetailDto(row, tree, sources);
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
    const sources = await this.repo.listSourcesByRepertoire(id);
    return rowToRepertoireDetailDto(row, tree, sources);
  }

  async updateRepertoire(
    userId: string,
    id: string,
    dto: UpdateRepertoireDto,
  ): Promise<OpeningRepertoireDetailDto> {
    const row = await this.requireRepertoire(userId, id);

    // Meta-поля (title/description/side) — простой update.
    const metaUpdate: Parameters<typeof this.repo.updateRepertoire>[1] = {};
    if (dto.title !== undefined) metaUpdate.title = dto.title;
    if (dto.description !== undefined) metaUpdate.description = dto.description;
    if (dto.side !== undefined) metaUpdate.side = dto.side;

    // KS-3326 / ADR-078: deprecated path. Если приходит `pgn` —
    // это означает «заменить все sources на один новый» (legacy
    // совместимость для существующих клиентов, которые ещё не
    // переключились на source-endpoints).
    let needRebuild = false;
    if (dto.pgn !== undefined && dto.pgn !== row.pgn) {
      this.logger.warn(
        `[updateRepertoire] DEPRECATED: legacy pgn-replace path for rep=${id.slice(0, 8)} — клиент должен переключиться на /sources endpoints (ADR-078)`,
      );
      // Удалить все существующие sources, INSERT один новый.
      const existing = await this.repo.listSourcesByRepertoire(id);
      for (const s of existing) {
        await this.repo.deleteSource(s.id);
      }
      await this.repo.createSource({
        repertoireId: id,
        pgn: dto.pgn,
        name: null,
        sourceKind: 'pgn-upload',
      });
      needRebuild = true;
    }

    if (Object.keys(metaUpdate).length > 0) {
      await this.repo.updateRepertoire(id, metaUpdate);
    }

    if (needRebuild) {
      const { row: updated, tree, sources } = await this.rebuildAndSyncTree(id);
      return rowToRepertoireDetailDto(updated, tree, sources);
    }

    // Нет pgn-замены — просто возвращаем обновлённую meta + текущий tree + sources.
    const refreshed = await this.repo.findRepertoireById(id);
    if (!refreshed) {
      throw new NotFoundException(`Repertoire ${id} not found after update`);
    }
    const tree = jsonToTree(refreshed.tree);
    const sources = await this.repo.listSourcesByRepertoire(id);
    return rowToRepertoireDetailDto(refreshed, tree, sources);
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

    // KS-3481: лимит maxActiveSessionsPerUser снят. Перед созданием
    // новой сессии автоматически закрываем все висящие активные
    // сессии пользователя (status='expired', finishedAt=now). Это
    // снимает «Active session limit reached» из UX и одновременно
    // не оставляет zombi-сессий в БД. Если у пользователя был реальный
    // прогресс в открытой сессии — он уже отражён в OpeningLineProgress
    // через runtime-апдейты после каждого хода (KS-3288), так что
    // сама закрываемая сессия не несёт уникальной информации.
    const expired = await this.repo.expireActiveSessionsByUser(userId);
    if (expired > 0) {
      this.logger.log(
        `[startSession] auto-expired ${expired} active session(s) for user=${userId.slice(0, 8)}`,
      );
    }

    const tree = jsonToTree(repertoire.tree);

    // KS-3302: side фиксируется на репертуаре, dto.side ИГНОРИРУЕТСЯ.
    // Старые клиенты могут прислать `side` — мы пропустим.
    const side = (repertoire as { side?: 'white' | 'black' }).side ?? 'white';

    // KS-3290 (M2 B4): review-режим — выбираем due-линию, replay PGN
    // до её позиции и стартуем сессию С НЕЙ.
    if (dto.mode === 'review') {
      const due = await this.repo.listDueLineProgress(userId, {
        now: new Date(),
        repertoireId,
      });
      if (due.length === 0) {
        throw new BadRequestException('no_lines_due');
      }
      const line = due[0];
      const pathUci = (line.pathUci as unknown as string[]) ?? [];
      const replayFen = this.replayPathToFen(tree.rootFen, pathUci);
      const session = await this.repo.createSession({
        userId,
        repertoireId,
        side,
        mode: 'review',
        repeatMode: dto.repeatMode,
        currentFen: replayFen,
        initialPath: pathUci,
        lineStartIndex: pathUci.length,
        reviewLinePathUci: pathUci,
      });
      return {
        session: sessionRowToDto(session),
        initialBotMove: null,
      };
    }

    // KS-3291 (M2 B5): mistakes-режим — выбираем линию с ошибками.
    if (dto.mode === 'mistakes') {
      const mistakes = await this.repo.listMistakeLineProgress(
        userId,
        repertoireId,
      );
      if (mistakes.length === 0) {
        throw new BadRequestException('no_mistakes');
      }
      const line = mistakes[0];
      const pathUci = (line.pathUci as unknown as string[]) ?? [];
      const replayFen = this.replayPathToFen(tree.rootFen, pathUci);
      const session = await this.repo.createSession({
        userId,
        repertoireId,
        side,
        mode: 'mistakes',
        repeatMode: dto.repeatMode,
        currentFen: replayFen,
        initialPath: pathUci,
        lineStartIndex: pathUci.length,
      });
      return {
        session: sessionRowToDto(session),
        initialBotMove: null,
      };
    }

    let session = await this.repo.createSession({
      userId,
      repertoireId,
      side,
      mode: dto.mode,
      repeatMode: dto.repeatMode,
      currentFen: tree.rootFen,
    });

    // Если играем чёрными — бот делает первый ход (белыми).
    let initialBotMove: StartOpeningTrainerSessionResponse['initialBotMove'] =
      null;
    if (side === 'black') {
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
      // KS-3289 (M2 B3): per-path прогресс. Для wrong — pathUci =
      // currentPath без applied-move'а (move не применён). Mode='free'
      // не учитываем (§2.7 ADR-077).
      if (session.mode !== 'free') {
        await this.progress
          .recordAttempt({
            userId,
            repertoireId: session.repertoireId,
            pathUci: readUciArray(session.currentPath),
            correct: false,
            now,
          })
          .catch((err) => {
            this.logger.warn(
              `[makeMove] recordAttempt(wrong) failed for session=${sessionId.slice(0, 8)}: ${(err as Error).message}`,
            );
          });
      }
      // KS-3290 (M2 B4): review-режим — wrong на review-линии → SM-2
      // applyReview(quality=1) сразу. Не дожидаемся line-complete.
      if (session.mode === 'review' && session.reviewLinePathUci) {
        const reviewPath = readUciArray(session.reviewLinePathUci);
        await this.progress
          .applyReviewResult({
            userId,
            repertoireId: session.repertoireId,
            pathUci: reviewPath,
            quality: 1,
            now,
          })
          .catch((err) => {
            this.logger.warn(
              `[makeMove] applyReviewResult(q=1) failed for session=${sessionId.slice(0, 8)}: ${(err as Error).message}`,
            );
          });
      }
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

    // KS-3289 (M2 B3): per-path прогресс. Для correct — pathUci =
    // currentPath + appliedMove (это путь от root до позиции ПОСЛЕ
    // нашего хода). Mode='free' не учитываем (§2.7).
    if (session.mode !== 'free') {
      await this.progress
        .recordAttempt({
          userId,
          repertoireId: session.repertoireId,
          pathUci: newPathAfterUser,
          correct: true,
          now,
        })
        .catch((err) => {
          this.logger.warn(
            `[makeMove] recordAttempt(correct) failed for session=${sessionId.slice(0, 8)}: ${(err as Error).message}`,
          );
        });
    }

    // KS-3317: в mistakes-mode при correct первого хода (когда юзер
    // отвечает на исходную mistake-позицию) — дополнительный апдейт
    // самой mistake-pathUci (равной session.currentPath на момент хода).
    // Без этого `wrongCount > 0` остаётся forever, линия каждую новую
    // mistakes-сессию первая в выборке `listMistakeLineProgress` (баг:
    // «при каждом заходе одна и та же позиция»).
    //
    // Парный фикс — фильтр `consecutiveCorrect: 0` в
    // `listMistakeLineProgress`. После этого recordAttempt(correct) на
    // mistake-pathUci сделает `consecutiveCorrect = 1`, и линия выйдет
    // из mistakes-pool в следующих сессиях.
    if (
      session.mode === 'mistakes' &&
      readUciArray(session.currentPath).length === session.lineStartIndex
    ) {
      const mistakePath = readUciArray(session.currentPath);
      await this.progress
        .recordAttempt({
          userId,
          repertoireId: session.repertoireId,
          pathUci: mistakePath,
          correct: true,
          now,
        })
        .catch((err) => {
          this.logger.warn(
            `[makeMove] recordAttempt(mistake-fix) failed for session=${sessionId.slice(0, 8)}: ${(err as Error).message}`,
          );
        });
    }

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
      const newPath = [...newPathAfterUser, botPick.pick.moveUci];
      const newCurrentFen = botPick.pick.childFen;
      const newPlayedLines = {
        ...playedLines,
        [fenAfterUser]: botPick.cycled
          ? [botPick.pick.childFen]
          : [...playedFromHere, botPick.pick.childFen],
      };

      // KS-3318: бот мог привести в листовую позицию (нет edges в дереве).
      // Если оставить сессию active с currentFen=лист — юзер застрянет:
      //   - hint бросает «No hint available» (edges пустой).
      //   - любой следующий ход юзера → result='wrong' (matched=undefined).
      // Поэтому триггерим handleLineComplete с новой fenAfterUser
      // (это лист) и обновлёнными playedLines/path. Для learn/free —
      // line-restart на root / next-branch; для mistakes/review —
      // tree-complete (KS-3316).
      const newPosEdges = tree.nodes[newCurrentFen]?.edges ?? [];
      if (newPosEdges.length === 0) {
        return this.handleLineComplete({
          session: {
            ...session,
            playedLines: newPlayedLines as unknown as object,
          },
          tree,
          newPath,
          fenAfterUser: newCurrentFen,
          cleanLines,
          baseUpdate,
          scoreDelta: scoreRes.scoreDelta,
          now,
        });
      }

      // Линия продолжается — бот сделал свой ход, новая позиция не лист.
      const updated = await this.repo.updateSession(sessionId, {
        ...baseUpdate,
        currentFen: newCurrentFen,
        currentPath: newPath,
        playedLines: newPlayedLines,
      });
      return {
        result: 'correct',
        applied: true,
        scoreDelta: scoreRes.scoreDelta,
        newFen: newCurrentFen,
        botMove: {
          moveUci: botPick.pick.moveUci,
          moveSan: botPick.pick.moveSan,
          newFen: newCurrentFen,
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
      userId: string;
      repertoireId: string;
      side: string;
      mode: string;
      currentLineHadWrong: boolean;
      lineStartIndex: number;
      playedLines: unknown;
      repeatMode: string;
      reviewLinePathUci: unknown;
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

    // KS-3301 (re-apply aa2cd5 fix): ВСЕГДА маркируем edges в cleanLines,
    // даже если в линии были wrong-attempts. Раньше `currentLineHadWrong`
    // гейтил addLineToClean — но это причина прод-бага «два раза один и
    // тот же ход»:
    //   * user играет правильный ход в линии, у бота нет ходов →
    //     handleLineComplete с currentLineHadWrong=true (был wrong раньше).
    //   * addLineToClean skipped → cleanLines не обновляется.
    //   * findNextUnexploredBranch видит user-edge как unclean (только
    //     KS-3281 фильтр исключает его на depth=fens.length-2),
    //     возвращает корневую позицию.
    //   * Бот replays первый ход → user видит ту же позицию.
    //
    // Trade-off: «грязные линии остаются в очереди» (KS-3277 design intent)
    // частично теряется. Multi-edge dirty-replay сохраняется через
    // KS-3281 filter (rest line на ALTERNATIVNUYU ветку); single-edge
    // dirty проходит сразу. Полную dirty-queue с per-line wrong-
    // tracking — в M3 (нужен per-line attempt-counter, не одна
    // session-флаг).
    cleanLines = addLineToClean(cleanLines, newPath, session.lineStartIndex);

    // KS-3290 (M2 B4): review-режим — clean line-complete без ошибок
    // → SM-2 applyReview(quality=5) на review-линию (продвигает interval).
    if (
      session.mode === 'review' &&
      !session.currentLineHadWrong &&
      session.reviewLinePathUci
    ) {
      const reviewPath = readUciArray(session.reviewLinePathUci);
      await this.progress
        .applyReviewResult({
          userId: session.userId,
          repertoireId: session.repertoireId,
          pathUci: reviewPath,
          quality: 5,
          now: args.now,
        })
        .catch((err) => {
          this.logger.warn(
            `[handleLineComplete] applyReviewResult(q=5) failed for session=${session.id.slice(0, 8)}: ${(err as Error).message}`,
          );
        });
    }

    // KS-3316: review/mistakes — одна сессия = одна линия. После её
    // прохождения НЕ ищем next-branch и не делаем line-restart на root
    // (иначе бот сыграет первый ход репертуара, и пользователь увидит
    // ту же стартовую позицию что в начале сессии — баг «один и тот же
    // ход дважды»). Финишируем сессию; UI предлагает «взять следующую
    // due-линию» или «вернуться на главную».
    if (session.mode === 'mistakes' || session.mode === 'review') {
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

    // 2. Ищем следующую развилку (learn / free — обход всего дерева).
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
        // KS-3307. См. computeAccuracyPercent.
        accuracyPercent: computeAccuracyPercent(
          updated.correctMoves,
          updated.wrongMoves,
        ),
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

  /**
   * KS-3290 (M2 B4). Прогоняет PGN-путь от root через chess.js, возвращая
   * FEN финальной позиции. Используется для review/mistakes mode'ов,
   * где сессия должна стартовать в середине дерева.
   */
  private replayPathToFen(rootFen: string, path: string[]): string {
    const chess = new Chess(rootFen);
    for (const uci of path) {
      try {
        const san = uciToSan(chess, uci);
        chess.move(san);
      } catch {
        // Корруптный path — fail loud (это inconsistency с tree).
        throw new BadRequestException(
          `Invalid path in repertoire progress: ${uci} not legal at ${chess.fen()}`,
        );
      }
    }
    return chess.fen();
  }

  // ── KS-3283 (M2 stats): GET /opening-trainer/repertoires/:id/stats ──

  /**
   * Агрегатная статистика прохождения репертуара для текущего юзера.
   * Used by frontend stats-страницы (KS-3273 follow-up).
   *
   * Загружает все sessions + attempts в память для агрегации
   * (типичный объём — сотни attempts на репертуар, тысячи — overkill
   * но не блокер). Если в будущем станет hot-path → переход на raw
   * SQL aggregate / materialized view.
   */
  async getRepertoireStats(userId: string, repertoireId: string) {
    await this.requireRepertoire(userId, repertoireId);

    const sessions = await this.repo.listSessionsForRepertoire(
      userId,
      repertoireId,
    );
    const allAttempts = await this.repo.listAttemptsForRepertoire(
      userId,
      repertoireId,
    );

    // Session aggregates.
    const totalSessions = sessions.length;
    const completedSessions = sessions.filter(
      (s) => s.status === 'finished',
    ).length;
    const hintsUsed = sessions.reduce((sum, s) => sum + s.hintsUsed, 0);

    // Attempt aggregates.
    const totalAttempts = allAttempts.length;
    const correctAttempts = allAttempts.filter((a) => a.correct).length;
    const wrongAttempts = totalAttempts - correctAttempts;
    const accuracyPercent =
      totalAttempts > 0
        ? Math.round((correctAttempts / totalAttempts) * 100)
        : 0;

    // Top error positions: group by positionFen, count wrong/total,
    // find most-frequent wrong move (mode).
    type PositionAcc = {
      positionFen: string;
      expectedMoves: string[];
      wrongCount: number;
      totalCount: number;
      wrongMoveCounts: Map<string, number>;
    };
    const byPosition = new Map<string, PositionAcc>();
    for (const a of allAttempts) {
      let acc = byPosition.get(a.positionFen);
      if (!acc) {
        acc = {
          positionFen: a.positionFen,
          expectedMoves: (a.expectedMoves as unknown as string[]) ?? [],
          wrongCount: 0,
          totalCount: 0,
          wrongMoveCounts: new Map(),
        };
        byPosition.set(a.positionFen, acc);
      }
      acc.totalCount++;
      if (!a.correct) {
        acc.wrongCount++;
        acc.wrongMoveCounts.set(
          a.userMove,
          (acc.wrongMoveCounts.get(a.userMove) ?? 0) + 1,
        );
      }
    }
    const topErrorPositions = Array.from(byPosition.values())
      .filter((p) => p.wrongCount > 0)
      .sort((a, b) => {
        if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
        return b.wrongCount / b.totalCount - a.wrongCount / a.totalCount;
      })
      .slice(0, 10)
      .map((p) => {
        // Find mode of wrong-moves. Если несколько вариантов с
        // одинаковым max count — null (нет clear mode).
        let maxCount = 0;
        let mostFrequent: string | null = null;
        for (const [move, count] of p.wrongMoveCounts.entries()) {
          if (count > maxCount) {
            maxCount = count;
            mostFrequent = move;
          }
        }
        const tieCount = Array.from(p.wrongMoveCounts.values()).filter(
          (c) => c === maxCount,
        ).length;
        const mode = tieCount === 1 ? mostFrequent : null;
        return {
          positionFen: p.positionFen,
          expectedMoves: p.expectedMoves,
          mostFrequentWrongMove: mode,
          wrongCount: p.wrongCount,
          totalCount: p.totalCount,
          errorRate: p.wrongCount / p.totalCount,
        };
      });

    // Last sessions (already sorted desc by startedAt; берём 10).
    // KS-3307. accuracy = correct / (correct + wrong); раньше делили на
    // movesPlayed → wrong-attempts не учитывались (movesPlayed === correct).
    const lastSessions = sessions.slice(0, 10).map((s) => {
      const totalAttempts = s.correctMoves + s.wrongMoves;
      return {
        id: s.id,
        finishedAt: s.finishedAt?.toISOString() ?? null,
        score: s.score,
        accuracy: totalAttempts > 0 ? s.correctMoves / totalAttempts : 0,
      };
    });

    return {
      repertoireId,
      totalSessions,
      completedSessions,
      totalAttempts,
      correctAttempts,
      wrongAttempts,
      hintsUsed,
      accuracyPercent,
      topErrorPositions,
      lastSessions,
    };
  }

  // ── KS-3294 (M2 B8): GET /opening-trainer/repertoires/:id/active-session ──

  /**
   * Последняя неоконченная сессия пользователя по репертуару с
   * `lastActivityAt > now - 7d`, иначе null. Используется для
   * sticky-карточки «продолжить тренировку».
   */
  async getActiveSession(
    userId: string,
    repertoireId: string,
  ): Promise<{ session: OpeningTrainerSessionDto | null }> {
    await this.requireRepertoire(userId, repertoireId);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const session = await this.repo.findLatestActiveSession(
      userId,
      repertoireId,
      sevenDaysAgo,
    );
    return {
      session: session ? sessionRowToDto(session) : null,
    };
  }

  // ── KS-3293 (M2 B7): POST /opening-trainer/repertoires/from-analysis ──

  /**
   * Конверсия из мастерской: создаёт репертуар из существующего
   * `Analysis.pgn` (текущего юзера). Owner-check, лимиты, PGN-парсинг —
   * все те же что и в `createRepertoire`.
   *
   * Title по умолчанию = `analysis.title` или `analysis.headline` или
   * fallback `'Опенинг из анализа'`.
   */
  async createRepertoireFromAnalysis(
    userId: string,
    input: {
      analysisId: string;
      title?: string;
      description?: string;
      side?: 'white' | 'black';
      // KS-3327 / ADR-078: если задан, добавляем source в существующий
      // репертуар вместо создания нового.
      repertoireId?: string;
    },
  ): Promise<OpeningRepertoireDetailDto> {
    const analysis = await this.repo.findAnalysisById(input.analysisId);
    if (!analysis || analysis.userId !== userId) {
      throw new NotFoundException(`Analysis ${input.analysisId} not found`);
    }
    if (!analysis.pgn || analysis.pgn.trim().length === 0) {
      throw new BadRequestException(
        'Analysis has no PGN content to import as repertoire',
      );
    }
    const sourceName =
      input.title?.trim() ||
      analysis.title?.trim() ||
      analysis.headline?.trim() ||
      `Из анализа от ${new Date().toISOString().slice(0, 10)}`;

    // KS-3327: ветка «добавить в существующий».
    if (input.repertoireId) {
      // requireRepertoire + addRepertoireSource внутри сделают owner-check
      // и лимит maxSourcesPerRepertoire.
      return this.addRepertoireSource(userId, input.repertoireId, {
        pgn: analysis.pgn,
        name: sourceName,
        sourceKind: 'workshop-analysis',
        sourceAnalysisId: input.analysisId,
      });
    }

    // KS-3293 (legacy): создаём новый репертуар с одним source.
    // Используем напрямую createRepertoire с legacy-pgn-форматом —
    // он внутри сконвертит в один source с `sourceKind='pgn-upload'`,
    // потом мы апдейтим источник до `workshop-analysis`.
    const created = await this.createRepertoire(userId, {
      title: sourceName,
      description: input.description,
      pgn: analysis.pgn,
      side: input.side,
    });
    // Перепометить kind созданного source'а на 'workshop-analysis' +
    // ссылка на analysisId. У свежесозданного репертуара ровно один source.
    if (created.sources.length === 1) {
      const onlySource = created.sources[0];
      await this.repo['prisma'].openingRepertoireSource.update({
        where: { id: onlySource.id },
        data: {
          sourceKind: 'workshop-analysis',
          sourceAnalysisId: input.analysisId,
        },
      });
      const refreshed = await this.repo.listSourcesByRepertoire(created.id);
      return {
        ...created,
        sources: refreshed.map((s, i) => sourceRowToDto(s, i)),
      };
    }
    return created;
  }

  // ── KS-3292 (M2 B6): GET /opening-trainer/repertoires/:id/progress ──

  /**
   * Список прогресса по линиям репертуара с derived `status:
   * OpeningLineStatus` (ADR-077 §5 / KS-3286 shared types).
   *
   * Status-rules:
   *   - `mastered`: masteredAt && (!sm2DueAt || sm2DueAt > now).
   *   - `due`: sm2DueAt && sm2DueAt <= now (mastered + просрочено).
   *   - `wrong`: wrongCount > correctCount.
   *   - `learning`: есть попытки, но не подпадает под выше.
   *   - `not-played` НЕ возвращается — записи создаются только при
   *     первой попытке. Фронт вычисляет 'not-played' для edges из
   *     `tree.nodes`, которых нет в массиве `lines`.
   *
   * Orphaned не фильтруются — фронт скрывает по `orphaned: true` сам.
   * Owner-check через `requireRepertoire` (404 для чужого).
   */
  async listRepertoireProgress(userId: string, repertoireId: string) {
    await this.requireRepertoire(userId, repertoireId);
    const rows = await this.repo.listLineProgress(userId, repertoireId);
    const now = new Date();
    return {
      repertoireId,
      lines: rows.map((r) => ({
        id: r.id,
        repertoireId: r.repertoireId,
        pathHash: r.pathHash,
        pathUci: (r.pathUci as unknown as string[]) ?? [],
        pathLength: r.pathLength,
        correctCount: r.correctCount,
        wrongCount: r.wrongCount,
        consecutiveCorrect: r.consecutiveCorrect,
        lastPlayedAt: r.lastPlayedAt.toISOString(),
        masteredAt: r.masteredAt?.toISOString() ?? null,
        sm2DueAt: r.sm2DueAt?.toISOString() ?? null,
        sm2Interval: r.sm2Interval ?? null,
        sm2Easiness: r.sm2Easiness ?? null,
        sm2Reps: r.sm2Reps ?? null,
        orphaned: r.orphaned,
        status: deriveLineStatus(r, now),
      })),
    };
  }

  // ── KS-3290 (M2 B4): GET /opening-trainer/reviews/due ──────────

  /**
   * Список линий «к повтору сегодня» — SRS-выборка по `sm2DueAt <= now`.
   * Без `repertoireId` — across all my repertoires; денормализуем
   * `repertoireTitle` для UI.
   */
  async listDueReviews(
    userId: string,
    opts: { repertoireId?: string } = {},
  ) {
    const now = new Date();
    const rows = await this.repo.listDueLineProgress(userId, {
      now,
      repertoireId: opts.repertoireId,
    });
    // Денормализуем repertoireTitle (один запрос на все уникальные
    // repertoireId — N+1 не страшен на типичных 5-20 линий).
    const repertoireIds = Array.from(new Set(rows.map((r) => r.repertoireId)));
    const repertoires = await Promise.all(
      repertoireIds.map(async (id) => {
        const r = await this.repo.findRepertoireById(id);
        return r && r.userId === userId
          ? { id: r.id, title: r.title }
          : null;
      }),
    );
    const titleById = new Map(
      repertoires
        .filter((x): x is { id: string; title: string } => x !== null)
        .map((r) => [r.id, r.title]),
    );
    return {
      lines: rows.map((r) => ({
        id: r.id,
        repertoireId: r.repertoireId,
        pathHash: r.pathHash,
        pathUci: (r.pathUci as unknown as string[]) ?? [],
        pathLength: r.pathLength,
        correctCount: r.correctCount,
        wrongCount: r.wrongCount,
        consecutiveCorrect: r.consecutiveCorrect,
        lastPlayedAt: r.lastPlayedAt.toISOString(),
        masteredAt: r.masteredAt?.toISOString() ?? null,
        sm2DueAt: r.sm2DueAt?.toISOString() ?? null,
        sm2Interval: r.sm2Interval ?? null,
        sm2Easiness: r.sm2Easiness ?? null,
        sm2Reps: r.sm2Reps ?? null,
        orphaned: r.orphaned,
        repertoireTitle: titleById.get(r.repertoireId) ?? '',
      })),
    };
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
  side?: string; // KS-3302; опц. для legacy-rows
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
  reviewLinePathUci: unknown;
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
    // KS-3302: side из row. Default 'white' для legacy.
    side: (row.side as 'white' | 'black' | undefined) ?? 'white',
    nodeCount: row.nodeCount,
    edgeCount: row.edgeCount,
    maxDepth: row.maxDepth,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface SourceRow {
  id: string;
  repertoireId: string;
  name: string | null;
  pgn: string;
  sourceKind: string;
  sourceAnalysisId: string | null;
  /** KS-3475 (ADR-090 §8). */
  archiveGameId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function sourceRowToDto(
  row: SourceRow,
  order: number,
): import('@kingside/shared').OpeningRepertoireSourceDto {
  return {
    id: row.id,
    repertoireId: row.repertoireId,
    name: row.name,
    pgn: row.pgn,
    sourceKind: row.sourceKind as
      | 'pgn-upload'
      | 'workshop-analysis'
      | 'legacy-import'
      | 'archive-position',
    sourceAnalysisId: row.sourceAnalysisId,
    archiveGameId: row.archiveGameId ?? null,
    order,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToRepertoireDetailDto(
  row: RepertoireRow,
  tree: RepertoireTree,
  sources: SourceRow[] = [],
): OpeningRepertoireDetailDto {
  return {
    ...rowToRepertoireDto(row),
    pgn: row.pgn,
    tree,
    // KS-3324/3326 / ADR-078: реальный список из БД (отсортирован по
    // createdAt ASC в repository). order = index в массиве.
    sources: sources.map((s, idx) => sourceRowToDto(s, idx)),
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
    // KS-3307. accuracyPercent = correct / (correct + wrong) * 100.
    // НЕ correct / movesPlayed: wrong-attempts не двигают movesPlayed,
    // потому давали 100% при любом числе ошибок.
    accuracyPercent: computeAccuracyPercent(row.correctMoves, row.wrongMoves),
    startedAt: row.startedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/**
 * KS-3307. Единая формула accuracy для session DTO / finish summary /
 * stats lastSessions. Округление до целого (UI показывает %).
 */
function computeAccuracyPercent(correct: number, wrong: number): number {
  const total = correct + wrong;
  if (total <= 0) return 0;
  return Math.round((correct / total) * 100);
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
 * KS-3294 (M2 B8). DFS через tree → set всех pathHash'ей, которые
 * соответствуют валидным линиям в текущем дереве. Используется в
 * `updateRepertoire` для orphan-pruning.
 *
 * Включает:
 *   - пустой path (root) — `pathHash([])`.
 *   - все prefix-paths по edges (любой intermediate node — это
 *     потенциальная line endpoint).
 *
 * Транспозиции (один fen достижим через разные пути) дают разные
 * pathHash'и — все валидные. `visited` set по `(fenFrom, moveUci)`
 * предотвращает бесконечный обход.
 *
 * Сложность: O(edges) ≤ 5000 итераций + 5000 sha1 — десятки
 * миллисекунд max (admin-операция, не hot-path).
 */
function enumerateTreePathHashes(tree: RepertoireTree): Set<string> {
  const hashes = new Set<string>();
  hashes.add(pathHash([])); // root itself

  const stack: Array<{ fen: string; path: string[] }> = [
    { fen: tree.rootFen, path: [] },
  ];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const { fen, path } = stack.pop()!;
    const node = tree.nodes[fen];
    if (!node) continue;
    for (const edge of node.edges) {
      const edgeKey = `${fen}|${edge.moveUci}`;
      if (visited.has(edgeKey)) continue;
      visited.add(edgeKey);
      const newPath = [...path, edge.moveUci];
      hashes.add(pathHash(newPath));
      stack.push({ fen: edge.childFen, path: newPath });
    }
  }

  return hashes;
}

/**
 * KS-3292 (M2 B6). Derive `OpeningLineStatus` из row+now.
 * Правила:
 *   - `mastered`: masteredAt && (!sm2DueAt || sm2DueAt > now).
 *   - `due`: masteredAt && sm2DueAt && sm2DueAt <= now.
 *   - `wrong`: wrongCount > correctCount.
 *   - `learning`: всё остальное (есть попытки, но не mastered/wrong).
 *
 * `not-played` НЕ возвращается — фронт вычисляет для edges из
 * `tree.nodes`, которых нет в массиве `lines`.
 */
function deriveLineStatus(
  row: {
    correctCount: number;
    wrongCount: number;
    masteredAt: Date | null;
    sm2DueAt: Date | null;
  },
  now: Date,
): 'learning' | 'wrong' | 'mastered' | 'due' {
  if (row.masteredAt) {
    if (row.sm2DueAt && row.sm2DueAt.getTime() <= now.getTime()) {
      return 'due';
    }
    return 'mastered';
  }
  if (row.wrongCount > row.correctCount) {
    return 'wrong';
  }
  return 'learning';
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
  // потому что бот не нашёл хода из current end.
  //
  // KS-3281: при depth=fens.length-2 (позиция ОТКУДА юзер только что
  // сделал ход) — исключаем user-edge из unclean-кандидатов. Иначе
  // dirty-сценарий (`!currentLineHadWrong`-ветка выше пропустила
  // addLineToClean) даст unclean=[user-edge] → return same position →
  // restart в ту же позицию = doski_не_двигается = бесконечный цикл.
  // Исключение user-edge даёт корректную семантику: если у юзера
  // несколько unclean-альтернатив — рестарт сюда (юзер выбирает другой
  // вариант); если только user-edge unclean → walking up.
  for (let depth = fens.length - 2; depth >= 0; depth--) {
    const fen = fens[depth];
    const edges = tree.nodes[fen]?.edges ?? [];
    const cleanHere = cleanLines[fen] ?? [];
    let uncleanEdges = edges.filter(
      (e) => !cleanHere.includes(e.childFen),
    );
    if (depth === fens.length - 2) {
      // childFen user-edge'а = позиция, в которую попал ход = fens[depth+1].
      const userEdgeChildFen = fens[depth + 1];
      uncleanEdges = uncleanEdges.filter(
        (e) => e.childFen !== userEdgeChildFen,
      );
    }
    if (uncleanEdges.length > 0) return { fen, depth };
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
