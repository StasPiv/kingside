/**
 * KS-2591. Тесты вспомогательной функции `shouldCloseRoundAsFinished`,
 * которая решает — закрывать ли раунд после PGN-обновления, когда все
 * партии финальные.
 *
 * Контекст: см. doc-блок над `shouldCloseRoundAsFinished` в
 * `broadcast-sync.service.ts` и описание KS-2591 в трекере.
 *
 * Покрываемые кейсы:
 *  1) 3 финальные партии + ongoing → true (закрыть);
 *  2) 2 финальные + 1 с `*` (или пустой result) → false (не закрывать);
 *  3) пустой массив игр → false (между турами PGN бывает пустой);
 *  4) currentStatus !== 'ongoing' (`pending` / `finished` / `failed`) → false.
 */
import {
  shouldCloseRoundAsFinished,
  extractClocksFromPgn,
  detectLastMoveAt,
  fetchKey,
  computeBackoffTtlSec,
  formatFetchError,
} from './broadcast-sync.service';

function game(result: string): { result: string } {
  return { result };
}

describe('shouldCloseRoundAsFinished — KS-2591', () => {
  describe('закрывает раунд', () => {
    it('3 финальные партии (1-0, 0-1, 1/2-1/2) + ongoing → true', () => {
      const games = [game('1-0'), game('0-1'), game('1/2-1/2')];
      expect(shouldCloseRoundAsFinished(games, 'ongoing')).toBe(true);
    });

    it('1 финальная партия + ongoing → true', () => {
      expect(shouldCloseRoundAsFinished([game('1-0')], 'ongoing')).toBe(true);
    });
  });

  describe('НЕ закрывает раунд', () => {
    it('2 финальные + 1 с `*` → false (продолжается)', () => {
      const games = [game('1-0'), game('0-1'), game('*')];
      expect(shouldCloseRoundAsFinished(games, 'ongoing')).toBe(false);
    });

    it('одна партия с пустым result → false', () => {
      const games = [game('1-0'), game('')];
      expect(shouldCloseRoundAsFinished(games, 'ongoing')).toBe(false);
    });

    it('пустой список игр → false (между турами PGN может быть пустой)', () => {
      expect(shouldCloseRoundAsFinished([], 'ongoing')).toBe(false);
    });

    it('round.status === "finished" → false (no-op для уже закрытого)', () => {
      const games = [game('1-0'), game('0-1')];
      expect(shouldCloseRoundAsFinished(games, 'finished')).toBe(false);
    });

    it('round.status === "pending" → false (раунд ещё не стартовал)', () => {
      const games = [game('1-0')];
      expect(shouldCloseRoundAsFinished(games, 'pending')).toBe(false);
    });

    it('round.status === "failed" → false (оператору решать)', () => {
      const games = [game('1-0'), game('0-1')];
      expect(shouldCloseRoundAsFinished(games, 'failed')).toBe(false);
    });
  });
});

/**
 * KS-2699: парсинг `%clk H:MM:SS` PGN-комментариев Lichess broadcast.
 *
 * Контракт: возвращаем последний `%clk` каждой стороны. Порядок:
 * 0-й (после 1-го хода белых) → белые, 1-й → чёрные, 2-й → белые, ...
 */
describe('extractClocksFromPgn — KS-2699', () => {
  it('два хода с %clk → белые и чёрные с правильными ms', () => {
    const pgn = '1. e4 { [%clk 1:30:00] } 1...e5 { [%clk 1:29:55] } *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBe(5_400_000); // 1ч30м = 5400с = 5_400_000 мс
    expect(r.blackMs).toBe(5_395_000);
  });

  it('берёт последний %clk каждой стороны', () => {
    const pgn =
      '1. e4 {[%clk 1:30:00]} e5 {[%clk 1:29:55]} ' +
      '2. Nf3 {[%clk 1:29:50]} Nc6 {[%clk 1:29:45]} *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBe(5_390_000); // после 2.Nf3
    expect(r.blackMs).toBe(5_385_000); // после 2...Nc6
  });

  it('только ход белых → blackMs остаётся null', () => {
    const pgn = '1. e4 { [%clk 1:30:00] } *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBe(5_400_000);
    expect(r.blackMs).toBeNull();
  });

  it('PGN без %clk → оба null', () => {
    const pgn = '1. e4 e5 2. Nf3 Nc6 *';
    expect(extractClocksFromPgn(pgn)).toEqual({
      whiteMs: null,
      blackMs: null,
    });
  });

  it('дробные секунды парсятся корректно', () => {
    const pgn = '1. e4 {[%clk 0:05:30.5]} e5 {[%clk 0:05:29.123]} *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBe(330_500); // 5:30.5
    expect(r.blackMs).toBe(329_123);
  });

  it('пустой PGN → оба null', () => {
    expect(extractClocksFromPgn('')).toEqual({
      whiteMs: null,
      blackMs: null,
    });
  });

  it('переменные пробелы и формат внутри тега', () => {
    const pgn = '1. e4 {[%clk 02:00:00]} e5 {[%clk 01:59:59]} *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBe(7_200_000);
    expect(r.blackMs).toBe(7_199_000);
  });

  // ── KS-2720: robust parsing по dots-pattern ────────────────────────

  it('KS-2720: явный `1...` маркер чёрных без хода белых → blackMs', () => {
    // Lichess может прислать инкремент только с ходом чёрных — формат
    // `1... e5 {...}` без предшествующего `1.` в этом блоке.
    const pgn = '1... e5 { [%eval 0.0] [%clk 1:30:00] } *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBeNull();
    expect(r.blackMs).toBe(5_400_000);
  });

  it('KS-2720: PGN с %eval перед %clk (lichess стандарт) парсится корректно', () => {
    const pgn =
      '1. c4 { [%eval 0.11] [%clk 1:30:53] } 1... c5 { [%eval 0.19] [%clk 1:30:55] } *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBe(5_453_000); // 1:30:53
    expect(r.blackMs).toBe(5_455_000); // 1:30:55
  });

  it('KS-2720: %clk только у чёрных ходов (старая чётность сломалась бы)', () => {
    // Гипотеза А из задачи: Lichess в каком-то snapshot отдал %clk
    // только для чёрных. Старый парсер записал бы первое значение
    // как whiteMs (i=0). Новый — корректно опознал бы по `1...`.
    const pgn = '1. c4 1... c5 { [%clk 1:30:55] } 2. Nf3 2... Nc6 { [%clk 1:29:18] } *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBeNull();
    expect(r.blackMs).toBe(5_358_000); // 1:29:18 (последний %clk чёрных)
  });

  it('KS-2720: %clk только у белых ходов', () => {
    const pgn = '1. c4 { [%clk 1:30:53] } 1... c5 2. Nf3 { [%clk 1:30:07] } 2... Nc6 *';
    const r = extractClocksFromPgn(pgn);
    expect(r.whiteMs).toBe(5_407_000); // 1:30:07
    expect(r.blackMs).toBeNull();
  });

  it('KS-2720: starting FEN side=b — первый ход чёрные, не сбивается на whiteMs', () => {
    // PGN с `[FEN "...b ..."]` (Chess960 / задачи / эндшпиль). Старый
    // парсер записал бы первый %clk как whiteMs (всё равно — он шёл
    // по чётности). Новый правильно ставит как black по `1...`.
    const pgn =
      '[FEN "8/8/8/8/8/8/8/8 b - - 0 1"]\n[SetUp "1"]\n\n1... Kf6 { [%clk 0:05:00] } 2. Kd5 { [%clk 0:04:50] } *';
    const r = extractClocksFromPgn(pgn);
    expect(r.blackMs).toBe(300_000); // 5:00 — ход чёрных первым
    expect(r.whiteMs).toBe(290_000); // 4:50 — ход белых после
  });
});

/**
 * KS-2798: `detectLastMoveAt` — чистый детектор «появился новый
 * полуход в этом PGN-update». Идея: смотрим только на смену FEN,
 * это работает и для broadcast'ов БЕЗ `%clk` в источнике.
 */
describe('detectLastMoveAt — KS-2798', () => {
  const STARTING =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const AFTER_E4 =
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const AFTER_E4_C5 =
    'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

  it('новая партия в стартовой позиции → не выставлять lastMoveAt', () => {
    expect(
      detectLastMoveAt({
        existingFen: null,
        newFen: STARTING,
        startingFen: STARTING,
      }),
    ).toBe(false);
  });

  it('новая партия с уже сделанным ходом (FEN ≠ стартовая) → выставить', () => {
    expect(
      detectLastMoveAt({
        existingFen: null,
        newFen: AFTER_E4,
        startingFen: STARTING,
      }),
    ).toBe(true);
  });

  it('повтор того же PGN (FEN не изменился) → не выставлять', () => {
    expect(
      detectLastMoveAt({
        existingFen: AFTER_E4,
        newFen: AFTER_E4,
        startingFen: STARTING,
      }),
    ).toBe(false);
  });

  it('появился новый ход (FEN изменился) → выставить', () => {
    expect(
      detectLastMoveAt({
        existingFen: AFTER_E4,
        newFen: AFTER_E4_C5,
        startingFen: STARTING,
      }),
    ).toBe(true);
  });

  it('existing undefined трактуется как новая партия', () => {
    expect(
      detectLastMoveAt({
        existingFen: undefined,
        newFen: STARTING,
        startingFen: STARTING,
      }),
    ).toBe(false);
    expect(
      detectLastMoveAt({
        existingFen: undefined,
        newFen: AFTER_E4,
        startingFen: STARTING,
      }),
    ).toBe(true);
  });
});

/**
 * KS-2722: Round не считается finished, если все партии партии активны
 * (даже если Lichess по календарю закрыл). И обратное: round_status
 * перейдёт в `finished` только когда все игры завершены.
 *
 * Ниже — поведенческие unit-тесты на хелпер `shouldCloseRoundAsFinished`
 * и сценарий «Lichess finished + БД ongoing».
 */
describe('shouldCloseRoundAsFinished — KS-2722', () => {
  it('round.status=ongoing + все 3 партии финальные → закрыть', () => {
    expect(
      shouldCloseRoundAsFinished(
        [{ result: '1-0' }, { result: '0-1' }, { result: '1/2-1/2' }],
        'ongoing',
      ),
    ).toBe(true);
  });

  it('round.status=ongoing + 1 партия незакрыта → НЕ закрывать', () => {
    expect(
      shouldCloseRoundAsFinished(
        [{ result: '1-0' }, { result: '*' }, { result: '1-0' }],
        'ongoing',
      ),
    ).toBe(false);
  });

  it('round.status=finished — no-op (уже закрыт)', () => {
    expect(
      shouldCloseRoundAsFinished([{ result: '1-0' }], 'finished'),
    ).toBe(false);
  });

  it('пустой games массив (между турами) → НЕ закрывать', () => {
    expect(shouldCloseRoundAsFinished([], 'ongoing')).toBe(false);
  });

  it('result=null → НЕ закрывать', () => {
    expect(
      shouldCloseRoundAsFinished(
        // @ts-expect-error — спец-кейс null
        [{ result: '1-0' }, { result: null }],
        'ongoing',
      ),
    ).toBe(false);
  });
});

describe('KS-3334: per-endpoint backoff helpers', () => {
  describe('fetchKey', () => {
    it('даёт стабильный ключ host+path без query', () => {
      expect(fetchKey('https://lichess.org/api/broadcast/round/abc.pgn')).toBe(
        'lichess.org/api/broadcast/round/abc.pgn',
      );
    });

    it('query-параметры не влияют на ключ', () => {
      const a = fetchKey('https://lichess.org/api/broadcast?nb=50');
      const b = fetchKey('https://lichess.org/api/broadcast?nb=100');
      expect(a).toBe(b);
    });

    it('разные roundId → разные ключи (один проблемный не блокирует другой)', () => {
      const a = fetchKey('https://lichess.org/api/broadcast/round/AAA.pgn');
      const b = fetchKey('https://lichess.org/api/broadcast/round/BBB.pgn');
      expect(a).not.toBe(b);
    });

    it('round-PGN endpoint и tour-API — разные ключи', () => {
      const round = fetchKey('https://lichess.org/api/broadcast/round/X.pgn');
      const tour = fetchKey('https://lichess.org/api/broadcast/Y');
      expect(round).not.toBe(tour);
    });

    it('невалидный URL → возвращает строку как есть (не падает)', () => {
      expect(fetchKey('not-a-url')).toBe('not-a-url');
    });
  });

  describe('computeBackoffTtlSec', () => {
    it('первая неудача → ~60 сек (с jitter)', () => {
      const ttl = computeBackoffTtlSec(1);
      // 60 ± 30% = [42, 78].
      expect(ttl).toBeGreaterThanOrEqual(60); // clamp на BASE_TTL минимум
      expect(ttl).toBeLessThanOrEqual(78);
    });

    it('эскалация: 4-я и далее неудача → ~1800 сек (30 мин)', () => {
      const ttl = computeBackoffTtlSec(10);
      // 1800 ± 30% clamp до MAX = 1800.
      expect(ttl).toBeGreaterThanOrEqual(1260);
      expect(ttl).toBeLessThanOrEqual(1800);
    });

    it('failures=2 → ~180 сек (3 мин)', () => {
      const ttl = computeBackoffTtlSec(2);
      expect(ttl).toBeGreaterThanOrEqual(126); // 180 - 30%
      expect(ttl).toBeLessThanOrEqual(234); // 180 + 30%
    });

    it('failures=3 → ~600 сек (10 мин)', () => {
      const ttl = computeBackoffTtlSec(3);
      expect(ttl).toBeGreaterThanOrEqual(420);
      expect(ttl).toBeLessThanOrEqual(780);
    });
  });
});

/**
 * KS-4836: раскрытие err.cause в логах.
 */
describe('formatFetchError — KS-4836', () => {
  it('простая ошибка без cause → класс и сообщение', () => {
    const err = new Error('boom');
    expect(formatFetchError(err)).toBe('Error("boom")');
  });

  it('undici-style fetch failed с cause=Error{code=EAI_AGAIN,syscall,hostname}', () => {
    // Воспроизводим то, что кладёт Node's fetch при DNS-таймауте.
    const cause = Object.assign(new Error('getaddrinfo EAI_AGAIN lichess.org'), {
      code: 'EAI_AGAIN',
      errno: -3001,
      syscall: 'getaddrinfo',
      hostname: 'lichess.org',
    });
    const err = new TypeError('fetch failed', { cause });
    const out = formatFetchError(err);
    expect(out).toContain('TypeError("fetch failed")');
    expect(out).toContain('cause: Error(');
    expect(out).toContain('code=EAI_AGAIN');
    expect(out).toContain('errno=-3001');
    expect(out).toContain('syscall=getaddrinfo');
    expect(out).toContain('hostname=lichess.org');
  });

  it('undici UND_ERR_CONNECT_TIMEOUT — код виден', () => {
    const cause = Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    const err = new TypeError('fetch failed', { cause });
    expect(formatFetchError(err)).toContain('code=UND_ERR_CONNECT_TIMEOUT');
  });

  it('AggregateError — берём первую под-ошибку из errors[]', () => {
    const sub = Object.assign(new Error('ECONNREFUSED'), {
      code: 'ECONNREFUSED',
      address: '5.196.24.6',
      port: 443,
    });
    const agg = new AggregateError([sub], 'All fetch attempts failed');
    expect(formatFetchError(agg)).toContain('code=ECONNREFUSED');
    expect(formatFetchError(agg)).toContain('address=5.196.24.6');
    expect(formatFetchError(agg)).toContain('port=443');
  });

  it('глубина ≤ 5 уровней — самоссылка не зацикливает', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    a.cause = a; // самоссылка
    expect(() => formatFetchError(a)).not.toThrow();
  });

  it('null/undefined → "unknown"', () => {
    expect(formatFetchError(undefined)).toBe('unknown');
    expect(formatFetchError(null)).toBe('unknown');
  });

  it('строка вместо Error → возвращается как есть', () => {
    expect(formatFetchError('boom')).toBe('boom');
  });
});
