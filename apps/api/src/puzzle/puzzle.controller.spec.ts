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
 *  - KS-3666: count(*) ВЫЗЫВАЕТСЯ всегда (total под фильтры).
 */
import { PuzzleController } from './puzzle.controller';
import {
  decodePuzzleCursor,
  encodePuzzleCursor,
} from './puzzle-cursor-codec';
import type { PuzzleService } from './puzzle.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

/**
 * KS-3666: browse теперь делает ДВА $queryRawUnsafe — count и data.
 * Mock различает их по SQL-сигнатуре `COUNT(*)`. `total` по умолчанию
 * равен `rows.length`; передать явное значение можно через второй
 * аргумент (для тестов где данные на странице != общему количеству).
 */
function makePrisma(rows: unknown[] = [], total?: number) {
  const queryFn = jest
    .fn<Promise<unknown>, [string, ...unknown[]]>()
    .mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*)')) {
        return Promise.resolve([{ total: total ?? rows.length }]);
      }
      return Promise.resolve(rows);
    });
  return {
    $queryRawUnsafe: queryFn,
  } as unknown as PrismaService & { $queryRawUnsafe: jest.Mock };
}

/**
 * KS-3666: помощник для тестов KS-3656/KS-3670 — найти именно
 * data-вызов (SELECT p.id ...), потому что в mock.calls теперь два
 * вызова (count + data), порядок которых зависит от Promise.all
 * resolve order.
 */
function getDataCall(prisma: PrismaService & { $queryRawUnsafe: jest.Mock }): [
  string,
  ...unknown[],
] {
  const calls = prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>;
  const dataCall = calls.find((c) => c[0].includes('SELECT p.id'));
  if (!dataCall) {
    throw new Error(
      'data-вызов $queryRawUnsafe не найден (есть только COUNT)',
    );
  }
  return dataCall;
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

/**
 * KS-3891. Заглушка RedisService для `PuzzleController`. По умолчанию
 * cache промахивается (get→null), а set — no-op. Тесты, которым нужно
 * проверить чтение из кеша, перепоставят моки на эту инстанцию.
 */
function makeFakeRedis(): {
  get: jest.Mock;
  set: jest.Mock;
} {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };
}
const fakeRedis = (): unknown => makeFakeRedis();

/**
 * KS-3893. `browse` теперь запускает COUNT в фоне через
 * `void this.spawnBackgroundBrowseTotal(...)`. Тесту нужно дождаться
 * пока цепочка микротасок добежит до `prisma.$queryRawUnsafe` и
 * `redis.set`. Достаточно пары итераций event-loop'а.
 */
async function flushBackgroundCount(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

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
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

    const res = await controller.browse(anonReq, 20);

    expect(res.data).toHaveLength(3);
    expect(res.nextCursor).toBeNull();
    // KS-3666: теперь два вызова — count (для total) + data.
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('nextCursor выставляется когда rows.length === limit+1', async () => {
    // limit=2 → запрос с LIMIT 3; вернулось 3 строки → есть следующая.
    const prisma = makePrisma([makeRow(1), makeRow(2), makeRow(3)]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

    await controller.browse(anonReq, 20, cursor);

    const [sql, ...params] = getDataCall(prisma);
    expect(sql).toContain('p.created_at < $');
    expect(sql).toContain('p.id < $');
    expect(params).toContain('2026-05-07T10:00:00.000Z');
    expect(params).toContain('pz-prev');
  });

  it('themes ANY-of: OR-цепочка LIKE', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

    await controller.browse(
      anonReq,
      20,
      undefined,
      undefined,
      'fork,pin,mate',
    );

    const [sql, ...params] = getDataCall(prisma);
    // OR-выражение: (p.themes LIKE $X OR p.themes LIKE $Y OR p.themes LIKE $Z).
    expect(sql).toMatch(/p\.themes LIKE \$\d+ OR p\.themes LIKE \$\d+ OR p\.themes LIKE \$\d+/);
    expect(params).toContain('%fork%');
    expect(params).toContain('%pin%');
    expect(params).toContain('%mate%');
  });

  it('ratingMin/ratingMax → BETWEEN-условия', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

    await controller.browse(
      anonReq,
      20,
      undefined,
      undefined,
      undefined,
      '1500',
      '1800',
    );

    const [sql, ...params] = getDataCall(prisma);
    expect(sql).toContain('p.rating >= $');
    expect(sql).toContain('p.rating <= $');
    expect(params).toContain(1500);
    expect(params).toContain(1800);
  });

  it('source whitelist: lichess', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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

    const [sql, ...params] = getDataCall(prisma);
    expect(sql).toContain('p.source = $');
    expect(params).toContain('lichess');
  });

  it('source whitelist: garbage → игнорируется', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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

    const [sql, ...params] = getDataCall(prisma);
    expect(sql).not.toContain('p.source =');
    expect(params.some((p: unknown) => typeof p === 'string' && p.includes('DROP'))).toBe(false);
  });

  it('anon: visibility = is_public=true', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

    await controller.browse(anonReq, 20);

    const [sql] = getDataCall(prisma);
    expect(sql).toContain('p.is_public = true');
    // Visibility: created_by фильтра нет (есть только в select-list).
    expect(sql).not.toMatch(/p\.created_by = \$/);
  });

  it('login без mine: visibility = (created_by=me OR is_public=true)', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

    await controller.browse(loginReq('user-1'), 20);

    const [sql, ...params] = getDataCall(prisma);
    expect(sql).toContain('OR p.is_public = true');
    expect(params).toContain('user-1');
  });

  it('login + mine=true: только свои', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

    await controller.browse(loginReq('user-1'), 20, undefined, 'true');

    const [sql] = getDataCall(prisma);
    expect(sql).toMatch(/p\.created_by = \$\d+::uuid/);
    expect(sql).not.toContain('OR p.is_public');
  });

  // KS-3353 / ADR-079 §3.1: scope=server в Precision требует «только
  // не мои публичные». excludeMine=true — NULL-aware фильтр.
  it('KS-3353: excludeMine=true → is_public=true AND (created_by IS NULL OR != me)', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );

    // browse(req, limit, cursor?, mine?, themes?, ratingMin?, ratingMax?,
    //        hideSolved?, source?, visibility?, blunderMin?, blunderMax?,
    //        excludeMine?)
    await controller.browse(
      loginReq('user-1'),
      20,
      undefined, // cursor
      undefined, // mine
      undefined, // themes
      undefined, // ratingMin
      undefined, // ratingMax
      undefined, // hideSolved
      undefined, // source
      undefined, // visibility
      undefined, // blundererEloMin
      undefined, // blundererEloMax
      'true', // excludeMine
    );

    const [sql, ...params] = (prisma.$queryRawUnsafe as jest.Mock).mock
      .calls[0];
    // Должен быть is_public=true И NULL-aware «не мои».
    expect(sql).toContain('p.is_public = true');
    expect(sql).toMatch(
      /\(p\.created_by IS NULL OR p\.created_by != \$\d+::uuid\)/,
    );
    expect(params).toContain('user-1');
    // НЕ должен возвращать legacy fallback (OR is_public=true с created_by=me).
    expect(sql).not.toContain('OR p.is_public = true');
  });

  it('KS-3353: excludeMine=true без user (anon) → fallback на public-only', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
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
      undefined,
      undefined,
      undefined,
      'true',
    );
    const [sql] = getDataCall(prisma);
    // Anon → просто is_public=true, без NULL-фильтра по created_by.
    expect(sql).toContain('p.is_public = true');
    expect(sql).not.toContain('created_by IS NULL');
  });

  it('hideSolved login: NOT EXISTS на puzzle_attempts', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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

    const [sql] = getDataCall(prisma);
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('puzzle_attempts');
  });

  it('shape ответа: data[].createdAt — ISO-строка, source проброшен', async () => {
    const prisma = makePrisma([
      makeRow(1, { source: 'lichess', is_public: true }),
    ]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

    const res = await controller.browse(anonReq, 20);
    expect(res.data[0]).toMatchObject({
      id: 'pz-1',
      source: 'lichess',
      isPublic: true,
    });
    expect(typeof res.data[0].createdAt).toBe('string');
    expect(res.data[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ── KS-3663 / ADR-106 §2.5. Maia-поля в DTO browse ─────────────────
  // Регрессия: до KS-3663 SQL `$queryRawUnsafe` не выбирал
  // p.maia_weak_choice_prob / p.maia_metric_version / p.maia_top1_elo,
  // и фронт индикатора сложности (KS-3660/KS-3662) получал undefined
  // на всех пазлах в боевой среде.
  it('KS-3663: SELECT включает maia_weak_choice_prob/metric_version/top1_elo', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    await controller.browse(anonReq, 20);
    const [sql] = getDataCall(prisma);
    expect(sql).toContain('p.maia_weak_choice_prob');
    expect(sql).toContain('p.maia_metric_version');
    expect(sql).toContain('p.maia_top1_elo');
  });

  it('KS-3663: размеченный пазл → maia-поля в response (snake → camel)', async () => {
    const prisma = makePrisma([
      makeRow(1, {
        maia_weak_choice_prob: 0.42,
        maia_metric_version: 1,
        maia_top1_elo: 1500,
      }),
    ]);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    const res = await controller.browse(anonReq, 20);
    expect(res.data[0]).toMatchObject({
      maiaWeakChoiceProb: 0.42,
      maiaMetricVersion: 1,
      maiaTop1Elo: 1500,
    });
  });

  it('KS-3663: неразмеченный пазл (отсутствующие поля) → null в response', async () => {
    const prisma = makePrisma([makeRow(1)]);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    const res = await controller.browse(anonReq, 20);
    expect(res.data[0]).toMatchObject({
      maiaWeakChoiceProb: null,
      maiaMetricVersion: null,
      maiaTop1Elo: null,
    });
  });
});

/**
 * KS-3656 / ADR-106 §2.6. Серверный фильтр precision-каталога по
 * `minMaiaWeakChoiceProb`. Должен:
 *  - null/undefined → без WHERE-фильтра по maia_weak_choice_prob;
 *  - 0 → без WHERE-фильтра (0 ≡ null, см. описание задачи);
 *  - 0 < v ≤ 1 → добавить
 *      `p.maia_weak_choice_prob >= $threshold
 *       AND p.maia_metric_version = 1`;
 *  - v вне [0, 1] → BadRequestException.
 */
describe('PuzzleController.browse — KS-3656 minMaiaWeakChoiceProb', () => {
  // browse(req, limit, cursor?, mine?, themes?, ratingMin?, ratingMax?,
  //        hideSolved?, source?, visibility?, blunderMin?, blunderMax?,
  //        excludeMine?, themesAnd?, themesOr?, minMaiaWeakChoiceProb?)
  const callBrowseWithThreshold = async (threshold: string | undefined) => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    await controller.browse(
      anonReq,
      20,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined,
      threshold,
    );
    return getDataCall(prisma) as [
      string,
      ...unknown[],
    ];
  };

  it('null/undefined → нет WHERE по maia_weak_choice_prob', async () => {
    // KS-3663: maia_weak_choice_prob / maia_metric_version присутствуют
    // в SELECT (нужны фронту для индикатора сложности), поэтому
    // проверяем отсутствие именно WHERE-условия, а не подстроки.
    const [sql, ...params] = await callBrowseWithThreshold(undefined);
    expect(sql).not.toMatch(/p\.maia_weak_choice_prob >=/);
    expect(sql).not.toContain('p.maia_metric_version = 1');
    expect(params).not.toContain(0);
  });

  it('threshold = 0 → без фильтра (трактуется как null)', async () => {
    const [sql, ...params] = await callBrowseWithThreshold('0');
    expect(sql).not.toMatch(/p\.maia_weak_choice_prob >=/);
    expect(sql).not.toContain('p.maia_metric_version = 1');
    expect(params).not.toContain(0);
  });

  it('threshold = 0.5 → WHERE >= 0.5 AND metric_version = 1', async () => {
    const [sql, ...params] = await callBrowseWithThreshold('0.5');
    expect(sql).toMatch(/p\.maia_weak_choice_prob >= \$\d+/);
    expect(sql).toContain('p.maia_metric_version = 1');
    expect(params).toContain(0.5);
  });

  it('threshold = 1 → WHERE >= 1 (пройдут только prob = 1)', async () => {
    const [sql, ...params] = await callBrowseWithThreshold('1');
    expect(sql).toMatch(/p\.maia_weak_choice_prob >= \$\d+/);
    expect(sql).toContain('p.maia_metric_version = 1');
    expect(params).toContain(1);
  });

  it('threshold вне [0, 1] (отрицательный) → 400', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    await expect(
      controller.browse(
        anonReq,
        20,
        undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined,
        '-0.1',
      ),
    ).rejects.toThrow(/minMaiaWeakChoiceProb must be a number in \[0, 1\]/);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('threshold вне [0, 1] (>1) → 400', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    await expect(
      controller.browse(
        anonReq,
        20,
        undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined,
        '1.5',
      ),
    ).rejects.toThrow(/minMaiaWeakChoiceProb must be a number in \[0, 1\]/);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('threshold не число → 400', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    await expect(
      controller.browse(
        anonReq,
        20,
        undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined,
        'abc',
      ),
    ).rejects.toThrow(/minMaiaWeakChoiceProb must be a number in \[0, 1\]/);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

/**
 * KS-3670 / ADR-106 §2.6. Парный maxMaiaWeakChoiceProb (верхняя
 * граница диапазона) — под двусторонний ползунок сложности KS-3665.
 * Семантика 1:1 с minMaiaWeakChoiceProb (KS-3656):
 *  - undefined / >= 1 → без WHERE по верхней границе;
 *  - 0 ≤ v < 1 → WHERE p.maia_weak_choice_prob <= v
 *                  AND p.maia_metric_version = 1;
 *  - min и max заданы оба → BETWEEN $min AND $max (две условия + один
 *                            common `metric_version = 1`).
 */
describe('PuzzleController.browse — KS-3670 maxMaiaWeakChoiceProb', () => {
  const callBrowseWithRange = async (
    min: string | undefined,
    max: string | undefined,
  ) => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    await controller.browse(
      anonReq,
      20,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined,
      min,
      max,
    );
    return getDataCall(prisma) as [
      string,
      ...unknown[],
    ];
  };

  it('max=undefined → нет WHERE по верхней границе', async () => {
    const [sql] = await callBrowseWithRange(undefined, undefined);
    expect(sql).not.toMatch(/p\.maia_weak_choice_prob <=/);
  });

  it('max=1 → без WHERE по верхней границе (трактуется как полный диапазон)', async () => {
    const [sql, ...params] = await callBrowseWithRange(undefined, '1');
    expect(sql).not.toMatch(/p\.maia_weak_choice_prob <=/);
    expect(sql).not.toContain('p.maia_metric_version = 1');
    expect(params).not.toContain(1);
  });

  it('max=0.7 → WHERE <= 0.7 AND metric_version = 1', async () => {
    const [sql, ...params] = await callBrowseWithRange(undefined, '0.7');
    expect(sql).toMatch(/p\.maia_weak_choice_prob <= \$\d+/);
    expect(sql).toContain('p.maia_metric_version = 1');
    expect(params).toContain(0.7);
  });

  it('max=0 → WHERE <= 0 (граничный, отсекает почти всё)', async () => {
    const [sql, ...params] = await callBrowseWithRange(undefined, '0');
    expect(sql).toMatch(/p\.maia_weak_choice_prob <= \$\d+/);
    expect(sql).toContain('p.maia_metric_version = 1');
    expect(params).toContain(0);
  });

  it('min=0.4 + max=0.7 → BETWEEN + metric_version = 1 один раз', async () => {
    const [sql, ...params] = await callBrowseWithRange('0.4', '0.7');
    expect(sql).toMatch(/p\.maia_weak_choice_prob >= \$\d+/);
    expect(sql).toMatch(/p\.maia_weak_choice_prob <= \$\d+/);
    // metric_version = 1 должен появиться РОВНО один раз даже при
    // двух активных границах.
    const metricMatches = sql.match(/p\.maia_metric_version = 1/g) ?? [];
    expect(metricMatches).toHaveLength(1);
    expect(params).toContain(0.4);
    expect(params).toContain(0.7);
  });

  it('min=0 + max=1 → без WHERE по maia (полный диапазон)', async () => {
    const [sql, ...params] = await callBrowseWithRange('0', '1');
    expect(sql).not.toMatch(/p\.maia_weak_choice_prob >=/);
    expect(sql).not.toMatch(/p\.maia_weak_choice_prob <=/);
    expect(sql).not.toContain('p.maia_metric_version = 1');
    expect(params).not.toContain(0);
    expect(params).not.toContain(1);
  });

  it('max вне [0, 1] (отрицательный) → 400', async () => {
    await expect(callBrowseWithRange(undefined, '-0.1')).rejects.toThrow(
      /maxMaiaWeakChoiceProb must be a number in \[0, 1\]/,
    );
  });

  it('max вне [0, 1] (>1) → 400', async () => {
    await expect(callBrowseWithRange(undefined, '1.5')).rejects.toThrow(
      /maxMaiaWeakChoiceProb must be a number in \[0, 1\]/,
    );
  });

  it('max не число → 400', async () => {
    await expect(callBrowseWithRange(undefined, 'abc')).rejects.toThrow(
      /maxMaiaWeakChoiceProb must be a number in \[0, 1\]/,
    );
  });

  it('min > max → 400 (диапазон бессмыслен)', async () => {
    await expect(callBrowseWithRange('0.8', '0.3')).rejects.toThrow(
      /minMaiaWeakChoiceProb \(0\.8\) must be <= maxMaiaWeakChoiceProb \(0\.3\)/,
    );
  });
});


/**
 * KS-3666: точный счётчик `total` под текущие фильтры в ответе
 * /puzzles/browse. Заменяет UI-заглушку «N+» из KS-3654 на «Найдено: N».
 *
 * Контракт:
 *  - всегда выполняется ВТОРОЙ $queryRawUnsafe — COUNT(*) с теми же
 *    WHERE-условиями, что и dataQuery, но БЕЗ keyset cursor (total
 *    стабилен между страницами);
 *  - возвращается в ответе как `total: number`;
 *  - source whitelist / theme-фильтры / rating-range / mine /
 *    visibility / minMaiaWeakChoiceProb / maxMaiaWeakChoiceProb —
 *    все участвуют в count;
 *  - cursor — НЕ участвует в count.
 */
describe('PuzzleController.browse — KS-3893 total с фоновым COUNT', () => {
  it('cache hit → total: number, COUNT в БД не идёт', async () => {
    const prisma = makePrisma([makeRow(1)], 999);
    const redis = makeFakeRedis();
    redis.get.mockResolvedValueOnce('42'); // cache hit
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      redis as unknown as never,
    );
    const res = await controller.browse(anonReq, 20);
    expect(res.total).toBe(42);
    const calls = prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>;
    expect(calls.find((c) => c[0].includes('COUNT(*)'))).toBeUndefined();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('cache miss → total: null СРАЗУ, COUNT уходит в фон и пишет в Redis', async () => {
    const prisma = makePrisma([makeRow(1), makeRow(2)], 777);
    const redis = makeFakeRedis(); // get → null
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      redis as unknown as never,
    );
    const res = await controller.browse(anonReq, 20);

    // KS-3893: на cache miss total приходит как null, не блокируем ответ.
    expect(res.total).toBeNull();
    expect(res.data).toHaveLength(2);

    // Фон должен достать COUNT и положить в Redis.
    await flushBackgroundCount();
    const calls = prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>;
    expect(calls.find((c) => c[0].includes('COUNT(*)'))).toBeDefined();
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, value, mode, ttl] = redis.set.mock.calls[0];
    expect(String(key)).toContain('puzzles:browse:count:v1:');
    expect(value).toBe('777');
    expect(mode).toBe('EX');
    expect(ttl).toBe(300);
  });

  it('cache miss + ошибка Redis на get → total: null без фонового COUNT (нет места куда писать)', async () => {
    const prisma = makePrisma([makeRow(1)], 5);
    const redis = makeFakeRedis();
    redis.get.mockRejectedValueOnce(new Error('redis down'));
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      redis as unknown as never,
    );
    const res = await controller.browse(anonReq, 20);
    expect(res.total).toBeNull();

    // Если Redis недоступен — фоновый COUNT не нужен, результат
    // некуда сохранить. Должен быть ТОЛЬКО dataQuery.
    await flushBackgroundCount();
    const calls = prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>;
    expect(calls.find((c) => c[0].includes('COUNT(*)'))).toBeUndefined();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('KS-3891: count НЕ запускается при наличии cursor (total=null на последующих страницах)', async () => {
    const prisma = makePrisma([makeRow(1)], 100);
    const redis = makeFakeRedis();
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      redis as unknown as never,
    );
    const cursor = encodePuzzleCursor({
      c: '2026-05-07T10:00:00.000Z',
      i: 'pz-5',
    });
    const res = await controller.browse(anonReq, 20, cursor);
    await flushBackgroundCount();
    const calls = prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>;
    expect(calls.find((c) => c[0].includes('COUNT(*)'))).toBeUndefined();
    expect(redis.get).not.toHaveBeenCalled();
    // dataQuery всё ещё содержит cursor-условие.
    const dataCall = calls.find((c) => c[0].includes('SELECT p.id'))!;
    expect(dataCall[0]).toContain('p.created_at <');
    expect(res.total).toBeNull();
  });

  it('фоновый count использует те же фильтры что dataQuery (source + rating)', async () => {
    const prisma = makePrisma([], 7);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    await controller.browse(
      anonReq,
      20,
      undefined, // cursor
      undefined, // mine
      undefined, // themes
      '1200',    // ratingMin
      '1600',    // ratingMax
      undefined, // hideSolved
      'lichess', // source
    );
    await flushBackgroundCount();
    const calls = prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>;
    const countCall = calls.find((c) => c[0].includes('COUNT(*)'))!;
    expect(countCall).toBeDefined();
    expect(countCall[0]).toContain('p.source = $');
    expect(countCall[0]).toContain('p.rating >= $');
    expect(countCall[0]).toContain('p.rating <= $');
    expect(countCall.slice(1)).toContain('lichess');
    expect(countCall.slice(1)).toContain(1200);
    expect(countCall.slice(1)).toContain(1600);
  });

  it('фоновый count НЕ содержит ORDER BY / LIMIT', async () => {
    const prisma = makePrisma([makeRow(1)], 100);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    await controller.browse(anonReq, 20);
    await flushBackgroundCount();
    const calls = prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>;
    const countCall = calls.find((c) => c[0].includes('COUNT(*)'))!;
    expect(countCall).toBeDefined();
    expect(countCall[0]).not.toContain('ORDER BY');
    expect(countCall[0]).not.toContain('LIMIT');
  });

  it('фоновый count учитывает minMaiaWeakChoiceProb', async () => {
    const prisma = makePrisma([], 3);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    await controller.browse(
      anonReq,
      20,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined,
      '0.5', // minMaiaWeakChoiceProb
    );
    await flushBackgroundCount();
    const calls = prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>;
    const countCall = calls.find((c) => c[0].includes('COUNT(*)'))!;
    expect(countCall).toBeDefined();
    expect(countCall[0]).toMatch(/p\.maia_weak_choice_prob >= \$\d+/);
    expect(countCall[0]).toContain('p.maia_metric_version = 1');
    expect(countCall.slice(1)).toContain(0.5);
  });

  it('фоновый count учитывает maxMaiaWeakChoiceProb (диапазон [0.4, 0.7])', async () => {
    const prisma = makePrisma([], 5);
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    await controller.browse(
      anonReq,
      20,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined,
      '0.4',
      '0.7',
    );
    await flushBackgroundCount();
    const calls = prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>;
    const countCall = calls.find((c) => c[0].includes('COUNT(*)'))!;
    expect(countCall).toBeDefined();
    expect(countCall[0]).toMatch(/p\.maia_weak_choice_prob >= \$\d+/);
    expect(countCall[0]).toMatch(/p\.maia_weak_choice_prob <= \$\d+/);
    expect(countCall.slice(1)).toContain(0.4);
    expect(countCall.slice(1)).toContain(0.7);
  });

  it('ошибка фонового COUNT не валит ответ (data уже отправлены)', async () => {
    const prisma = {
      $queryRawUnsafe: jest
        .fn<Promise<unknown>, [string, ...unknown[]]>()
        .mockImplementation((sql: string) => {
          if (sql.includes('COUNT(*)')) {
            return Promise.reject(new Error('db down'));
          }
          return Promise.resolve([makeRow(1)]);
        }),
    } as unknown as PrismaService & { $queryRawUnsafe: jest.Mock };
    const redis = makeFakeRedis();
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      redis as unknown as never,
    );
    const res = await controller.browse(anonReq, 20);
    expect(res.total).toBeNull();
    expect(res.data).toHaveLength(1);
    // Фоновый COUNT упал — Redis НЕ должен получить запись.
    await flushBackgroundCount();
    expect(redis.set).not.toHaveBeenCalled();
  });
});

/**
 * KS-3893. `/puzzles/browse/count` — выделенный обработчик счётчика.
 *   - `approx=true` → planner-estimate через EXPLAIN FORMAT JSON.
 *   - default       → точный путь через Redis + COUNT (как в KS-3891).
 */
describe('PuzzleController.browseCount — KS-3893', () => {
  /**
   * Prisma-mock с поддержкой EXPLAIN FORMAT JSON: возвращает
   * структуру `[{ "QUERY PLAN": [{ Plan: { "Plan Rows": N } }] }]`.
   */
  function makePrismaWithExplain(opts: {
    explainRows?: number | null;
    countTotal?: number;
    explainShouldThrow?: boolean;
  }) {
    const { explainRows = null, countTotal = 0, explainShouldThrow = false } = opts;
    const queryFn = jest
      .fn<Promise<unknown>, [string, ...unknown[]]>()
      .mockImplementation((sql: string) => {
        if (sql.startsWith('EXPLAIN')) {
          if (explainShouldThrow) {
            return Promise.reject(new Error('EXPLAIN failed'));
          }
          if (explainRows === null) {
            return Promise.resolve([]);
          }
          return Promise.resolve([
            { 'QUERY PLAN': [{ Plan: { 'Plan Rows': explainRows } }] },
          ]);
        }
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve([{ total: countTotal }]);
        }
        return Promise.resolve([]);
      });
    return {
      $queryRawUnsafe: queryFn,
    } as unknown as PrismaService & { $queryRawUnsafe: jest.Mock };
  }

  it('approx=true → EXPLAIN FORMAT JSON, округление до сотен', async () => {
    const prisma = makePrismaWithExplain({ explainRows: 12347 });
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    const res = await controller.browseCount(anonReq, 'true');
    expect(res).toEqual({ total: 12300, approximate: true });
    const calls = prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>;
    expect(calls[0][0]).toMatch(/^EXPLAIN \(FORMAT JSON\) SELECT COUNT\(\*\)/);
    // На approx-пути COUNT НЕ выполняется.
    expect(calls.find((c) => c[0].startsWith('SELECT COUNT'))).toBeUndefined();
  });

  it('approx=true: planRows < 100 → возвращаем точное значение (без округления)', async () => {
    const prisma = makePrismaWithExplain({ explainRows: 47 });
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    const res = await controller.browseCount(anonReq, 'true');
    expect(res).toEqual({ total: 47, approximate: true });
  });

  it('approx=true: EXPLAIN падает → fallback на точный COUNT', async () => {
    const prisma = makePrismaWithExplain({
      explainShouldThrow: true,
      countTotal: 123,
    });
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    const res = await controller.browseCount(anonReq, 'true');
    expect(res).toEqual({ total: 123, approximate: false });
  });

  it('без approx → точный путь, Redis cache hit', async () => {
    const prisma = makePrismaWithExplain({ countTotal: 999 });
    const redis = makeFakeRedis();
    redis.get.mockResolvedValueOnce('555');
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      redis as unknown as never,
    );
    const res = await controller.browseCount(anonReq);
    expect(res).toEqual({ total: 555, approximate: false });
    const calls = prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>;
    expect(calls.find((c) => c[0].includes('COUNT(*)'))).toBeUndefined();
  });

  it('без approx → cache miss → COUNT + запись в Redis', async () => {
    const prisma = makePrismaWithExplain({ countTotal: 321 });
    const redis = makeFakeRedis();
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      redis as unknown as never,
    );
    const res = await controller.browseCount(anonReq);
    expect(res).toEqual({ total: 321, approximate: false });
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [, value, , ttl] = redis.set.mock.calls[0];
    expect(value).toBe('321');
    expect(ttl).toBe(300);
  });

  it('browseCount уважает source-фильтр', async () => {
    const prisma = makePrismaWithExplain({ countTotal: 0 });
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    await controller.browseCount(
      anonReq,
      undefined, // approx
      undefined, // mine
      undefined, // themes
      undefined, // ratingMin
      undefined, // ratingMax
      undefined, // hideSolved
      'lichess', // source
    );
    const calls = prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>;
    const countCall = calls.find((c) => c[0].includes('COUNT(*)'))!;
    expect(countCall[0]).toContain('p.source = $');
    expect(countCall.slice(1)).toContain('lichess');
  });

  it('approx-EXPLAIN использует тот же WHERE что точный COUNT', async () => {
    const prisma = makePrismaWithExplain({ explainRows: 500 });
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    await controller.browseCount(
      loginReq('user-1'),
      'true',     // approx
      undefined,
      undefined,
      undefined,
      undefined,
      'true',     // hideSolved
      'lichess',
    );
    const calls = prisma.$queryRawUnsafe.mock.calls as Array<[string, ...unknown[]]>;
    const explainCall = calls.find((c) => c[0].startsWith('EXPLAIN'))!;
    expect(explainCall[0]).toContain('p.source = $');
    expect(explainCall[0]).toContain('NOT EXISTS');
    expect(explainCall.slice(1)).toContain('lichess');
    expect(explainCall.slice(1)).toContain('user-1');
  });

  it('approx=true: пустой EXPLAIN-результат → fallback на точный', async () => {
    const prisma = makePrismaWithExplain({ explainRows: null, countTotal: 99 });
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );
    const res = await controller.browseCount(anonReq, 'true');
    expect(res).toEqual({ total: 99, approximate: false });
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
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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

    const [sql] = getDataCall(prisma);
    expect(sql).toMatch(/p\.created_by = \$\d+::uuid/);
    expect(sql).toContain('p.is_public = false');
    expect(sql).not.toContain('p.is_public = true');
  });

  it('mine=true + visibility=public → AND p.is_public = true', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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

    const [sql] = getDataCall(prisma);
    expect(sql).toMatch(/p\.created_by = \$\d+::uuid/);
    expect(sql).toContain('p.is_public = true');
    expect(sql).not.toContain('p.is_public = false');
  });

  it('mine=true + visibility=all (default) → только created_by, без is_public-фильтра', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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

    const [sql] = getDataCall(prisma);
    expect(sql).toMatch(/p\.created_by = \$\d+::uuid/);
    // Нет ни одного is_public-условия в WHERE (поле в SELECT-list — ок).
    expect(sql).not.toContain('p.is_public = true');
    expect(sql).not.toContain('p.is_public = false');
  });

  it('mine=true без visibility → default all (поведение KS-2560 не сломано)', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

    await controller.browse(loginReq('user-1'), 20, undefined, 'true');

    const [sql] = getDataCall(prisma);
    expect(sql).toMatch(/p\.created_by = \$\d+::uuid/);
    expect(sql).not.toContain('p.is_public = true');
    expect(sql).not.toContain('p.is_public = false');
  });

  it('visibility=draft без mine=true → 400', async () => {
    const prisma = makePrisma([]);
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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

    const [sql] = getDataCall(prisma);
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
  /**
   * KS-2959. После переезда на `findMany` для получения id вставленных
   * пазлов мок должен отдавать те же id, что прилетели в `createMany`
   * (мы заранее генерируем UUID локально). По умолчанию возвращаем
   * полный набор — это эмулирует «дубликатов не было».
   */
  function makeBatchPrisma() {
    const createMany = jest
      .fn<Promise<{ count: number }>, [{ data: Array<{ id: string }> }]>()
      .mockImplementation(async ({ data }) => ({ count: data.length }));
    const findMany = jest
      .fn<Promise<Array<{ id: string }>>, [{ where: { id: { in: string[] } } }]>()
      .mockImplementation(async ({ where }) => where.id.in.map((id) => ({ id })));
    return {
      puzzle: {
        createMany,
        findMany,
      },
    } as unknown as PrismaService & {
      puzzle: { createMany: jest.Mock; findMany: jest.Mock };
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
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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

  it('пустой puzzles[] → count=0, created=[], createMany не вызывается', async () => {
    const prisma = makeBatchPrisma();
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

    const res = await controller.batch(
      { puzzles: [] } as any,
      loginReq('user-1'),
    );
    expect(res.count).toBe(0);
    expect(res.created).toEqual([]);
    expect(prisma.puzzle.createMany).not.toHaveBeenCalled();
  });
});

/**
 * KS-2959. `POST /puzzles/batch` обязан вернуть id'ы созданных
 * пазлов: фронт после генерации перенаправляет на
 * `/puzzle/<id>?source=precision&visibility=draft` без follow-up
 * `GET /puzzles/browse`.
 *
 * Проверяем:
 *  1. `created.length === count` и каждый элемент — `{id: uuid, fen: string}`.
 *  2. `id` валидный v4 UUID.
 *  3. `fen` соответствует i-той позиции входного массива (позиционный порядок).
 *  4. Дубликаты, отсеянные `skipDuplicates`, в `created` не попадают.
 */
describe('PuzzleController.batch — KS-2959 response.created', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function makeBatchPrismaCustom(opts: {
    insertedFilter?: (ids: string[]) => string[];
    insertedCount?: (n: number) => number;
  } = {}) {
    const createMany = jest
      .fn<Promise<{ count: number }>, [{ data: Array<{ id: string }> }]>()
      .mockImplementation(async ({ data }) => {
        const filtered = opts.insertedFilter
          ? opts.insertedFilter(data.map((d) => d.id))
          : data.map((d) => d.id);
        return { count: opts.insertedCount ? opts.insertedCount(filtered.length) : filtered.length };
      });
    const findMany = jest
      .fn<Promise<Array<{ id: string }>>, [{ where: { id: { in: string[] } } }]>()
      .mockImplementation(async ({ where }) => {
        const all = where.id.in;
        const kept = opts.insertedFilter ? opts.insertedFilter(all) : all;
        return kept.map((id) => ({ id }));
      });
    return {
      puzzle: { createMany, findMany },
    } as unknown as PrismaService & {
      puzzle: { createMany: jest.Mock; findMany: jest.Mock };
    };
  }

  const fen = (i: number) => `position-${i}-fen w - - 0 1`;
  const mkPuzzle = (i: number) => ({
    fen: fen(i),
    moves: 'e2e4',
    rating: 1500,
    gap: 100,
    themes: 'fork',
    sourceType: 'pgn_import',
  });

  it('N пазлов вставлены → created.length === N, id — UUID v4', async () => {
    const prisma = makeBatchPrismaCustom();
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );

    const N = 3;
    const res = await controller.batch(
      { puzzles: [mkPuzzle(0), mkPuzzle(1), mkPuzzle(2)] } as any,
      loginReq('user-1'),
    );

    expect(res.count).toBe(N);
    expect(res.created).toHaveLength(N);
    for (const c of res.created) {
      expect(c.id).toMatch(UUID_RE);
      expect(typeof c.fen).toBe('string');
    }
  });

  it('created сохраняет позиционный порядок входного puzzles[] (created[i].fen === puzzles[i].fen)', async () => {
    const prisma = makeBatchPrismaCustom();
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );

    const input = [mkPuzzle(10), mkPuzzle(20), mkPuzzle(30)];
    const res = await controller.batch({ puzzles: input } as any, loginReq('user-1'));

    expect(res.created.map((c) => c.fen)).toEqual([fen(10), fen(20), fen(30)]);
  });

  it('skipDuplicates: один пазл отсеян → count=N-1, created без него', async () => {
    // Эмулируем: первый и третий вставились, второй — дубликат.
    const prisma = makeBatchPrismaCustom({
      insertedFilter: (ids) => [ids[0], ids[2]],
    });
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );

    const input = [mkPuzzle(1), mkPuzzle(2), mkPuzzle(3)];
    const res = await controller.batch({ puzzles: input } as any, loginReq('user-1'));

    expect(res.count).toBe(2);
    expect(res.created).toHaveLength(2);
    // Порядок сохранён: позиции 0 и 2 из входа.
    expect(res.created[0].fen).toBe(fen(1));
    expect(res.created[1].fen).toBe(fen(3));
  });

  it('id из created совпадает с id, переданным в createMany', async () => {
    const prisma = makeBatchPrismaCustom();
    const controller = new PuzzleController(
      { buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService,
      prisma,
      fakeRedis() as any,
    );

    const res = await controller.batch(
      { puzzles: [mkPuzzle(0), mkPuzzle(1)] } as any,
      loginReq('user-1'),
    );

    const createManyArgs = (prisma.puzzle.createMany as jest.Mock).mock.calls[0][0];
    const idsPassedToDb: string[] = createManyArgs.data.map((d: { id: string }) => d.id);
    const idsInResponse = res.created.map((c) => c.id);
    expect(idsInResponse).toEqual(idsPassedToDb);
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
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

    const res = await controller.deleteOne('P1', loginReq('user-1'));

    expect(res).toEqual({ deleted: 0 });
    expect(prisma.puzzle.delete).not.toHaveBeenCalled();
  });

  it('DELETE /all — owner: вызывает только puzzle.deleteMany (cascade на FK)', async () => {
    const prisma = makeDeletePrisma();
    (prisma.puzzle.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 3 });
    const controller = new PuzzleController({ buildBrowseEnrichments: () => ({}) } as unknown as PuzzleService, prisma, fakeRedis() as any);

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
