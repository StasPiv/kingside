/**
 * Тесты `PuzzleController.browse` (KS-2560 курсорная пагинация).
 *
 * Покрытие:
 *  - source whitelist (KS-2556).
 *  - keyset cursor encode/decode + WHERE-условие.
 *  - themes ANY-of (OR).
 *  - rating range.
 *  - hideSolved для login.
 *  - nextCursor выставляется когда rows.length > take.
 *  - count(*) НЕ вызывается (только один $queryRawUnsafe per browse).
 */
import { PuzzleController } from './puzzle.controller';
import {
  decodePuzzleCursor,
  encodePuzzleCursor,
} from './puzzle-cursor-codec';
import type { PuzzleService } from './puzzle.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

function makePrisma(rows: unknown[] = []) {
  return {
    $queryRawUnsafe: jest
      .fn<Promise<unknown>, [string, ...unknown[]]>()
      .mockResolvedValueOnce(rows),
  } as unknown as PrismaService & { $queryRawUnsafe: jest.Mock };
}

function makeRow(i: number, override: Partial<Record<string, unknown>> = {}) {
  return {
    id: `pz-${i}`,
    fen: 'fen',
    moves: 'e2e4',
    rating: 1500,
    themes: 'fork',
    source: 'lichess',
    source_type: null,
    is_public: true,
    created_by: null,
    created_at: new Date(`2026-05-07T1${i}:00:00Z`),
    solved_status: null,
    ...override,
  };
}

const anonReq = { user: undefined } as unknown as AuthenticatedRequest;
const loginReq = (id: string) =>
  ({ user: { id } }) as unknown as AuthenticatedRequest;

describe('puzzle-cursor-codec', () => {
  it('encode → decode round-trip', () => {
    const c = { c: '2026-05-07T10:00:00.000Z', i: 'pz-1' };
    const encoded = encodePuzzleCursor(c);
    expect(decodePuzzleCursor(encoded)).toEqual(c);
  });

  it('decode пустой/невалидный → null', () => {
    expect(decodePuzzleCursor(undefined)).toBeNull();
    expect(decodePuzzleCursor('')).toBeNull();
    expect(decodePuzzleCursor('not-base64')).toBeNull();
    expect(decodePuzzleCursor(Buffer.from('{}', 'utf8').toString('base64url'))).toBeNull();
  });

  it('decode невалидный timestamp → null', () => {
    const bad = Buffer.from(
      JSON.stringify({ c: 'not-a-date', i: 'x' }),
      'utf8',
    ).toString('base64url');
    expect(decodePuzzleCursor(bad)).toBeNull();
  });
});

describe('PuzzleController.browse — KS-2560 cursor', () => {
  it('первая страница: data + nextCursor=null когда rows < limit+1', async () => {
    const prisma = makePrisma([makeRow(1), makeRow(2), makeRow(3)]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    const res = await controller.browse(anonReq, 20);

    expect(res.data).toHaveLength(3);
    expect(res.nextCursor).toBeNull();
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1); // нет COUNT
  });

  it('nextCursor выставляется когда rows.length === limit+1', async () => {
    // limit=2 → запрос с LIMIT 3; вернулось 3 строки → есть следующая.
    const prisma = makePrisma([makeRow(1), makeRow(2), makeRow(3)]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    const res = await controller.browse(anonReq, 2);

    expect(res.data).toHaveLength(2); // отдаём только take, не take+1
    expect(res.nextCursor).not.toBeNull();
    const decoded = decodePuzzleCursor(res.nextCursor);
    // Cursor указывает на последнюю строку из data (rows[take-1]).
    expect(decoded?.i).toBe('pz-2');
  });

  it('cursor query → WHERE keyset с (created_at, id)', async () => {
    const cursor = encodePuzzleCursor({
      c: '2026-05-07T10:00:00.000Z',
      i: 'pz-prev',
    });
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(anonReq, 20, cursor);

    const [sql, ...params] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).toContain('p.created_at < $');
    expect(sql).toContain('p.id < $');
    expect(params).toContain('2026-05-07T10:00:00.000Z');
    expect(params).toContain('pz-prev');
  });

  it('themes ANY-of: OR-цепочка LIKE', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(
      anonReq,
      20,
      undefined,
      undefined,
      'fork,pin,mate',
    );

    const [sql, ...params] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    // OR-выражение: (p.themes LIKE $X OR p.themes LIKE $Y OR p.themes LIKE $Z).
    expect(sql).toMatch(/p\.themes LIKE \$\d+ OR p\.themes LIKE \$\d+ OR p\.themes LIKE \$\d+/);
    expect(params).toContain('%fork%');
    expect(params).toContain('%pin%');
    expect(params).toContain('%mate%');
  });

  it('ratingMin/ratingMax → BETWEEN-условия', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(
      anonReq,
      20,
      undefined,
      undefined,
      undefined,
      '1500',
      '1800',
    );

    const [sql, ...params] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).toContain('p.rating >= $');
    expect(sql).toContain('p.rating <= $');
    expect(params).toContain(1500);
    expect(params).toContain(1800);
  });

  it('source whitelist: lichess', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(
      anonReq,
      20,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'lichess',
    );

    const [sql, ...params] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).toContain('p.source = $');
    expect(params).toContain('lichess');
  });

  it('source whitelist: garbage → игнорируется', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(
      anonReq,
      20,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "evil'; DROP TABLE puzzles --",
    );

    const [sql, ...params] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).not.toContain('p.source =');
    expect(params.some((p: unknown) => typeof p === 'string' && p.includes('DROP'))).toBe(false);
  });

  it('anon: visibility = is_public=true', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(anonReq, 20);

    const [sql] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).toContain('p.is_public = true');
    // Visibility: created_by фильтра нет (есть только в select-list).
    expect(sql).not.toMatch(/p\.created_by = \$/);
  });

  it('login без mine: visibility = (created_by=me OR is_public=true)', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(loginReq('user-1'), 20);

    const [sql, ...params] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).toContain('OR p.is_public = true');
    expect(params).toContain('user-1');
  });

  it('login + mine=true: только свои', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(loginReq('user-1'), 20, undefined, 'true');

    const [sql] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/p\.created_by = \$\d+::uuid/);
    expect(sql).not.toContain('OR p.is_public');
  });

  it('hideSolved login: NOT EXISTS на puzzle_attempts', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(
      loginReq('user-1'),
      20,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'true',
    );

    const [sql] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('puzzle_attempts');
  });

  it('shape ответа: data[].createdAt — ISO-строка, source проброшен', async () => {
    const prisma = makePrisma([
      makeRow(1, { source: 'lichess', is_public: true }),
    ]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    const res = await controller.browse(anonReq, 20);
    expect(res.data[0]).toMatchObject({
      id: 'pz-1',
      source: 'lichess',
      isPublic: true,
    });
    expect(typeof res.data[0].createdAt).toBe('string');
    expect(res.data[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

/**
 * KS-2582: visibility=public|draft|all для GET /puzzles/browse.
 *
 * Логика (ADR-050 §3 #3):
 *  - anon/mine=false: ВСЕГДА is_public=true, visibility игнорируется.
 *  - mine=true + visibility=all (default): свои public + свои draft.
 *  - mine=true + visibility=public: только свои is_public=true.
 *  - mine=true + visibility=draft: только свои is_public=false.
 *  - visibility=draft без mine=true → 400.
 *  - visibility вне whitelist → 400.
 */
describe('PuzzleController.browse — KS-2582 visibility', () => {
  it('mine=true + visibility=draft → AND p.is_public = false', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(
      loginReq('user-1'),
      20,
      undefined,
      'true',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'draft',
    );

    const [sql] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/p\.created_by = \$\d+::uuid/);
    expect(sql).toContain('p.is_public = false');
    expect(sql).not.toContain('p.is_public = true');
  });

  it('mine=true + visibility=public → AND p.is_public = true', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(
      loginReq('user-1'),
      20,
      undefined,
      'true',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'public',
    );

    const [sql] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/p\.created_by = \$\d+::uuid/);
    expect(sql).toContain('p.is_public = true');
    expect(sql).not.toContain('p.is_public = false');
  });

  it('mine=true + visibility=all (default) → только created_by, без is_public-фильтра', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(
      loginReq('user-1'),
      20,
      undefined,
      'true',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'all',
    );

    const [sql] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/p\.created_by = \$\d+::uuid/);
    // Нет ни одного is_public-условия в WHERE (поле в SELECT-list — ок).
    expect(sql).not.toContain('p.is_public = true');
    expect(sql).not.toContain('p.is_public = false');
  });

  it('mine=true без visibility → default all (поведение KS-2560 не сломано)', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(loginReq('user-1'), 20, undefined, 'true');

    const [sql] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/p\.created_by = \$\d+::uuid/);
    expect(sql).not.toContain('p.is_public = true');
    expect(sql).not.toContain('p.is_public = false');
  });

  it('visibility=draft без mine=true → 400', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await expect(
      controller.browse(
        loginReq('user-1'),
        20,
        undefined,
        undefined, // mine=undefined
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'draft',
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('mine=true'),
    });
  });

  it('visibility=draft без логина (anon) → 400', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await expect(
      controller.browse(
        anonReq,
        20,
        undefined,
        'true', // mine=true, но userId нет
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'draft',
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('mine=true'),
    });
  });

  it('visibility=garbage → 400 валидация whitelist', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await expect(
      controller.browse(
        loginReq('user-1'),
        20,
        undefined,
        'true',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'garbage',
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('public, draft, all'),
    });
  });

  it('mine=false (anon) + visibility=draft (попытка обхода) → 400', async () => {
    // mine=false НЕ установлен — но visibility='draft' приходит.
    // Без mine=true (для drafts) — отвечаем 400 даже до проверки auth.
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await expect(
      controller.browse(
        anonReq,
        20,
        undefined,
        'false',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'draft',
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('anon + visibility=public → ВСЕГДА is_public=true (visibility игнорируется в anon)', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.browse(
      anonReq,
      20,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'public',
    );

    const [sql] = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0];
    expect(sql).toContain('p.is_public = true');
  });
});

/**
 * KS-2580 / KS-2659: per-puzzle isPublic + server-side инвариант
 * `solutionMode='play-vs-engine'` для batch endpoint'а.
 *
 * История:
 *   * KS-2580: дефолт `solutionMode='forced-line'`, фронт мог
 *     переопределить.
 *   * KS-2659: до фикса фронт не всегда передавал
 *     `'play-vs-engine'` — generated-пазлы попадали в БД с
 *     `'forced-line'`, что ломало `/precision`-runner. После фикса
 *     batch endpoint **жёстко** ставит `'play-vs-engine'` (любое
 *     значение от клиента игнорируется), потому что batch создаёт
 *     только generated-пазлы (`source='generated'`), для которых
 *     ADR-050 §3 #1 требует PVE-runner.
 */
describe('PuzzleController.batch — KS-2580/KS-2659 isPublic + solutionMode', () => {
  function makeBatchPrisma() {
    return {
      puzzle: {
        createMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService & {
      puzzle: { createMany: jest.Mock };
    };
  }

  const minimalPuzzle = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves: 'e2e4',
    rating: 1500,
    gap: 100,
    themes: 'fork',
    sourceType: 'pgn_import',
  };

  it('KS-2659: без явного solutionMode → "play-vs-engine" (server invariant)', async () => {
    const prisma = makeBatchPrisma();
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.batch(
      { puzzles: [minimalPuzzle as any] } as any,
      loginReq('user-1'),
    );

    const args = (prisma.puzzle.createMany as jest.Mock).mock.calls[0][0];
    expect(args.data[0].isPublic).toBe(false);
    // KS-2659: batch endpoint всегда ставит PVE — `source='generated'`.
    expect(args.data[0].solutionMode).toBe('play-vs-engine');
  });

  it('explicit isPublic=true → пишется true', async () => {
    const prisma = makeBatchPrisma();
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.batch(
      {
        puzzles: [{ ...minimalPuzzle, isPublic: true } as any],
      } as any,
      loginReq('user-1'),
    );

    const args = (prisma.puzzle.createMany as jest.Mock).mock.calls[0][0];
    expect(args.data[0].isPublic).toBe(true);
  });

  it('solutionMode="play-vs-engine" с moves="" → принимается, поле сохраняется', async () => {
    const prisma = makeBatchPrisma();
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.batch(
      {
        puzzles: [
          {
            ...minimalPuzzle,
            moves: '',
            solutionMode: 'play-vs-engine',
            acceptedMoves: 'e4d5,d2d4',
          } as any,
        ],
      } as any,
      loginReq('user-1'),
    );

    const args = (prisma.puzzle.createMany as jest.Mock).mock.calls[0][0];
    expect(args.data[0].solutionMode).toBe('play-vs-engine');
    expect(args.data[0].moves).toBe('');
    expect(args.data[0].acceptedMoves).toBe('e4d5,d2d4');
  });

  it('KS-2659: solutionMode="forced-line" от клиента игнорируется → принудительно "play-vs-engine"', async () => {
    // Регрессионный кейс: до KS-2659 batch уважал клиентское значение,
    // и недописанный фронт сохранял generated-пазлы как `forced-line`.
    // Теперь сервер форсирует PVE независимо от тела запроса.
    const prisma = makeBatchPrisma();
    (prisma.puzzle.createMany as jest.Mock).mockResolvedValueOnce({ count: 2 });
    const controller = new PuzzleController({} as PuzzleService, prisma);

    await controller.batch(
      {
        puzzles: [
          { ...minimalPuzzle, isPublic: true, solutionMode: 'forced-line' } as any,
          { ...minimalPuzzle, isPublic: false, solutionMode: 'play-vs-engine' } as any,
        ],
      } as any,
      loginReq('user-1'),
    );

    const args = (prisma.puzzle.createMany as jest.Mock).mock.calls[0][0];
    // isPublic — per-puzzle, его уважаем.
    expect(args.data[0].isPublic).toBe(true);
    expect(args.data[1].isPublic).toBe(false);
    // solutionMode — server invariant: оба = 'play-vs-engine'.
    expect(args.data[0].solutionMode).toBe('play-vs-engine');
    expect(args.data[1].solutionMode).toBe('play-vs-engine');
    // source тоже фиксированный — все generated.
    expect(args.data[0].source).toBe('generated');
    expect(args.data[1].source).toBe('generated');
  });

  it('пустой puzzles[] → count=0, createMany не вызывается', async () => {
    const prisma = makeBatchPrisma();
    const controller = new PuzzleController({} as PuzzleService, prisma);

    const res = await controller.batch(
      { puzzles: [] } as any,
      loginReq('user-1'),
    );
    expect(res.count).toBe(0);
    expect(prisma.puzzle.createMany).not.toHaveBeenCalled();
  });
});

/**
 * KS-2580: валидация невалидного solutionMode на уровне DTO
 * (class-validator). Проверяем что class-transformer + validate
 * ловит мусор до контроллера.
 */
describe('BatchPuzzlesDto — class-validator (KS-2580)', () => {
  it('невалидный solutionMode → ошибка валидации', async () => {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');
    const { BatchPuzzlesDto } = await import('./dto/batch-puzzle.dto');

    const dto = plainToInstance(BatchPuzzlesDto, {
      puzzles: [
        {
          fen: 'fen',
          moves: 'e2e4',
          rating: 1500,
          gap: 100,
          themes: 'fork',
          sourceType: 'pgn_import',
          solutionMode: 'invalid-mode',
        },
      ],
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: false,
    });
    // Ошибка должна прилететь на nested property `puzzles[0].solutionMode`.
    const flat = JSON.stringify(errors);
    expect(flat).toContain('solutionMode');
  });

  it('валидный solutionMode="play-vs-engine" + isPublic=false → без ошибок', async () => {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');
    const { BatchPuzzlesDto } = await import('./dto/batch-puzzle.dto');

    const dto = plainToInstance(BatchPuzzlesDto, {
      puzzles: [
        {
          fen: 'fen',
          moves: '',
          rating: 1500,
          gap: 100,
          themes: 'fork',
          sourceType: 'wdl-generated',
          solutionMode: 'play-vs-engine',
          isPublic: false,
        },
      ],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});

/**
 * KS-2675: DELETE /puzzles/:id и /puzzles/all больше не падают на
 * FK `puzzle_attempts_puzzle_id_fkey`. Cascade теперь на уровне БД
 * (миграция `20260509190000_ks2675_puzzle_cascade`); код контроллера
 * полагается на каскад и явно `puzzleAttempt.deleteMany` больше не
 * вызывает.
 */
describe('PuzzleController.delete — KS-2675 (cascade)', () => {
  function makeDeletePrisma() {
    return {
      puzzle: {
        findUnique: jest.fn<Promise<{ id: string; createdBy: string } | null>, [unknown]>(),
        delete: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
        deleteMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 0 }),
        findMany: jest
          .fn<Promise<unknown[]>, [unknown]>()
          .mockResolvedValue([]),
      },
      puzzleAttempt: {
        deleteMany: jest.fn<Promise<{ count: number }>, [unknown]>(),
      },
    } as unknown as PrismaService & {
      puzzle: {
        findUnique: jest.Mock;
        delete: jest.Mock;
        deleteMany: jest.Mock;
        findMany: jest.Mock;
      };
      puzzleAttempt: { deleteMany: jest.Mock };
    };
  }

  it('DELETE /:id — owner: вызывает только puzzle.delete (cascade на FK)', async () => {
    const prisma = makeDeletePrisma();
    (prisma.puzzle.findUnique as jest.Mock).mockResolvedValue({
      id: 'P1',
      createdBy: 'user-1',
    });
    const controller = new PuzzleController({} as PuzzleService, prisma);

    const res = await controller.deleteOne('P1', loginReq('user-1'));

    expect(res).toEqual({ deleted: 1 });
    expect(prisma.puzzle.delete).toHaveBeenCalledWith({ where: { id: 'P1' } });
    // KS-2675: ручной cleanup attempts больше не делается.
    expect(prisma.puzzleAttempt.deleteMany).not.toHaveBeenCalled();
  });

  it('DELETE /:id — не owner: deleted=0, puzzle.delete не вызывается', async () => {
    const prisma = makeDeletePrisma();
    (prisma.puzzle.findUnique as jest.Mock).mockResolvedValue({
      id: 'P1',
      createdBy: 'other-user',
    });
    const controller = new PuzzleController({} as PuzzleService, prisma);

    const res = await controller.deleteOne('P1', loginReq('user-1'));

    expect(res).toEqual({ deleted: 0 });
    expect(prisma.puzzle.delete).not.toHaveBeenCalled();
  });

  it('DELETE /all — owner: вызывает только puzzle.deleteMany (cascade на FK)', async () => {
    const prisma = makeDeletePrisma();
    (prisma.puzzle.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 3 });
    const controller = new PuzzleController({} as PuzzleService, prisma);

    const res = await controller.deleteAll(loginReq('user-1'));

    expect(res).toEqual({ deleted: 3 });
    expect(prisma.puzzle.deleteMany).toHaveBeenCalledWith({
      where: { createdBy: 'user-1', source: 'generated' },
    });
    // KS-2675: предварительная выборка id и `puzzleAttempt.deleteMany`
    // больше не нужна — FK CASCADE делает это в БД.
    expect(prisma.puzzleAttempt.deleteMany).not.toHaveBeenCalled();
    expect(prisma.puzzle.findMany).not.toHaveBeenCalled();
  });
});
