import { Injectable } from '@nestjs/common';
import { Prisma } from '@kingside/db';
import { PrismaService } from '../prisma/prisma.service';

/**
 * KS-3270 (ADR-077 §2.1, §2.6). Тонкий слой доступа к данным для
 * Opening Trainer'а. Сервисная логика (валидация PGN, бот-picker,
 * скоринг) живёт в отдельных файлах KS-3271 / KS-3272 — здесь только
 * репозиторий, чтобы:
 *
 *   1. Тестируемо изолировать prisma-вызовы.
 *   2. Дать единое место для добавления soft-delete фильтра
 *      (`deletedAt: null`) — backend service не должен случайно
 *      получить soft-deleted репертуар.
 *   3. Скрыть Prisma-нюансы (Json-поля, default'ы) от controllers.
 *
 * Возвращает «сырые» Prisma-объекты — конвертация в shared DTO
 * (`OpeningRepertoireDto` и т.п.) — задача сервисов в KS-3272.
 */
@Injectable()
export class OpeningTrainerRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── OpeningRepertoire ────────────────────────────────────────────

  /**
   * Список репертуаров пользователя. Soft-deleted (`deletedAt != null`)
   * отфильтрованы по умолчанию — это правильное поведение для лобби.
   * Если в M2 нам понадобится «restore from trash» UI — добавим параметр
   * `includeDeleted: true`.
   */
  async listRepertoires(
    userId: string,
    opts: { take?: number; skip?: number } = {},
  ) {
    return this.prisma.openingRepertoire.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: opts.take ?? 50,
      skip: opts.skip ?? 0,
    });
  }

  /**
   * Конкретный репертуар. Soft-deleted ВКЛЮЧЁН в выборку — нужен для
   * 410 Gone на /:id если только что удалили (UX вежливее, чем 404).
   * Owner-check — на уровне сервиса.
   */
  async findRepertoireById(id: string) {
    return this.prisma.openingRepertoire.findUnique({ where: { id } });
  }

  async countRepertoiresByUser(userId: string): Promise<number> {
    return this.prisma.openingRepertoire.count({
      where: { userId, deletedAt: null },
    });
  }

  async createRepertoire(data: {
    userId: string;
    title: string;
    description?: string | null;
    pgn: string;
    tree: Prisma.InputJsonValue;
    nodeCount: number;
    edgeCount: number;
    maxDepth: number;
  }) {
    return this.prisma.openingRepertoire.create({
      data: {
        userId: data.userId,
        title: data.title,
        description: data.description ?? null,
        pgn: data.pgn,
        tree: data.tree,
        nodeCount: data.nodeCount,
        edgeCount: data.edgeCount,
        maxDepth: data.maxDepth,
      },
    });
  }

  async updateRepertoire(
    id: string,
    data: {
      title?: string;
      description?: string | null;
      pgn?: string;
      tree?: Prisma.InputJsonValue;
      nodeCount?: number;
      edgeCount?: number;
      maxDepth?: number;
    },
  ) {
    return this.prisma.openingRepertoire.update({ where: { id }, data });
  }

  /**
   * Soft-delete: проставляем `deletedAt = now`. Hard-delete делает
   * cleanup job через 30 дней (M2, отдельный scheduler).
   */
  async softDeleteRepertoire(id: string, now: Date = new Date()) {
    return this.prisma.openingRepertoire.update({
      where: { id },
      data: { deletedAt: now },
    });
  }

  // ── OpeningTrainerSession ────────────────────────────────────────

  async createSession(data: {
    userId: string;
    repertoireId: string;
    side: 'white' | 'black';
    mode: 'learn' | 'review' | 'mistakes' | 'free';
    repeatMode?: 'cycle' | 'complete';
    currentFen: string;
    // KS-3290 (B4): для review-режима — начальный path и review-line.
    initialPath?: string[];
    lineStartIndex?: number;
    reviewLinePathUci?: string[] | null;
  }) {
    return this.prisma.openingTrainerSession.create({
      data: {
        userId: data.userId,
        repertoireId: data.repertoireId,
        side: data.side,
        mode: data.mode,
        repeatMode: data.repeatMode ?? 'complete',
        status: 'active',
        playedLines: {},
        currentFen: data.currentFen,
        currentPath: (data.initialPath ?? []) as unknown as Prisma.InputJsonValue,
        lineStartIndex: data.lineStartIndex ?? 0,
        ...(data.reviewLinePathUci !== undefined
          ? {
              reviewLinePathUci:
                data.reviewLinePathUci as unknown as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
  }

  async findSessionById(id: string) {
    return this.prisma.openingTrainerSession.findUnique({ where: { id } });
  }

  /**
   * Количество активных (не завершённых) сессий — для проверки лимита
   * `OPENING_REPERTOIRE_LIMITS.maxActiveSessionsPerUser`.
   */
  async countActiveSessionsByUser(userId: string): Promise<number> {
    return this.prisma.openingTrainerSession.count({
      where: { userId, status: 'active' },
    });
  }

  /**
   * Patch'ит сессию (после хода / hint'а / undo / финиша). Поля
   * указываются явно — каждый caller передаёт только то, что меняет.
   */
  async updateSession(
    id: string,
    data: {
      status?: 'active' | 'finished' | 'expired';
      playedLines?: Prisma.InputJsonValue;
      currentFen?: string;
      currentPath?: Prisma.InputJsonValue;
      score?: number;
      movesPlayed?: number;
      correctMoves?: number;
      wrongMoves?: number;
      hintsUsed?: number;
      streakMax?: number;
      currentStreak?: number;
      pendingHintFen?: string | null;
      // KS-3277:
      cleanPlayedLines?: Prisma.InputJsonValue;
      currentLineHadWrong?: boolean;
      lineStartIndex?: number;
      // KS-3290 (B4): pathUci review-линии для SM-2 callbacks.
      reviewLinePathUci?: Prisma.InputJsonValue;
      lastActivityAt?: Date;
      finishedAt?: Date | null;
    },
  ) {
    return this.prisma.openingTrainerSession.update({
      where: { id },
      data: data as Parameters<
        typeof this.prisma.openingTrainerSession.update
      >[0]['data'],
    });
  }

  /**
   * KS-3272: удаление одной (последней) attempt'ы по id — для /undo.
   * Caller сначала находит её через listAttemptsBySession (или
   * `findLastAttempt`).
   */
  async deleteAttempt(id: string) {
    return this.prisma.openingTrainerAttempt.delete({ where: { id } });
  }

  async findLastAttempt(sessionId: string) {
    return this.prisma.openingTrainerAttempt.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── OpeningTrainerAttempt ────────────────────────────────────────

  async createAttempt(data: {
    sessionId: string;
    positionFen: string;
    expectedMoves: string[];
    userMove: string;
    correct: boolean;
    hintUsed?: boolean;
    scoreDelta: number;
    responseTimeMs: number;
  }) {
    return this.prisma.openingTrainerAttempt.create({
      data: {
        sessionId: data.sessionId,
        positionFen: data.positionFen,
        expectedMoves: data.expectedMoves,
        userMove: data.userMove,
        correct: data.correct,
        hintUsed: data.hintUsed ?? false,
        scoreDelta: data.scoreDelta,
        responseTimeMs: data.responseTimeMs,
      },
    });
  }

  async listAttemptsBySession(sessionId: string) {
    return this.prisma.openingTrainerAttempt.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async countAttemptsBySession(sessionId: string): Promise<number> {
    return this.prisma.openingTrainerAttempt.count({ where: { sessionId } });
  }

  // ── OpeningLineProgress (KS-3287 M2 §2.5) ──────────────────────

  /**
   * Upsert по уникальному `(userId, repertoireId, pathHash)`. Caller
   * (KS-3288 B2 `OpeningLineProgressService`) формирует data — здесь
   * только тонкий wrap-перевод в prisma.
   *
   * Concurrent upsert безопасен через UNIQUE constraint + ON CONFLICT.
   */
  async upsertLineProgress(
    userId: string,
    repertoireId: string,
    pathHash: string,
    createData: {
      pathUci: string[];
      pathLength: number;
      lastPlayedAt: Date;
      correctCount: number;
      wrongCount: number;
      consecutiveCorrect: number;
      masteredAt?: Date | null;
      sm2Easiness?: number | null;
      sm2Interval?: number | null;
      sm2DueAt?: Date | null;
      sm2Reps?: number | null;
      orphaned?: boolean;
    },
    updateData: {
      lastPlayedAt: Date;
      correctCount?: number;
      wrongCount?: number;
      consecutiveCorrect?: number;
      masteredAt?: Date | null;
      sm2Easiness?: number | null;
      sm2Interval?: number | null;
      sm2DueAt?: Date | null;
      sm2Reps?: number | null;
      orphaned?: boolean;
    },
  ) {
    return this.prisma.openingLineProgress.upsert({
      where: {
        userId_repertoireId_pathHash: { userId, repertoireId, pathHash },
      },
      create: {
        userId,
        repertoireId,
        pathHash,
        ...createData,
        pathUci: createData.pathUci as unknown as Prisma.InputJsonValue,
      },
      update: updateData,
    });
  }

  async findLineProgress(
    userId: string,
    repertoireId: string,
    pathHash: string,
  ) {
    return this.prisma.openingLineProgress.findUnique({
      where: {
        userId_repertoireId_pathHash: { userId, repertoireId, pathHash },
      },
    });
  }

  /**
   * Все линии репертуара пользователя. Опц. `excludeOrphaned: true`
   * — фильтр для SRS-выборок и нормальных листингов.
   */
  async listLineProgress(
    userId: string,
    repertoireId: string,
    opts: { excludeOrphaned?: boolean } = {},
  ) {
    return this.prisma.openingLineProgress.findMany({
      where: {
        userId,
        repertoireId,
        ...(opts.excludeOrphaned ? { orphaned: false } : {}),
      },
      orderBy: { lastPlayedAt: 'desc' },
    });
  }

  /**
   * SRS-выборка «к повтору сегодня» (KS-3290 B4). Без `repertoireId`
   * — across all my repertoires. Сортировка по `sm2DueAt ASC`.
   */
  async listDueLineProgress(
    userId: string,
    opts: { now: Date; repertoireId?: string },
  ) {
    return this.prisma.openingLineProgress.findMany({
      where: {
        userId,
        orphaned: false,
        sm2DueAt: { lte: opts.now, not: null },
        ...(opts.repertoireId ? { repertoireId: opts.repertoireId } : {}),
      },
      orderBy: { sm2DueAt: 'asc' },
    });
  }

  /**
   * KS-3291 (B5): линии репертуара с ошибками для mistakes-режима.
   */
  async listMistakeLineProgress(userId: string, repertoireId: string) {
    return this.prisma.openingLineProgress.findMany({
      where: {
        userId,
        repertoireId,
        orphaned: false,
        wrongCount: { gt: 0 },
      },
      orderBy: { lastPlayedAt: 'desc' },
    });
  }

  /**
   * KS-3294 (B8) orphan-pruning: bulk-update в одной транзакции.
   * `validHashes` — pathHash'и текущего дерева (после rebuild).
   */
  async markOrphans(
    repertoireId: string,
    validHashes: string[],
  ): Promise<{ markedOrphan: number; resurrected: number }> {
    if (validHashes.length === 0) {
      const r = await this.prisma.openingLineProgress.updateMany({
        where: { repertoireId, orphaned: false },
        data: { orphaned: true },
      });
      return { markedOrphan: r.count, resurrected: 0 };
    }
    const [markedOrphan, resurrected] = await this.prisma.$transaction([
      this.prisma.openingLineProgress.updateMany({
        where: {
          repertoireId,
          orphaned: false,
          pathHash: { notIn: validHashes },
        },
        data: { orphaned: true },
      }),
      this.prisma.openingLineProgress.updateMany({
        where: {
          repertoireId,
          orphaned: true,
          pathHash: { in: validHashes },
        },
        data: { orphaned: false },
      }),
    ]);
    return {
      markedOrphan: markedOrphan.count,
      resurrected: resurrected.count,
    };
  }

  // ── Active session (KS-3294 B8) ────────────────────────────────

  async findLatestActiveSession(
    userId: string,
    repertoireId: string,
    sevenDaysAgo: Date,
  ) {
    return this.prisma.openingTrainerSession.findFirst({
      where: {
        userId,
        repertoireId,
        finishedAt: null,
        lastActivityAt: { gt: sevenDaysAgo },
      },
      orderBy: { lastActivityAt: 'desc' },
    });
  }

  // ── KS-3293 (B7) from-analysis ─────────────────────────────────

  /**
   * Тонкий обёртка над `prisma.analysis.findUnique` для конверсии
   * из мастерской. Owner-check делает сервис.
   */
  async findAnalysisById(id: string) {
    return this.prisma.analysis.findUnique({
      where: { id },
      select: { id: true, userId: true, title: true, headline: true, pgn: true },
    });
  }
}
