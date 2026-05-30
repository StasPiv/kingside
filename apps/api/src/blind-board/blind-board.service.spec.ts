/**
 * KS-3441 / ADR-088 §11 B2. Unit-тесты BlindBoardService.
 *
 * Prisma полностью мокается. Покрытие (acceptance §11 B2):
 *  1. createSession — за ≤20 попыток находит валидную позицию, пишет
 *     сессию + первый attempt; клиенту отдаёт ТОЛЬКО координаты nextMove
 *     (не fen / не типы фигур).
 *  2. submitAnswer (correct) — продолжает сессию, инкрементит streak,
 *     записывает следующий round в attempts.
 *  3. submitAnswer (wrong) — финиш `wrong-answer`, раскрывает позицию,
 *     обновляет User.blindBoardBestStreak при необходимости.
 *  4. submitAnswer (dead-end) — корректный ответ, но у новой target
 *     нет ходов с |involved|=1 → финиш `dead-end`, streak засчитан.
 *  5. owner-check — чужая сессия даёт Forbidden, неизвестная — NotFound.
 *  6. leaderboard — топ по User.blindBoardBestStreak.
 */
import { BlindBoardService, isLightSquare } from './blind-board.service';
import {
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type {
  BlindBoardPiece,
  BlindBoardSquare,
} from '@kingside/shared';

// Тип «любой» для удобства моков Prisma.
type AnyMock = any;

function makePrisma(): AnyMock {
  return {
    blindBoardSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
    },
    blindBoardAttempt: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ blindBoardBestStreak: 0 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

/** Детерминированный «рандом» — возвращает значения последовательно. */
function seqRandom(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('BlindBoardService.createSession', () => {
  it('создаёт сессию с валидным стартом, пишет первый attempt, не раскрывает позицию клиенту', async () => {
    const prisma = makePrisma();
    const created = {
      id: 's1',
      userId: 'u1',
      startPosition: [],
      currentPosition: [],
      nextTargetPiece: null,
      currentCompMove: null,
      streak: 0,
      bestStreak: 0,
      status: 'active',
      finishReason: null,
      startedAt: new Date('2026-05-30T00:00:00Z'),
      finishedAt: null,
    };
    prisma.blindBoardSession.create.mockImplementation(({ data }: any) => ({
      ...created,
      ...data,
      id: 's1',
      startedAt: created.startedAt,
    }));

    const svc = new BlindBoardService(prisma);
    // Достаточно вызовов Math.random для шаффла стартовой позиции (5 фигур
    // + индексов 5 + кандидата). seqRandom с 0.5 каждый раз — детерминизм.
    svc.setRandom(seqRandom([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]));

    const res = await svc.createSession('u1');

    expect(prisma.blindBoardSession.create).toHaveBeenCalledTimes(1);
    expect(prisma.blindBoardAttempt.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.blindBoardSession.create.mock.calls[0][0];
    // Сервер сохранил позицию (start/current) и target — это ВНУТРЕННИЕ
    // поля, в DTO клиенту они НЕ попадают.
    expect(createArgs.data.startPosition).toHaveLength(5);
    expect(createArgs.data.nextTargetPiece).toBeTruthy();
    expect(createArgs.data.currentCompMove).toBeTruthy();

    // DTO клиенту: координаты nextMove + агрегаты + startPosition
    // (KS-3448 фаза memorize). currentPosition внутри session НЕ
    // раскрывается — анти-чит §5 действует на answer-запросах.
    expect(res.session.id).toBe('s1');
    expect(res.session.status).toBe('active');
    expect(res.session.round).toBe(1);
    expect(res.session.nextMove).toEqual({
      from: createArgs.data.currentCompMove.from,
      to: createArgs.data.currentCompMove.to,
    });
    expect(res.session.streak).toBe(0);
    // KS-3448: startPosition = ровно 5 фигур (Q/R/N/B/B) для memorize.
    expect(res.startPosition).toHaveLength(5);
    const types = res.startPosition.map((p) => p.type).sort();
    expect(types).toEqual(['B', 'B', 'N', 'Q', 'R']);
  });
});

describe('BlindBoardService.submitAnswer', () => {
  // KS-3451 (novelty): для positive-теста позиция в которой target после
  // правильного ответа ещё имеет ход со свежим взаимодействием.
  // startPosition: R@a1, Q@a4 (нет взаимодействия — R 1-я гориз + a-файл;
  // Q a-файл + 4-я гориз + диагонали; a1 на a-файле Q, но между ними a2/a3
  // пусто — Q@a4 атакует a1! Поэтому нужно избежать a-файла).
  // Возьмём R@e1, Q@a4 без пред-взаимодействия: R@e1 атакует e-файл +
  // 1-ю гориз; Q@a4 — a-файл, 4-я гориз, диагонали a4-d1, a4-e8. e1 не
  // на этих линиях (a4-d1: b3,c2,d1; e1 не среди). OK без интеракции.
  // Раунд 1: comp играл R@a1→e1 (детали startPosition выбраны лишь для
  // raw raise reveal). nextTargetPiece = Q@a4. Игрок отвечает Q@a4.
  // После — findUniqueTargetMoves([{e1,R},{a4,Q}], 'a4') даёт кандидаты
  // (например Q→e4: атакует R@e1; novelty OK).
  const startPosition: BlindBoardPiece[] = [
    { square: 'a1' as BlindBoardSquare, type: 'R' },
    { square: 'a4' as BlindBoardSquare, type: 'Q' },
  ];
  const currentPosition: BlindBoardPiece[] = [
    { square: 'e1' as BlindBoardSquare, type: 'R' },
    { square: 'a4' as BlindBoardSquare, type: 'Q' },
  ];
  const nextTargetPiece: BlindBoardPiece = {
    square: 'a4' as BlindBoardSquare,
    type: 'Q',
  };
  const currentCompMove = { from: 'a1', to: 'e1' };

  function activeRow(): any {
    return {
      id: 's1',
      userId: 'u1',
      startPosition,
      currentPosition,
      nextTargetPiece,
      currentCompMove,
      streak: 0,
      bestStreak: 0,
      status: 'active',
      finishReason: null,
      startedAt: new Date('2026-05-30T00:00:00Z'),
      finishedAt: null,
    };
  }

  it('правильный ответ → продолжает сессию, streak++ и пишет следующий attempt', async () => {
    const prisma = makePrisma();
    prisma.blindBoardSession.findUnique.mockResolvedValue(activeRow());
    prisma.blindBoardAttempt.findMany.mockResolvedValue([{ round: 1 }]);
    prisma.blindBoardSession.update.mockImplementation(({ data }: any) => ({
      ...activeRow(),
      ...data,
    }));

    const svc = new BlindBoardService(prisma);
    svc.setRandom(seqRandom([0]));

    const res = await svc.submitAnswer('u1', 's1', {
      square: 'a4' as BlindBoardSquare,
      pieceType: 'Q',
    });

    expect(res.correct).toBe(true);
    expect(res.session.status).toBe('active');
    expect(res.session.streak).toBe(1);
    expect(res.session.bestStreak).toBe(1);
    expect(res.session.round).toBe(2);
    // Следующий attempt должен быть создан (round=2).
    expect(prisma.blindBoardAttempt.create).toHaveBeenCalled();
    const attemptArgs = prisma.blindBoardAttempt.create.mock.calls.find(
      (c: any) => c[0].data.round === 2,
    );
    expect(attemptArgs).toBeTruthy();
  });

  it('неверный ответ → finish wrong-answer + раскрытие startPosition + апдейт User.bestStreak если нужно', async () => {
    const prisma = makePrisma();
    prisma.blindBoardSession.findUnique.mockResolvedValue({
      ...activeRow(),
      streak: 5,
      bestStreak: 7,
    });
    prisma.blindBoardAttempt.findMany.mockResolvedValue([{ round: 6 }]);
    prisma.blindBoardSession.update.mockResolvedValue({
      ...activeRow(),
      streak: 5,
      bestStreak: 7,
      status: 'finished',
      finishReason: 'wrong-answer',
      finishedAt: new Date('2026-05-30T01:00:00Z'),
      currentCompMove: null,
      nextTargetPiece: null,
    });
    prisma.user.findUnique.mockResolvedValue({ blindBoardBestStreak: 3 });

    const svc = new BlindBoardService(prisma);

    const res = await svc.submitAnswer('u1', 's1', {
      square: 'a2' as BlindBoardSquare,
      pieceType: 'N',
    });

    expect(res.correct).toBe(false);
    expect(res.session.status).toBe('finished');
    expect(res.session.finishReason).toBe('wrong-answer');
    expect(res.session.nextMove).toBeNull();
    expect(res.expectedSquare).toBe('a4');
    expect(res.expectedPieceType).toBe('Q');
    expect(res.revealedPosition).toEqual(startPosition);
    // User.bestStreak обновлён до 7 (было 3, в сессии 7).
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { blindBoardBestStreak: 7 },
    });
  });

  it('KS-3453: target без ходов → fallback на другую фигуру, сессия продолжается', async () => {
    // currentPosition: N@a1 (target — обе клетки прыжков заняты R@b3, R@c2),
    // и Q@d8 (есть ход Q→d4 с novelty: атакует N@a1 диагональю d4-a1).
    // Игрок отвечает N@a1 (правильно) — у N нет ходов, но fallback найдёт
    // ход у одной из других фигур. Сессия НЕ завершается dead-end.
    const prisma = makePrisma();
    prisma.blindBoardSession.findUnique.mockResolvedValue({
      ...activeRow(),
      currentPosition: [
        { square: 'a1' as BlindBoardSquare, type: 'N' },
        { square: 'b3' as BlindBoardSquare, type: 'R' },
        { square: 'c2' as BlindBoardSquare, type: 'R' },
        { square: 'd8' as BlindBoardSquare, type: 'Q' },
      ],
      nextTargetPiece: { square: 'a1' as BlindBoardSquare, type: 'N' },
      currentCompMove: { from: 'X', to: 'a1' },
      streak: 2,
      bestStreak: 2,
    });
    prisma.blindBoardAttempt.findMany.mockResolvedValue([{ round: 3 }]);
    prisma.blindBoardSession.update.mockImplementation(({ data }: any) => ({
      ...activeRow(),
      streak: 3,
      bestStreak: 3,
      ...data,
    }));

    const svc = new BlindBoardService(prisma);

    const res = await svc.submitAnswer('u1', 's1', {
      square: 'a1' as BlindBoardSquare,
      pieceType: 'N',
    });

    expect(res.correct).toBe(true);
    // KS-3453: dead-end упразднён — сессия продолжается.
    expect(res.session.status).toBe('active');
    expect(res.session.finishReason).toBeNull();
    expect(res.session.streak).toBe(3);
    expect(res.session.nextMove).not.toBeNull();
    // Ход компа должен быть от ОДНОЙ из других фигур (не от N@a1):
    // a1 не может быть `from`, т.к. у N нет ходов.
    expect(res.session.nextMove!.from).not.toBe('a1');
    // Был записан новый attempt (round=4).
    const round4Create = prisma.blindBoardAttempt.create.mock.calls.find(
      (c: any) => c[0].data.round === 4,
    );
    expect(round4Create).toBeTruthy();
  });

  it('чужая сессия → Forbidden', async () => {
    const prisma = makePrisma();
    prisma.blindBoardSession.findUnique.mockResolvedValue({
      ...activeRow(),
      userId: 'OTHER',
    });
    const svc = new BlindBoardService(prisma);
    await expect(
      svc.submitAnswer('u1', 's1', {
        square: 'h1' as BlindBoardSquare,
        pieceType: 'Q',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('неизвестная сессия → NotFound', async () => {
    const prisma = makePrisma();
    prisma.blindBoardSession.findUnique.mockResolvedValue(null);
    const svc = new BlindBoardService(prisma);
    await expect(
      svc.submitAnswer('u1', 'missing', {
        square: 'h1' as BlindBoardSquare,
        pieceType: 'Q',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('finished сессия → BadRequest', async () => {
    const prisma = makePrisma();
    prisma.blindBoardSession.findUnique.mockResolvedValue({
      ...activeRow(),
      status: 'finished',
    });
    const svc = new BlindBoardService(prisma);
    await expect(
      svc.submitAnswer('u1', 's1', {
        square: 'h1' as BlindBoardSquare,
        pieceType: 'Q',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('BlindBoardService.leaderboard', () => {
  it('возвращает топ по blindBoardBestStreak', async () => {
    const prisma = makePrisma();
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', username: 'alice', blindBoardBestStreak: 12 },
      { id: 'u2', username: 'bob', blindBoardBestStreak: 7 },
    ]);
    prisma.blindBoardSession.findFirst.mockResolvedValue({
      finishedAt: new Date('2026-05-29T12:00:00Z'),
    });
    const svc = new BlindBoardService(prisma);
    const res = await svc.leaderboard(10);
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]).toMatchObject({
      userId: 'u1',
      username: 'alice',
      bestStreak: 12,
    });
    expect(res.entries[0].achievedAt).toMatch(/^2026-/);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { blindBoardBestStreak: 'desc' },
        take: 10,
      }),
    );
  });

  it('пустой топ → пустой массив без падений', async () => {
    const prisma = makePrisma();
    const svc = new BlindBoardService(prisma);
    const res = await svc.leaderboard();
    expect(res.entries).toEqual([]);
  });
});

describe('BlindBoardService.generateValidStart', () => {
  it('всегда находит валидный старт (Math.random)', () => {
    const svc = new BlindBoardService(makePrisma());
    // Прогон множества попыток для статистики (не часть acceptance, но
    // даёт гарантию что MAX_START_ATTEMPTS=20 хватает «почти всегда»).
    let successes = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      if (svc.generateValidStart()) successes++;
    }
    // На случайных позициях из 5 фигур всегда есть хотя бы один ход с
    // |involved|=1 (ферзь имеет 27 ходов в центре доски). Допускаем
    // 99% success rate.
    expect(successes).toBeGreaterThan(N * 0.99);
  });

  it('KS-3449: слоны всегда разнопольные (100 позиций)', () => {
    const svc = new BlindBoardService(makePrisma());
    for (let i = 0; i < 100; i++) {
      const position = svc.randomStartPosition();
      const bishops = position.filter((p) => p.type === 'B');
      expect(bishops).toHaveLength(2);
      expect(isLightSquare(bishops[0].square)).not.toBe(
        isLightSquare(bishops[1].square),
      );
    }
  });

  it('KS-3449: разнопольность сохраняется и в generateValidStart (50 позиций)', () => {
    const svc = new BlindBoardService(makePrisma());
    for (let i = 0; i < 50; i++) {
      const start = svc.generateValidStart();
      expect(start).not.toBeNull();
      const bishops = start!.position.filter((p) => p.type === 'B');
      expect(bishops).toHaveLength(2);
      expect(isLightSquare(bishops[0].square)).not.toBe(
        isLightSquare(bishops[1].square),
      );
    }
  });
});

describe('isLightSquare', () => {
  // a1 dark, h1 light, a8 light, h8 dark (диагональ a1-h8 = dark, h1-a8 = light).
  it('a1 — тёмное', () => expect(isLightSquare('a1')).toBe(false));
  it('h1 — светлое', () => expect(isLightSquare('h1')).toBe(true));
  it('a8 — светлое', () => expect(isLightSquare('a8')).toBe(true));
  it('h8 — тёмное', () => expect(isLightSquare('h8')).toBe(false));
});
