import type { TickResult, TickSourceResult } from './archive-import.service';

/**
 * Мок `aws-embedded-metrics`. Возвращаем фабрику, которая даёт MetricsLogger-подобные
 * объекты с jest-spy методами. Тесты проверяют вызовы и аргументы, не полагаясь
 * на реальный stdout-flush.
 */
const createdLoggers: MockMetricsLogger[] = [];

interface MockMetricsLogger {
  putMetric: jest.Mock;
  setDimensions: jest.Mock;
  setNamespace: jest.Mock;
  setProperty: jest.Mock;
  flush: jest.Mock;
  __metrics: Array<{ name: string; value: number; unit: string }>;
  __dimensions: Record<string, string> | null;
  __namespace: string | null;
  __props: Record<string, unknown>;
}

function makeMockLogger(): MockMetricsLogger {
  const self: MockMetricsLogger = {
    putMetric: jest.fn(),
    setDimensions: jest.fn(),
    setNamespace: jest.fn(),
    setProperty: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    __metrics: [],
    __dimensions: null,
    __namespace: null,
    __props: {},
  };
  self.putMetric.mockImplementation((name: string, value: number, unit: string) => {
    self.__metrics.push({ name, value, unit });
    return self;
  });
  self.setDimensions.mockImplementation((dim: Record<string, string>) => {
    self.__dimensions = dim;
    return self;
  });
  self.setNamespace.mockImplementation((ns: string) => {
    self.__namespace = ns;
    return self;
  });
  self.setProperty.mockImplementation((key: string, value: unknown) => {
    self.__props[key] = value;
    return self;
  });
  return self;
}

jest.mock('aws-embedded-metrics', () => ({
  createMetricsLogger: jest.fn(() => {
    const l = makeMockLogger();
    createdLoggers.push(l);
    return l;
  }),
  Unit: {
    Seconds: 'Seconds',
    Count: 'Count',
    None: 'None',
  },
  Configuration: {
    namespace: '',
  },
}));

// eslint-disable-next-line import/first
import { EmfMetricsPublisher } from './emf-metrics.service';

describe('EmfMetricsPublisher', () => {
  beforeEach(() => {
    createdLoggers.length = 0;
  });

  function makeRun(overrides: Partial<TickSourceResult> = {}): TickSourceResult {
    return {
      sourceCode: 'twic',
      due: true,
      lockHeld: false,
      result: {
        status: 'ok',
        cursorBefore: '1500',
        cursorAfter: '1501',
        fileName: 'twic1501.pgn',
        gamesParsed: 100,
        gamesAdded: 95,
        gamesSkipped: 5,
        classicalRatio: 0.84,
      },
      durationSec: 12.34,
      lastSuccessAt: new Date('2026-04-20T00:00:00Z'),
      ...overrides,
    };
  }

  it('recordSourceRun публикует 6 run-level метрик с dimension source (LastSuccessAgeSeconds перенесён в recordCatalogAge)', async () => {
    const publisher = new EmfMetricsPublisher();
    publisher.recordSourceRun(makeRun());

    expect(createdLoggers).toHaveLength(1);
    const l = createdLoggers[0];
    expect(l.__namespace).toBe('Kingside/ArchiveImporter');
    expect(l.__dimensions).toEqual({ source: 'twic' });

    const names = l.__metrics.map((m) => m.name).sort();
    expect(names).toEqual([
      'ClassicalRatio',
      'GamesAdded',
      'GamesParsed',
      'GamesSkipped',
      'ImportDurationSeconds',
      'SourcesFailed',
    ]);

    const byName = Object.fromEntries(l.__metrics.map((m) => [m.name, m]));
    expect(byName.GamesAdded.value).toBe(95);
    expect(byName.GamesSkipped.value).toBe(5);
    expect(byName.GamesParsed.value).toBe(100);
    expect(byName.ImportDurationSeconds.value).toBeCloseTo(12.34, 5);
    expect(byName.ImportDurationSeconds.unit).toBe('Seconds');
    expect(byName.SourcesFailed.value).toBe(0);
    expect(byName.ClassicalRatio.value).toBeCloseTo(0.84, 5);
    expect(byName.ClassicalRatio.unit).toBe('None');
    // KS-1716: LastSuccessAgeSeconds здесь больше не эмитится.
    expect(names).not.toContain('LastSuccessAgeSeconds');
  });

  it('ClassicalRatio не публикуется, если ImportResult.classicalRatio=undefined (noop/failed/no-games)', () => {
    const publisher = new EmfMetricsPublisher();
    publisher.recordSourceRun(
      makeRun({
        result: {
          status: 'ok',
          cursorBefore: '1500',
          cursorAfter: '1501',
          fileName: 'twic1501.pgn',
          gamesParsed: 0,
          gamesAdded: 0,
          gamesSkipped: 0,
          // classicalRatio: undefined — нет добавленных партий
        },
      }),
    );
    const names = createdLoggers[0].__metrics.map((m) => m.name).sort();
    expect(names).not.toContain('ClassicalRatio');
  });

  it('ClassicalRatio не публикуется для failed-run (result.classicalRatio undefined)', () => {
    const publisher = new EmfMetricsPublisher();
    publisher.recordSourceRun(
      makeRun({
        result: {
          status: 'failed',
          cursorBefore: '1500',
          cursorAfter: '1500',
          fileName: null,
          gamesParsed: 0,
          gamesAdded: 0,
          gamesSkipped: 0,
          error: 'HTTP 500',
        },
      }),
    );
    const byName = Object.fromEntries(
      createdLoggers[0].__metrics.map((m) => [m.name, m]),
    );
    expect(byName.ClassicalRatio).toBeUndefined();
  });

  it('SourcesFailed=1 при ImportResult.status=failed', () => {
    const publisher = new EmfMetricsPublisher();
    publisher.recordSourceRun(
      makeRun({
        result: {
          status: 'failed',
          cursorBefore: '1500',
          cursorAfter: '1500',
          fileName: null,
          gamesParsed: 0,
          gamesAdded: 0,
          gamesSkipped: 0,
          error: 'HTTP 500',
        },
      }),
    );
    const byName = Object.fromEntries(
      createdLoggers[0].__metrics.map((m) => [m.name, m]),
    );
    expect(byName.SourcesFailed.value).toBe(1);
  });

  it('SourcesFailed=1 при throw (run.error set, run.result=null)', () => {
    const publisher = new EmfMetricsPublisher();
    publisher.recordSourceRun(
      makeRun({
        result: null,
        error: 'redis connection lost',
      }),
    );
    const byName = Object.fromEntries(
      createdLoggers[0].__metrics.map((m) => [m.name, m]),
    );
    expect(byName.SourcesFailed.value).toBe(1);
    expect(byName.GamesAdded.value).toBe(0);
  });

  it('no-op run (not due) публикует нули run-level метрик, без ClassicalRatio (LastSuccessAgeSeconds теперь в recordCatalogAge)', () => {
    const publisher = new EmfMetricsPublisher();
    publisher.recordSourceRun(
      makeRun({
        due: false,
        result: null,
        durationSec: 0,
      }),
    );
    const byName = Object.fromEntries(
      createdLoggers[0].__metrics.map((m) => [m.name, m]),
    );
    expect(byName.GamesAdded.value).toBe(0);
    expect(byName.GamesSkipped.value).toBe(0);
    expect(byName.GamesParsed.value).toBe(0);
    expect(byName.ImportDurationSeconds.value).toBe(0);
    expect(byName.SourcesFailed.value).toBe(0);
    expect(byName.LastSuccessAgeSeconds).toBeUndefined();
    expect(byName.ClassicalRatio).toBeUndefined();
  });

  describe('recordCatalogAge (KS-1716 — catalog-level LastSuccessAgeSeconds)', () => {
    it('публикует LastSuccessAgeSeconds{source=code} для каждого источника каталога', () => {
      const publisher = new EmfMetricsPublisher();
      const now = new Date('2026-04-21T00:00:00Z');
      publisher.recordCatalogAge(
        [
          { code: 'twic', lastSuccessAt: new Date('2026-04-20T00:00:00Z') },
          { code: 'other', lastSuccessAt: new Date('2026-04-14T00:00:00Z') },
        ],
        now,
      );

      expect(createdLoggers).toHaveLength(2);
      const [twic, other] = createdLoggers;
      expect(twic.__namespace).toBe('Kingside/ArchiveImporter');
      expect(twic.__dimensions).toEqual({ source: 'twic' });
      expect(twic.__metrics.map((m) => m.name)).toEqual([
        'LastSuccessAgeSeconds',
      ]);
      expect(twic.__metrics[0].value).toBe(86400); // 1 день
      expect(twic.__metrics[0].unit).toBe('Seconds');
      expect(twic.__props.lastSuccessAt).toBe('2026-04-20T00:00:00.000Z');

      expect(other.__dimensions).toEqual({ source: 'other' });
      expect(other.__metrics[0].value).toBe(7 * 86400); // 7 дней
    });

    it('lastSuccessAt=null → sentinel 10 лет в секундах (alarm A4 threshold=14d сработает)', () => {
      const publisher = new EmfMetricsPublisher();
      publisher.recordCatalogAge(
        [{ code: 'twic', lastSuccessAt: null }],
        new Date('2026-04-23T00:00:00Z'),
      );
      expect(createdLoggers).toHaveLength(1);
      const l = createdLoggers[0];
      expect(l.__metrics[0].name).toBe('LastSuccessAgeSeconds');
      expect(l.__metrics[0].value).toBe(10 * 365 * 86400);
      expect(l.__props.lastSuccessAt).toBeNull();
    });

    it('пустой каталог → ни одного logger не создаётся (nothing to publish)', () => {
      const publisher = new EmfMetricsPublisher();
      publisher.recordCatalogAge([], new Date());
      expect(createdLoggers).toHaveLength(0);
    });
  });

  it('recordTickSummary публикует агрегат SourcesChecked/Processed/Failed + TotalGamesAdded + ExitCode без dimensions', () => {
    const publisher = new EmfMetricsPublisher();
    const tick: TickResult = {
      runs: [
        makeRun(),
        makeRun({ sourceCode: 'other', error: 'boom', result: null }),
        makeRun({ sourceCode: 'third', due: false, result: null }),
      ],
      totalGamesAdded: 95,
    };
    publisher.recordTickSummary(tick, 2);
    expect(createdLoggers).toHaveLength(1);
    const l = createdLoggers[0];
    expect(l.__dimensions).toEqual({});
    const names = l.__metrics.map((m) => m.name).sort();
    expect(names).toEqual([
      'ExitCode',
      'SourcesChecked',
      'SourcesFailed',
      'SourcesProcessed',
      'TotalGamesAdded',
    ]);
    const byName = Object.fromEntries(l.__metrics.map((m) => [m.name, m]));
    expect(byName.SourcesChecked.value).toBe(3); // все 3 run'а перебраны
    expect(byName.SourcesProcessed.value).toBe(2); // due && !lockHeld (первый ok + второй с error, третий due=false не процессился)
    expect(byName.SourcesFailed.value).toBe(1); // один с error
    expect(byName.TotalGamesAdded.value).toBe(95);
    expect(byName.ExitCode.value).toBe(2);
    expect(byName.ExitCode.unit).toBe('None');
  });

  it('recordTickSummary: lockHeld не попадает в SourcesProcessed', () => {
    const publisher = new EmfMetricsPublisher();
    const tick: TickResult = {
      runs: [
        makeRun({ due: true, lockHeld: true, result: null }),
        makeRun({ sourceCode: 'other', due: true, lockHeld: false }),
      ],
      totalGamesAdded: 95,
    };
    publisher.recordTickSummary(tick, 0);
    const byName = Object.fromEntries(
      createdLoggers[0].__metrics.map((m) => [m.name, m]),
    );
    expect(byName.SourcesProcessed.value).toBe(1); // только второй
    expect(byName.SourcesFailed.value).toBe(0);
    expect(byName.ExitCode.value).toBe(0);
  });

  it('recordTickSummary по умолчанию (без exitCode-аргумента) пишет ExitCode=0', () => {
    const publisher = new EmfMetricsPublisher();
    publisher.recordTickSummary({ runs: [], totalGamesAdded: 0 });
    const byName = Object.fromEntries(
      createdLoggers[0].__metrics.map((m) => [m.name, m]),
    );
    expect(byName.ExitCode.value).toBe(0);
  });

  it('flush вызывает flush на всех накопленных loggers и очищает pending', async () => {
    const publisher = new EmfMetricsPublisher();
    publisher.recordSourceRun(makeRun());
    publisher.recordSourceRun(makeRun({ sourceCode: 'other' }));
    publisher.recordTickSummary({ runs: [], totalGamesAdded: 0 }, 0);

    expect(createdLoggers).toHaveLength(3);
    await publisher.flush();
    for (const l of createdLoggers) {
      expect(l.flush).toHaveBeenCalledTimes(1);
    }

    // Повторный flush — ничего не делает (pending очищен).
    await publisher.flush();
    for (const l of createdLoggers) {
      expect(l.flush).toHaveBeenCalledTimes(1);
    }
  });

  it('flush не падает, если одна из метрик выбросила ошибку', async () => {
    const publisher = new EmfMetricsPublisher();
    publisher.recordSourceRun(makeRun());
    publisher.recordSourceRun(makeRun({ sourceCode: 'other' }));
    createdLoggers[0].flush.mockRejectedValueOnce(new Error('stdout broken'));
    await expect(publisher.flush()).resolves.toBeUndefined();
    // Вторая метрика всё равно flushнулась.
    expect(createdLoggers[1].flush).toHaveBeenCalled();
  });
});
