import { OpeningTrainerService } from './opening-trainer.service';
import { OpeningTrainerRepository } from './opening-trainer.repository';
import { RepertoireBuilderService } from './repertoire-builder.service';
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
      currentPath: [],
      score: 0,
      movesPlayed: 0,
      correctMoves: 0,
      wrongMoves: 0,
      hintsUsed: 0,
      currentStreak: 0,
      streakMax: 0,
      pendingHintFen: null,
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
}

function makeService() {
  const repo = new FakeRepo();
  const builder = new RepertoireBuilderService();
  const svc = new OpeningTrainerService(
    repo as unknown as OpeningTrainerRepository,
    builder,
  );
  return { svc, repo };
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

  it('start session играя чёрными — бот делает первый ход', async () => {
    const { svc } = makeService();
    const r = await svc.createRepertoire('u-1', {
      title: 't',
      pgn: SAMPLE_PGN,
    });
    const start = await svc.startSession('u-1', r.id, {
      side: 'black',
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

  it('line-complete: единственный ход → после него нет edges → session finished', async () => {
    const { svc } = makeService();
    // PGN с одним ходом — после e4 нет ответа в репертуаре, line-complete.
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
    expect(r1.result).toBe('line-complete');
    expect(r1.session.status).toBe('finished');
  });
});
