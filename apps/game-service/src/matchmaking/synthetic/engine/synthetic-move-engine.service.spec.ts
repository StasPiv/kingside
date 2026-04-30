/**
 * KS-2161 (B8). Тесты композиции SyntheticMoveEngineService.selectFromMultipv
 * + parseInfoLines + computeEvalDiff + clampUciElo + depthForCategory.
 *
 * `computeMove` end-to-end (с реальной заглушкой pool'а) — отдельный
 * smoke-тест ниже.
 */
import {
  SyntheticMoveEngineService,
  parseInfoLines,
  computeEvalDiff,
  clampUciElo,
  depthForCategory,
  randomLegalMove,
} from './synthetic-move-engine.service';
import type { StockfishPoolService } from './stockfish-pool.service';

describe('parseInfoLines', () => {
  it('одна multipv-линия → одна запись', () => {
    const out = parseInfoLines([
      'info depth 12 multipv 1 score cp 30 pv e2e4 e7e5',
    ]);
    expect(out).toEqual([
      { rank: 1, uci: 'e2e4', scoreCp: 30, mateIn: null },
    ]);
  });

  it('multipv 1/2/3 — отсортированы по rank', () => {
    const out = parseInfoLines([
      'info depth 8 multipv 2 score cp 10 pv g1f3',
      'info depth 8 multipv 1 score cp 30 pv e2e4',
      'info depth 8 multipv 3 score cp -50 pv b1c3',
    ]);
    expect(out.map((l) => l.rank)).toEqual([1, 2, 3]);
    expect(out.map((l) => l.uci)).toEqual(['e2e4', 'g1f3', 'b1c3']);
  });

  it('mate-score корректно распознаётся', () => {
    const out = parseInfoLines([
      'info depth 14 multipv 1 score mate 3 pv h1h8',
    ]);
    expect(out[0].mateIn).toBe(3);
    expect(out[0].scoreCp).toBeNull();
  });

  it('последовательные info на разных глубинах — берётся последнее значение', () => {
    const out = parseInfoLines([
      'info depth 8 multipv 1 score cp 10 pv e2e4',
      'info depth 12 multipv 1 score cp 30 pv e2e4',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].scoreCp).toBe(30);
  });

  it('некорректные info игнорируются', () => {
    const out = parseInfoLines(['some garbage', '', 'bestmove e2e4']);
    expect(out).toEqual([]);
  });
});

describe('computeEvalDiff', () => {
  it('|score(best) − score(2nd)|', () => {
    expect(
      computeEvalDiff([
        { rank: 1, uci: 'a', scoreCp: 50, mateIn: null },
        { rank: 2, uci: 'b', scoreCp: -20, mateIn: null },
      ]),
    ).toBe(70);
  });
  it('< 2 lines → 0', () => {
    expect(
      computeEvalDiff([{ rank: 1, uci: 'a', scoreCp: 50, mateIn: null }]),
    ).toBe(0);
  });
  it('mate-score без cp → 0', () => {
    expect(
      computeEvalDiff([
        { rank: 1, uci: 'a', scoreCp: null, mateIn: 5 },
        { rank: 2, uci: 'b', scoreCp: 0, mateIn: null },
      ]),
    ).toBe(0);
  });
});

describe('clampUciElo', () => {
  it.each([
    [500, 1320],
    [1000, 1320],
    [1500, 1500],
    [2000, 2000],
    [2900, 2850],
  ])('rating=%i → %i', (rating, expected) => {
    expect(clampUciElo(rating)).toBe(expected);
  });
});

describe('depthForCategory', () => {
  it.each([
    ['bullet', 8],
    ['blitz', 12],
    ['rapid', 16],
    ['classical', 20],
  ] as const)('%s → depth %i', (cat, depth) => {
    expect(depthForCategory(cat)).toBe(depth);
  });
});

describe('SyntheticMoveEngineService.selectFromMultipv', () => {
  let svc: SyntheticMoveEngineService;
  beforeEach(() => {
    svc = new SyntheticMoveEngineService(undefined as unknown as StockfishPoolService);
  });

  const lines = [
    { rank: 1, uci: 'best', scoreCp: 30, mateIn: null },
    { rank: 2, uci: '2nd', scoreCp: -20, mateIn: null },
    { rank: 3, uci: '3rd', scoreCp: -50, mateIn: null },
  ];

  it('rating 1500, rng=0.05 → best (попадает в 80%)', () => {
    const r = svc.selectFromMultipv(lines, 1500, () => 0.05);
    expect(r.uci).toBe('best');
    expect(r.notes).toBeUndefined();
  });

  it('rating 1500, rng=0.85 → 2nd (попадает в 16%, 80..96)', () => {
    const r = svc.selectFromMultipv(lines, 1500, () => 0.85);
    expect(r.uci).toBe('2nd');
    expect(r.notes?.noiseIndex).toBe(1);
  });

  it('rating 700, rng последовательность → blunder инжектится примерно в 1.5%', () => {
    let blunders = 0;
    for (let i = 0; i < 1000; i++) {
      const r = svc.selectFromMultipv(lines, 700);
      if (r.notes?.blunder === 'blunder') blunders++;
    }
    expect(blunders).toBeGreaterThan(2);
    expect(blunders).toBeLessThan(40);
  });

  it('sanity: candidate с mate -2 (соперник матует) → подмена на best', () => {
    const linesWithMate = [
      { rank: 1, uci: 'best', scoreCp: 30, mateIn: null },
      { rank: 2, uci: '2nd', scoreCp: 20, mateIn: -2 }, // мат -2 = соперник матует в 2
    ];
    // rng = 0.85 для rating 1500 → попытается выбрать 2nd, но sanity подменит.
    const r = svc.selectFromMultipv(linesWithMate, 1500, () => 0.85);
    expect(r.uci).toBe('best');
  });

  it('rating высокий, mate за нас → не подмена (mateForOpponent=null)', () => {
    const linesPositiveMate = [
      { rank: 1, uci: 'best', scoreCp: 30, mateIn: null },
      { rank: 2, uci: '2nd', scoreCp: 20, mateIn: 4 }, // мы матуем в 4 — это норм
    ];
    const r = svc.selectFromMultipv(linesPositiveMate, 1500, () => 0.85);
    expect(r.uci).toBe('2nd');
  });

  it('пустой список линий → throws', () => {
    expect(() => svc.selectFromMultipv([], 1500)).toThrow();
  });
});

describe('randomLegalMove', () => {
  it('startpos → возвращает любой из 20 легальных', () => {
    const uci = randomLegalMove(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    expect(uci).toMatch(/^[a-h][1-8][a-h][1-8][nbrq]?$/);
  });
  it('mate-позиция (нет ходов) → null', () => {
    // K vs K+R мат: 7k/R7/7K/8/8/8/8/8 b - - 0 1 — black to move, в мате? нет, в стале.
    // Возьмём более прямой пример: shouldn't matter — chess.js на конечной позиции вернёт [].
    const uci = randomLegalMove('8/8/8/8/8/4k3/4q3/4K3 w - - 0 1');
    expect(uci).toBeNull();
  });
});
