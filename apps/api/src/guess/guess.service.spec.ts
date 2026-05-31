/**
 * KS-3409 / ADR-086 §9 B2 — unit-тесты GuessService.
 * Prisma мокается; проверяем server-trust (метрики из compareGuessMove),
 * owner-check, агрегаты (score/streak/betterThanPlayerCount), две точности.
 */
import { GuessService } from './guess.service';
import {
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';

type AnyMock = any;

function makePrisma(over: Partial<Record<string, any>> = {}): AnyMock {
  return {
    guessSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: 0 },
        _avg: { userAccuracy: null, playerAccuracy: null, userStars: null },
        _sum: { score: 0, betterThanPlayerCount: 0 },
        _max: { bestStreak: 0 },
      }),
      ...(over.guessSession ?? {}),
    },
    guessMove: {
      upsert: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      ...(over.guessMove ?? {}),
    },
    // KS-3460. Для toAnalysis-пути.
    analysis: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      ...(over.analysis ?? {}),
    },
    // KS-3508. Stats endpoints используют $queryRawUnsafe.
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };
}

/**
 * KS-3460. Стаб AnalysisService — для конструктора. По умолчанию
 * `create` возвращает фейк-id. Тесты, проверяющие toAnalysis, могут
 * передавать свою реализацию.
 */
function makeAnalysisService(over: Partial<AnyMock> = {}): AnyMock {
  return {
    create: jest.fn().mockResolvedValue({ id: 'a1', existing: false }),
    // KS-3523: lazy-resolve pgn по archiveGameId/lichessGameId.
    resolveSourceGame: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

/** Стаб I18nService.t — возвращает ключ + args (детерминированно). */
function makeI18n(): AnyMock {
  return {
    t: jest.fn((key: string, opts?: { args?: Record<string, unknown> }) =>
      opts?.args ? `${key}(${JSON.stringify(opts.args)})` : key,
    ),
  };
}

function makeService(
  prisma: AnyMock,
  analysis: AnyMock = makeAnalysisService(),
  i18n: AnyMock = makeI18n(),
): GuessService {
  return new GuessService(prisma, analysis, i18n);
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
    const svc = makeService(prisma);
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
    const svc = makeService(makePrisma());
    await expect(
      svc.startSession('u1', { gameSource: 'archive', side: 'white' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("pgn без pgn-тела → BadRequest", async () => {
    const svc = makeService(makePrisma());
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
    // KS-3429: для live-accuracy нужны accuracyUser/accuracyPlayer/userClass.
    prisma.guessMove.findMany.mockResolvedValue([
      {
        ply: 20,
        verdict: 'betterThanPlayer',
        accuracyUser: 95,
        accuracyPlayer: 60,
        userClass: 'good',
        eBefore: 0.94,
        eAfterPlayed: 0.30,
        eAfterUser: 0.65,
      },
    ]);
    prisma.guessSession.update.mockResolvedValue(activeSession());
    const svc = makeService(prisma);

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
    // KS-3429: live-accuracy. 1 ход: mean=min=accuracy. user=95 без cap
    // (worst='good', cap не применяется); player=60.
    expect(r.currentUserAccuracy).toBeCloseTo(95, 5);
    expect(r.currentPlayerAccuracy).toBeCloseTo(60, 5);
    // KS-3435: HUD-табло «ты : игрок». 1 ход betterThanPlayer → user=1, player=0.
    expect(r.userPoints).toBe(1);
    expect(r.playerPoints).toBe(0);
  });

  it('чужая сессия → Forbidden', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue({
      ...activeSession(),
      userId: 'other',
    });
    const svc = makeService(prisma);
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
    const svc = makeService(prisma);
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

  it('KS-3433: Lichess-style accuracy (без cap/min, weighted+harmonic) — user падает на mistake, player мало волатилен', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(activeSession());
    // 3 хода в persisted после upsert. user имеет mistake на 3-м ходу
    // (accuracy=40), player ровный (≥88). Lichess weighted+harmonic
    // (без cap/min) — мягче «застывания» precision, но всё равно
    // штрафует за низкую accuracy через harmonic mean.
    prisma.guessMove.findMany.mockResolvedValue([
      {
        ply: 1, verdict: 'asPlayer',
        accuracyUser: 100, accuracyPlayer: 90, userClass: 'best',
        eBefore: 0.50, eAfterPlayed: 0.50, eAfterUser: 0.50,
      },
      {
        ply: 2, verdict: 'asPlayer',
        accuracyUser: 90, accuracyPlayer: 88, userClass: 'good',
        eBefore: 0.50, eAfterPlayed: 0.48, eAfterUser: 0.45,
      },
      {
        ply: 3, verdict: 'weaker',
        accuracyUser: 40, accuracyPlayer: 95, userClass: 'mistake',
        eBefore: 0.50, eAfterPlayed: 0.50, eAfterUser: 0.20,
      },
    ]);
    prisma.guessSession.update.mockResolvedValue(activeSession());
    const svc = makeService(prisma);

    const r = await svc.submitMove('u1', 's1', {
      ply: 3,
      fenBefore: 'f',
      playedUci: 'a1a2',
      userUci: 'b1b2',
      bestUci: 'c1c2',
      wdlBefore: wdl(500, 300, 200),
      wdlAfterPlayed: wdl(500, 300, 200),
      wdlAfterUser: wdl(500, 300, 200),
    });

    // user [100, 90, 40] → harmonic тянет вниз (1/40 доминирует) →
    // итог в диапазоне ~55..72. Цель: НЕ застряло на 60 (cap), но
    // реально упало (< 80).
    expect(r.currentUserAccuracy).toBeGreaterThan(50);
    expect(r.currentUserAccuracy).toBeLessThan(75);
    // player [90, 88, 95] → стабильно высоко (>87).
    expect(r.currentPlayerAccuracy).toBeGreaterThan(85);
  });

  it('KS-3435: HUD-табло user/player на смеси вердиктов (strongest+better=user, weaker=player, asPlayer=никому)', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(activeSession());
    prisma.guessMove.findMany.mockResolvedValue([
      { ply: 1, verdict: 'strongest', accuracyUser: 100, accuracyPlayer: 80, userClass: 'best',
        eBefore: 0.50, eAfterPlayed: 0.50, eAfterUser: 0.50 },
      { ply: 2, verdict: 'betterThanPlayer', accuracyUser: 90, accuracyPlayer: 70, userClass: 'good',
        eBefore: 0.50, eAfterPlayed: 0.50, eAfterUser: 0.50 },
      { ply: 3, verdict: 'asPlayer', accuracyUser: 85, accuracyPlayer: 85, userClass: 'good',
        eBefore: 0.50, eAfterPlayed: 0.50, eAfterUser: 0.50 },
      { ply: 4, verdict: 'weaker', accuracyUser: 30, accuracyPlayer: 95, userClass: 'mistake',
        eBefore: 0.50, eAfterPlayed: 0.50, eAfterUser: 0.20 },
      { ply: 5, verdict: 'weaker', accuracyUser: 40, accuracyPlayer: 95, userClass: 'mistake',
        eBefore: 0.50, eAfterPlayed: 0.50, eAfterUser: 0.25 },
    ]);
    prisma.guessSession.update.mockResolvedValue(activeSession());
    const svc = makeService(prisma);
    const r = await svc.submitMove('u1', 's1', {
      ply: 5, fenBefore: 'f', playedUci: 'a1a2', userUci: 'b1b2', bestUci: 'c1c2',
      wdlBefore: wdl(500, 300, 200), wdlAfterPlayed: wdl(500, 300, 200), wdlAfterUser: wdl(500, 300, 200),
    });
    // user = strongest + betterThanPlayer = 2; player = weaker · 2; asPlayer не считается.
    expect(r.userPoints).toBe(2);
    expect(r.playerPoints).toBe(2);
    // betterThanPlayerCount по-прежнему = userPoints (синоним, backward-compat).
    expect(r.betterThanPlayerCount).toBe(2);
  });

  it('KS-3433: реалистичная топ-партия (10 ходов 95-100, один 88) → accuracy 95+%', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(activeSession());
    const moves = Array.from({ length: 10 }, (_, i) => ({
      ply: i + 1,
      verdict: 'asPlayer',
      accuracyUser: i === 5 ? 88 : 100,
      accuracyPlayer: i === 5 ? 88 : 100,
      userClass: 'best',
      eBefore: 0.50,
      eAfterPlayed: i === 5 ? 0.45 : 0.50,
      eAfterUser: i === 5 ? 0.45 : 0.50,
    }));
    prisma.guessMove.findMany.mockResolvedValue(moves);
    prisma.guessSession.update.mockResolvedValue(activeSession());
    const svc = makeService(prisma);
    const r = await svc.submitMove('u1', 's1', {
      ply: 10, fenBefore: 'f', playedUci: 'a1a2', userUci: 'b1b2', bestUci: 'c1c2',
      wdlBefore: wdl(500, 300, 200), wdlAfterPlayed: wdl(500, 300, 200), wdlAfterUser: wdl(500, 300, 200),
    });
    // Один accuracy=88 не должен резко обвалить итог: harmonic≈98.6,
    // weighted≈98.8 → итог ~98.7%. Acceptance KS-3433: топы 95+%.
    expect(r.currentUserAccuracy).toBeGreaterThan(95);
    expect(r.currentPlayerAccuracy).toBeGreaterThan(95);
  });

  it('KS-3433: все user-ходы accuracy≈100 → user accuracy ~100 (НЕ обрезано cap=60 даже если ранее был blunder в classification)', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(activeSession());
    // worst userClass='blunder' (был раньше), НО все accuracyUser=100.
    // По precision: cap=60 → итог 60. По Lichess: cap отсутствует →
    // ~100. Цель — убедиться, что cap не применяется.
    prisma.guessMove.findMany.mockResolvedValue([
      { ply: 1, verdict: 'asPlayer', accuracyUser: 100, accuracyPlayer: 100, userClass: 'blunder',
        eBefore: 0.50, eAfterPlayed: 0.50, eAfterUser: 0.50 },
      { ply: 2, verdict: 'asPlayer', accuracyUser: 100, accuracyPlayer: 100, userClass: 'best',
        eBefore: 0.50, eAfterPlayed: 0.50, eAfterUser: 0.50 },
      { ply: 3, verdict: 'asPlayer', accuracyUser: 100, accuracyPlayer: 100, userClass: 'best',
        eBefore: 0.50, eAfterPlayed: 0.50, eAfterUser: 0.50 },
    ]);
    prisma.guessSession.update.mockResolvedValue(activeSession());
    const svc = makeService(prisma);
    const r = await svc.submitMove('u1', 's1', {
      ply: 3, fenBefore: 'f', playedUci: 'a1a2', userUci: 'b1b2', bestUci: 'c1c2',
      wdlBefore: wdl(500, 300, 200), wdlAfterPlayed: wdl(500, 300, 200), wdlAfterUser: wdl(500, 300, 200),
    });
    // Все 100 → weighted=100, harmonic=100 → ~100. cap НЕ срабатывает.
    expect(r.currentUserAccuracy).toBeGreaterThan(99);
  });

  it('стрик рвётся на weaker', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(activeSession());
    prisma.guessMove.findMany.mockResolvedValue([
      { ply: 1, verdict: 'strongest', accuracyUser: 100, accuracyPlayer: 80, userClass: 'best',
        eBefore: 0.50, eAfterPlayed: 0.50, eAfterUser: 0.50 },
      { ply: 2, verdict: 'betterThanPlayer', accuracyUser: 95, accuracyPlayer: 70, userClass: 'good',
        eBefore: 0.50, eAfterPlayed: 0.50, eAfterUser: 0.50 },
      { ply: 3, verdict: 'weaker', accuracyUser: 30, accuracyPlayer: 95, userClass: 'mistake',
        eBefore: 0.50, eAfterPlayed: 0.50, eAfterUser: 0.20 }, // рвёт
    ]);
    prisma.guessSession.update.mockResolvedValue(activeSession());
    const svc = makeService(prisma);
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
    const svc = makeService(prisma);
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
    const svc = makeService(prisma);
    const r = await svc.finish('u1', 's1');
    expect(r.outcome).toBe('userBetter');
    // повторный finish не апдейтит.
    expect(prisma.guessSession.update).not.toHaveBeenCalled();
  });
});

describe('GuessService.toAnalysis (KS-3460 / ADR-089 §6)', () => {
  function finishedSession(extra: Partial<AnyMock> = {}): AnyMock {
    return {
      id: 's1',
      userId: 'u1',
      gameSource: 'archive',
      gameRef: 'g1',
      pgn: '1. e4 e5 2. Nf3 *',
      side: 'white',
      status: 'finished',
      userAccuracy: 87,
      playerAccuracy: 81,
      userStars: 4,
      score: 10,
      bestStreak: 1,
      betterThanPlayerCount: 1,
      startedAt: new Date('2026-05-30T00:00:00Z'),
      finishedAt: new Date('2026-05-30T01:00:00Z'),
      ...extra,
    };
  }

  it('создаёт Analysis с annotated-PGN, обновляет guessSessionId, existing=false', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(finishedSession());
    prisma.guessMove.findMany.mockResolvedValue([]);
    prisma.analysis.findFirst.mockResolvedValue(null);
    prisma.analysis.update.mockResolvedValue({});
    const analysisService = makeAnalysisService({
      create: jest.fn().mockResolvedValue({ id: 'a42', existing: false }),
    });
    const svc = makeService(prisma, analysisService);

    const res = await svc.toAnalysis('u1', 's1', 'ru');

    expect(res.analysisId).toBe('a42');
    expect(res.url).toBe('/analysis/a42');
    expect(res.existing).toBe(false);
    // create вызван с PGN, без lichess/archive id, category='analysis'.
    const callArg = analysisService.create.mock.calls[0][1];
    expect(callArg.pgn).toContain('1. e4');
    expect(callArg.category).toBe('analysis');
    expect(callArg.lichessGameId).toBeUndefined();
    expect(callArg.archiveGameId).toBeUndefined();
    // Соответствующий UPDATE Analysis SET guess_session_id = sessionId.
    expect(prisma.analysis.update).toHaveBeenCalledWith({
      where: { id: 'a42' },
      data: { guessSessionId: 's1' },
    });
  });

  it('повторный вызов возвращает existing (дедуп по guessSessionId)', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(finishedSession());
    prisma.analysis.findFirst.mockResolvedValue({ id: 'a-existing' });
    const analysisService = makeAnalysisService();
    const svc = makeService(prisma, analysisService);

    const res = await svc.toAnalysis('u1', 's1', 'en');

    expect(res.existing).toBe(true);
    expect(res.analysisId).toBe('a-existing');
    expect(res.url).toBe('/analysis/a-existing');
    // AnalysisService.create НЕ должен вызываться.
    expect(analysisService.create).not.toHaveBeenCalled();
    // lastOpenedAt бамп для LRU.
    expect(prisma.analysis.update).toHaveBeenCalledWith({
      where: { id: 'a-existing' },
      data: { lastOpenedAt: expect.any(Date) },
    });
  });

  it('чужая сессия → Forbidden', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(
      finishedSession({ userId: 'OTHER' }),
    );
    const svc = makeService(prisma);
    await expect(svc.toAnalysis('u1', 's1', 'en')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('сессия не finished → Conflict', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(
      finishedSession({ status: 'active' }),
    );
    const svc = makeService(prisma);
    await expect(svc.toAnalysis('u1', 's1', 'en')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('пустой pgn → BadRequest', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(
      finishedSession({ pgn: '' }),
    );
    const svc = makeService(prisma);
    await expect(svc.toAnalysis('u1', 's1', 'en')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('P2002 race-condition на UPDATE → возвращаем winner-existing', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(finishedSession());
    // findFirst первый раз nul (дедуп не нашёл), второй — winner.
    prisma.analysis.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'a-winner' });
    prisma.analysis.update.mockRejectedValue(
      Object.assign(new Error('Unique constraint'), { code: 'P2002' }),
    );
    const analysisService = makeAnalysisService({
      create: jest.fn().mockResolvedValue({ id: 'a-loser', existing: false }),
    });
    const svc = makeService(prisma, analysisService);

    const res = await svc.toAnalysis('u1', 's1', 'en');

    expect(res.existing).toBe(true);
    expect(res.analysisId).toBe('a-winner');
    expect(res.url).toBe('/analysis/a-winner');
  });
});

// ─── KS-3508: stats / trends / breakdowns ─────────────────────────────

describe('GuessService.statsForUser — KS-3508', () => {
  it('агрегирует totals/avg + winsVsPlayer через raw count', async () => {
    const prisma = makePrisma();
    prisma.guessSession.aggregate.mockResolvedValue({
      _count: { _all: 12 },
      _avg: { userAccuracy: 87.5, playerAccuracy: 80.0, userStars: 4.1 },
      _sum: { score: 240, betterThanPlayerCount: 15 },
      _max: { bestStreak: 8 },
    });
    prisma.guessSession.count.mockResolvedValue(0);
    prisma.$queryRawUnsafe.mockResolvedValue([{ c: BigInt(7) }]);
    const svc = makeService(prisma);
    const res = await svc.statsForUser('u1');
    expect(res.totalSessions).toBe(12);
    expect(res.avgUserAccuracy).toBe(87.5);
    expect(res.avgPlayerAccuracy).toBe(80.0);
    expect(res.winsVsPlayer).toBe(7);
    expect(res.avgStars).toBe(4.1);
    expect(res.totalScore).toBe(240);
    expect(res.bestStreak).toBe(8);
    expect(res.totalBetterMoves).toBe(15);
  });
});

describe('GuessService.trendsForUser — KS-3508', () => {
  it('возвращает per-bucket sessions+avg, default bucket=week', async () => {
    const prisma = makePrisma();
    const d1 = new Date('2026-05-25T00:00:00Z');
    const d2 = new Date('2026-06-01T00:00:00Z');
    prisma.$queryRawUnsafe.mockResolvedValue([
      { bucket: d1, sessions: BigInt(3), avg_acc: 90.0 },
      { bucket: d2, sessions: BigInt(5), avg_acc: 87.5 },
    ]);
    const svc = makeService(prisma);
    const res = await svc.trendsForUser('u1', undefined);
    expect(res.bucket).toBe('week');
    expect(res.points).toEqual([
      { date: '2026-05-25', sessions: 3, avgUserAccuracy: 90.0 },
      { date: '2026-06-01', sessions: 5, avgUserAccuracy: 87.5 },
    ]);
    // Проверяем что в raw SQL пошёл bucket-параметр 'week'.
    expect(prisma.$queryRawUnsafe).toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe.mock.calls[0][1]).toBe('week');
  });

  it('bucket=day проксируется в raw SQL', async () => {
    const prisma = makePrisma();
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    const svc = makeService(prisma);
    await svc.trendsForUser('u1', 'day');
    expect(prisma.$queryRawUnsafe.mock.calls[0][1]).toBe('day');
  });

  it('невалидный bucket → fallback week', async () => {
    const prisma = makePrisma();
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    const svc = makeService(prisma);
    await svc.trendsForUser('u1', 'year');
    expect(prisma.$queryRawUnsafe.mock.calls[0][1]).toBe('week');
  });
});

describe('GuessService.breakdownsForUser — KS-3508', () => {
  it('считает доли verdict + userClass', async () => {
    const prisma = makePrisma();
    prisma.$queryRawUnsafe
      .mockResolvedValueOnce([
        { verdict: 'strongest', c: BigInt(3) },
        { verdict: 'asPlayer', c: BigInt(7) },
      ])
      .mockResolvedValueOnce([
        { user_class: 'best', c: BigInt(2) },
        { user_class: 'good', c: BigInt(8) },
      ]);
    const svc = makeService(prisma);
    const res = await svc.breakdownsForUser('u1');
    expect(res.verdict.strongest.count).toBe(3);
    expect(res.verdict.strongest.share).toBeCloseTo(0.3, 5);
    expect(res.verdict.asPlayer.count).toBe(7);
    expect(res.verdict.asPlayer.share).toBeCloseTo(0.7, 5);
    // Неотмеченные verdict'ы → нули.
    expect(res.verdict.weaker.count).toBe(0);
    expect(res.userClass.best.count).toBe(2);
    expect(res.userClass.good.count).toBe(8);
    expect(res.userClass.good.share).toBeCloseTo(0.8, 5);
  });

  it('пустые ходы → все count=0 share=0', async () => {
    const prisma = makePrisma();
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    const svc = makeService(prisma);
    const res = await svc.breakdownsForUser('u1');
    expect(res.verdict.strongest).toEqual({ count: 0, share: 0 });
    expect(res.userClass.blunder).toEqual({ count: 0, share: 0 });
  });
});

// ─── KS-3514: getSession review-страница ───────────────────────────

describe('GuessService.getSession — KS-3514', () => {
  function row(extra: Partial<AnyMock> = {}): AnyMock {
    return {
      id: 's1',
      userId: 'u1',
      gameSource: 'archive',
      gameRef: 'g1',
      pgn: null,
      side: 'white',
      status: 'finished',
      userAccuracy: 90,
      playerAccuracy: 75,
      userStars: 5,
      score: 30,
      bestStreak: 3,
      betterThanPlayerCount: 2,
      startedAt: new Date('2026-05-29T00:00:00Z'),
      finishedAt: new Date('2026-05-29T01:00:00Z'),
      ...extra,
    };
  }

  it('возвращает session+moves+userPoints+playerPoints для finished', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(row());
    prisma.guessMove.findMany.mockResolvedValue([
      { ply: 1, fenBefore: 'f', playedUci: 'a', userUci: 'a', bestUci: 'a',
        eBefore: 0.5, eAfterPlayed: 0.5, eAfterUser: 0.5,
        lossPlayer: 0, lossUser: 0, accuracyPlayer: 100, accuracyUser: 100,
        userClass: 'best', verdict: 'strongest' },
      { ply: 3, fenBefore: 'f', playedUci: 'b', userUci: 'c', bestUci: 'c',
        eBefore: 0.5, eAfterPlayed: 0.3, eAfterUser: 0.5,
        lossPlayer: 0.2, lossUser: 0, accuracyPlayer: 50, accuracyUser: 100,
        userClass: 'good', verdict: 'betterThanPlayer' },
      { ply: 5, fenBefore: 'f', playedUci: 'd', userUci: 'd', bestUci: 'd',
        eBefore: 0.5, eAfterPlayed: 0.5, eAfterUser: 0.5,
        lossPlayer: 0, lossUser: 0, accuracyPlayer: 100, accuracyUser: 100,
        userClass: 'best', verdict: 'asPlayer' },
      { ply: 7, fenBefore: 'f', playedUci: 'e', userUci: 'f', bestUci: 'e',
        eBefore: 0.5, eAfterPlayed: 0.5, eAfterUser: 0.2,
        lossPlayer: 0, lossUser: 0.3, accuracyPlayer: 100, accuracyUser: 30,
        userClass: 'blunder', verdict: 'weaker' },
    ]);
    const svc = makeService(prisma);
    const res = await svc.getSession('u1', 's1');
    expect(res.session.id).toBe('s1');
    expect(res.session.status).toBe('finished');
    expect(res.moves).toHaveLength(4);
    // strongest + betterThanPlayer = 2 userPoints; weaker = 1; asPlayer = 0.
    expect(res.userPoints).toBe(2);
    expect(res.playerPoints).toBe(1);
  });

  it('работает для active-сессии (любой status)', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(row({ status: 'active', userAccuracy: null, playerAccuracy: null }));
    prisma.guessMove.findMany.mockResolvedValue([]);
    const svc = makeService(prisma);
    const res = await svc.getSession('u1', 's1');
    expect(res.session.status).toBe('active');
    expect(res.moves).toEqual([]);
    expect(res.userPoints).toBe(0);
    expect(res.playerPoints).toBe(0);
  });

  it('чужая сессия → Forbidden', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue(row({ userId: 'other' }));
    const svc = makeService(prisma);
    await expect(svc.getSession('u1', 's1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

// ─── KS-3523: persist + lazy-resolve PGN ─────────────────────────────

describe('GuessService — KS-3523 PGN persist/lazy-resolve', () => {
  it('startSession archive без pgn: backend подгружает через resolveSourceGame и персистит', async () => {
    const prisma = makePrisma();
    const analysis = makeAnalysisService({
      resolveSourceGame: jest.fn().mockResolvedValue({
        pgn: '[White "A"]\n[Black "B"]\n\n1. e4 *',
        white: 'A',
        black: 'B',
        whiteElo: null,
        blackElo: null,
        result: '*',
      }),
    });
    prisma.guessSession.create.mockImplementation(({ data }: any) => ({
      id: 's1',
      ...data,
      userAccuracy: null,
      playerAccuracy: null,
      userStars: null,
      score: 0,
      bestStreak: 0,
      betterThanPlayerCount: 0,
      startedAt: new Date(),
      finishedAt: null,
    }));
    const svc = makeService(prisma, analysis);
    await svc.startSession('u1', {
      gameSource: 'archive',
      gameRef: 'arch-uuid',
      side: 'white',
    });
    expect(analysis.resolveSourceGame).toHaveBeenCalledWith({
      archiveGameId: 'arch-uuid',
    });
    const createArg = prisma.guessSession.create.mock.calls[0][0].data;
    expect(createArg.pgn).toContain('1. e4');
  });

  it('startSession archive: если resolve вернул null — сохраняется null pgn (не падает)', async () => {
    const prisma = makePrisma();
    prisma.guessSession.create.mockImplementation(({ data }: any) => ({
      id: 's1',
      ...data,
      userAccuracy: null,
      playerAccuracy: null,
      userStars: null,
      score: 0,
      bestStreak: 0,
      betterThanPlayerCount: 0,
      startedAt: new Date(),
      finishedAt: null,
    }));
    const svc = makeService(prisma); // analysis.resolveSourceGame по умолчанию null
    await svc.startSession('u1', {
      gameSource: 'archive',
      gameRef: 'arch-uuid',
      side: 'white',
    });
    const createArg = prisma.guessSession.create.mock.calls[0][0].data;
    expect(createArg.pgn).toBeNull();
  });

  it('startSession pgn-source: НЕ дёргает resolveSourceGame (есть dto.pgn)', async () => {
    const prisma = makePrisma();
    const analysis = makeAnalysisService();
    prisma.guessSession.create.mockImplementation(({ data }: any) => ({
      id: 's1',
      ...data,
      userAccuracy: null,
      playerAccuracy: null,
      userStars: null,
      score: 0,
      bestStreak: 0,
      betterThanPlayerCount: 0,
      startedAt: new Date(),
      finishedAt: null,
    }));
    const svc = makeService(prisma, analysis);
    await svc.startSession('u1', {
      gameSource: 'pgn',
      pgn: '1. d4 *',
      side: 'black',
    });
    expect(analysis.resolveSourceGame).not.toHaveBeenCalled();
    const createArg = prisma.guessSession.create.mock.calls[0][0].data;
    expect(createArg.pgn).toBe('1. d4 *');
  });

  it('getSession legacy без pgn: lazy-resolve, апдейт БД, в ответе session.pgn', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue({
      id: 's1', userId: 'u1', gameSource: 'archive', gameRef: 'arch-uuid',
      pgn: null, side: 'white', status: 'finished',
      userAccuracy: 80, playerAccuracy: 70, userStars: 4,
      score: 12, bestStreak: 3, betterThanPlayerCount: 2,
      startedAt: new Date(), finishedAt: new Date(),
    });
    prisma.guessSession.update.mockImplementation(({ data }: any) => ({
      id: 's1', userId: 'u1', gameSource: 'archive', gameRef: 'arch-uuid',
      side: 'white', status: 'finished',
      userAccuracy: 80, playerAccuracy: 70, userStars: 4,
      score: 12, bestStreak: 3, betterThanPlayerCount: 2,
      startedAt: new Date(), finishedAt: new Date(),
      ...data,
    }));
    const analysis = makeAnalysisService({
      resolveSourceGame: jest.fn().mockResolvedValue({
        pgn: 'LAZY-PGN',
        white: null, black: null,
        whiteElo: null, blackElo: null, result: null,
      }),
    });
    prisma.guessMove.findMany.mockResolvedValue([]);
    const svc = makeService(prisma, analysis);
    const res = await svc.getSession('u1', 's1');
    expect(analysis.resolveSourceGame).toHaveBeenCalled();
    expect(prisma.guessSession.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { pgn: 'LAZY-PGN' },
    });
    expect(res.session.pgn).toBe('LAZY-PGN');
  });

  it('toAnalysis legacy без pgn: lazy-resolve, проходит дальше (НЕ кидает has no pgn)', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue({
      id: 's1', userId: 'u1', gameSource: 'archive', gameRef: 'arch-uuid',
      pgn: null, side: 'white', status: 'finished',
      userAccuracy: 80, playerAccuracy: 70, userStars: 4,
      score: 12, bestStreak: 3, betterThanPlayerCount: 2,
      startedAt: new Date(), finishedAt: new Date(),
    });
    prisma.guessSession.update.mockImplementation(({ data }: any) => ({
      id: 's1', userId: 'u1', gameSource: 'archive', gameRef: 'arch-uuid',
      side: 'white', status: 'finished',
      userAccuracy: 80, playerAccuracy: 70, userStars: 4,
      score: 12, bestStreak: 3, betterThanPlayerCount: 2,
      startedAt: new Date(), finishedAt: new Date(),
      ...data,
    }));
    const analysis = makeAnalysisService({
      resolveSourceGame: jest.fn().mockResolvedValue({
        pgn: '1. e4 *', white: null, black: null,
        whiteElo: null, blackElo: null, result: null,
      }),
      create: jest.fn().mockResolvedValue({ id: 'a99', existing: false }),
    });
    prisma.guessMove.findMany.mockResolvedValue([]);
    const svc = makeService(prisma, analysis);
    const res = await svc.toAnalysis('u1', 's1', 'en');
    expect(res.analysisId).toBe('a99');
    expect(analysis.resolveSourceGame).toHaveBeenCalled();
  });
});

// ─── KS-3530: deleteSession ──────────────────────────────────────────

describe('GuessService.deleteSession — KS-3530', () => {
  it('owner: удаляет сессию (cascade GuessMove через FK), 204', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue({
      id: 's1', userId: 'u1', gameSource: 'archive', gameRef: 'g1',
      pgn: null, side: 'white', status: 'finished',
      userAccuracy: null, playerAccuracy: null, userStars: null,
      score: 0, bestStreak: 0, betterThanPlayerCount: 0,
      startedAt: new Date(), finishedAt: new Date(),
    });
    prisma.guessSession.delete = jest.fn().mockResolvedValue({});
    const svc = makeService(prisma);
    await svc.deleteSession('u1', 's1');
    expect(prisma.guessSession.delete).toHaveBeenCalledWith({
      where: { id: 's1' },
    });
  });

  it('чужая сессия → Forbidden', async () => {
    const prisma = makePrisma();
    prisma.guessSession.findUnique.mockResolvedValue({
      id: 's1', userId: 'OTHER', gameSource: 'archive', gameRef: 'g1',
      pgn: null, side: 'white', status: 'finished',
      userAccuracy: null, playerAccuracy: null, userStars: null,
      score: 0, bestStreak: 0, betterThanPlayerCount: 0,
      startedAt: new Date(), finishedAt: new Date(),
    });
    const svc = makeService(prisma);
    await expect(svc.deleteSession('u1', 's1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
