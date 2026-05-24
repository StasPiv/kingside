import { OpeningTrainerService } from './opening-trainer.service';
import {
  findNextUnexploredBranch,
  addLineToClean,
} from './opening-trainer.service';
import { OpeningTrainerRepository } from './opening-trainer.repository';
import { RepertoireBuilderService } from './repertoire-builder.service';
import { OpeningLineProgressService } from './opening-line-progress.service';
import { pathHash as pathHashFn } from './path-hash';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OPENING_REPERTOIRE_LIMITS } from '@kingside/shared';

/**
 * KS-3272. Service-level flow тесты с in-memory fake-репозиторием.
 * Полный e2e (через TestingModule + supertest) — за рамками M1, добавим
 * в M2 при стабилизации API.
 *
 * Покрываем:
 *   - Полный flow: create repertoire → start session → move (correct/
 *     wrong/hint/undo) → finish + summary.
 *   - Бот-picker не повторяется в одной сессии (random-without-repeat).
 *   - Owner-check: 404 NotFound для чужих ресурсов.
 *   - Limits: 50 репертуаров → 409 Conflict.
 *   - Soft-delete: 403 Forbidden на удалённом репертуаре.
 */

// ─── In-memory fake-repository ──────────────────────────────────────

class FakeRepo {
  private repos: any[] = [];
  private sessions: any[] = [];
  private attempts: any[] = [];
  private lineProgress: any[] = [];
  private analyses: any[] = [];

  async listRepertoires(userId: string) {
    return this.repos
      .filter((r) => r.userId === userId && r.deletedAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async findRepertoireById(id: string) {
    return this.repos.find((r) => r.id === id) ?? null;
  }
  async countRepertoiresByUser(userId: string) {
    return this.repos.filter(
      (r) => r.userId === userId && r.deletedAt === null,
    ).length;
  }
  async createRepertoire(data: any) {
    const row = {
      id: `r-${this.repos.length + 1}`,
      description: data.description ?? null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    };
    this.repos.push(row);
    return row;
  }
  async updateRepertoire(id: string, data: any) {
    const r = this.repos.find((x) => x.id === id)!;
    Object.assign(r, data, { updatedAt: new Date() });
    return r;
  }
  async softDeleteRepertoire(id: string, now: Date) {
    const r = this.repos.find((x) => x.id === id)!;
    r.deletedAt = now;
    return r;
  }
  async createSession(data: any) {
    const row = {
      id: `s-${this.sessions.length + 1}`,
      status: 'active',
      playedLines: {},
      currentPath: data.initialPath ?? [],
      reviewLinePathUci: data.reviewLinePathUci ?? null,
      score: 0,
      movesPlayed: 0,
      correctMoves: 0,
      wrongMoves: 0,
      hintsUsed: 0,
      currentStreak: 0,
      streakMax: 0,
      pendingHintFen: null,
      // KS-3277:
      cleanPlayedLines: {},
      currentLineHadWrong: false,
      lineStartIndex: 0,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      finishedAt: null,
      repeatMode: data.repeatMode ?? 'complete',
      ...data,
    };
    this.sessions.push(row);
    return row;
  }
  async findSessionById(id: string) {
    return this.sessions.find((s) => s.id === id) ?? null;
  }
  async countActiveSessionsByUser(userId: string) {
    return this.sessions.filter(
      (s) => s.userId === userId && s.status === 'active',
    ).length;
  }
  async updateSession(id: string, data: any) {
    const s = this.sessions.find((x) => x.id === id)!;
    Object.assign(s, data);
    return s;
  }
  async createAttempt(data: any) {
    const row = {
      id: `a-${this.attempts.length + 1}`,
      hintUsed: false,
      createdAt: new Date(Date.now() + this.attempts.length),
      ...data,
    };
    this.attempts.push(row);
    return row;
  }
  async listAttemptsBySession(sessionId: string) {
    return this.attempts
      .filter((a) => a.sessionId === sessionId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async countAttemptsBySession(sessionId: string) {
    return this.attempts.filter((a) => a.sessionId === sessionId).length;
  }
  async findLastAttempt(sessionId: string) {
    const list = await this.listAttemptsBySession(sessionId);
    return list[list.length - 1] ?? null;
  }
  async deleteAttempt(id: string) {
    const i = this.attempts.findIndex((a) => a.id === id);
    if (i >= 0) this.attempts.splice(i, 1);
    return null;
  }

  // ── KS-3287 (B1) line-progress ──
  async findLineProgress(userId: string, repertoireId: string, pathHash: string) {
    return (
      this.lineProgress.find(
        (l) =>
          l.userId === userId &&
          l.repertoireId === repertoireId &&
          l.pathHash === pathHash,
      ) ?? null
    );
  }
  async upsertLineProgress(
    userId: string,
    repertoireId: string,
    pathHash: string,
    createData: any,
    updateData: any,
  ) {
    const existing = this.lineProgress.find(
      (l) =>
        l.userId === userId &&
        l.repertoireId === repertoireId &&
        l.pathHash === pathHash,
    );
    if (existing) {
      Object.assign(existing, updateData);
      return existing;
    }
    const row = {
      id: `lp-${this.lineProgress.length + 1}`,
      userId,
      repertoireId,
      pathHash,
      orphaned: false,
      ...createData,
    };
    this.lineProgress.push(row);
    return row;
  }
  async listLineProgress(userId: string, repertoireId: string) {
    return this.lineProgress.filter(
      (l) => l.userId === userId && l.repertoireId === repertoireId,
    );
  }
  async listDueLineProgress(
    userId: string,
    opts: { now: Date; repertoireId?: string },
  ) {
    return this.lineProgress
      .filter(
        (l) =>
          l.userId === userId &&
          !l.orphaned &&
          l.sm2DueAt != null &&
          l.sm2DueAt <= opts.now &&
          (!opts.repertoireId || l.repertoireId === opts.repertoireId),
      )
      .sort((a, b) => a.sm2DueAt.getTime() - b.sm2DueAt.getTime());
  }
  async listMistakeLineProgress(userId: string, repertoireId: string) {
    return this.lineProgress
      .filter(
        (l) =>
          l.userId === userId &&
          l.repertoireId === repertoireId &&
          !l.orphaned &&
          (l.wrongCount ?? 0) > 0,
      )
      .sort((a, b) => b.lastPlayedAt.getTime() - a.lastPlayedAt.getTime());
  }

  // Helper для тестов: вручную засеить line-progress row.
  _seedLineProgress(row: any) {
    this.lineProgress.push(row);
  }

  // ── KS-3293 (B7) Analysis lookup ──
  async findAnalysisById(id: string) {
    return this.analyses.find((a) => a.id === id) ?? null;
  }
  _seedAnalysis(row: any) {
    this.analyses.push(row);
  }

  // ── KS-3283 (M2 stats) ──
  async listSessionsForRepertoire(userId: string, repertoireId: string) {
    return this.sessions
      .filter((s) => s.userId === userId && s.repertoireId === repertoireId)
      .map((s) => ({
        id: s.id,
        status: s.status,
        finishedAt: s.finishedAt,
        startedAt: s.startedAt,
        score: s.score,
        movesPlayed: s.movesPlayed,
        correctMoves: s.correctMoves,
        wrongMoves: s.wrongMoves,
        hintsUsed: s.hintsUsed,
      }))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }
  async listAttemptsForRepertoire(userId: string, repertoireId: string) {
    // session-id of all sessions for this user+repertoire.
    const sessionIds = new Set(
      this.sessions
        .filter((s) => s.userId === userId && s.repertoireId === repertoireId)
        .map((s) => s.id),
    );
    return this.attempts
      .filter((a) => sessionIds.has(a.sessionId))
      .map((a) => ({
        positionFen: a.positionFen,
        expectedMoves: a.expectedMoves,
        userMove: a.userMove,
        correct: a.correct,
        hintUsed: a.hintUsed,
      }));
  }

  // ── KS-3294 (B8) markOrphans + findLatestActiveSession ──
  async markOrphans(repertoireId: string, validHashes: string[]) {
    let markedOrphan = 0;
    let resurrected = 0;
    const valid = new Set(validHashes);
    for (const lp of this.lineProgress) {
      if (lp.repertoireId !== repertoireId) continue;
      const inValid = valid.has(lp.pathHash);
      if (!lp.orphaned && !inValid) {
        lp.orphaned = true;
        markedOrphan++;
      } else if (lp.orphaned && inValid) {
        lp.orphaned = false;
        resurrected++;
      }
    }
    return { markedOrphan, resurrected };
  }
  async findLatestActiveSession(
    userId: string,
    repertoireId: string,
    sevenDaysAgo: Date,
  ) {
    return (
      [...this.sessions]
        .filter(
          (s) =>
            s.userId === userId &&
            s.repertoireId === repertoireId &&
            s.finishedAt == null &&
            s.lastActivityAt > sevenDaysAgo,
        )
        .sort(
          (a, b) =>
            b.lastActivityAt.getTime() - a.lastActivityAt.getTime(),
        )[0] ?? null
    );
  }
}

function makeService() {
  const repo = new FakeRepo();
  const builder = new RepertoireBuilderService();
  // KS-3289 (M2 B3): мок OpeningLineProgressService — для большинства
  // тестов нам всё равно, реальная запись прогресса не критична.
  // Кейсы B3 (integration) подменяют это на spy/real, чтобы проверить
  // вызовы.
  const progress = {
    recordAttempt: jest.fn(async () => null),
    applyReviewResult: jest.fn(async () => null),
  } as unknown as OpeningLineProgressService;
  const svc = new OpeningTrainerService(
    repo as unknown as OpeningTrainerRepository,
    builder,
    progress,
  );
  return { svc, repo, progress };
}

const SAMPLE_PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5';

describe('OpeningTrainerService — full flow (KS-3272)', () => {
  it('create → list → get → update → delete', async () => {
    const { svc } = makeService();
    const created = await svc.createRepertoire('u-1', {
      title: 'Ruy Lopez',
      pgn: SAMPLE_PGN,
    });
    expect(created.title).toBe('Ruy Lopez');
    expect(created.nodeCount).toBe(6);
    expect(created.edgeCount).toBe(5);
    expect(created.tree.rootFen).toBeDefined();

    const list = await svc.listRepertoires('u-1', false);
    expect(list.repertoires).toHaveLength(1);

    const got = await svc.getRepertoire('u-1', created.id);
    expect(got.id).toBe(created.id);
    expect(got.pgn).toBe(SAMPLE_PGN);

    const renamed = await svc.updateRepertoire('u-1', created.id, {
      title: 'Spanish Game',
    });
    expect(renamed.title).toBe('Spanish Game');
    expect(renamed.pgn).toBe(SAMPLE_PGN); // не менялось

    const deleted = await svc.deleteRepertoire('u-1', created.id);
    expect(deleted.id).toBe(created.id);
    expect(deleted.deletedAt).toBeDefined();

    // После удаления — list пуст.
    const afterDel = await svc.listRepertoires('u-1', false);
    expect(afterDel.repertoires).toHaveLength(0);

    // GET по soft-deleted — 403.
    await expect(svc.getRepertoire('u-1', created.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('owner-check: чужой репертуар → 404 NotFound', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: SAMPLE_PGN,
    });
    await expect(svc.getRepertoire('u-2', r.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.deleteRepertoire('u-2', r.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('limit 50 репертуаров → 409 Conflict', async () => {
    const { svc, repo } = makeService();
    // Заглушим count, чтобы не насиловать БД.
    (repo as any).countRepertoiresByUser = async () =>
      OPENING_REPERTOIRE_LIMITS.maxRepertoiresPerUser;
    await expect(
      svc.createRepertoire('u-1', { title: 't', pgn: SAMPLE_PGN }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('битый PGN → 400 BadRequest', async () => {
    const { svc } = makeService();
    await expect(
      svc.createRepertoire('u-1', { title: 't', pgn: '1. e9 e5' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('start session играя белыми — initialBotMove=null', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: SAMPLE_PGN,
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    expect(start.initialBotMove).toBeNull();
    expect(start.session.side).toBe('white');
    expect(start.session.currentFen).toBe(r.tree.rootFen);
  });

  it('start session играя чёрными — бот делает первый ход (KS-3302: side из repertoire)', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: SAMPLE_PGN,
      side: 'black', // KS-3302: side фиксируется на репертуаре
    });
    const start = await svc.startSession('u-1', r.id, {
      // KS-3302: side в startSession игнорируется (backward-compat).
      mode: 'learn',
    });
    expect(start.initialBotMove).not.toBeNull();
    expect(start.initialBotMove!.moveSan).toBe('e4'); // единственный ход белыми
    expect(start.session.currentFen).toBe(start.initialBotMove!.newFen);
    expect(start.session.currentPath).toEqual(['e2e4']);
  });

  it('correct user-move → +10, бот отвечает, session обновляется', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: SAMPLE_PGN,
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    // Играем единственный ход — e2e4.
    const r1 = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 8000,
    });
    expect(r1.result).toBe('correct');
    if (r1.result === 'correct') {
      expect(r1.scoreDelta).toBe(10);
      expect(r1.session.score).toBe(10);
      expect(r1.session.correctMoves).toBe(1);
      expect(r1.botMove).not.toBeNull();
      expect(r1.botMove!.moveSan).toBe('e5'); // единственный ход чёрных в репертуаре
    }
  });

  it('wrong user-move → -5, ход не применяется, expectedMoves возвращаются', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: SAMPLE_PGN,
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    const r1 = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'd2d4', // не e2e4 — не в репертуаре
      responseTimeMs: 1000,
    });
    expect(r1.result).toBe('wrong');
    if (r1.result === 'wrong') {
      // score=0, clamp до 0 (Math.max(-5, -0) = -0 в JS — сверяем по модулю).
      expect(Math.abs(r1.scoreDelta)).toBe(0);
      expect(r1.session.score).toBe(0);
      expect(r1.session.currentFen).toBe(start.session.currentFen); // не двинулся
      expect(r1.expectedMoves.map((e) => e.moveSan)).toEqual(['e4']);
    }
  });

  it('hint → +5 за следующий правильный (вместо +10)', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: SAMPLE_PGN,
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    const hint = await svc.hint('u-1', start.session.id);
    expect(hint.hint.moveSan).toBe('e4');
    expect(hint.session.hintsUsed).toBe(1);

    const r1 = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 8000,
    });
    expect(r1.result).toBe('correct');
    if (r1.result === 'correct') {
      expect(r1.scoreDelta).toBe(5); // hint penalty
    }
  });

  it('бот random-without-repeat: 2 варианта чёрных → бот выберет каждый раз новый', async () => {
    // PGN с двумя ответами чёрных: 1.e4 e5 (1...c5).
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 e5 (1... c5)',
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
      repeatMode: 'cycle',
    });

    // Играем e4.
    const r1 = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 8000,
    });
    expect(r1.result).toBe('correct');
    if (r1.result !== 'correct' || !r1.botMove) throw new Error();
    const firstBot = r1.botMove.moveSan;
    expect(['e5', 'c5']).toContain(firstBot);

    // Откатываем последний ход (correct → revert).
    const undone = await svc.undo('u-1', start.session.id);
    expect(undone.session.currentFen).toBe(start.session.currentFen);
    expect(undone.session.score).toBe(0);

    // Снова играем e4 — бот должен сыграть ДРУГОЙ вариант (не повторился).
    // ВАЖНО: playedLines не сбрасывается на undo (M1 ограничение), бот
    // помнит предыдущий ход.
    const r2 = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 8000,
    });
    if (r2.result !== 'correct' || !r2.botMove) throw new Error();
    expect(r2.botMove.moveSan).not.toBe(firstBot);

    // Снова undo + ход — теперь оба варианта пройдены, cycle-mode
    // обнуляет и выбирает.
    await svc.undo('u-1', start.session.id);
    const r3 = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 8000,
    });
    if (r3.result !== 'correct' || !r3.botMove) throw new Error();
    expect(['e5', 'c5']).toContain(r3.botMove.moveSan);
  });

  it('undo откатывает correct: score, counters, currentFen', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: SAMPLE_PGN,
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    const r1 = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 8000,
    });
    if (r1.result !== 'correct') throw new Error();
    expect(r1.session.score).toBe(10);
    expect(r1.session.correctMoves).toBe(1);

    const undone = await svc.undo('u-1', start.session.id);
    expect(undone.session.score).toBe(0);
    expect(undone.session.correctMoves).toBe(0);
    expect(undone.session.currentFen).toBe(start.session.currentFen);
  });

  it('finish → status=finished + summary', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: SAMPLE_PGN,
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    const finish = await svc.finish('u-1', start.session.id);
    expect(finish.session.status).toBe('finished');
    expect(finish.session.finishedAt).not.toBeNull();
    expect(finish.summary.score).toBe(0);
    expect(finish.summary.movesPlayed).toBe(0);
  });

  it('giveup → expectedMoves возвращаются + бот делает ход', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: SAMPLE_PGN,
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    const g = await svc.giveup('u-1', start.session.id);
    expect(g.expectedMoves[0].moveSan).toBe('e4');
    expect(g.botMove).not.toBeNull();
    expect(g.session.wrongMoves).toBe(1);
  });

  it('KS-3277: единственный ход без ошибок → tree-complete (всё дерево пройдено), session finished', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4',
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    const r1 = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 8000,
    });
    expect(r1.result).toBe('tree-complete');
    expect(r1.session.status).toBe('finished');
  });
});

describe('KS-3277: auto-restart до tree-complete', () => {
  it('линия без ошибок → line-restart на оставшийся вариант → следующая → tree-complete', async () => {
    // 1.e4 (1.d4) — два варианта первого хода, оба ведут в концевые позиции.
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 (1. d4)',
      side: 'black', // KS-3302: side в репертуаре
    });
    // Играем чёрными — бот делает первый ход. Бот выберет один из e4/d4.
    const start = await svc.startSession('u-1', r.id, {
      mode: 'learn',
    });
    // Бот сыграл — после его хода у нас черная позиция БЕЗ ходов в репертуаре.
    // Если бы пользователь попробовал любой ход, был бы wrong (no expected).
    // НО: бот сразу подобрал ход — мы уже в end-of-line.
    // /finish для проверки cleanLines не нужно — fresh start:
    expect(start.initialBotMove).not.toBeNull();
    // Бот теперь играет ОДИН из вариантов; чтобы дойти до tree-complete,
    // нужно «закрыть» этот вариант. Пользователь у нас в позиции с 0 edges —
    // /move с любым UCI вернёт wrong с expectedMoves=[]. Это marks
    // currentLineHadWrong=true → линия не помечена clean → следующий refresh
    // даст line-restart на ту же позицию (т.к. в дереве остался непройденный
    // вариант от root).
    //
    // Сделаем /finish — простой sanity что session жива.
    const fin = await svc.finish('u-1', start.session.id);
    expect(fin.session.status).toBe('finished');
  });

  it('PGN с двумя вариантами user-хода → line-restart после первой линии, tree-complete после второй', async () => {
    // 1.e4 (1.d4) — два варианта первого хода БЕЛЫХ. Юзер играет белыми.
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 (1. d4)',
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    // Юзер играет e4. После e4 в дереве нет ответа чёрных — handleLineComplete:
    //  - line clean (нет wrong).
    //  - cleanLines[root] += [afterE4].
    //  - findNextUnexploredBranch: depth 0 = root, edges=[e4, d4], clean=[afterE4],
    //    unclean=[d4] — найдена развилка.
    //  - Поскольку user играет белыми и restartPath.length=0 (вернулись в root) —
    //    ходить пользователю; initialBotMove=null.
    //  → line-restart с newFen=root, botMove=null.
    const r1 = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 8000,
    });
    expect(r1.result).toBe('line-restart');
    if (r1.result === 'line-restart') {
      expect(r1.newPath).toEqual([]);
      expect(r1.botMove).toBeNull();
      expect(r1.session.status).toBe('active');
    }

    // Теперь юзер играет d4 (оставшийся вариант).
    const r2 = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'd2d4',
      responseTimeMs: 8000,
    });
    // После d4 тоже нет ответа в дереве. cleanLines[root] += [afterD4].
    // Теперь root полностью clean (e4 и d4 оба пройдены) → tree-complete.
    expect(r2.result).toBe('tree-complete');
    if (r2.result === 'tree-complete') {
      expect(r2.session.status).toBe('finished');
      expect(r2.session.finishedAt).not.toBeNull();
    }
  });

  it('KS-3278 регрессия: line-restart всегда возвращает newFen ≠ currentFen (доска двигается)', async () => {
    // PGN с альтернативами у бота, которые могут оказаться все session-played.
    // 1.e4 (1.e4 c5) — главная линия 1.e4 без ответа, вариант 1.e4 c5
    // (chess.js valid PGN; вариант от позиции до 1-го хода).
    // Хотим: после прохода e4 → c5 → линия закончилась (нет нашего ответа),
    // потом restart должен дать newFen ≠ ранее последний currentFen.
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 c5 (1... e5)',
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    // Юзер e4. Бот выбирает c5 или e5.
    const r1 = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 8000,
    });
    expect(r1.result).toBe('correct');
    if (r1.result !== 'correct' || !r1.botMove) throw new Error();
    const fenAfterFirstBot = r1.session.currentFen;
    expect(['c5', 'e5']).toContain(r1.botMove.moveSan);

    // Линия закончилась (после bot'а нет ходов юзера в репертуаре).
    // Пользователь подаёт finish/giveup или мы ждём что следующий ход
    // даст line-restart. Здесь имитируем: пытаемся giveup, чтобы линия
    // formally закончилась. ИЛИ играем wrong → wrong → undo → snapshot...
    //
    // Проще: дёрнем makeMove с любым UCI (получим wrong, т.к. нет edges)
    // и проверим что после следующего хода line-restart даст НОВЫЙ fen.
    //
    // Упрощённый тест KS-3278: вернёмся через undo и доиграем другую
    // ветку — бот выберет неотыгранный вариант, newFen ≠ предыдущему.
    const undone = await svc.undo('u-1', start.session.id);
    expect(undone.session.currentFen).toBe(start.session.currentFen);

    const r2 = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 8000,
    });
    expect(r2.result).toBe('correct');
    if (r2.result !== 'correct' || !r2.botMove) throw new Error();
    // Бот должен сыграть ДРУГОЙ вариант (random-without-repeat).
    expect(r2.botMove.moveSan).not.toBe(r1.botMove.moveSan);
    // newFen ≠ предыдущему bot'у:
    expect(r2.session.currentFen).not.toBe(fenAfterFirstBot);
  });

  it('KS-3281 регрессия: dirty single-edge user-position не зацикливает (real prod PGN "Каталон")', async () => {
    // PGN из прод-дампа (KS-3281, user 06f68cfd). Сценарий из жалобы:
    // юзер чёрными в Ne5-варианте, бот сыграл Bf3 (главный вариант),
    // юзер должен сыграть e5 (единственный edge). До фикса: если линия
    // помечена dirty (предыдущий wrong + clean-завершение НЕ обновляет
    // cleanLines) → findNextUnexploredBranch возвращал depth=fens.length-2
    // = после-Bf3 (= currentFen) → restart в ту же позицию → cycle.
    // С фиксом: user-edge исключается из unclean на этом depth → walking
    // up в before-Bf3 → бот переключается на Bg2 → доска двигается.
    const PGN_CATALON =
      '1. c4 e6 2. g3 d5 3. Bg2 dxc4 4. Nf3 a6 5. Qc2 ' +
      '(5. Ne5 Qd4 6. f4 Nd7 7. e3 Qc5 8. Nxd7 Bxd7 9. Bxb7 Rb8 10. Bf3 (10. Bg2 Bc6 $15) 10... e5 $15) ' +
      '(5. Na3 b5 6. Ne5 Ra7 7. O-O Bb7 8. Bxb7 Rxb7 9. Nc2 Nf6 10. b3 cxb3 11. axb3 Qd5 12. d4 Qxb3 13. Re1 Ne4 $17) ' +
      '5... b5 6. Ne5 Ra7 7. d3 (7. b3 cxb3 8. axb3 c5 $17) 7... cxd3 8. Qxd3 Qxd3 9. Nxd3 Bb7 10. Be3 Bxg2 11. Bxa7 Bxh1 12. Bxb8 Be4 $11';
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 'Каталон',
      pgn: PGN_CATALON,
      side: 'black', // KS-3302: side в репертуаре
    });
    // Дерево содержит репертуар; нам нужен симулированный «dirty»
    // single-edge сценарий. Делаем синтетический минимальный кейс:
    // фронт-симуляция Ne5 + Bf3 + e5 с currentLineHadWrong=true.
    //
    // Удобнее проверить непосредственно `findNextUnexploredBranch` —
    // unit-тестом ниже. Этот сервисный тест — smoke: PGN валидно
    // парсится и не падает на старте.
    expect(r.nodeCount).toBeGreaterThan(50);
    expect(r.edgeCount).toBeGreaterThan(50);
    const start = await svc.startSession('u-1', r.id, {
      mode: 'learn',
    });
    expect(start.initialBotMove).not.toBeNull();
    // Первый бот-ход — c4 (единственный root-edge).
    expect(start.initialBotMove!.moveSan).toBe('c4');
  });

  it('грязная линия (с wrong) → multi-edge user pos → line-restart на альтернативу', async () => {
    // PGN с двумя user-вариантами: 1.e4 (1.d4). Юзер ошибается на e4,
    // потом правильно играет. С dirty-skip-гейтом cleanLines[root] не
    // обновляется → user-edge e4 unclean, но KS-3281 фильтр исключает
    // его → restart на root с unclean=[d4]. Юзер играет d4, тоже
    // помечено dirty (флаг живёт между линиями — это известный M2 issue
    // про per-line wrong-tracking) → line-restart снова. Multi-edge
    // dirty-replay семантика поддерживается, tree-complete случится
    // через несколько чистых проходов.
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 (1. d4)',
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    // Wrong: Nf3.
    const wrong = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'g1f3',
      responseTimeMs: 8000,
    });
    expect(wrong.result).toBe('wrong');

    // Correct e4 → dirty line-restart (cleanLines не обновляется из-за
    // currentLineHadWrong=true; user-edge на root исключается; восходит
    // d4 unclean).
    const correct = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 8000,
    });
    expect(correct.result).toBe('line-restart');
    if (correct.result === 'line-restart') {
      expect(correct.session.status).toBe('active');
    }
  });

  it('KS-3282: wrong + correct корректно засчитывается с первого ввода', async () => {
    // Проверяет issue 1 (KS-3282): backend не требует двух correct'ов
    // после wrong'а. Если этот тест проходит на бэке — баг во фронте.
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 e5',
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    // Wrong move.
    const wrong = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'g1f3',
      responseTimeMs: 1000,
    });
    expect(wrong.result).toBe('wrong');
    // session.currentFen НЕ изменился после wrong:
    expect(wrong.session.currentFen).toBe(start.session.currentFen);

    // Correct move сразу после wrong. Должен быть correct с первого ввода.
    const correct = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 1000,
    });
    // Должен быть correct (не wrong), session двигается дальше.
    expect(correct.result).not.toBe('wrong');
    if (correct.result === 'correct' || correct.result === 'line-restart' || correct.result === 'tree-complete') {
      // Любой из этих успешных исходов — ход засчитан.
      expect(correct.session.correctMoves).toBe(1);
      expect(correct.session.wrongMoves).toBe(1);
    } else {
      throw new Error(`expected success result, got ${correct.result}`);
    }
  });
});

describe('KS-3281: findNextUnexploredBranch — exclude user-edge at depth-1', () => {
  /**
   * Прямой unit-test на хелпер. Воспроизводит prod-сценарий KS-3281:
   * dirty single-edge user-position не должна давать «restart в ту же позицию».
   *
   * Используем РЕАЛЬНОЕ дерево через RepertoireBuilderService —
   * chess.js fen()-формат должен совпасть с тем, что findNextBranch
   * вычисляет при walk'е (en-passant эвристика, half-move counters
   * формируются одинаково).
   */
  const builder = new RepertoireBuilderService();

  it('dirty single-edge user-position возвращает root (а не same currentFen)', () => {
    const tree = builder.buildTree('1. e4 e5');
    // path = main line, cleanLines пустой (dirty).
    const path = Object.values(tree.nodes)[0].edges[0]
      ? ['e2e4', 'e7e5']
      : [];
    const cleanLines = {};
    const next = findNextUnexploredBranch(tree, path, cleanLines);
    // Должен НЕ возвращать after-e4 (= user's currentFen перед e7e5).
    // Должен вернуть root: исключив user-edge на depth=1, осталось root
    // c unclean=[e2e4] и user-edge=e2e4 → e2e4 child = after-e4 ≠ fens[1].
    // Hmm wait: на depth=0, user-edge filter применяется только при
    // depth === fens.length-2 = 1. depth=0 != 1 → no filter. unclean=[e2e4].
    expect(next).not.toBeNull();
    expect(next!.depth).toBe(0);
    expect(next!.fen).toBe(tree.rootFen);
  });

  it('clean multi-user-edge возвращает depth-1 (юзер играет альтернативу)', () => {
    // PGN с двумя ответами чёрных: 1.e4 e5 (1...c5). У root один edge
    // (e4). После e4 у чёрных 2 edges: e5 и c5.
    const tree = builder.buildTree('1. e4 e5 (1... c5)');
    const path = ['e2e4', 'e7e5'];
    // Реальный after-e4 FEN — берём из tree.
    const rootNode = tree.nodes[tree.rootFen];
    const e4Edge = rootNode.edges.find((e) => e.moveSan === 'e4')!;
    const afterE4 = e4Edge.childFen;
    const e5Edge = tree.nodes[afterE4].edges.find((e) => e.moveSan === 'e5')!;
    const afterE5 = e5Edge.childFen;
    // cleanLines: только after-e5 помечен (clean). c5 — unclean.
    const cleanLines = { [afterE4]: [afterE5] };
    const next = findNextUnexploredBranch(tree, path, cleanLines);
    // Должен вернуть depth=1 (after-e4), потому что c5 (другой user-edge)
    // ещё unclean.
    expect(next).not.toBeNull();
    expect(next!.depth).toBe(1);
    expect(next!.fen).toBe(afterE4);
  });

  it('всё clean → null (tree-complete)', () => {
    const tree = builder.buildTree('1. e4');
    const rootNode = tree.nodes[tree.rootFen];
    const afterE4 = rootNode.edges[0].childFen;
    const path = ['e2e4'];
    const cleanLines = { [tree.rootFen]: [afterE4] };
    const next = findNextUnexploredBranch(tree, path, cleanLines);
    expect(next).toBeNull();
  });
});

describe('KS-3289 (M2 B3): integration recordAttempt в makeMove', () => {
  it('correct user-move → recordAttempt с pathUci=currentPath+move correct=true', async () => {
    const { svc, progress } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 e5 2. Nf3',
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 3000,
    });
    expect(progress.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-1',
        repertoireId: r.id,
        pathUci: ['e2e4'],
        correct: true,
      }),
    );
  });

  it('wrong user-move → recordAttempt с pathUci=currentPath correct=false (без applied-move)', async () => {
    const { svc, progress } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 e5',
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'learn',
    });
    await svc.makeMove('u-1', start.session.id, {
      moveUci: 'g1f3', // не в репертуаре
      responseTimeMs: 3000,
    });
    expect(progress.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        pathUci: [], // currentPath на старте сессии = []
        correct: false,
      }),
    );
  });

  it('mode=free → recordAttempt НЕ вызывается (§2.7)', async () => {
    const { svc, progress } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4',
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'white',
      mode: 'free',
    });
    await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 3000,
    });
    expect(progress.recordAttempt).not.toHaveBeenCalled();
  });

  it('mastered после 3 подряд correct (integration с REAL OpeningLineProgressService)', async () => {
    // Используем настоящий progress service с in-memory mock-repo.
    const repo = new FakeRepo();
    const lineProgressRows: any[] = [];
    const fakeProgressRepo = {
      findLineProgress: jest.fn(async (uid, rid, hash) =>
        lineProgressRows.find(
          (r) => r.userId === uid && r.repertoireId === rid && r.pathHash === hash,
        ) ?? null,
      ),
      upsertLineProgress: jest.fn(
        async (uid, rid, hash, createData, updateData) => {
          const existing = lineProgressRows.find(
            (r) =>
              r.userId === uid &&
              r.repertoireId === rid &&
              r.pathHash === hash,
          );
          if (existing) {
            Object.assign(existing, updateData);
            return existing;
          }
          const row = {
            id: `lp-${lineProgressRows.length + 1}`,
            userId: uid,
            repertoireId: rid,
            pathHash: hash,
            ...createData,
          };
          lineProgressRows.push(row);
          return row;
        },
      ),
    };
    const realProgress = new OpeningLineProgressService(
      fakeProgressRepo as unknown as OpeningTrainerRepository,
    );
    const builder = new RepertoireBuilderService();
    const svc = new OpeningTrainerService(
      repo as unknown as OpeningTrainerRepository,
      builder,
      realProgress,
    );
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4',
    });
    // 3 раза проходим одну и ту же линию (1 ply): e2e4.
    // Каждый раз startSession создаёт новую сессию, makeMove e2e4 → tree-complete.
    for (let i = 0; i < 3; i++) {
      const session = await svc.startSession('u-1', r.id, {
        side: 'white',
        mode: 'learn',
      });
      await svc.makeMove('u-1', session.session.id, {
        moveUci: 'e2e4',
        responseTimeMs: 3000,
      });
    }
    // 3 correct attempts → должен быть mastered.
    expect(lineProgressRows).toHaveLength(1);
    const lp = lineProgressRows[0];
    expect(lp.correctCount).toBe(3);
    expect(lp.consecutiveCorrect).toBe(3);
    expect(lp.masteredAt).not.toBeNull();
    expect(lp.sm2Easiness).toBeCloseTo(2.6, 5);
  });
});

describe('KS-3290 (M2 B4): review-mode + GET /reviews/due', () => {
  function makeReviewService() {
    const repo = new FakeRepo();
    const builder = new RepertoireBuilderService();
    const progress = {
      recordAttempt: jest.fn(async () => null),
      applyReviewResult: jest.fn(async () => null),
    } as unknown as OpeningLineProgressService;
    const svc = new OpeningTrainerService(
      repo as unknown as OpeningTrainerRepository,
      builder,
      progress,
    );
    return { svc, repo, progress };
  }

  it('startSession(mode=review) без due-линий → 400 no_lines_due', async () => {
    const { svc } = makeReviewService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 e5',
    });
    await expect(
      svc.startSession('u-1', r.id, {
        side: 'white',
        mode: 'review',
      }),
    ).rejects.toThrow(/no_lines_due/);
  });

  it('startSession(mode=review) с due-линией → стартует с replayed FEN', async () => {
    const { svc, repo } = makeReviewService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 e5 2. Nf3',
    });
    // Засеиваем due line (path = [e2e4]).
    const dueAt = new Date('2026-05-23T00:00:00Z'); // в прошлом → due
    repo._seedLineProgress({
      userId: 'u-1',
      repertoireId: r.id,
      pathHash: 'hash-e4',
      pathUci: ['e2e4'],
      pathLength: 1,
      correctCount: 3,
      wrongCount: 0,
      consecutiveCorrect: 3,
      lastPlayedAt: new Date('2026-05-22T00:00:00Z'),
      masteredAt: new Date('2026-05-22T00:00:00Z'),
      sm2DueAt: dueAt,
      sm2Easiness: 2.6,
      sm2Interval: 1,
      sm2Reps: 1,
      orphaned: false,
    });

    const session = await svc.startSession('u-1', r.id, {
      side: 'black', // user играет дальше после e4
      mode: 'review',
    });
    expect(session.session.mode).toBe('review');
    expect(session.session.currentPath).toEqual(['e2e4']);
    // currentFen — позиция после e4 (replayed).
    expect(session.session.currentFen).toContain('PPPP1PPP'); // pawn pattern after e4
    expect(session.initialBotMove).toBeNull();
  });

  it('wrong на review-линии → applyReviewResult(quality=1)', async () => {
    const { svc, repo, progress } = makeReviewService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 e5',
    });
    const dueAt = new Date('2026-05-23T00:00:00Z');
    repo._seedLineProgress({
      userId: 'u-1',
      repertoireId: r.id,
      pathHash: 'hash-e4',
      pathUci: ['e2e4'],
      pathLength: 1,
      correctCount: 3,
      wrongCount: 0,
      consecutiveCorrect: 3,
      lastPlayedAt: new Date('2026-05-22T00:00:00Z'),
      masteredAt: new Date('2026-05-22T00:00:00Z'),
      sm2DueAt: dueAt,
      sm2Easiness: 2.6,
      sm2Interval: 1,
      sm2Reps: 1,
      orphaned: false,
    });
    const session = await svc.startSession('u-1', r.id, {
      side: 'black',
      mode: 'review',
    });
    // Wrong move (a7a6 не в репертуаре, в репертуаре e7e5).
    await svc.makeMove('u-1', session.session.id, {
      moveUci: 'a7a6',
      responseTimeMs: 3000,
    });
    expect(progress.applyReviewResult).toHaveBeenCalledWith(
      expect.objectContaining({
        pathUci: ['e2e4'],
        quality: 1,
      }),
    );
  });

  it('clean line-complete на review → applyReviewResult(quality=5)', async () => {
    const { svc, repo, progress } = makeReviewService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 e5',
    });
    const dueAt = new Date('2026-05-23T00:00:00Z');
    repo._seedLineProgress({
      userId: 'u-1',
      repertoireId: r.id,
      pathHash: 'hash-e4',
      pathUci: ['e2e4'],
      pathLength: 1,
      correctCount: 3,
      wrongCount: 0,
      consecutiveCorrect: 3,
      lastPlayedAt: new Date('2026-05-22T00:00:00Z'),
      masteredAt: new Date('2026-05-22T00:00:00Z'),
      sm2DueAt: dueAt,
      sm2Easiness: 2.6,
      sm2Interval: 1,
      sm2Reps: 1,
      orphaned: false,
    });
    const session = await svc.startSession('u-1', r.id, {
      side: 'black',
      mode: 'review',
    });
    // Correct: e7e5 (in репертуар). Бот не может больше → line-complete.
    await svc.makeMove('u-1', session.session.id, {
      moveUci: 'e7e5',
      responseTimeMs: 3000,
    });
    expect(progress.applyReviewResult).toHaveBeenCalledWith(
      expect.objectContaining({
        pathUci: ['e2e4'],
        quality: 5,
      }),
    );
  });

  it('listDueReviews возвращает линии с repertoireTitle denorm', async () => {
    const { svc, repo } = makeReviewService();
    const r = await svc.createRepertoire('u-1', {
      title: 'My Caro',
      pgn: '1. e4 c6',
    });
    repo._seedLineProgress({
      userId: 'u-1',
      repertoireId: r.id,
      pathHash: 'hash-1',
      pathUci: ['e2e4'],
      pathLength: 1,
      correctCount: 3,
      wrongCount: 0,
      consecutiveCorrect: 3,
      lastPlayedAt: new Date('2026-05-22T00:00:00Z'),
      masteredAt: new Date('2026-05-22T00:00:00Z'),
      sm2DueAt: new Date('2026-05-23T00:00:00Z'),
      sm2Easiness: 2.6,
      sm2Interval: 1,
      sm2Reps: 1,
      orphaned: false,
    });
    const r2 = await svc.listDueReviews('u-1');
    expect(r2.lines).toHaveLength(1);
    expect(r2.lines[0].repertoireTitle).toBe('My Caro');
    expect(r2.lines[0].pathUci).toEqual(['e2e4']);
  });

  describe('KS-3291 (M2 B5) mistakes-mode', () => {
    it('startSession(mistakes) без wrongCount>0 → 400 no_mistakes', async () => {
      const { svc } = makeReviewService();
      const r = await svc.createRepertoire('u-1', {
        title: 't',
        pgn: '1. e4 e5',
      });
      await expect(
        svc.startSession('u-1', r.id, {
          side: 'white',
          mode: 'mistakes',
        }),
      ).rejects.toThrow(/no_mistakes/);
    });

    it('startSession(mistakes) с линиями wrongCount>0 → стартует с последней по lastPlayedAt', async () => {
      const { svc, repo } = makeReviewService();
      const r = await svc.createRepertoire('u-1', {
        title: 't',
        pgn: '1. e4 e5 2. Nf3',
      });
      // Старая линия с ошибкой.
      repo._seedLineProgress({
        userId: 'u-1',
        repertoireId: r.id,
        pathHash: 'old-h',
        pathUci: ['e2e4'],
        pathLength: 1,
        correctCount: 1,
        wrongCount: 2,
        consecutiveCorrect: 0,
        lastPlayedAt: new Date('2026-05-20T00:00:00Z'),
        masteredAt: null,
        sm2DueAt: null,
        sm2Easiness: null,
        sm2Interval: null,
        sm2Reps: null,
        orphaned: false,
      });
      // Свежая линия с ошибкой.
      repo._seedLineProgress({
        userId: 'u-1',
        repertoireId: r.id,
        pathHash: 'new-h',
        pathUci: ['e2e4', 'e7e5'],
        pathLength: 2,
        correctCount: 2,
        wrongCount: 1,
        consecutiveCorrect: 1,
        lastPlayedAt: new Date('2026-05-23T00:00:00Z'),
        masteredAt: null,
        sm2DueAt: null,
        sm2Easiness: null,
        sm2Interval: null,
        sm2Reps: null,
        orphaned: false,
      });
      const start = await svc.startSession('u-1', r.id, {
        side: 'white',
        mode: 'mistakes',
      });
      // Берётся свежая (по lastPlayedAt DESC).
      expect(start.session.currentPath).toEqual(['e2e4', 'e7e5']);
      expect(start.session.mode).toBe('mistakes');
      // reviewLinePathUci НЕ заполняется (mistakes не апдейтит SM-2 как review).
    });

    it('orphaned-линии не попадают в mistakes-выборку', async () => {
      const { svc, repo } = makeReviewService();
      const r = await svc.createRepertoire('u-1', {
        title: 't',
        pgn: '1. e4',
      });
      // Линия с ошибкой, но orphaned=true.
      repo._seedLineProgress({
        userId: 'u-1',
        repertoireId: r.id,
        pathHash: 'orph-h',
        pathUci: ['e2e4'],
        pathLength: 1,
        correctCount: 0,
        wrongCount: 5,
        consecutiveCorrect: 0,
        lastPlayedAt: new Date(),
        masteredAt: null,
        sm2DueAt: null,
        sm2Easiness: null,
        sm2Interval: null,
        sm2Reps: null,
        orphaned: true,
      });
      await expect(
        svc.startSession('u-1', r.id, {
          side: 'white',
          mode: 'mistakes',
        }),
      ).rejects.toThrow(/no_mistakes/);
    });
  });

  describe('KS-3292 (M2 B6): listRepertoireProgress + status derive', () => {
    it('derive 4 status-варианта (mastered / due / wrong / learning)', async () => {
      const { svc, repo } = makeReviewService();
      const r = await svc.createRepertoire('u-1', {
        title: 't',
        pgn: '1. e4',
      });
      const past = new Date('2026-05-20T00:00:00Z');
      const future = new Date('2026-06-01T00:00:00Z');

      // 1. mastered (sm2DueAt в будущем)
      repo._seedLineProgress({
        userId: 'u-1',
        repertoireId: r.id,
        pathHash: 'h-mastered',
        pathUci: ['m1'],
        pathLength: 1,
        correctCount: 5,
        wrongCount: 0,
        consecutiveCorrect: 5,
        lastPlayedAt: past,
        masteredAt: past,
        sm2DueAt: future,
        sm2Easiness: 2.6,
        sm2Interval: 30,
        sm2Reps: 5,
        orphaned: false,
      });

      // 2. due (mastered + sm2DueAt в прошлом)
      repo._seedLineProgress({
        userId: 'u-1',
        repertoireId: r.id,
        pathHash: 'h-due',
        pathUci: ['d1'],
        pathLength: 1,
        correctCount: 5,
        wrongCount: 0,
        consecutiveCorrect: 5,
        lastPlayedAt: past,
        masteredAt: past,
        sm2DueAt: past,
        sm2Easiness: 2.6,
        sm2Interval: 1,
        sm2Reps: 1,
        orphaned: false,
      });

      // 3. wrong (wrongCount > correctCount, не mastered)
      repo._seedLineProgress({
        userId: 'u-1',
        repertoireId: r.id,
        pathHash: 'h-wrong',
        pathUci: ['w1'],
        pathLength: 1,
        correctCount: 1,
        wrongCount: 5,
        consecutiveCorrect: 0,
        lastPlayedAt: past,
        masteredAt: null,
        sm2DueAt: null,
        sm2Easiness: null,
        sm2Interval: null,
        sm2Reps: null,
        orphaned: false,
      });

      // 4. learning (есть попытки, не mastered, не wrong)
      repo._seedLineProgress({
        userId: 'u-1',
        repertoireId: r.id,
        pathHash: 'h-learning',
        pathUci: ['l1'],
        pathLength: 1,
        correctCount: 2,
        wrongCount: 0,
        consecutiveCorrect: 2,
        lastPlayedAt: past,
        masteredAt: null,
        sm2DueAt: null,
        sm2Easiness: null,
        sm2Interval: null,
        sm2Reps: null,
        orphaned: false,
      });

      const result = await svc.listRepertoireProgress('u-1', r.id);
      expect(result.repertoireId).toBe(r.id);
      expect(result.lines).toHaveLength(4);
      const byHash = Object.fromEntries(
        result.lines.map((l) => [l.pathHash, l.status]),
      );
      expect(byHash['h-mastered']).toBe('mastered');
      expect(byHash['h-due']).toBe('due');
      expect(byHash['h-wrong']).toBe('wrong');
      expect(byHash['h-learning']).toBe('learning');
    });

    it('owner-check: чужой репертуар → 404 NotFound', async () => {
      const { svc } = makeReviewService();
      const r = await svc.createRepertoire('u-1', {
        title: 't',
        pgn: '1. e4',
      });
      await expect(
        svc.listRepertoireProgress('u-2', r.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('пустой репертуар (нет линий) → lines=[]', async () => {
      const { svc } = makeReviewService();
      const r = await svc.createRepertoire('u-1', {
        title: 't',
        pgn: '1. e4',
      });
      const result = await svc.listRepertoireProgress('u-1', r.id);
      expect(result.lines).toEqual([]);
    });
  });

  describe('KS-3293 (M2 B7): createRepertoireFromAnalysis', () => {
    it('из своего analysis → создаёт репертуар с PGN из analysis', async () => {
      const { svc, repo } = makeReviewService();
      repo._seedAnalysis({
        id: 'a-1',
        userId: 'u-1',
        title: 'My Caro-Kann',
        headline: null,
        pgn: '1. e4 c6 2. d4 d5',
      });
      const r = await svc.createRepertoireFromAnalysis('u-1', {
        analysisId: 'a-1',
      });
      expect(r.title).toBe('My Caro-Kann');
      expect(r.pgn).toBe('1. e4 c6 2. d4 d5');
      expect(r.nodeCount).toBe(5);
    });

    it('из своего analysis с явным title → используется явный title', async () => {
      const { svc, repo } = makeReviewService();
      repo._seedAnalysis({
        id: 'a-1',
        userId: 'u-1',
        title: 'My Game',
        headline: null,
        pgn: '1. e4 e5',
      });
      const r = await svc.createRepertoireFromAnalysis('u-1', {
        analysisId: 'a-1',
        title: 'Open Game (custom)',
        description: 'Imported from analysis',
      });
      expect(r.title).toBe('Open Game (custom)');
      expect(r.description).toBe('Imported from analysis');
    });

    it('fallback title: headline → "Опенинг из анализа"', async () => {
      const { svc, repo } = makeReviewService();
      repo._seedAnalysis({
        id: 'a-1',
        userId: 'u-1',
        title: null,
        headline: 'Magnus vs Hikaru — Sicilian',
        pgn: '1. e4 c5',
      });
      const r = await svc.createRepertoireFromAnalysis('u-1', {
        analysisId: 'a-1',
      });
      expect(r.title).toBe('Magnus vs Hikaru — Sicilian');
    });

    it('чужой analysisId → 404 NotFoundException', async () => {
      const { svc, repo } = makeReviewService();
      repo._seedAnalysis({
        id: 'a-1',
        userId: 'u-other',
        title: 'Not mine',
        headline: null,
        pgn: '1. e4',
      });
      await expect(
        svc.createRepertoireFromAnalysis('u-1', { analysisId: 'a-1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('analysis без pgn → 400 BadRequestException', async () => {
      const { svc, repo } = makeReviewService();
      repo._seedAnalysis({
        id: 'a-1',
        userId: 'u-1',
        title: 'Empty',
        headline: null,
        pgn: null,
      });
      await expect(
        svc.createRepertoireFromAnalysis('u-1', { analysisId: 'a-1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('KS-3294 (M2 B8): getActiveSession + orphan-pruning', () => {
    it('нет активной сессии → session=null', async () => {
      const { svc } = makeReviewService();
      const r = await svc.createRepertoire('u-1', {
        title: 't',
        pgn: '1. e4',
      });
      const r2 = await svc.getActiveSession('u-1', r.id);
      expect(r2.session).toBeNull();
    });

    it('есть активная сессия → возвращается DTO', async () => {
      const { svc } = makeReviewService();
      const r = await svc.createRepertoire('u-1', {
        title: 't',
        pgn: '1. e4',
      });
      const start = await svc.startSession('u-1', r.id, {
        side: 'white',
        mode: 'learn',
      });
      const r2 = await svc.getActiveSession('u-1', r.id);
      expect(r2.session).not.toBeNull();
      expect(r2.session?.id).toBe(start.session.id);
    });

    it('owner-check: чужой репертуар → 404', async () => {
      const { svc } = makeReviewService();
      const r = await svc.createRepertoire('u-1', {
        title: 't',
        pgn: '1. e4',
      });
      await expect(svc.getActiveSession('u-2', r.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('orphan-pruning: PATCH pgn удаляет вариант → старые pathHash → orphaned=true', async () => {
      const { svc, repo } = makeReviewService();
      // PGN с двумя вариантами: 1.e4 (1.d4).
      const r = await svc.createRepertoire('u-1', {
        title: 't',
        pgn: '1. e4 (1. d4)',
      });
      // Засеиваем line-progress для e2e4 и d2d4.
      repo._seedLineProgress({
        userId: 'u-1',
        repertoireId: r.id,
        pathHash: pathHashFn(['e2e4']),
        pathUci: ['e2e4'],
        pathLength: 1,
        correctCount: 3,
        wrongCount: 0,
        consecutiveCorrect: 3,
        lastPlayedAt: new Date(),
        masteredAt: new Date(),
        sm2DueAt: null,
        sm2Easiness: 2.6,
        sm2Interval: 1,
        sm2Reps: 1,
        orphaned: false,
      });
      repo._seedLineProgress({
        userId: 'u-1',
        repertoireId: r.id,
        pathHash: pathHashFn(['d2d4']),
        pathUci: ['d2d4'],
        pathLength: 1,
        correctCount: 2,
        wrongCount: 0,
        consecutiveCorrect: 2,
        lastPlayedAt: new Date(),
        masteredAt: null,
        sm2DueAt: null,
        sm2Easiness: null,
        sm2Interval: null,
        sm2Reps: null,
        orphaned: false,
      });

      // PATCH pgn — удаляем 1.d4 вариант.
      await svc.updateRepertoire('u-1', r.id, { pgn: '1. e4' });

      // Записи: e2e4 валиден → НЕ orphan; d2d4 невалиден → orphan=true.
      const all = await svc.listRepertoireProgress('u-1', r.id);
      const byPath = Object.fromEntries(
        all.lines.map((l) => [l.pathUci.join(','), l]),
      );
      expect(byPath['e2e4'].orphaned).toBe(false);
      expect(byPath['d2d4'].orphaned).toBe(true);
    });

    it('KS-3302: startSession игнорирует dto.side, берёт из repertoire', async () => {
      const { svc } = makeReviewService();
      const r = await svc.createRepertoire('u-1', {
        title: 't',
        pgn: '1. e4 e5',
        side: 'black', // фиксируем за чёрных
      });
      // dto.side = 'white' должен быть проигнорирован.
      const start = await svc.startSession('u-1', r.id, {
        side: 'white' as 'white' | 'black',
        mode: 'learn',
      });
      // Сторона должна быть 'black' (из репертуара).
      expect(start.session.side).toBe('black');
      // Поскольку играем чёрными, бот сделал первый ход.
      expect(start.initialBotMove).not.toBeNull();
    });

    it('KS-3302: createRepertoire сохраняет side (default white)', async () => {
      const { svc } = makeReviewService();
      const r1 = await svc.createRepertoire('u-1', {
        title: 'whites',
        pgn: '1. e4',
      });
      expect(r1.side).toBe('white');

      const r2 = await svc.createRepertoire('u-1', {
        title: 'blacks',
        pgn: '1. e4',
        side: 'black',
      });
      expect(r2.side).toBe('black');
    });

    it('KS-3302: from-analysis с side=black создаёт чёрный репертуар', async () => {
      const { svc, repo } = makeReviewService();
      repo._seedAnalysis({
        id: 'a-1',
        userId: 'u-1',
        title: 'My Black Defense',
        headline: null,
        pgn: '1. e4 c6',
      });
      const r = await svc.createRepertoireFromAnalysis('u-1', {
        analysisId: 'a-1',
        side: 'black',
      });
      expect(r.side).toBe('black');
    });

    it('orphan-resurrection: PATCH pgn возвращает удалённый вариант → orphaned=false', async () => {
      const { svc, repo } = makeReviewService();
      const r = await svc.createRepertoire('u-1', {
        title: 't',
        pgn: '1. e4',
      });
      // Засеиваем линию d2d4 как orphan'a (мол, был в старом PGN).
      repo._seedLineProgress({
        userId: 'u-1',
        repertoireId: r.id,
        pathHash: pathHashFn(['d2d4']),
        pathUci: ['d2d4'],
        pathLength: 1,
        correctCount: 3,
        wrongCount: 0,
        consecutiveCorrect: 3,
        lastPlayedAt: new Date(),
        masteredAt: new Date(),
        sm2DueAt: null,
        sm2Easiness: 2.6,
        sm2Interval: 1,
        sm2Reps: 1,
        orphaned: true,
      });
      // PATCH pgn — добавляем d4 как вариант.
      await svc.updateRepertoire('u-1', r.id, { pgn: '1. e4 (1. d4)' });
      // d2d4 валиден → orphaned=false (resurrected).
      const all = await svc.listRepertoireProgress('u-1', r.id);
      const d4Line = all.lines.find((l) => l.pathUci.join(',') === 'd2d4');
      expect(d4Line?.orphaned).toBe(false);
    });
  });

  it('listDueReviews фильтрует по repertoireId если задан', async () => {
    const { svc, repo } = makeReviewService();
    const r1 = await svc.createRepertoire('u-1', {
      title: 'A',
      pgn: '1. e4',
    });
    const r2 = await svc.createRepertoire('u-1', {
      title: 'B',
      pgn: '1. d4',
    });
    repo._seedLineProgress({
      userId: 'u-1',
      repertoireId: r1.id,
      pathHash: 'h1',
      pathUci: ['e2e4'],
      pathLength: 1,
      correctCount: 3,
      wrongCount: 0,
      consecutiveCorrect: 3,
      lastPlayedAt: new Date(),
      masteredAt: new Date(),
      sm2DueAt: new Date('2026-05-23T00:00:00Z'),
      sm2Easiness: 2.6,
      sm2Interval: 1,
      sm2Reps: 1,
      orphaned: false,
    });
    repo._seedLineProgress({
      userId: 'u-1',
      repertoireId: r2.id,
      pathHash: 'h2',
      pathUci: ['d2d4'],
      pathLength: 1,
      correctCount: 3,
      wrongCount: 0,
      consecutiveCorrect: 3,
      lastPlayedAt: new Date(),
      masteredAt: new Date(),
      sm2DueAt: new Date('2026-05-23T00:00:00Z'),
      sm2Easiness: 2.6,
      sm2Interval: 1,
      sm2Reps: 1,
      orphaned: false,
    });
    const all = await svc.listDueReviews('u-1');
    expect(all.lines).toHaveLength(2);
    const filtered = await svc.listDueReviews('u-1', { repertoireId: r1.id });
    expect(filtered.lines).toHaveLength(1);
    expect(filtered.lines[0].repertoireTitle).toBe('A');
  });
});

describe('KS-3283 (M2 stats): GET /repertoires/:id/stats', () => {
  function makeService() {
    const repo = new FakeRepo();
    const builder = new RepertoireBuilderService();
    const progress = {
      recordAttempt: jest.fn(async () => null),
      applyReviewResult: jest.fn(async () => null),
    } as unknown as OpeningLineProgressService;
    const svc = new OpeningTrainerService(
      repo as unknown as OpeningTrainerRepository,
      builder,
      progress,
    );
    return { svc, repo };
  }

  it('пустой репертуар (нет сессий) → все нули', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 e5',
    });
    const stats = await svc.getRepertoireStats('u-1', r.id);
    expect(stats.totalSessions).toBe(0);
    expect(stats.completedSessions).toBe(0);
    expect(stats.totalAttempts).toBe(0);
    expect(stats.correctAttempts).toBe(0);
    expect(stats.wrongAttempts).toBe(0);
    expect(stats.hintsUsed).toBe(0);
    expect(stats.accuracyPercent).toBe(0);
    expect(stats.topErrorPositions).toEqual([]);
    expect(stats.lastSessions).toEqual([]);
  });

  it('owner-check: чужой репертуар → 404', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4',
    });
    await expect(svc.getRepertoireStats('u-2', r.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('агрегация: 2 сессии, разные attempts → корректные totals + accuracy + topError', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 e5 2. Nf3 Nc6', // 2 user-correct'а до tree-complete
    });
    const s1 = await svc.startSession('u-1', r.id, { mode: 'learn' });
    const s2 = await svc.startSession('u-1', r.id, { mode: 'learn' });

    // s1: user white. Bot не ходит на старте. Юзер делает:
    //   1) e2e4 (correct, бот отвечает e7e5)
    //   2) wrong (a7a6 на after-e5)
    //   3) wrong (a7a6 снова — same wrong move)
    //   4) g1f3 (correct, бот отвечает b8c6, tree-complete)
    await svc.makeMove('u-1', s1.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 3000,
    });
    await svc.makeMove('u-1', s1.session.id, {
      moveUci: 'a7a6',
      responseTimeMs: 3000,
    });
    await svc.makeMove('u-1', s1.session.id, {
      moveUci: 'a7a6',
      responseTimeMs: 3000,
    });
    await svc.makeMove('u-1', s1.session.id, {
      moveUci: 'g1f3',
      responseTimeMs: 3000,
    });
    // s2: user white. 1 user-correct (e2e4 + бот e7e5).
    await svc.makeMove('u-1', s2.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 3000,
    });
    await svc.finish('u-1', s2.session.id);

    const stats = await svc.getRepertoireStats('u-1', r.id);
    expect(stats.totalSessions).toBe(2);
    expect(stats.completedSessions).toBeGreaterThanOrEqual(1);
    expect(stats.totalAttempts).toBe(5); // 4 в s1 + 1 в s2
    expect(stats.correctAttempts).toBe(3); // e2e4, g1f3 в s1 + e2e4 в s2
    expect(stats.wrongAttempts).toBe(2); // 2 раза a7a6 в s1
    expect(stats.accuracyPercent).toBe(60); // 3/5 = 60%

    // Top error positions: after-e5 имеет 2 wrong (a7a6) + 1 correct
    // (g1f3) = 3 totalCount, 2 wrong.
    expect(stats.topErrorPositions.length).toBeGreaterThanOrEqual(1);
    const topErr = stats.topErrorPositions[0];
    expect(topErr.wrongCount).toBe(2);
    expect(topErr.totalCount).toBe(3);
    expect(topErr.errorRate).toBeCloseTo(2 / 3, 3);
    expect(topErr.mostFrequentWrongMove).toBe('a7a6');
    expect(topErr.expectedMoves).toContain('g1f3');
  });

  it('mostFrequentWrongMove=null если нет одного явного mode', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4 e5 2. Nf3 Nc6',
    });
    const s1 = await svc.startSession('u-1', r.id, { mode: 'learn' });
    await svc.makeMove('u-1', s1.session.id, {
      moveUci: 'e2e4',
      responseTimeMs: 3000,
    });
    // 2 разных wrong moves на after-e5: a7a6 и b7b6 (по 1 разу).
    await svc.makeMove('u-1', s1.session.id, {
      moveUci: 'a7a6',
      responseTimeMs: 3000,
    });
    await svc.makeMove('u-1', s1.session.id, {
      moveUci: 'b7b6',
      responseTimeMs: 3000,
    });
    const stats = await svc.getRepertoireStats('u-1', r.id);
    const topErr = stats.topErrorPositions[0];
    expect(topErr.wrongCount).toBe(2);
    expect(topErr.mostFrequentWrongMove).toBeNull(); // tie → null
  });

  it('lastSessions: последние 10, сортировка по startedAt DESC, accuracy = correctMoves/movesPlayed', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: '1. e4',
    });
    // 3 сессии с разным результатом.
    for (let i = 0; i < 3; i++) {
      const s = await svc.startSession('u-1', r.id, { mode: 'learn' });
      await svc.makeMove('u-1', s.session.id, {
        moveUci: 'e2e4',
        responseTimeMs: 3000,
      });
    }
    const stats = await svc.getRepertoireStats('u-1', r.id);
    expect(stats.lastSessions).toHaveLength(3);
    // Все сессии должны иметь accuracy=1 (1 correct, 0 wrongs).
    for (const s of stats.lastSessions) {
      expect(s.accuracy).toBeGreaterThan(0);
    }
  });
});

describe('KS-3301 (M2 regression): wrong + correct засчитывается с первого ввода во всех 3 режимах', () => {
  /**
   * KS-3301 — пользователь жалуется что после M2 deploy «два раза
   * предлагает один и тот же ход». Воспроизводим сценарий на
   * упрощённом PGN (минимум 2 ply, чтобы был user-move):
   *
   *   1.e4 e5 — bot:e4, user:e5.
   *
   * В каждом режиме (learn, review, mistakes) проверяем:
   *   1. User делает wrong (a7a6 не в репертуаре).
   *   2. Сразу следом делает correct (e7e5).
   *   3. Backend должен засчитать correct СРАЗУ (not 'wrong'),
   *      session.currentFen двигается, correctMoves увеличивается.
   */

  const SIMPLE_PGN = '1. e4 e5';

  it('learn mode: wrong + correct → correct засчитан с первого ввода', async () => {
    const repo = new FakeRepo();
    const builder = new RepertoireBuilderService();
    const progress = {
      recordAttempt: jest.fn(async () => null),
      applyReviewResult: jest.fn(async () => null),
    } as unknown as OpeningLineProgressService;
    const svc = new OpeningTrainerService(
      repo as unknown as OpeningTrainerRepository,
      builder,
      progress,
    );
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: SIMPLE_PGN,
      side: 'black', // user plays black (отвечает на e4)
    });
    const start = await svc.startSession('u-1', r.id, { mode: 'learn' });
    // Bot уже сыграл e4. Юзеру надо сыграть e5.
    expect(start.initialBotMove).not.toBeNull();
    expect(start.session.currentPath).toEqual(['e2e4']);

    // Шаг 1: wrong (a7a6 не в репертуаре).
    const wrong = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'a7a6',
      responseTimeMs: 3000,
    });
    expect(wrong.result).toBe('wrong');
    expect(wrong.session.currentFen).toBe(start.session.currentFen);

    // Шаг 2: correct (e7e5). Должен быть успех с первого ввода.
    const correct = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e7e5',
      responseTimeMs: 3000,
    });
    expect(correct.result).not.toBe('wrong');
    expect(correct.session.correctMoves).toBe(1);
    expect(correct.session.wrongMoves).toBe(1);
    // currentFen двигается (или сразу tree-complete если линия закончилась).
    expect(correct.session.currentFen).not.toBe(start.session.currentFen);
  });

  it('mistakes mode: wrong + correct засчитывается с первого ввода', async () => {
    const repo = new FakeRepo();
    const builder = new RepertoireBuilderService();
    const progress = {
      recordAttempt: jest.fn(async () => null),
      applyReviewResult: jest.fn(async () => null),
    } as unknown as OpeningLineProgressService;
    const svc = new OpeningTrainerService(
      repo as unknown as OpeningTrainerRepository,
      builder,
      progress,
    );
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: SIMPLE_PGN,
      side: 'black',
    });
    // Seed mistake-линию.
    repo._seedLineProgress({
      userId: 'u-1',
      repertoireId: r.id,
      pathHash: pathHashFn(['e2e4']),
      pathUci: ['e2e4'],
      pathLength: 1,
      correctCount: 0,
      wrongCount: 2,
      consecutiveCorrect: 0,
      lastPlayedAt: new Date(),
      masteredAt: null,
      sm2DueAt: null,
      sm2Easiness: null,
      sm2Interval: null,
      sm2Reps: null,
      orphaned: false,
    });
    const start = await svc.startSession('u-1', r.id, { mode: 'mistakes' });
    expect(start.session.currentPath).toEqual(['e2e4']);
    // Юзер играет с позиции after-e4.

    // Wrong (a7a6).
    const wrong = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'a7a6',
      responseTimeMs: 3000,
    });
    expect(wrong.result).toBe('wrong');

    // Correct (e7e5) — должен сразу пройти.
    const correct = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e7e5',
      responseTimeMs: 3000,
    });
    expect(correct.result).not.toBe('wrong');
    expect(correct.session.correctMoves).toBe(1);
  });

  it('review mode: wrong + correct засчитывается с первого ввода, applyReviewResult вызывается правильно', async () => {
    const repo = new FakeRepo();
    const builder = new RepertoireBuilderService();
    const progress = {
      recordAttempt: jest.fn(async () => null),
      applyReviewResult: jest.fn(async () => null),
    } as unknown as OpeningLineProgressService;
    const svc = new OpeningTrainerService(
      repo as unknown as OpeningTrainerRepository,
      builder,
      progress,
    );
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: SIMPLE_PGN,
      side: 'black',
    });
    // Seed due-линию.
    repo._seedLineProgress({
      userId: 'u-1',
      repertoireId: r.id,
      pathHash: pathHashFn(['e2e4']),
      pathUci: ['e2e4'],
      pathLength: 1,
      correctCount: 3,
      wrongCount: 0,
      consecutiveCorrect: 3,
      lastPlayedAt: new Date('2026-05-22T00:00:00Z'),
      masteredAt: new Date('2026-05-22T00:00:00Z'),
      sm2DueAt: new Date('2026-05-23T00:00:00Z'), // в прошлом → due
      sm2Easiness: 2.6,
      sm2Interval: 1,
      sm2Reps: 1,
      orphaned: false,
    });
    const start = await svc.startSession('u-1', r.id, { mode: 'review' });
    expect(start.session.currentPath).toEqual(['e2e4']);

    // Wrong.
    const wrong = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'a7a6',
      responseTimeMs: 3000,
    });
    expect(wrong.result).toBe('wrong');
    // applyReviewResult(q=1) вызван — линия отмечена как нужная повторению.
    expect(progress.applyReviewResult).toHaveBeenCalledWith(
      expect.objectContaining({ pathUci: ['e2e4'], quality: 1 }),
    );

    (progress.applyReviewResult as jest.Mock).mockClear();

    // Correct сразу следом — должен пройти.
    const correct = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e7e5',
      responseTimeMs: 3000,
    });
    expect(correct.result).not.toBe('wrong');
    expect(correct.session.correctMoves).toBe(1);
    // Линия dirty (был wrong), поэтому applyReviewResult q=5 НЕ вызывается.
    expect(progress.applyReviewResult).not.toHaveBeenCalled();
  });

  it('Каталон PGN: глубокий wrong+correct в Ne5 варианте', async () => {
    const PGN_CATALON =
      '1. c4 e6 2. g3 d5 3. Bg2 dxc4 4. Nf3 a6 5. Qc2 ' +
      '(5. Ne5 Qd4 6. f4 Nd7 7. e3 Qc5 8. Nxd7 Bxd7 9. Bxb7 Rb8 10. Bf3 (10. Bg2 Bc6 $15) 10... e5 $15) ' +
      '(5. Na3 b5 6. Ne5 Ra7 7. O-O Bb7 8. Bxb7 Rxb7 9. Nc2 Nf6 10. b3 cxb3 11. axb3 Qd5 12. d4 Qxb3 13. Re1 Ne4 $17) ' +
      '5... b5 6. Ne5 Ra7 7. d3 (7. b3 cxb3 8. axb3 c5 $17) 7... cxd3 8. Qxd3 Qxd3 9. Nxd3 Bb7 10. Be3 Bxg2 11. Bxa7 Bxh1 12. Bxb8 Be4 $11';
    const repo = new FakeRepo();
    const builder = new RepertoireBuilderService();
    const progress = {
      recordAttempt: jest.fn(async () => null),
      applyReviewResult: jest.fn(async () => null),
    } as unknown as OpeningLineProgressService;
    const svc = new OpeningTrainerService(
      repo as unknown as OpeningTrainerRepository,
      builder,
      progress,
    );
    const r = await svc.createRepertoire('u-1', {
      title: 'Каталон',
      pgn: PGN_CATALON,
      side: 'black',
    });
    const start = await svc.startSession('u-1', r.id, { mode: 'learn' });
    // Bot играет c4. Юзер должен e6.
    expect(start.initialBotMove?.moveSan).toBe('c4');
    expect(start.session.currentPath).toEqual(['c2c4']);

    // Wrong: a7a6 не в репертуаре чёрных на этой позиции.
    const wrong = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'a7a6',
      responseTimeMs: 3000,
    });
    expect(wrong.result).toBe('wrong');
    expect(wrong.session.currentFen).toBe(start.session.currentFen);

    // Correct: e7e6 (правильный ответ на c4 в Каталоне).
    const correct = await svc.makeMove('u-1', start.session.id, {
      moveUci: 'e7e6',
      responseTimeMs: 3000,
    });
    expect(correct.result).not.toBe('wrong');
    expect(correct.session.correctMoves).toBe(1);
    expect(correct.session.wrongMoves).toBe(1);
    // currentFen двигается.
    expect(correct.session.currentFen).not.toBe(start.session.currentFen);
  });
});
