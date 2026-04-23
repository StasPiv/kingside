import {
  parseArgs,
  runBackfillTwic,
  lockKeyFor,
  type BackfillTwicDeps,
} from './backfill-twic';
import type { ImportResult } from '../archive-import/sources/twic.importer';

describe('backfill-twic: parseArgs', () => {
  const emptyEnv: NodeJS.ProcessEnv = {};

  it('флаг --issue <N>', () => {
    expect(parseArgs(['--issue', '1638'], emptyEnv)).toEqual({
      issue: 1638,
      force: false,
    });
  });

  it('флаг --issue=<N>', () => {
    expect(parseArgs(['--issue=1638'], emptyEnv)).toEqual({
      issue: 1638,
      force: false,
    });
  });

  it('env TWIC_ISSUE без флага', () => {
    expect(parseArgs([], { TWIC_ISSUE: '1638' })).toEqual({
      issue: 1638,
      force: false,
    });
  });

  it('флаг приоритетнее env', () => {
    expect(
      parseArgs(['--issue', '1638'], { TWIC_ISSUE: '1639' }),
    ).toEqual({ issue: 1638, force: false });
  });

  it('--force включает force=true', () => {
    expect(parseArgs(['--issue', '1638', '--force'], emptyEnv)).toEqual({
      issue: 1638,
      force: true,
    });
  });

  it('env TWIC_BACKFILL_FORCE=1 включает force=true', () => {
    expect(
      parseArgs([], { TWIC_ISSUE: '1638', TWIC_BACKFILL_FORCE: '1' }),
    ).toEqual({ issue: 1638, force: true });
  });

  it.each(['true', 'yes', 'TRUE', 'Yes'])(
    'env TWIC_BACKFILL_FORCE=%s → force=true',
    (val) => {
      expect(
        parseArgs([], { TWIC_ISSUE: '1638', TWIC_BACKFILL_FORCE: val }),
      ).toEqual({ issue: 1638, force: true });
    },
  );

  it('без --issue и без env → throw с usage', () => {
    expect(() => parseArgs([], emptyEnv)).toThrow(
      /Usage: backfill-twic --issue/,
    );
  });

  it('нечисловой --issue → throw', () => {
    expect(() => parseArgs(['--issue', 'abc'], emptyEnv)).toThrow(
      /Invalid issue number/,
    );
  });

  it('нулевой или отрицательный --issue → throw', () => {
    expect(() => parseArgs(['--issue', '0'], emptyEnv)).toThrow(
      /Invalid issue number/,
    );
    expect(() => parseArgs(['--issue', '-5'], emptyEnv)).toThrow(
      /Invalid issue number/,
    );
  });

  it('дробный --issue → throw', () => {
    expect(() => parseArgs(['--issue', '1638.5'], emptyEnv)).toThrow(
      /Invalid issue number/,
    );
  });
});

describe('backfill-twic: lockKeyFor', () => {
  it('per-issue ключ, отличный от scheduler-lock', () => {
    expect(lockKeyFor(1638)).toBe('archive:import:lock:twic:backfill:1638');
    expect(lockKeyFor(1638)).not.toBe('archive:import:lock:twic');
    expect(lockKeyFor(1638)).not.toBe(lockKeyFor(1639));
  });
});

/**
 * Строит stub-деп для runBackfillTwic. По умолчанию:
 *   - `archive_sources.findFirst` возвращает row с cursor=1641;
 *   - `archive_imports.findFirst` — null (не импортировали);
 *   - `redis.set` возвращает 'OK' (lock взят);
 *   - `runAdHoc` возвращает success-result с gamesAdded=42.
 */
function makeDeps(
  overrides: {
    sourceRow?: { id: string; code: string; cursor: string | null } | null;
    existingImport?: {
      id: string;
      fileName: string;
      gamesAdded: number;
      startedAt: Date | null;
    } | null;
    importResult?: ImportResult;
    lockAcquired?: boolean;
  } = {},
): {
  deps: BackfillTwicDeps;
  spies: {
    runAdHoc: jest.Mock;
    publish: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    sourceFindFirst: jest.Mock;
    importFindFirst: jest.Mock;
  };
} {
  const source =
    overrides.sourceRow === undefined
      ? { id: 'source-uuid', code: 'twic', cursor: '1641' }
      : overrides.sourceRow;
  const existingImport =
    overrides.existingImport === undefined ? null : overrides.existingImport;
  const defaultResult: ImportResult = overrides.importResult ?? {
    status: 'ok',
    cursorBefore: source?.cursor ?? null,
    cursorAfter: source?.cursor ?? null,
    fileName: 'twic1638.pgn',
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
  const sourceFindFirst = jest.fn().mockResolvedValue(source);
  const importFindFirst = jest.fn().mockResolvedValue(existingImport);

  const deps: BackfillTwicDeps = {
    prisma: {
      archiveSource: { findFirst: sourceFindFirst },
      archiveImport: { findFirst: importFindFirst },
    } as never,
    redis: { set, del, publish } as never,
    makeImporter: () => ({ runAdHoc }) as never,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
  return {
    deps,
    spies: { runAdHoc, publish, set, del, sourceFindFirst, importFindFirst },
  };
}

describe('runBackfillTwic — happy path', () => {
  it('берёт per-issue lock, вызывает runAdHoc(issue), публикует событие, отпускает lock', async () => {
    const { deps, spies } = makeDeps();

    const outcome = await runBackfillTwic(deps, {
      issue: 1638,
      force: false,
    });

    expect(outcome.result?.status).toBe('ok');
    expect(outcome.result?.gamesAdded).toBe(42);
    expect(outcome.skippedAlreadyImported).toBe(false);
    expect(outcome.lockHeld).toBe(false);

    // Per-issue lock, не scheduler-lock.
    expect(spies.set).toHaveBeenCalledWith(
      'archive:import:lock:twic:backfill:1638',
      expect.stringMatching(/^\d+:\d+:backfill$/),
      'EX',
      30 * 60,
      'NX',
    );
    expect(spies.runAdHoc).toHaveBeenCalledWith(1638);
    expect(spies.publish).toHaveBeenCalledWith('archive:imported', 'twic:1638');
    expect(spies.del).toHaveBeenCalledWith(
      'archive:import:lock:twic:backfill:1638',
    );
  });

  it('gamesAdded=0 → PUBLISH НЕ вызывается, lock всё равно отпущен', async () => {
    const { deps, spies } = makeDeps({
      importResult: {
        status: 'ok',
        cursorBefore: '1641',
        cursorAfter: '1641',
        fileName: 'twic1638.pgn',
        gamesParsed: 3000,
        gamesAdded: 0,
        gamesSkipped: 3000,
      },
    });

    const outcome = await runBackfillTwic(deps, {
      issue: 1638,
      force: false,
    });

    expect(outcome.result?.gamesAdded).toBe(0);
    expect(spies.publish).not.toHaveBeenCalled();
    expect(spies.del).toHaveBeenCalledWith(
      'archive:import:lock:twic:backfill:1638',
    );
  });
});

describe('runBackfillTwic — idempotency (already imported)', () => {
  it('force=false + найден успешный импорт → skip без runAdHoc', async () => {
    const { deps, spies } = makeDeps({
      existingImport: {
        id: 'imp-existing',
        fileName: 'twic1638.pgn',
        gamesAdded: 2500,
        startedAt: new Date('2026-04-01T12:00:00Z'),
      },
    });

    const outcome = await runBackfillTwic(deps, {
      issue: 1638,
      force: false,
    });

    expect(outcome.skippedAlreadyImported).toBe(true);
    expect(outcome.result).toBeNull();
    expect(outcome.lockHeld).toBe(false);
    // Lock НЕ брался — skip произошёл раньше.
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.runAdHoc).not.toHaveBeenCalled();
    expect(spies.publish).not.toHaveBeenCalled();
    // del не вызван — мы лок не брали.
    expect(spies.del).not.toHaveBeenCalled();
  });

  it('force=true + найден успешный импорт → runAdHoc всё равно вызывается', async () => {
    const { deps, spies } = makeDeps({
      existingImport: {
        id: 'imp-existing',
        fileName: 'twic1638.pgn',
        gamesAdded: 2500,
        startedAt: new Date('2026-04-01T12:00:00Z'),
      },
    });

    const outcome = await runBackfillTwic(deps, {
      issue: 1638,
      force: true,
    });

    expect(outcome.skippedAlreadyImported).toBe(false);
    // findFirst по archive_imports даже не должен был вызваться при force=true
    // (мы пропускаем idempotent-check).
    expect(spies.importFindFirst).not.toHaveBeenCalled();
    expect(spies.runAdHoc).toHaveBeenCalledWith(1638);
  });

  it('findFirst по archive_imports фильтрует по source_id + file_name prefix + status=ok', async () => {
    const { deps, spies } = makeDeps();

    await runBackfillTwic(deps, { issue: 1638, force: false });

    expect(spies.importFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceId: 'source-uuid',
          status: 'ok',
          fileName: { startsWith: 'twic1638' },
        }),
      }),
    );
  });
});

describe('runBackfillTwic — Redis-lock', () => {
  it('lock занят → lockHeld=true, runAdHoc НЕ вызывается', async () => {
    const { deps, spies } = makeDeps({ lockAcquired: false });

    const outcome = await runBackfillTwic(deps, {
      issue: 1638,
      force: false,
    });

    expect(outcome.lockHeld).toBe(true);
    expect(outcome.result).toBeNull();
    expect(spies.runAdHoc).not.toHaveBeenCalled();
    expect(spies.publish).not.toHaveBeenCalled();
    // del не вызываем — лок держит другой процесс.
    expect(spies.del).not.toHaveBeenCalled();
  });

  it('runAdHoc throw → lock отпускается, ошибка пробрасывается', async () => {
    const { deps, spies } = makeDeps();
    (spies.runAdHoc as jest.Mock).mockRejectedValueOnce(new Error('boom'));

    await expect(
      runBackfillTwic(deps, { issue: 1638, force: false }),
    ).rejects.toThrow(/boom/);

    expect(spies.del).toHaveBeenCalledWith(
      'archive:import:lock:twic:backfill:1638',
    );
  });

  it('lock-key per-issue: для 1638 и 1639 разные ключи (параллельный backfill разных выпусков не мешает)', async () => {
    const a = makeDeps();
    const b = makeDeps();

    await runBackfillTwic(a.deps, { issue: 1638, force: false });
    await runBackfillTwic(b.deps, { issue: 1639, force: false });

    expect(a.spies.set).toHaveBeenCalledWith(
      'archive:import:lock:twic:backfill:1638',
      expect.anything(),
      'EX',
      30 * 60,
      'NX',
    );
    expect(b.spies.set).toHaveBeenCalledWith(
      'archive:import:lock:twic:backfill:1639',
      expect.anything(),
      'EX',
      30 * 60,
      'NX',
    );
  });
});

describe('runBackfillTwic — bootstrap errors', () => {
  it('archive_sources.code="twic" не найден → понятная ошибка, без lock/runAdHoc', async () => {
    const { deps, spies } = makeDeps({ sourceRow: null });

    await expect(
      runBackfillTwic(deps, { issue: 1638, force: false }),
    ).rejects.toThrow(/archive_sources row with code="twic" not found/);

    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.runAdHoc).not.toHaveBeenCalled();
  });
});
