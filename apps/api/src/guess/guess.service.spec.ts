/**
 * KS-3409 / ADR-086 §9 B2 — unit-тесты GuessService.
 * Prisma мокается; проверяем server-trust (метрики из compareGuessMove),
 * owner-check, агрегаты (score/streak/betterThanPlayerCount), две точности.
 */
import { GuessService } from './guess.service';
import { ForbiddenException, BadRequestException } from '@nestjs/common';

type AnyMock = any;

function makePrisma(over: Partial<Record<string, any>> = {}): AnyMock {
  return {
    guessSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      ...(over.guessSession ?? {}),
    },
    guessMove: {
      upsert: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      ...(over.guessMove ?? {}),
    },
  };
}

// raw WDL POV side-to-move.
const wdl = (w: number, d: number, l: number) => ({ w, d, l });

describe('GuessService.startSession', () => {
  it('создаёт сессию для archive с gameRef', async () => {
    const prisma = makePrisma();
    prisma.guessSession.create.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      gameSource: 'archive',
      gameRef: 'g1',
      pgn: null,
      side: 'white',
      status: 'active',
      userAccuracy: null,
      playerAccuracy: null,
      userStars: null,
      score: 0,
      bestStreak: 0,
      betterThanPlayerCount: 0,
      startedAt: new Date('2026-05-29T00:00:00Z'),
      finishedAt: null,
    });
    const svc = new GuessService(prisma);
    const r = await svc.startSession('u1', {
      gameSource: 'archive',
      gameRef: 'g1',
      side: 'white',
    });
    expect(r.session.id).toBe('s1');
    expect(r.session.status).toBe('active');
    expect(prisma.guessSession.create).toHaveBeenCalledTimes(1);
  });

  it('archive без gameRef → BadRequest', async () => {
    const svc = new GuessService(makePrisma());
    await expect(
      svc.startSession('u1', { gameSource: 'archive', side: 'white' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("pgn без pgn-тела → BadRequest", async () => {
    const svc = new GuessService(makePrisma());
    await expect(
      svc.startSession('u1', { gameSource: 'pgn', side: 'black' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('GuessService.submitMove (server-trust + агрегаты)', () => {
  function activeSession() {
    return {
      id: 's1',
      userId: 'u1',
      gameSource: 'archive',
      gameRef: 'g1',
      pgn: null,
      side: 'white',
      status: 'active',
      userAccuracy: null,
      playerAccuracy: null,
      userStars: null,
      score: 0,
      bestStreak: 0,
      betterThanPlayerCount: 0,
      startedAt: new Date(),
      finishedAt: null,
    };
  }

  it('пересчитывает метрики из WDL (не доверяет клиенту), пишет ход', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(activeSession());
    // после upsert — один ход (betterThanPlayer-кейс).
    prisma.guessMove.findMany.mockResolvedValue([
      { ply: 20, verdict: 'betterThanPlayer' },
    ]);
    prisma.guessSession.update.mockResolvedValue(activeSession());
    const svc = new GuessService(prisma);

    const r = await svc.submitMove('u1', 's1', {
      ply: 20,
      fenBefore: 'fen',
      playedUci: 'g1f3',
      userUci: 'd2d4',
      bestUci: 'e2e4',
      // выбранная white: eBefore=0.94. реальный обвалил, юзер лучше.
      wdlBefore: wdl(900, 80, 20),
      wdlAfterPlayed: wdl(600, 200, 200), // POV black → инверт E≈0.30, lossPlayer≈0.64
      wdlAfterUser: wdl(300, 100, 600), // POV black → инверт E≈0.65, lossUser≈0.29
    });

    // verdict пересчитан сервером.
    expect(r.move.verdict).toBe('betterThanPlayer');
    expect(r.move.lossPlayer).toBeGreaterThan(r.move.lossUser);
    // upsert вызван с пересчитанными метриками.
    const upsertArg = prisma.guessMove.upsert.mock.calls[0][0];
    expect(upsertArg.create.verdict).toBe('betterThanPlayer');
    expect(upsertArg.where).toEqual({ sessionId_ply: { sessionId: 's1', ply: 20 } });
    // агрегаты обновлены.
    expect(r.betterThanPlayerCount).toBe(1);
    expect(r.score).toBe(7); // betterThanPlayer = 7 очков
    expect(r.currentStreak).toBe(1);
  });

  it('чужая сессия → Forbidden', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue({
      ...activeSession(),
      userId: 'other',
    });
    const svc = new GuessService(prisma);
    await expect(
      svc.submitMove('u1', 's1', {
        ply: 1,
        fenBefore: 'f',
        playedUci: 'e2e4',
        userUci: 'e2e4',
        bestUci: 'e2e4',
        wdlBefore: wdl(500, 300, 200),
        wdlAfterPlayed: wdl(500, 300, 200),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('завершённая сессия → BadRequest (не active)', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue({
      ...activeSession(),
      status: 'finished',
    });
    const svc = new GuessService(prisma);
    await expect(
      svc.submitMove('u1', 's1', {
        ply: 1,
        fenBefore: 'f',
        playedUci: 'e2e4',
        userUci: 'e2e4',
        bestUci: 'e2e4',
        wdlBefore: wdl(500, 300, 200),
        wdlAfterPlayed: wdl(500, 300, 200),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('стрик рвётся на weaker', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(activeSession());
    prisma.guessMove.findMany.mockResolvedValue([
      { ply: 1, verdict: 'strongest' },
      { ply: 2, verdict: 'betterThanPlayer' },
      { ply: 3, verdict: 'weaker' }, // рвёт
    ]);
    prisma.guessSession.update.mockResolvedValue(activeSession());
    const svc = new GuessService(prisma);
    const r = await svc.submitMove('u1', 's1', {
      ply: 3,
      fenBefore: 'f',
      playedUci: 'a2a3',
      userUci: 'h2h3',
      bestUci: 'e2e4',
      wdlBefore: wdl(900, 80, 20),
      wdlAfterPlayed: wdl(100, 100, 800),
      wdlAfterUser: wdl(800, 100, 100),
    });
    expect(r.currentStreak).toBe(0); // хвостовой стрик прерван (weaker)
    // BETTER_THAN_PLAYER = {strongest, betterThanPlayer} → 2 из 3 ходов.
    expect(r.betterThanPlayerCount).toBe(2);
  });
});

describe('GuessService.finish (две точности + outcome)', () => {
  function finishedMoves() {
    return [
      { accuracyUser: 95, accuracyPlayer: 80, userClass: 'best' },
      { accuracyUser: 90, accuracyPlayer: 70, userClass: 'good' },
    ];
  }
  it('считает userAccuracy/playerAccuracy/stars, ставит finished, outcome=userBetter', async () => {
    const prisma = makePrisma();
    const base = {
      id: 's1',
      userId: 'u1',
      gameSource: 'archive',
      gameRef: 'g1',
      pgn: null,
      side: 'white',
      status: 'active',
      userAccuracy: null,
      playerAccuracy: null,
      userStars: null,
      score: 12,
      bestStreak: 2,
      betterThanPlayerCount: 2,
      startedAt: new Date(),
      finishedAt: null,
    };
    prisma.guessSession.findUnique.mockResolvedValue(base);
    prisma.guessMove.findMany.mockResolvedValue(finishedMoves());
    prisma.guessSession.update.mockImplementation(async ({ data }: any) => ({
      ...base,
      ...data,
    }));
    const svc = new GuessService(prisma);
    const r = await svc.finish('u1', 's1');

    expect(r.session.status).toBe('finished');
    expect(r.session.userAccuracy).not.toBeNull();
    expect(r.session.playerAccuracy).not.toBeNull();
    expect(r.session.userStars).not.toBeNull();
    // user 95/90 > player 80/70 → userBetter.
    expect(r.outcome).toBe('userBetter');
  });

  it('идемпотентно для уже finished', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      gameSource: 'archive',
      gameRef: 'g1',
      pgn: null,
      side: 'white',
      status: 'finished',
      userAccuracy: 87,
      playerAccuracy: 81,
      userStars: 4,
      score: 12,
      bestStreak: 2,
      betterThanPlayerCount: 2,
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    const svc = new GuessService(prisma);
    const r = await svc.finish('u1', 's1');
    expect(r.outcome).toBe('userBetter');
    // повторный finish не апдейтит.
    expect(prisma.guessSession.update).not.toHaveBeenCalled();
  });
});
