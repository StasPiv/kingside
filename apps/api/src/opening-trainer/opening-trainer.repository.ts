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
        currentPath: [],
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
      lastActivityAt?: Date;
      finishedAt?: Date | null;
    },
  ) {
    return this.prisma.openingTrainerSession.update({ where: { id }, data });
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
}
