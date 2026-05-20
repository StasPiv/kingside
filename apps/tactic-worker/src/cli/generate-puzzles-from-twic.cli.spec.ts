/**
 * KS-3150 unit-тесты `generate-puzzles-from-twic`. Высокоуровневый
 * `runGeneratePuzzlesFromTwic` использует Stockfish + Prisma + Pg —
 * его интеграционный smoke прогоняется отдельно на staging.
 * Здесь покрываем чистые функции: parseArgs и resolveTwicImportId.
 */
import {
  parseArgs,
  resolveTwicImportId,
} from './generate-puzzles-from-twic.cli';

describe('parseArgs (KS-3150)', () => {
  it('default: только save, без issue, без dry-run', () => {
    const r = parseArgs([]);
    expect(r.twicIssue).toBeNull();
    expect(r.onlySave).toBe(true);
    expect(r.dryRun).toBe(false);
    expect(r.limit).toBeNull();
    // Дефолтный engineLimit идёт из defaultGeneratorOptions().
    expect(typeof r.options.engineLimit.timeMs).toBe('number');
  });

  it('--twic-issue=1660 → twicIssue=1660', () => {
    const r = parseArgs(['--twic-issue=1660']);
    expect(r.twicIssue).toBe(1660);
  });

  it('--all отключает onlySave', () => {
    const r = parseArgs(['--all']);
    expect(r.onlySave).toBe(false);
  });

  it('--only-save=false тоже отключает', () => {
    const r = parseArgs(['--only-save=false']);
    expect(r.onlySave).toBe(false);
  });

  it('--dry-run (без значения) → true', () => {
    const r = parseArgs(['--dry-run']);
    expect(r.dryRun).toBe(true);
  });

  it('--limit=5 → maxGames=5', () => {
    const r = parseArgs(['--limit=5']);
    expect(r.limit).toBe(5);
    expect(r.options.maxGames).toBe(5);
  });

  it('--time-ms=2000 и --depth=20 пробрасываются в engineLimit', () => {
    const r = parseArgs(['--time-ms=2000', '--depth=20']);
    expect(r.options.engineLimit.timeMs).toBe(2000);
    expect(r.options.engineLimit.depth).toBe(20);
  });

  it('бросает на --twic-issue<=0', () => {
    expect(() => parseArgs(['--twic-issue=0'])).toThrow(/bad --twic-issue/);
    expect(() => parseArgs(['--twic-issue=-1'])).toThrow(/bad --twic-issue/);
  });

  it('неизвестный флаг → throw', () => {
    expect(() => parseArgs(['--no-such-flag'])).toThrow(/unknown CLI option/);
  });
});

describe('resolveTwicImportId (KS-3150)', () => {
  function makePg(responses: Array<{ rows: unknown[] }>) {
    let i = 0;
    return {
      query: jest.fn(async () => {
        const r = responses[i] ?? { rows: [] };
        i++;
        return r;
      }),
    };
  }

  it('null если archive_sources пустой', async () => {
    const pg = makePg([{ rows: [] }]);
    const r = await resolveTwicImportId(pg as never, null);
    expect(r).toBeNull();
  });

  it('issue не задан → берёт последний успешный по started_at DESC', async () => {
    const pg = makePg([
      { rows: [{ id: 'src-uuid' }] },
      {
        rows: [
          {
            id: 'import-latest',
            cursor_after: '1660',
            file_name: 'twic1660g.zip',
          },
        ],
      },
    ]);
    const r = await resolveTwicImportId(pg as never, null);
    expect(r).toEqual({
      importId: 'import-latest',
      issue: 1660,
      fileName: 'twic1660g.zip',
    });
  });

  it('issue задан → ищет по cursor_after=$N или file_name LIKE twic{N}g%', async () => {
    const pg = makePg([
      { rows: [{ id: 'src-uuid' }] },
      {
        rows: [
          {
            id: 'import-specific',
            cursor_after: '1655',
            file_name: 'twic1655g.zip',
          },
        ],
      },
    ]);
    const r = await resolveTwicImportId(pg as never, 1655);
    expect(r?.importId).toBe('import-specific');
    expect(r?.issue).toBe(1655);
  });

  it('cursor_after не-число → извлекает issue из file_name', async () => {
    const pg = makePg([
      { rows: [{ id: 'src-uuid' }] },
      {
        rows: [
          {
            id: 'import-x',
            cursor_after: null,
            file_name: 'twic1700g_v2.zip',
          },
        ],
      },
    ]);
    const r = await resolveTwicImportId(pg as never, null);
    expect(r?.issue).toBe(1700);
  });

  it('issue=42, но в БД его нет → null', async () => {
    const pg = makePg([{ rows: [{ id: 'src-uuid' }] }, { rows: [] }]);
    const r = await resolveTwicImportId(pg as never, 42);
    expect(r).toBeNull();
  });
});
