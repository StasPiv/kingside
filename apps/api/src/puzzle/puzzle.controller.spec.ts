/**
 * Тесты `PuzzleController.browse` (KS-2556).
 *
 * Минимальные unit-тесты на формирование WHERE-условий: hard-coded
 * `source='generated'` убран, `?source=` whitelist'ится.
 *
 * Полный e2e через сеть — отдельная тема; здесь проверяем только что
 * controller передаёт корректный SQL и params в `$queryRawUnsafe`.
 */
import { PuzzleController } from './puzzle.controller';
import type { PuzzleService } from './puzzle.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

function build() {
  const prisma = {
    $queryRawUnsafe: jest
      .fn<Promise<unknown>, [string, ...unknown[]]>()
      // первый вызов — dataQuery, возвращает строки; второй — countQuery.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }]),
  } as unknown as PrismaService;
  const service = {} as unknown as PuzzleService;
  const controller = new PuzzleController(service, prisma);
  return { controller, prisma };
}

const anonReq = {
  user: undefined,
} as unknown as AuthenticatedRequest;

describe('PuzzleController.browse — KS-2556', () => {
  it('без ?source=: hard-coded source filter отсутствует', async () => {
    const { controller, prisma } = build();
    await controller.browse(anonReq, 20, 0);

    const queryRaw = prisma.$queryRawUnsafe as jest.Mock;
    expect(queryRaw).toHaveBeenCalled();
    const [dataSql, ...dataParams] = queryRaw.mock.calls[0];
    expect(dataSql).not.toContain("p.source = 'generated'");
    expect(dataSql).not.toContain('p.source = $');
    // visibility — anon, должен быть `p.is_public = true`.
    expect(dataSql).toContain('p.is_public = true');
    // params должны содержать только LIMIT/OFFSET (нет source-параметра).
    expect(dataParams).toEqual([20, 0]);
  });

  it('?source=lichess → фильтр p.source = $1, param "lichess"', async () => {
    const { controller, prisma } = build();
    await controller.browse(
      anonReq,
      20,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'lichess',
    );

    const queryRaw = prisma.$queryRawUnsafe as jest.Mock;
    const [dataSql, ...dataParams] = queryRaw.mock.calls[0];
    expect(dataSql).toContain('p.source = $1');
    expect(dataParams[0]).toBe('lichess');
  });

  it('?source=generated → фильтр p.source = $1, param "generated"', async () => {
    const { controller, prisma } = build();
    await controller.browse(
      anonReq,
      20,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'generated',
    );

    const queryRaw = prisma.$queryRawUnsafe as jest.Mock;
    const [dataSql, ...dataParams] = queryRaw.mock.calls[0];
    expect(dataSql).toContain('p.source = $1');
    expect(dataParams[0]).toBe('generated');
  });

  it('?source=garbage → значение игнорируется (без source-фильтра)', async () => {
    const { controller, prisma } = build();
    await controller.browse(
      anonReq,
      20,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'evil; DROP TABLE puzzles --',
    );

    const queryRaw = prisma.$queryRawUnsafe as jest.Mock;
    const [dataSql, ...dataParams] = queryRaw.mock.calls[0];
    expect(dataSql).not.toContain('p.source =');
    // В params не должно быть мусорной строки.
    expect(dataParams.some((p: unknown) => typeof p === 'string' && p.includes('DROP'))).toBe(
      false,
    );
  });
});
