import {
  parseArgs,
  runImportTwicIssue,
  type ImportTwicIssueDeps,
} from './import-twic-issue';
import type { ImportResult } from '../archive-import/sources/twic.importer';

describe('import-twic-issue parseArgs', () => {
  it('парсит позиционный номер выпуска: ["1639"] → { issue: 1639 }', () => {
    expect(parseArgs(['1639'])).toEqual({ issue: 1639 });
  });

  it('без аргументов → бросает с usage-текстом', () => {
    expect(() => parseArgs([])).toThrow(/Usage: import-twic-issue <issue>/);
  });

  it('нечисловой аргумент → ошибка', () => {
    expect(() => parseArgs(['abc'])).toThrow(/Invalid issue number/);
  });

  it('0 → ошибка (позитивное целое)', () => {
    expect(() => parseArgs(['0'])).toThrow(/Invalid issue number/);
  });

  it('отрицательное → ошибка', () => {
    expect(() => parseArgs(['-5'])).toThrow(/Invalid issue number/);
  });

  it('плавающее → ошибка (ожидается целое)', () => {
    expect(() => parseArgs(['1639.5'])).toThrow(/Invalid issue number/);
  });

  it('несколько позиционных → ошибка', () => {
    expect(() => parseArgs(['1639', '1638'])).toThrow(
      /Expected exactly one positional argument/,
    );
  });

  it('флаги `--foo` игнорируются (не считаются позиционными)', () => {
    expect(parseArgs(['--verbose', '1639'])).toEqual({ issue: 1639 });
  });
});

/**
 * Набор вспомогательных моков. Redis `set` возвращает 'OK' при успешном
 * взятии lock'а, `null` — если lock занят (`SET NX` reject).
 */
function makeDeps(
  overrides: Partial<ImportTwicIssueDeps> & {
    sourceRow?: { id: string; code: string; cursor: string | null } | null;
    importResult?: ImportResult;
    lockAcquired?: boolean;
  } = {},
): {
  deps: ImportTwicIssueDeps;
  spies: {
    runAdHoc: jest.Mock;
    publish: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    findFirst: jest.Mock;
  };
} {
  const source =
    overrides.sourceRow === undefined
      ? { id: 'source-uuid', code: 'twic', cursor: '1641' }
      : overrides.sourceRow;
  const defaultResult: ImportResult = overrides.importResult ?? {
    status: 'ok',
    cursorBefore: source?.cursor ?? null,
    cursorAfter: source?.cursor ?? null,
    fileName: 'twic1639.pgn',
    gamesParsed: 3000,
    gamesAdded: 42,
    gamesSkipped: 2958,
  };
  const runAdHoc = jest.fn().mockResolvedValue(defaultResult);
  const publish = jest.fn().mockResolvedValue(1);
  const set = jest
    .fn()
    .mockResolvedValue(overrides.lockAcquired === false ? null : 'OK');
  const del = jest.fn().mockResolvedValue(1);
  const findFirst = jest.fn().mockResolvedValue(source);

  const deps: ImportTwicIssueDeps = {
    prisma: {
      archiveSource: { findFirst },
    } as never,
    redis: { set, del, publish } as never,
    makeImporter: () => ({ runAdHoc }) as never,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
  return { deps, spies: { runAdHoc, publish, set, del, findFirst } };
}

describe('runImportTwicIssue — happy path', () => {
  it('берёт lock, вызывает runAdHoc с issue, публикует событие, отпускает lock', async () => {
    const { deps, spies } = makeDeps();

    const res = await runImportTwicIssue(deps, { issue: 1639 });

    expect(res.status).toBe('ok');
    expect(res.gamesAdded).toBe(42);

    // Redis-lock: SET archive:import:lock:twic <...> EX 1800 NX
    expect(spies.set).toHaveBeenCalledWith(
      'archive:import:lock:twic',
      expect.stringMatching(/^\d+:\d+:adhoc$/),
      'EX',
      30 * 60,
      'NX',
    );
    expect(spies.runAdHoc).toHaveBeenCalledWith(1639);
    expect(spies.publish).toHaveBeenCalledWith('archive:imported', 'twic:1639');
    expect(spies.del).toHaveBeenCalledWith('archive:import:lock:twic');
  });

  it('если games_added=0 (дубликат), PUBLISH НЕ вызывается', async () => {
    const { deps, spies } = makeDeps({
      importResult: {
        status: 'ok',
        cursorBefore: '1641',
        cursorAfter: '1641',
        fileName: 'twic1639.pgn',
        gamesParsed: 3000,
        gamesAdded: 0,
        gamesSkipped: 3000,
      },
    });

    const res = await runImportTwicIssue(deps, { issue: 1639 });

    expect(res.gamesAdded).toBe(0);
    expect(spies.publish).not.toHaveBeenCalled();
    // Lock всё равно отпущен (важно для следующего ad-hoc запуска).
    expect(spies.del).toHaveBeenCalledWith('archive:import:lock:twic');
  });

  it('если Redis-lock занят → бросает ошибку и НЕ вызывает runAdHoc', async () => {
    const { deps, spies } = makeDeps({ lockAcquired: false });

    await expect(runImportTwicIssue(deps, { issue: 1639 })).rejects.toThrow(
      /lock "archive:import:lock:twic" is held/,
    );
    expect(spies.runAdHoc).not.toHaveBeenCalled();
    expect(spies.publish).not.toHaveBeenCalled();
    // del не вызван — локом владеет другой процесс, мы его не трогаем.
    expect(spies.del).not.toHaveBeenCalled();
  });

  it('если archive_sources.code="twic" не найден → бросает понятную ошибку', async () => {
    const { deps, spies } = makeDeps({ sourceRow: null });

    await expect(runImportTwicIssue(deps, { issue: 1639 })).rejects.toThrow(
      /archive_sources row with code="twic" not found/,
    );
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.runAdHoc).not.toHaveBeenCalled();
  });

  it('runAdHoc throw → lock отпускается (финально), ошибка пробрасывается', async () => {
    const { deps, spies } = makeDeps();
    (spies.runAdHoc as jest.Mock).mockRejectedValueOnce(new Error('boom'));

    await expect(runImportTwicIssue(deps, { issue: 1639 })).rejects.toThrow(
      /boom/,
    );
    expect(spies.del).toHaveBeenCalledWith('archive:import:lock:twic');
  });
});
