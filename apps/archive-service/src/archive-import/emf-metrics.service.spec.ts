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

  it('recordSourceRun публикует все 7 бизнес-метрик с dimension source (включая ClassicalRatio)', async () => {
    const publisher = new EmfMetricsPublisher();
    const now = new Date('2026-04-21T00:00:00Z');
    publisher.recordSourceRun(makeRun(), now);

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
      'LastSuccessAgeSeconds',
      'SourcesFailed',
    ]);

    const byName = Object.fromEntries(l.__metrics.map((m) => [m.name, m]));
    expect(byName.GamesAdded.value).toBe(95);
    expect(byName.GamesSkipped.value).toBe(5);
    expect(byName.GamesParsed.value).toBe(100);
    expect(byName.ImportDurationSeconds.value).toBeCloseTo(12.34, 5);
    expect(byName.ImportDurationSeconds.unit).toBe('Seconds');
    expect(byName.SourcesFailed.value).toBe(0);
    // 24 часа между 2026-04-20 и 2026-04-21 = 86400s.
    expect(byName.LastSuccessAgeSeconds.value).toBe(86400);
    expect(byName.ClassicalRatio.value).toBeCloseTo(0.84, 5);
    expect(byName.ClassicalRatio.unit).toBe('None');
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

  it('LastSuccessAgeSeconds=sentinel (10 лет) если lastSuccessAt=null', () => {
    const publisher = new EmfMetricsPublisher();
    publisher.recordSourceRun(
      makeRun({
        lastSuccessAt: null,
        due: false,
        result: null,
      }),
    );
    const byName = Object.fromEntries(
      createdLoggers[0].__metrics.map((m) => [m.name, m]),
    );
    expect(byName.LastSuccessAgeSeconds.value).toBe(10 * 365 * 86400);
  });

  it('no-op run (not due) публикует нули и LastSuccessAgeSeconds, без ClassicalRatio', () => {
    const publisher = new EmfMetricsPublisher();
    const now = new Date('2026-04-21T00:00:00Z');
    publisher.recordSourceRun(
      makeRun({
        due: false,
        result: null,
        durationSec: 0,
      }),
      now,
    );
    const byName = Object.fromEntries(
      createdLoggers[0].__metrics.map((m) => [m.name, m]),
    );
    expect(byName.GamesAdded.value).toBe(0);
    expect(byName.GamesSkipped.value).toBe(0);
    expect(byName.GamesParsed.value).toBe(0);
    expect(byName.ImportDurationSeconds.value).toBe(0);
    expect(byName.SourcesFailed.value).toBe(0);
    expect(byName.LastSuccessAgeSeconds.value).toBe(86400);
    expect(byName.ClassicalRatio).toBeUndefined();
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
