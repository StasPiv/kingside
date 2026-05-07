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
